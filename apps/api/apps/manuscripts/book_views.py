from __future__ import annotations

import json

from django.db import transaction
from django.db.models import F
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from apps.accounts.tier_progression import record_tier_activity
from apps.accounts.tiers import quota_violation
from apps.audit.service import write_audit_event

from .metadata import (
    InvalidManuscriptMetadata,
    normalize_manuscript_genres,
    normalize_manuscript_language,
)
from .models import Document, Manuscript, ManuscriptItem
from .quotas import (
    quota_response,
)
from .services import (
    MAX_FOLDER_DEPTH,
    InvalidStructure,
    create_book,
    create_book_item,
    create_imported_book,
    restore_book_item,
    trash_book_item,
)
from .text_import import InvalidTextImport, parse_import_plan
from .versioning import document_statistics
from .views import (
    SYNOPSIS_MAX_LENGTH,
    TITLE_MAX_LENGTH,
    _cover_media_from_request,
    manuscript_payload,
)


def _read_json(request):
    try:
        value = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _book_for_owner(manuscript_id: int, user):
    return (
        Manuscript.objects.filter(
            id=manuscript_id,
            workspace__owner=user,
            kind=Manuscript.KIND_BOOK,
        )
        .select_related("workspace")
        .prefetch_related("documents")
        .first()
    )


def item_payload(
    item: ManuscriptItem,
    statistics: dict[int, tuple[int, int]] | None = None,
) -> dict:
    word_count, character_count = (statistics or {}).get(item.id, (0, 0))
    return {
        "id": str(item.public_id),
        "parentId": str(item.parent.public_id) if item.parent_id else None,
        "kind": item.kind,
        "title": item.title,
        "position": item.position,
        "wordCount": word_count,
        "characterCount": character_count,
        "trashedAt": item.trashed_at.isoformat() if item.trashed_at else None,
        "createdAt": item.created_at.isoformat(),
        "updatedAt": item.updated_at.isoformat(),
    }


def tree_payload(manuscript: Manuscript) -> dict:
    items = list(
        ManuscriptItem.objects.filter(manuscript=manuscript)
        .select_related("manuscript__workspace", "parent")
        .order_by("position", "created_at")
    )
    active_items = [item for item in items if item.trashed_at is None]
    direct_statistics = {
        document.item_id: document_statistics(document.content)
        for document in Document.objects.filter(
            manuscript=manuscript,
            item__trashed_at__isnull=True,
        ).select_related("manuscript__workspace")
        if document.item_id is not None
    }
    children: dict[int, list[int]] = {}
    for item in active_items:
        if item.parent_id is not None:
            children.setdefault(item.parent_id, []).append(item.id)

    statistics: dict[int, tuple[int, int]] = {}

    def aggregate(item_id: int) -> tuple[int, int]:
        if item_id in statistics:
            return statistics[item_id]
        word_count, character_count = direct_statistics.get(item_id, (0, 0))
        for child_id in children.get(item_id, []):
            child_words, child_characters = aggregate(child_id)
            word_count += child_words
            character_count += child_characters
        statistics[item_id] = (word_count, character_count)
        return statistics[item_id]

    for item in active_items:
        aggregate(item.id)

    active = [item_payload(item, statistics) for item in active_items]
    trash = [
        item_payload(item)
        for item in items
        if item.trashed_at is not None and item.previous_position is not None
    ]
    return {
        "items": active,
        "trash": trash,
        "structureGeneration": manuscript.structure_generation,
        "maxFolderDepth": MAX_FOLDER_DEPTH,
    }


def _descendant_ids(item: ManuscriptItem) -> set[int]:
    items = list(ManuscriptItem.objects.filter(manuscript_id=item.manuscript_id))
    children: dict[int, list[int]] = {}
    for candidate in items:
        if candidate.parent_id is not None:
            children.setdefault(candidate.parent_id, []).append(candidate.id)
    result: set[int] = set()
    pending = list(children.get(item.id, []))
    while pending:
        candidate_id = pending.pop()
        result.add(candidate_id)
        pending.extend(children.get(candidate_id, []))
    return result


