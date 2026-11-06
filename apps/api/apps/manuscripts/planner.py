from __future__ import annotations

import json
import re
from datetime import date
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.db.models import F
from django.http import JsonResponse
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.views.decorators.http import require_http_methods

from apps.audit.service import write_audit_event
from apps.sources.contest_tracking import contest_deadlines_payload

from .models import (
    Document,
    Manuscript,
    ManuscriptItem,
    ManuscriptPlanStatus,
    ManuscriptTask,
    ManuscriptWritingDay,
)
from .services import InvalidStructure, create_book_item
from .versioning import document_statistics

MAX_WORD_GOAL = 100_000_000
MAX_STATUS_COUNT = 20
MAX_STATUS_NAME_LENGTH = 40
MAX_ITEM_TITLE_LENGTH = 240
MAX_ITEM_SYNOPSIS_LENGTH = 5_000
MAX_TASK_TITLE_LENGTH = 240
MAX_TASK_DESCRIPTION_LENGTH = 5_000
PLANNER_ROLES = {"untyped", "act", "chapter", "scene"}
STATUS_COLORS = {"gray", "blue", "green", "amber", "purple", "red", "teal"}
DEFAULT_STATUSES = (
    ("Draft", "amber", False),
    ("In progress", "blue", False),
    ("Complete", "green", True),
    ("Needs revision", "purple", False),
)
DEFAULT_STATUSES_RU = (
    ("Черновик", "amber", False),
    ("В работе", "blue", False),
    ("Завершено", "green", True),
    ("Нужна доработка", "purple", False),
)


