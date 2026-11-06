from __future__ import annotations

import json
from datetime import time
from uuid import UUID

from django.db import transaction
from django.db.models import Q
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from apps.manuscripts.models import Manuscript

from .models import NotificationRule
from .scheduling import TIMED_RULE_KINDS, next_rule_run

RULE_KINDS = tuple(value for value, _label in NotificationRule.KIND_CHOICES)
CHECKPOINT_DEFAULTS = {
    NotificationRule.KIND_MANUSCRIPT_DEADLINE: [100, 60, 30, 15, 5, 1],
    NotificationRule.KIND_ITEM_DEADLINE: [30, 15, 5, 1],
    NotificationRule.KIND_TASK_DEADLINE: [3, 1, 0],
}
CHECKPOINT_ALLOWED = {kind: set(values) for kind, values in CHECKPOINT_DEFAULTS.items()}


def active_manuscripts(user):
    return (
        Manuscript.objects.filter(workspace__owner=user, drawer_at__isnull=True)
        .filter(
            Q(series_membership__isnull=True) | Q(series_membership__series__drawer_at__isnull=True)
        )
        .select_related("workspace")
        .distinct()
        .order_by("-updated_at", "-id")
    )


def ensure_notification_rules(user) -> list[NotificationRule]:
    existing = {rule.kind: rule for rule in user.notification_rules.all()}
    missing = [
        NotificationRule(
            user=user,
            kind=kind,
            checkpoints=CHECKPOINT_DEFAULTS.get(kind, []),
        )
        for kind in RULE_KINDS
        if kind not in existing
    ]
    if missing:
        NotificationRule.objects.bulk_create(missing, ignore_conflicts=True)
    return list(
        NotificationRule.objects.filter(user=user).prefetch_related("manuscripts").order_by("id")
    )


def rule_payload(rule: NotificationRule, *, active_ids: set[UUID]) -> dict:
    return {
        "kind": rule.kind,
        "enabled": rule.enabled,
        "emailEnabled": rule.email_enabled,
        "time": rule.delivery_time.strftime("%H:%M") if rule.delivery_time else None,
        "weekdays": rule.weekdays,
        "checkpoints": rule.checkpoints,
        "manuscriptIds": [
            str(item.public_id) for item in rule.manuscripts.all() if item.public_id in active_ids
        ],
    }


def preferences_payload(user) -> dict:
    rules = ensure_notification_rules(user)
    manuscripts = list(active_manuscripts(user))
    active_ids = {manuscript.public_id for manuscript in manuscripts}
    return {
        "timezone": user.timezone,
        "rules": [rule_payload(rule, active_ids=active_ids) for rule in rules],
        "manuscripts": [
            {
                "id": str(manuscript.public_id),
                "title": manuscript.title,
                "kind": manuscript.kind,
            }
            for manuscript in manuscripts
        ],
    }


def _parse_time(value) -> time | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("notification_rule_time_invalid")
    try:
        parsed = time.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("notification_rule_time_invalid") from exc
    if parsed.tzinfo is not None or parsed.second or parsed.microsecond:
        raise ValueError("notification_rule_time_invalid")
    return parsed


