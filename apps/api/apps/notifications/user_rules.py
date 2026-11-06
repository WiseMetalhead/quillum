from __future__ import annotations

import logging
from datetime import date
from zoneinfo import ZoneInfo

from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date

from apps.manuscripts.models import (
    Document,
    Manuscript,
    ManuscriptItem,
    ManuscriptPlanStatus,
    ManuscriptTask,
    ManuscriptWritingDay,
)
from apps.manuscripts.versioning import document_statistics

from .models import Notification, NotificationRule
from .scheduling import next_rule_run
from .service import create_notification

logger = logging.getLogger(__name__)
EXCERPT_LENGTH = 240


def _selected_manuscripts(rule: NotificationRule):
    return (
        rule.manuscripts.filter(workspace__owner=rule.user, drawer_at__isnull=True)
        .filter(
            Q(series_membership__isnull=True) | Q(series_membership__series__drawer_at__isnull=True)
        )
        .select_related("workspace")
        .distinct()
    )


def _date(value) -> date | None:
    return parse_date(value) if isinstance(value, str) else None


def _notify(
    rule: NotificationRule,
    *,
    kind: str,
    payload: dict,
    deduplication_key: str,
) -> bool:
    _notification, created = create_notification(
        recipient=rule.user,
        category=Notification.CATEGORY_USER,
        kind=kind,
        payload=payload,
        deduplication_key=deduplication_key,
        email=rule.email_enabled,
    )
    return created


def _complete_status_ids(manuscript: Manuscript) -> set[str]:
    return {
        str(value)
        for value in ManuscriptPlanStatus.objects.filter(
            manuscript=manuscript,
            counts_as_complete=True,
        ).values_list("public_id", flat=True)
    }


def _manuscript_deadlines(rule: NotificationRule, today: date) -> int:
    created = 0
    checkpoints = set(rule.checkpoints)
    for manuscript in _selected_manuscripts(rule):
        deadline = _date(manuscript.planner_settings.get("deadline"))
        if deadline is None:
            continue
        days = (deadline - today).days
        if days not in checkpoints:
            continue
        created += int(
            _notify(
                rule,
                kind=NotificationRule.KIND_MANUSCRIPT_DEADLINE,
                payload={
                    "manuscriptId": str(manuscript.public_id),
                    "manuscriptTitle": manuscript.title,
                    "deadline": deadline.isoformat(),
                    "daysRemaining": days,
                    "actionPath": f"/manuscripts/{manuscript.public_id}/planner?workspace=author",
                },
                deduplication_key=(
                    f"user-manuscript-deadline:{rule.id}:{manuscript.id}:"
                    f"{deadline.isoformat()}:{days}"
                ),
            )
        )
    return created


def _item_deadlines(rule: NotificationRule, today: date) -> int:
    created = 0
    checkpoints = set(rule.checkpoints)
    for manuscript in _selected_manuscripts(rule):
        complete_ids = _complete_status_ids(manuscript)
        items = ManuscriptItem.objects.filter(
            manuscript=manuscript,
            trashed_at__isnull=True,
        ).select_related("manuscript__workspace")
        for item in items.iterator():
            metadata = item.planner_metadata
            if metadata.get("statusId") in complete_ids:
                continue
            deadline = _date(metadata.get("deadline"))
            if deadline is None:
                continue
            days = (deadline - today).days
            if days not in checkpoints:
                continue
            created += int(
                _notify(
                    rule,
                    kind=NotificationRule.KIND_ITEM_DEADLINE,
                    payload={
                        "manuscriptId": str(manuscript.public_id),
                        "manuscriptTitle": manuscript.title,
                        "itemId": str(item.public_id),
                        "itemTitle": item.title,
                        "deadline": deadline.isoformat(),
                        "daysRemaining": days,
                        "actionPath": (
                            f"/manuscripts/{manuscript.public_id}/planner?workspace=author"
                        ),
                    },
                    deduplication_key=(
                        f"user-item-deadline:{rule.id}:{item.id}:{deadline.isoformat()}:{days}"
                    ),
                )
            )
    return created