def _folder_depth(item: ManuscriptItem | None) -> int:
    depth = 0
    current = item
    while current is not None:
        if current.kind == ManuscriptItem.KIND_FOLDER:
            depth += 1
        current = current.parent
    return depth


def _subtree_folder_height(item: ManuscriptItem) -> int:
    items = list(
        ManuscriptItem.objects.filter(manuscript_id=item.manuscript_id, trashed_at__isnull=True)
    )
    children: dict[int, list[ManuscriptItem]] = {}
    for candidate in items:
        if candidate.parent_id is not None:
            children.setdefault(candidate.parent_id, []).append(candidate)

    def height(candidate: ManuscriptItem) -> int:
        own = 1 if candidate.kind == ManuscriptItem.KIND_FOLDER else 0
        descendants = children.get(candidate.id, [])
        return own + (max((height(child) for child in descendants), default=0))

    return height(item)


def _move_item(item: ManuscriptItem, parent: ManuscriptItem | None, before: ManuscriptItem | None):
    planner_role = item.planner_metadata.get("role", "untyped")
    if planner_role == "act" and parent is not None:
        raise InvalidStructure("planner_act_must_be_root")
    if planner_role == "scene" and parent is None:
        raise InvalidStructure("planner_scene_parent_required")
    if parent is not None and (
        parent.kind != ManuscriptItem.KIND_FOLDER or parent.trashed_at is not None
    ):
        raise InvalidStructure("book_parent_invalid")
    descendants = _descendant_ids(item)
    if parent is not None and (parent.id == item.id or parent.id in descendants):
        raise InvalidStructure("book_move_cycle")
    if _folder_depth(parent) + _subtree_folder_height(item) > MAX_FOLDER_DEPTH:
        raise InvalidStructure("book_max_depth_exceeded")
    if before is not None and (
        before.parent_id != (parent.id if parent else None) or before.id == item.id
    ):
        raise InvalidStructure("book_before_invalid")
    siblings = list(
        ManuscriptItem.objects.filter(
            manuscript_id=item.manuscript_id,
            parent=parent,
            trashed_at__isnull=True,
        )
        .exclude(id=item.id)
        .order_by("position", "created_at")
    )
    index = siblings.index(before) if before in siblings else len(siblings)
    siblings.insert(index, item)
    item.parent = parent
    for position, sibling in enumerate(siblings, start=1):
        ManuscriptItem.objects.filter(id=sibling.id).update(
            parent=parent if sibling.id == item.id else sibling.parent,
            position=position * ManuscriptItem.POSITION_STEP,
            updated_at=timezone.now(),
        )