def local_date(timezone_name: str) -> date:
    try:
        selected_timezone = ZoneInfo(timezone_name)
    except (TypeError, ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError("planner_timezone_invalid") from exc
    return timezone.now().astimezone(selected_timezone).date()


@transaction.atomic
def record_words_written(*, manuscript_id: int, writing_date: date, words: int) -> None:
    if words <= 0:
        return
    manuscript = Manuscript.objects.select_for_update().get(id=manuscript_id)
    writing_day, _created = ManuscriptWritingDay.objects.get_or_create(
        manuscript=manuscript,
        date=writing_date,
    )
    ManuscriptWritingDay.objects.filter(id=writing_day.id).update(
        words_written=F("words_written") + words,
    )


def _active_documents(manuscript: Manuscript):
    return Document.objects.filter(
        manuscript=manuscript,
        item__trashed_at__isnull=True,
    ).select_related("manuscript__workspace")


def _ensure_default_statuses(manuscript: Manuscript) -> list[ManuscriptPlanStatus]:
    statuses = list(manuscript.plan_statuses.all())
    if statuses or manuscript.plan_statuses_initialized:
        return statuses
    with transaction.atomic():
        locked = Manuscript.objects.select_for_update().select_related("workspace").get(
            id=manuscript.id
        )
        statuses = list(locked.plan_statuses.all())
        if not statuses and not locked.plan_statuses_initialized:
            defaults = (
                DEFAULT_STATUSES_RU
                if locked.workspace.owner.language == "ru"
                else DEFAULT_STATUSES
            )
            for position, (name, color, complete) in enumerate(defaults, start=1):
                status = ManuscriptPlanStatus(
                    manuscript=locked,
                    color=color,
                    position=position * 1024,
                    counts_as_complete=complete,
                )
                status.name = name
                status.save()
                statuses.append(status)
            Manuscript.objects.filter(id=locked.id).update(
                planner_generation=F("planner_generation") + 1,
                plan_statuses_initialized=True,
            )
    manuscript.refresh_from_db(fields=["planner_generation", "plan_statuses_initialized"])
    return statuses


def _status_payload(status: ManuscriptPlanStatus) -> dict:
    return {
        "id": str(status.public_id),
        "name": status.name,
        "color": status.color,
        "position": status.position,
        "countsAsComplete": status.counts_as_complete,
    }


def _plan_payload(manuscript: Manuscript) -> dict:
    statuses = _ensure_default_statuses(manuscript)
    items = list(
        ManuscriptItem.objects.filter(manuscript=manuscript, trashed_at__isnull=True)
        .select_related("manuscript__workspace", "parent")
        .order_by("position", "created_at")
    )
    direct_words = {
        document.item_id: document_statistics(document.content)[0]
        for document in _active_documents(manuscript)
        if document.item_id is not None
    }
    children: dict[int, list[int]] = {}
    for item in items:
        if item.parent_id is not None:
            children.setdefault(item.parent_id, []).append(item.id)
    aggregate_words: dict[int, int] = {}

    def aggregate(item_id: int) -> int:
        if item_id not in aggregate_words:
            aggregate_words[item_id] = direct_words.get(item_id, 0) + sum(
                aggregate(child_id) for child_id in children.get(item_id, [])
            )
        return aggregate_words[item_id]

    result = []
    for item in items:
        metadata = item.planner_metadata
        result.append(
            {
                "id": str(item.public_id),
                "parentId": str(item.parent.public_id) if item.parent_id else None,
                "kind": item.kind,
                "title": item.title,
                "position": item.position,
                "role": metadata.get("role", "untyped"),
                "synopsis": metadata.get("synopsis", ""),
                "deadline": metadata.get("deadline"),
                "wordGoal": metadata.get("wordGoal", 0),
                "statusId": metadata.get("statusId"),
                "completedDate": metadata.get("completedDate"),
                "wordCount": aggregate(item.id),
            }
        )
    return {
        "items": result,
        "statuses": [_status_payload(status) for status in statuses],
        "structureGeneration": manuscript.structure_generation,
        "plannerGeneration": manuscript.planner_generation,
    }


def planner_payload(manuscript: Manuscript, *, today: date) -> dict:
    total_words = sum(
        document_statistics(document.content)[0]
        for document in _active_documents(manuscript)
    )
    words_today = (
        ManuscriptWritingDay.objects.filter(manuscript=manuscript, date=today)
        .values_list("words_written", flat=True)
        .first()
        or 0
    )
    return {
        "manuscriptTitle": manuscript.title,
        "settings": manuscript.planner_settings,
        "statistics": {
            "today": today.isoformat(),
            "wordsToday": words_today,
            "totalWords": total_words,
        },
        "plan": _plan_payload(manuscript),
        "tasks": _tasks_payload(manuscript),
        "contestDeadlines": contest_deadlines_payload(manuscript),
    }


def _task_payload(task: ManuscriptTask) -> dict:
    content = task.content
    return {
        "id": str(task.public_id),
        "title": content.get("title", ""),
        "description": content.get("description", ""),
        "deadline": content.get("deadline"),
        "priority": task.priority,
        "associatedItemId": (
            str(task.associated_item.public_id) if task.associated_item_id else None
        ),
        "pinned": task.is_pinned,
        "completed": task.completed_at is not None,
        "createdAt": task.created_at.isoformat(),
        "updatedAt": task.updated_at.isoformat(),
    }


def _tasks_payload(manuscript: Manuscript) -> list[dict]:
    tasks = ManuscriptTask.objects.filter(manuscript=manuscript).select_related(
        "manuscript__workspace", "associated_item"
    )
    return [_task_payload(task) for task in tasks]


def _word_goal(value, error_code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_WORD_GOAL:
        raise ValueError(error_code)
    return value


def _read_json(request):
    try:
        value = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _manuscript_for_owner(manuscript_id: int, user):
    return (
        Manuscript.objects.filter(id=manuscript_id, workspace__owner=user)
        .select_related("workspace")
        .first()
    )


def _public_id(value):
    try:
        return UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _validate_role(role: object, kind: str) -> bool:
    if role not in PLANNER_ROLES:
        return False
    if role == "act":
        return kind == ManuscriptItem.KIND_FOLDER
    if role == "scene":
        return kind == ManuscriptItem.KIND_DOCUMENT
    return True


def _task_fields(payload: dict, manuscript: Manuscript):
    title = str(payload.get("title") or "").strip()
    description = str(payload.get("description") or "").strip()
    priority = payload.get("priority")
    deadline_value = payload.get("deadline")
    deadline = parse_date(deadline_value) if isinstance(deadline_value, str) else None
    associated_public_id = (
        _public_id(payload.get("associatedItemId")) if payload.get("associatedItemId") else None
    )
    if not title or len(title) > MAX_TASK_TITLE_LENGTH:
        raise ValueError("planner_task_title_invalid")
    if len(description) > MAX_TASK_DESCRIPTION_LENGTH:
        raise ValueError("planner_task_description_invalid")
    if priority not in dict(ManuscriptTask.PRIORITY_CHOICES):
        raise ValueError("planner_task_priority_invalid")
    if deadline_value is not None and deadline is None:
        raise ValueError("planner_task_deadline_invalid")
    if not isinstance(payload.get("pinned"), bool):
        raise ValueError("planner_task_pinned_invalid")
    associated_item = None
    if associated_public_id is not None:
        associated_item = ManuscriptItem.objects.filter(
            manuscript=manuscript,
            public_id=associated_public_id,
            trashed_at__isnull=True,
        ).first()
        if associated_item is None:
            raise ValueError("planner_task_item_not_found")
    return title, description, deadline, priority, associated_item, payload["pinned"]


@require_http_methods(["GET", "PATCH"])
def manuscript_planner(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = (
        Manuscript.objects.filter(id=manuscript_id, workspace__owner=request.user)
        .select_related("workspace")
        .first()
    )
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    if request.method == "GET":
        timezone_name = request.GET.get("timezone", "UTC")
    else:
        try:
            payload = json.loads(request.body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "invalid_json"}, status=400)
        if not isinstance(payload, dict) or set(payload) != {
            "deadline",
            "dailyWordGoal",
            "manuscriptWordGoal",
            "timezone",
        }:
            return JsonResponse({"error": "planner_settings_invalid"}, status=400)
        timezone_name = payload["timezone"]

    try:
        today = local_date(timezone_name)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    if request.method == "PATCH":
        deadline_value = payload["deadline"]
        deadline = parse_date(deadline_value) if isinstance(deadline_value, str) else None
        if deadline_value is not None and deadline is None:
            return JsonResponse({"error": "planner_deadline_invalid"}, status=400)
        try:
            daily_word_goal = _word_goal(payload["dailyWordGoal"], "planner_daily_goal_invalid")
            manuscript_word_goal = _word_goal(
                payload["manuscriptWordGoal"],
                "planner_manuscript_goal_invalid",
            )
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        with transaction.atomic():
            manuscript = Manuscript.objects.select_for_update().select_related("workspace").get(
                id=manuscript.id
            )
            manuscript.planner_settings = {
                "deadline": deadline.isoformat() if deadline else None,
                "dailyWordGoal": daily_word_goal,
                "manuscriptWordGoal": manuscript_word_goal,
            }
            manuscript.save(update_fields=["planner_settings", "updated_at"])
            write_audit_event(
                request,
                "manuscript.planner_updated",
                actor=request.user,
                subject=f"manuscript:{manuscript.public_id}",
                payload={"kind": manuscript.kind},
            )
    return JsonResponse({"planner": planner_payload(manuscript, today=today)})


@require_http_methods(["POST"])
def planner_items(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if manuscript.kind != Manuscript.KIND_BOOK:
        return JsonResponse({"error": "planner_oneshot_structure_fixed"}, status=400)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    title = str(payload.get("title") or "").strip()
    role = payload.get("role")
    chapter_mode = payload.get("chapterMode")
    parent_public_id = _public_id(payload.get("parentId")) if payload.get("parentId") else None
    expected_structure = payload.get("expectedStructureGeneration")
    expected_planner = payload.get("expectedPlannerGeneration")
    try:
        today = local_date(payload.get("timezone", "UTC"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    if not title or len(title) > MAX_ITEM_TITLE_LENGTH:
        return JsonResponse({"error": "planner_item_title_invalid"}, status=400)
    if role == "act":
        kind = ManuscriptItem.KIND_FOLDER
        if parent_public_id is not None:
            return JsonResponse({"error": "planner_act_must_be_root"}, status=400)
    elif role == "scene":
        kind = ManuscriptItem.KIND_DOCUMENT
        if parent_public_id is None:
            return JsonResponse({"error": "planner_scene_parent_required"}, status=400)
    elif role == "chapter" and chapter_mode in {"document", "scenes"}:
        kind = (
            ManuscriptItem.KIND_DOCUMENT
            if chapter_mode == "document"
            else ManuscriptItem.KIND_FOLDER
        )
    else:
        return JsonResponse({"error": "planner_item_type_invalid"}, status=400)

    with transaction.atomic():
        locked = Manuscript.objects.select_for_update().select_related("workspace").get(
            id=manuscript.id
        )
        if expected_structure != locked.structure_generation:
            return JsonResponse({"error": "book_structure_conflict"}, status=409)
        if expected_planner != locked.planner_generation:
            return JsonResponse({"error": "planner_update_conflict"}, status=409)
        parent = None
        if parent_public_id is not None:
            parent = ManuscriptItem.objects.filter(
                manuscript=locked,
                public_id=parent_public_id,
                kind=ManuscriptItem.KIND_FOLDER,
                trashed_at__isnull=True,
            ).select_related("parent").first()
            if parent is None:
                return JsonResponse({"error": "book_parent_not_found"}, status=400)
        try:
            create_book_item(
                manuscript=locked,
                parent=parent,
                kind=kind,
                title=title,
                planner_role=role,
            )
        except InvalidStructure as exc:
            return JsonResponse({"error": exc.code}, status=400)
        Manuscript.objects.filter(id=locked.id).update(
            planner_generation=F("planner_generation") + 1
        )
    manuscript.refresh_from_db()
    return JsonResponse({"planner": planner_payload(manuscript, today=today)}, status=201)


@require_http_methods(["PATCH"])
def planner_item_detail(request, item_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    item = (
        ManuscriptItem.objects.filter(
            public_id=item_id,
            manuscript__workspace__owner=request.user,
            trashed_at__isnull=True,
        )
        .select_related("manuscript__workspace")
        .first()
    )
    if item is None:
        return JsonResponse({"error": "book_item_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    title = str(payload.get("title") or "").strip()
    synopsis = str(payload.get("synopsis") or "").strip()
    role = payload.get("role")
    deadline_value = payload.get("deadline")
    deadline = parse_date(deadline_value) if isinstance(deadline_value, str) else None
    status_public_id = _public_id(payload.get("statusId")) if payload.get("statusId") else None
    if not title or len(title) > MAX_ITEM_TITLE_LENGTH:
        return JsonResponse({"error": "planner_item_title_invalid"}, status=400)
    if len(synopsis) > MAX_ITEM_SYNOPSIS_LENGTH:
        return JsonResponse({"error": "planner_item_synopsis_too_long"}, status=400)
    if not _validate_role(role, item.kind):
        return JsonResponse({"error": "planner_item_role_invalid"}, status=400)
    if role == "act" and item.parent_id is not None:
        return JsonResponse({"error": "planner_act_must_be_root"}, status=400)
    if deadline_value is not None and deadline is None:
        return JsonResponse({"error": "planner_deadline_invalid"}, status=400)
    try:
        word_goal = _word_goal(payload.get("wordGoal"), "planner_item_goal_invalid")
        today = local_date(payload.get("timezone", "UTC"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    with transaction.atomic():
        manuscript = Manuscript.objects.select_for_update().select_related("workspace").get(
            id=item.manuscript_id
        )
        if payload.get("expectedStructureGeneration") != manuscript.structure_generation:
            return JsonResponse({"error": "book_structure_conflict"}, status=409)
        if payload.get("expectedPlannerGeneration") != manuscript.planner_generation:
            return JsonResponse({"error": "planner_update_conflict"}, status=409)
        item = ManuscriptItem.objects.select_for_update().select_related(
            "manuscript__workspace"
        ).get(id=item.id)
        status = None
        if status_public_id is not None:
            status = ManuscriptPlanStatus.objects.filter(
                manuscript=manuscript,
                public_id=status_public_id,
            ).first()
            if status is None:
                return JsonResponse({"error": "planner_status_not_found"}, status=400)
        metadata = item.planner_metadata
        previous_status_id = metadata.get("statusId")
        completed_date = metadata.get("completedDate")
        previous_status = ManuscriptPlanStatus.objects.filter(
            manuscript=manuscript,
            public_id=_public_id(previous_status_id),
        ).first() if previous_status_id else None
        if status and status.counts_as_complete:
            if not previous_status or not previous_status.counts_as_complete:
                completed_date = today.isoformat()
        else:
            completed_date = None
        old_title = item.title
        item.title = title
        item.planner_metadata = {
            "role": role,
            "synopsis": synopsis,
            "deadline": deadline.isoformat() if deadline else None,
            "wordGoal": word_goal,
            "statusId": str(status.public_id) if status else None,
            "completedDate": completed_date,
        }
        title_changed = title != old_title
        item.save(update_fields=["title", "planner_metadata", "updated_at"])
        if title_changed and manuscript.kind == Manuscript.KIND_ONESHOT:
            manuscript.title = title
            manuscript.save(update_fields=["title", "updated_at"])
        updates = {
            "planner_generation": F("planner_generation") + 1,
            "updated_at": timezone.now(),
        }
        if title_changed:
            updates["structure_generation"] = F("structure_generation") + 1
        Manuscript.objects.filter(id=manuscript.id).update(**updates)
        write_audit_event(
            request,
            "manuscript.plan_item_updated",
            actor=request.user,
            subject=f"manuscript-item:{item.public_id}",
            payload={"kind": item.kind, "role": role},
        )
    manuscript.refresh_from_db()
    return JsonResponse({"planner": planner_payload(manuscript, today=today)})


@require_http_methods(["POST"])
def planner_tasks(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        title, description, deadline, priority, associated_item, pinned = _task_fields(
            payload, manuscript
        )
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    task = ManuscriptTask(
        manuscript=manuscript,
        associated_item=associated_item,
        priority=priority,
        is_pinned=pinned,
    )
    task.content = {
        "title": title,
        "description": description,
        "deadline": deadline.isoformat() if deadline else None,
    }
    task.save()
    write_audit_event(
        request,
        "manuscript.task_created",
        actor=request.user,
        subject=f"manuscript-task:{task.public_id}",
        payload={"kind": manuscript.kind},
    )
    return JsonResponse({"task": _task_payload(task)}, status=201)


@require_http_methods(["PATCH", "DELETE"])
def planner_task_detail(request, task_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    task = (
        ManuscriptTask.objects.filter(
            public_id=task_id,
            manuscript__workspace__owner=request.user,
        )
        .select_related("manuscript__workspace", "associated_item")
        .first()
    )
    if task is None:
        return JsonResponse({"error": "planner_task_not_found"}, status=404)
    if request.method == "DELETE":
        manuscript_kind = task.manuscript.kind
        task.delete()
        write_audit_event(
            request,
            "manuscript.task_deleted",
            actor=request.user,
            subject=f"manuscript-task:{task_id}",
            payload={"kind": manuscript_kind},
        )
        return JsonResponse({"deleted": True})

    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    update_fields = []
    if "completed" in payload:
        if not isinstance(payload["completed"], bool):
            return JsonResponse({"error": "planner_task_completed_invalid"}, status=400)
        task.completed_at = timezone.now() if payload["completed"] else None
        update_fields.append("completed_at")
    editable_keys = {"title", "description", "deadline", "priority", "associatedItemId", "pinned"}
    if editable_keys.intersection(payload):
        if not editable_keys.issubset(payload):
            return JsonResponse({"error": "planner_task_fields_invalid"}, status=400)
        try:
            title, description, deadline, priority, associated_item, pinned = _task_fields(
                payload, task.manuscript
            )
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        task.content = {
            "title": title,
            "description": description,
            "deadline": deadline.isoformat() if deadline else None,
        }
        task.priority = priority
        task.associated_item = associated_item
        task.is_pinned = pinned
        update_fields.extend(["content", "priority", "associated_item", "is_pinned"])
    if not update_fields or set(payload) - (editable_keys | {"completed"}):
        return JsonResponse({"error": "planner_task_fields_invalid"}, status=400)
    update_fields.append("updated_at")
    task.save(update_fields=update_fields)
    write_audit_event(
        request,
        "manuscript.task_updated",
        actor=request.user,
        subject=f"manuscript-task:{task.public_id}",
        payload={"kind": task.manuscript.kind},
    )
    return JsonResponse({"task": _task_payload(task)})


@require_http_methods(["PATCH"])
def planner_statuses(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    payload = _read_json(request)
    status_items = payload.get("statuses") if payload else None
    if not isinstance(status_items, list) or len(status_items) > MAX_STATUS_COUNT:
        return JsonResponse({"error": "planner_statuses_invalid"}, status=400)
    normalized = []
    names = set()
    for position, candidate in enumerate(status_items, start=1):
        if not isinstance(candidate, dict):
            return JsonResponse({"error": "planner_statuses_invalid"}, status=400)
        name = str(candidate.get("name") or "").strip()
        color = candidate.get("color")
        if not name or len(name) > MAX_STATUS_NAME_LENGTH or name.casefold() in names:
            return JsonResponse({"error": "planner_status_name_invalid"}, status=400)
        valid_color = isinstance(color, str) and (
            color in STATUS_COLORS or bool(re.fullmatch(r"#[0-9a-fA-F]{6}", color))
        )
        if not valid_color or not isinstance(candidate.get("countsAsComplete"), bool):
            return JsonResponse({"error": "planner_statuses_invalid"}, status=400)
        names.add(name.casefold())
        candidate_id = _public_id(candidate.get("id")) if candidate.get("id") else None
        if candidate.get("id") and candidate_id is None:
            return JsonResponse({"error": "planner_status_not_found"}, status=400)
        normalized.append(
            {
                "id": candidate_id,
                "name": name,
                "color": color.lower() if color.startswith("#") else color,
                "position": position * 1024,
                "complete": candidate["countsAsComplete"],
            }
        )
    try:
        today = local_date(payload.get("timezone", "UTC"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    with transaction.atomic():
        manuscript = Manuscript.objects.select_for_update().select_related("workspace").get(
            id=manuscript.id
        )
        if payload.get("expectedPlannerGeneration") != manuscript.planner_generation:
            return JsonResponse({"error": "planner_update_conflict"}, status=409)
        existing = {
            status.public_id: status
            for status in ManuscriptPlanStatus.objects.filter(manuscript=manuscript)
        }
        kept_ids = set()
        for candidate in normalized:
            status = existing.get(candidate["id"]) if candidate["id"] else None
            if candidate["id"] and status is None:
                return JsonResponse({"error": "planner_status_not_found"}, status=400)
            if status is None:
                status = ManuscriptPlanStatus(manuscript=manuscript)
            status.name = candidate["name"]
            status.color = candidate["color"]
            status.position = candidate["position"]
            status.counts_as_complete = candidate["complete"]
            status.save()
            kept_ids.add(status.public_id)
        deleted_ids = set(existing) - kept_ids
        resulting_statuses = {
            str(status.public_id): status
            for status in ManuscriptPlanStatus.objects.filter(
                manuscript=manuscript,
                public_id__in=kept_ids,
            )
        }
        for item in ManuscriptItem.objects.filter(manuscript=manuscript).select_related(
            "manuscript__workspace"
        ):
            metadata = item.planner_metadata
            status = resulting_statuses.get(metadata.get("statusId"))
            changed = False
            if metadata.get("statusId") and status is None:
                metadata["statusId"] = None
                metadata["completedDate"] = None
                changed = True
            elif status and status.counts_as_complete and not metadata.get("completedDate"):
                metadata["completedDate"] = today.isoformat()
                changed = True
            elif status and not status.counts_as_complete and metadata.get("completedDate"):
                metadata["completedDate"] = None
                changed = True
            if changed:
                item.planner_metadata = metadata
                item.save(update_fields=["planner_metadata", "updated_at"])
        if deleted_ids:
            ManuscriptPlanStatus.objects.filter(
                manuscript=manuscript,
                public_id__in=deleted_ids,
            ).delete()
        Manuscript.objects.filter(id=manuscript.id).update(
            planner_generation=F("planner_generation") + 1,
            plan_statuses_initialized=True,
            updated_at=timezone.now(),
        )
    manuscript.refresh_from_db()
    return JsonResponse({"planner": planner_payload(manuscript, today=today)})