def _task_deadlines(rule: NotificationRule, today: date) -> int:
    created = 0
    checkpoints = set(rule.checkpoints)
    for manuscript in _selected_manuscripts(rule):
        tasks = ManuscriptTask.objects.filter(
            manuscript=manuscript,
            completed_at__isnull=True,
        ).select_related("manuscript__workspace")
        for task in tasks.iterator():
            content = task.content
            deadline = _date(content.get("deadline"))
            if deadline is None:
                continue
            days = (deadline - today).days
            if days not in checkpoints:
                continue
            created += int(
                _notify(
                    rule,
                    kind=NotificationRule.KIND_TASK_DEADLINE,
                    payload={
                        "manuscriptId": str(manuscript.public_id),
                        "manuscriptTitle": manuscript.title,
                        "taskId": str(task.public_id),
                        "taskTitle": str(content.get("title", "")),
                        "deadline": deadline.isoformat(),
                        "daysRemaining": days,
                        "actionPath": (
                            f"/manuscripts/{manuscript.public_id}/planner?workspace=author"
                        ),
                    },
                    deduplication_key=(
                        f"user-task-deadline:{rule.id}:{task.id}:{deadline.isoformat()}:{days}"
                    ),
                )
            )
    return created


def _daily_goals(rule: NotificationRule, today: date) -> int:
    created = 0
    for manuscript in _selected_manuscripts(rule):
        goal = int(manuscript.planner_settings.get("dailyWordGoal") or 0)
        if goal <= 0:
            continue
        written = (
            ManuscriptWritingDay.objects.filter(manuscript=manuscript, date=today)
            .values_list("words_written", flat=True)
            .first()
            or 0
        )
        created += int(
            _notify(
                rule,
                kind=NotificationRule.KIND_DAILY_GOAL,
                payload={
                    "manuscriptId": str(manuscript.public_id),
                    "manuscriptTitle": manuscript.title,
                    "goalWords": goal,
                    "writtenWords": written,
                    "completed": written >= goal,
                    "date": today.isoformat(),
                    "actionPath": f"/manuscripts/{manuscript.public_id}?workspace=author",
                },
                deduplication_key=f"user-daily-goal:{rule.id}:{manuscript.id}:{today}",
            )
        )
    return created


def _active_documents(manuscript: Manuscript):
    return (
        Document.objects.filter(manuscript=manuscript)
        .filter(Q(item__isnull=True) | Q(item__trashed_at__isnull=True))
        .select_related("item", "manuscript__workspace")
    )


def _digest(rule: NotificationRule, today: date) -> int:
    from apps.manuscripts.views import manuscript_lifecycle_status

    created = 0
    for manuscript in _selected_manuscripts(rule).prefetch_related("plan_statuses"):
        if manuscript_lifecycle_status(manuscript) != "in_progress":
            continue
        settings = manuscript.planner_settings
        total_words = sum(
            document_statistics(document.content)[0] for document in _active_documents(manuscript)
        )
        word_goal = int(settings.get("manuscriptWordGoal") or 0)
        statuses = list(manuscript.plan_statuses.all().order_by("position", "created_at"))
        status_by_id = {str(status.public_id): status for status in statuses}
        status_counts = {str(status.public_id): 0 for status in statuses}
        status_counts[""] = 0
        complete_ids = {
            status_id for status_id, status in status_by_id.items() if status.counts_as_complete
        }
        deadlines = []
        manuscript_deadline = _date(settings.get("deadline"))
        if manuscript_deadline is not None and 0 <= (manuscript_deadline - today).days <= 30:
            deadlines.append(
                {
                    "kind": "manuscript",
                    "title": manuscript.title,
                    "date": manuscript_deadline.isoformat(),
                }
            )
        items = ManuscriptItem.objects.filter(
            manuscript=manuscript,
            trashed_at__isnull=True,
        ).select_related("manuscript__workspace")
        for item in items.iterator():
            metadata = item.planner_metadata
            status_id = str(metadata.get("statusId") or "")
            status_counts[status_id if status_id in status_counts else ""] += 1
            if status_id in complete_ids:
                continue
            deadline = _date(metadata.get("deadline"))
            if deadline is not None and 0 <= (deadline - today).days <= 30:
                deadlines.append(
                    {
                        "kind": "item",
                        "id": str(item.public_id),
                        "title": item.title,
                        "date": deadline.isoformat(),
                    }
                )
        tasks = []
        task_rows = ManuscriptTask.objects.filter(
            manuscript=manuscript,
            completed_at__isnull=True,
        ).select_related("manuscript__workspace")
        for task in task_rows.iterator():
            content = task.content
            deadline = _date(content.get("deadline"))
            if deadline is not None and 0 <= (deadline - today).days <= 10:
                tasks.append(
                    {
                        "id": str(task.public_id),
                        "title": str(content.get("title", "")),
                        "date": deadline.isoformat(),
                    }
                )
        deadlines.sort(key=lambda item: (item["date"], item["title"]))
        tasks.sort(key=lambda item: (item["date"], item["title"]))
        status_breakdown = [
            {
                "id": status_id or None,
                "name": status_by_id[status_id].name if status_id else "",
                "color": status_by_id[status_id].color if status_id else "gray",
                "count": count,
            }
            for status_id, count in status_counts.items()
            if count
        ]
        created += int(
            _notify(
                rule,
                kind=NotificationRule.KIND_MANUSCRIPT_DIGEST,
                payload={
                    "manuscriptId": str(manuscript.public_id),
                    "manuscriptTitle": manuscript.title,
                    "date": today.isoformat(),
                    "totalWords": total_words,
                    "wordGoal": word_goal,
                    "statusBreakdown": status_breakdown,
                    "deadlines": deadlines[:5],
                    "remainingDeadlines": max(len(deadlines) - 5, 0),
                    "tasks": tasks[:5],
                    "remainingTasks": max(len(tasks) - 5, 0),
                    "actionPath": f"/manuscripts/{manuscript.public_id}?workspace=author",
                },
                deduplication_key=f"user-manuscript-digest:{rule.id}:{manuscript.id}:{today}",
            )
        )
    return created