@require_http_methods(["GET", "POST"])
def books(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if request.method == "GET":
        manuscripts = (
            Manuscript.objects.filter(
                workspace__owner=request.user,
                kind=Manuscript.KIND_BOOK,
                series_membership__isnull=True,
                drawer_at__isnull=True,
            )
            .select_related("workspace")
            .prefetch_related("documents")
            .order_by("-updated_at")
        )
        return JsonResponse({"items": [manuscript_payload(item) for item in manuscripts]})

    if request.content_type and request.content_type.startswith("multipart/form-data"):
        payload = request.POST
    else:
        payload = _read_json(request)
        if payload is None:
            return JsonResponse({"error": "invalid_json"}, status=400)
    title = str(payload.get("title") or "").strip()
    synopsis = str(payload.get("synopsis") or "").strip()
    template = payload.get("template")
    if not title:
        return JsonResponse({"error": "book_title_required"}, status=400)
    if len(title) > TITLE_MAX_LENGTH:
        return JsonResponse({"error": "book_title_too_long"}, status=400)
    if len(synopsis) > SYNOPSIS_MAX_LENGTH:
        return JsonResponse({"error": "book_synopsis_too_long"}, status=400)
    try:
        manuscript_language = normalize_manuscript_language(payload.get("language"))
        genres = normalize_manuscript_genres(payload.get("genres"))
    except InvalidManuscriptMetadata as exc:
        return JsonResponse({"error": exc.code}, status=400)
    violation = quota_violation(request.user, "books")
    if violation is not None:
        return quota_response(violation)
    cover, error = _cover_media_from_request(request)
    if error is not None:
        return error
    raw_import_manifest = payload.get("importManifest")
    try:
        if raw_import_manifest:
            import_plan = parse_import_plan(
                str(raw_import_manifest),
                request.FILES,
                kind="book",
            )
            manuscript = create_imported_book(
                user=request.user,
                title=title,
                synopsis=synopsis,
                cover=cover,
                import_plan=import_plan,
                language=manuscript_language,
                genres=genres,
            )
        else:
            manuscript = create_book(
                user=request.user,
                title=title,
                synopsis=synopsis,
                template=template,
                cover=cover,
                language=request.user.language,
                manuscript_language=manuscript_language,
                genres=genres,
            )
    except (InvalidStructure, InvalidTextImport) as exc:
        return JsonResponse({"error": exc.code}, status=400)
    manuscript = _book_for_owner(manuscript.id, request.user)
    write_audit_event(
        request,
        "manuscript.book_created",
        actor=request.user,
        subject=f"manuscript:{manuscript.public_id}",
        payload={
            "kind": manuscript.kind,
            "template": template if not raw_import_manifest else None,
            "imported": bool(raw_import_manifest),
        },
    )
    return JsonResponse({"manuscript": manuscript_payload(manuscript)}, status=201)


@require_http_methods(["GET", "PATCH"])
def book_detail(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _book_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if request.method == "PATCH":
        payload = _read_json(request)
        if payload is None or set(payload) != {"title"}:
            return JsonResponse({"error": "book_update_invalid"}, status=400)
        title = str(payload["title"] or "").strip()
        if not title:
            return JsonResponse({"error": "book_title_required"}, status=400)
        if len(title) > TITLE_MAX_LENGTH:
            return JsonResponse({"error": "book_title_too_long"}, status=400)
        manuscript.title = title
        manuscript.save(update_fields=["title", "updated_at"])
    return JsonResponse({"manuscript": manuscript_payload(manuscript)})


@require_http_methods(["GET", "POST"])
def book_tree(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _book_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if request.method == "GET":
        return JsonResponse({"tree": tree_payload(manuscript)})
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    title = str(payload.get("title") or "").strip()
    kind = payload.get("kind")
    parent_id = payload.get("parentId")
    expected = payload.get("expectedStructureGeneration")
    if not title or len(title) > TITLE_MAX_LENGTH:
        return JsonResponse({"error": "book_item_title_invalid"}, status=400)
    with transaction.atomic():
        locked = Manuscript.objects.select_for_update().get(id=manuscript.id)
        if expected != locked.structure_generation:
            return JsonResponse(
                {
                    "error": "book_structure_conflict",
                    "structureGeneration": locked.structure_generation,
                },
                status=409,
            )
        parent = None
        if parent_id:
            parent = (
                ManuscriptItem.objects.filter(manuscript=locked, public_id=parent_id)
                .select_related("parent")
                .first()
            )
            if parent is None:
                return JsonResponse({"error": "book_parent_not_found"}, status=400)
        try:
            item = create_book_item(
                manuscript=locked,
                parent=parent,
                kind=kind,
                title=title,
            )
        except InvalidStructure as exc:
            return JsonResponse({"error": exc.code}, status=400)
    manuscript.refresh_from_db()
    write_audit_event(
        request,
        "manuscript.book_item_created",
        actor=request.user,
        subject=f"manuscript-item:{item.public_id}",
        payload={
            "manuscriptId": str(manuscript.public_id),
            "kind": item.kind,
        },
    )
    return JsonResponse(
        {"item": item_payload(item), "structureGeneration": manuscript.structure_generation},
        status=201,
    )


@require_http_methods(["PATCH", "DELETE"])
def book_item_detail(request, item_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    item = (
        ManuscriptItem.objects.filter(
            public_id=item_id,
            manuscript__workspace__owner=request.user,
            manuscript__kind=Manuscript.KIND_BOOK,
        )
        .select_related("manuscript__workspace", "parent", "previous_parent")
        .first()
    )
    if item is None:
        return JsonResponse({"error": "book_item_not_found"}, status=404)
    if request.method == "DELETE":
        if item.trashed_at is None or item.previous_position is None:
            return JsonResponse({"error": "book_item_not_trashed"}, status=400)
        item_public_id = str(item.public_id)
        item_kind = item.kind
        manuscript_public_id = str(item.manuscript.public_id)
        item.delete()
        Manuscript.objects.filter(id=item.manuscript_id).update(
            structure_generation=F("structure_generation") + 1,
            updated_at=timezone.now(),
        )
        write_audit_event(
            request,
            "manuscript.book_item_permanently_deleted",
            actor=request.user,
            subject=f"manuscript-item:{item_public_id}",
            payload={
                "manuscriptId": manuscript_public_id,
                "kind": item_kind,
            },
        )
        return JsonResponse({})

    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    expected = payload.get("expectedStructureGeneration")
    action = payload.get("action")
    audit_payload = None
    with transaction.atomic():
        manuscript = Manuscript.objects.select_for_update().get(id=item.manuscript_id)
        if expected != manuscript.structure_generation:
            return JsonResponse(
                {
                    "error": "book_structure_conflict",
                    "structureGeneration": manuscript.structure_generation,
                },
                status=409,
            )
        if action == "trash":
            audit_payload = {
                "manuscriptId": str(manuscript.public_id),
                "kind": item.kind,
            }
            trash_book_item(item)
        elif action == "restore":
            if item.previous_position is None:
                return JsonResponse({"error": "book_item_not_trash_root"}, status=400)
            try:
                restore_book_item(item)
            except InvalidStructure as exc:
                return JsonResponse({"error": exc.code}, status=400)
        elif action == "rename":
            title = str(payload.get("title") or "").strip()
            if not title or len(title) > TITLE_MAX_LENGTH or item.trashed_at is not None:
                return JsonResponse({"error": "book_item_title_invalid"}, status=400)
            item.title = title
            item.save(update_fields=["title", "updated_at"])
            Manuscript.objects.filter(id=manuscript.id).update(
                structure_generation=F("structure_generation") + 1,
                updated_at=timezone.now(),
            )
        elif action == "move":
            if item.trashed_at is not None:
                return JsonResponse({"error": "book_item_trashed"}, status=400)
            parent_id = payload.get("parentId")
            before_id = payload.get("beforeId")
            parent = None
            before = None
            if parent_id:
                parent = (
                    ManuscriptItem.objects.filter(manuscript=manuscript, public_id=parent_id)
                    .select_related("parent")
                    .first()
                )
                if parent is None:
                    return JsonResponse({"error": "book_parent_not_found"}, status=400)
            if before_id:
                before = ManuscriptItem.objects.filter(
                    manuscript=manuscript, public_id=before_id, trashed_at__isnull=True
                ).first()
                if before is None:
                    return JsonResponse({"error": "book_before_invalid"}, status=400)
            try:
                _move_item(item, parent, before)
            except InvalidStructure as exc:
                return JsonResponse({"error": exc.code}, status=400)
            Manuscript.objects.filter(id=manuscript.id).update(
                structure_generation=F("structure_generation") + 1,
                updated_at=timezone.now(),
            )
        else:
            return JsonResponse({"error": "book_item_action_invalid"}, status=400)
    manuscript.refresh_from_db()
    item.refresh_from_db()
    if action == "trash":
        write_audit_event(
            request,
            "manuscript.book_item_trashed",
            actor=request.user,
            subject=f"manuscript-item:{item.public_id}",
            payload=audit_payload,
        )
    else:
        record_tier_activity(request.user)
    return JsonResponse(
        {"item": item_payload(item), "structureGeneration": manuscript.structure_generation}
    )