def _uuid_list(value) -> list[UUID]:
    if not isinstance(value, list) or len(value) > 500:
        raise ValueError("notification_rule_manuscripts_invalid")
    try:
        return list(dict.fromkeys(UUID(str(item)) for item in value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("notification_rule_manuscripts_invalid") from exc


def _integer_list(value, *, error: str) -> list[int]:
    if not isinstance(value, list) or any(
        isinstance(item, bool) or not isinstance(item, int) for item in value
    ):
        raise ValueError(error)
    return sorted(set(value), reverse=True)


def _validate_rule(raw: object, manuscripts_by_id: dict[UUID, Manuscript]) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("notification_rule_invalid")
    kind = raw.get("kind")
    if kind not in RULE_KINDS:
        raise ValueError("notification_rule_kind_invalid")
    enabled = raw.get("enabled")
    email_enabled = raw.get("emailEnabled")
    if not isinstance(enabled, bool) or not isinstance(email_enabled, bool):
        raise ValueError("notification_rule_invalid")
    delivery_time = _parse_time(raw.get("time"))
    manuscript_ids = _uuid_list(raw.get("manuscriptIds"))
    if any(item_id not in manuscripts_by_id for item_id in manuscript_ids):
        raise ValueError("notification_rule_manuscripts_invalid")
    checkpoints = _integer_list(
        raw.get("checkpoints", []),
        error="notification_rule_checkpoints_invalid",
    )
    allowed_checkpoints = CHECKPOINT_ALLOWED.get(kind)
    if allowed_checkpoints is None:
        if checkpoints:
            raise ValueError("notification_rule_checkpoints_invalid")
    elif any(value not in allowed_checkpoints for value in checkpoints):
        raise ValueError("notification_rule_checkpoints_invalid")
    weekdays = _integer_list(
        raw.get("weekdays", []),
        error="notification_rule_weekdays_invalid",
    )
    if kind != NotificationRule.KIND_MANUSCRIPT_DIGEST and weekdays:
        raise ValueError("notification_rule_weekdays_invalid")
    if any(value < 0 or value > 6 for value in weekdays):
        raise ValueError("notification_rule_weekdays_invalid")
    if enabled:
        if not manuscript_ids:
            raise ValueError("notification_rule_manuscript_required")
        if kind in TIMED_RULE_KINDS and delivery_time is None:
            raise ValueError("notification_rule_time_required")
        if allowed_checkpoints is not None and not checkpoints:
            raise ValueError("notification_rule_checkpoint_required")
        if kind == NotificationRule.KIND_MANUSCRIPT_DIGEST and not weekdays:
            raise ValueError("notification_rule_weekday_required")
    return {
        "kind": kind,
        "enabled": enabled,
        "email_enabled": email_enabled,
        "delivery_time": delivery_time,
        "checkpoints": checkpoints,
        "weekdays": weekdays,
        "manuscript_ids": manuscript_ids,
    }


@require_http_methods(["GET", "PATCH"])
def notification_preferences(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if request.method == "GET":
        return JsonResponse({"preferences": preferences_payload(request.user)})
    try:
        payload = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "invalid_json"}, status=400)
    raw_rules = payload.get("rules") if isinstance(payload, dict) else None
    if not isinstance(raw_rules, list) or len(raw_rules) != len(RULE_KINDS):
        return JsonResponse({"error": "notification_rules_invalid"}, status=400)
    if len({item.get("kind") for item in raw_rules if isinstance(item, dict)}) != len(RULE_KINDS):
        return JsonResponse({"error": "notification_rules_invalid"}, status=400)
    manuscripts_by_id = {
        manuscript.public_id: manuscript for manuscript in active_manuscripts(request.user)
    }
    try:
        validated = [_validate_rule(item, manuscripts_by_id) for item in raw_rules]
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    with transaction.atomic():
        locked_rules = {
            rule.kind: rule
            for rule in NotificationRule.objects.select_for_update().filter(user=request.user)
        }
        for item in validated:
            rule = locked_rules.get(item["kind"])
            if rule is None:
                rule = NotificationRule(user=request.user, kind=item["kind"])
            was_enabled = rule.enabled
            rule.enabled = item["enabled"]
            rule.email_enabled = item["email_enabled"]
            rule.delivery_time = item["delivery_time"]
            rule.checkpoints = item["checkpoints"]
            rule.weekdays = item["weekdays"]
            if rule.enabled and not was_enabled:
                from django.utils import timezone

                rule.enabled_at = timezone.now()
                rule.last_processed_local_date = None
            elif not rule.enabled:
                rule.enabled_at = None
                rule.last_processed_local_date = None
            rule.save()
            rule.manuscripts.set([manuscripts_by_id[item_id] for item_id in item["manuscript_ids"]])
            rule.next_run_at = next_rule_run(rule)
            rule.save(update_fields=["next_run_at", "updated_at"])
    return JsonResponse({"preferences": preferences_payload(request.user)})