PROCESSORS = {
    NotificationRule.KIND_MANUSCRIPT_DEADLINE: _manuscript_deadlines,
    NotificationRule.KIND_ITEM_DEADLINE: _item_deadlines,
    NotificationRule.KIND_TASK_DEADLINE: _task_deadlines,
    NotificationRule.KIND_DAILY_GOAL: _daily_goals,
    NotificationRule.KIND_MANUSCRIPT_DIGEST: _digest,
}


def process_timed_rule(rule: NotificationRule, *, now=None) -> int:
    now = now or timezone.now()
    local_today = now.astimezone(ZoneInfo(rule.user.timezone)).date()
    if rule.last_processed_local_date == local_today:
        return 0
    processor = PROCESSORS.get(rule.kind)
    if processor is None:
        return 0
    created = processor(rule, local_today)
    NotificationRule.objects.filter(id=rule.id, enabled=True).update(
        last_processed_local_date=local_today,
        next_run_at=next_rule_run(rule, after=now),
        updated_at=timezone.now(),
    )
    return created


def _excerpt(value: str) -> str:
    normalized = " ".join(value.split())
    return (
        normalized if len(normalized) <= EXCERPT_LENGTH else f"{normalized[: EXCERPT_LENGTH - 1]}…"
    )


def notify_public_review_comment(*, annotation, reply=None) -> None:
    manuscript = annotation.document.manuscript
    rule = (
        NotificationRule.objects.filter(
            user=manuscript.workspace.owner,
            kind=NotificationRule.KIND_REVIEW_COMMENT,
            enabled=True,
            manuscripts=manuscript,
        )
        .select_related("user")
        .first()
    )
    if rule is None:
        return
    source = reply or annotation
    body = reply.body if reply is not None else annotation.comment
    guest_name = (
        source.guest_author.display_name.strip()
        if source.guest_author_id and source.guest_author is not None
        else ""
    )
    item_id = annotation.document.item.public_id if annotation.document.item_id else None
    parameters = f"inspector=comments&annotation={annotation.public_id}"
    if item_id is not None:
        parameters = f"item={item_id}&{parameters}"
    try:
        _notify(
            rule,
            kind=NotificationRule.KIND_REVIEW_COMMENT,
            payload={
                "manuscriptId": str(manuscript.public_id),
                "manuscriptTitle": manuscript.title,
                "documentId": str(annotation.document.public_id),
                "itemId": str(item_id) if item_id is not None else None,
                "annotationId": str(annotation.public_id),
                "replyId": str(reply.public_id) if reply is not None else None,
                "guestName": guest_name,
                "excerpt": _excerpt(body),
                "isReply": reply is not None,
                "actionPath": (
                    f"/manuscripts/{manuscript.public_id}/editor?{parameters}&workspace=author"
                ),
            },
            deduplication_key=f"user-review-comment:{rule.id}:{source.public_id}",
        )
    except Exception:
        logger.exception(
            "Unable to create Public Review notification annotation_id=%s",
            annotation.id,
        )


def reschedule_user_rules(user) -> None:
    rules = NotificationRule.objects.filter(user=user, enabled=True).select_related("user")
    for rule in rules:
        rule.next_run_at = next_rule_run(rule)
        rule.save(update_fields=["next_run_at", "updated_at"])
