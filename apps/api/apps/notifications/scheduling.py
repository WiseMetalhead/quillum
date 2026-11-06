from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from .models import NotificationRule

TIMED_RULE_KINDS = {
    NotificationRule.KIND_MANUSCRIPT_DEADLINE,
    NotificationRule.KIND_ITEM_DEADLINE,
    NotificationRule.KIND_TASK_DEADLINE,
    NotificationRule.KIND_DAILY_GOAL,
    NotificationRule.KIND_MANUSCRIPT_DIGEST,
}


def next_rule_run(rule: NotificationRule, *, after=None) -> datetime | None:
    if not rule.enabled or rule.kind not in TIMED_RULE_KINDS or rule.delivery_time is None:
        return None
    after = after or timezone.now()
    selected_timezone = ZoneInfo(rule.user.timezone)
    local_after = after.astimezone(selected_timezone)
    candidate_date = local_after.date()
    candidate = datetime.combine(
        candidate_date,
        rule.delivery_time,
        tzinfo=selected_timezone,
    )
    if candidate <= local_after:
        candidate_date += timedelta(days=1)
    if rule.kind == NotificationRule.KIND_MANUSCRIPT_DIGEST:
        weekdays = set(rule.weekdays)
        while candidate_date.weekday() not in weekdays:
            candidate_date += timedelta(days=1)
    return datetime.combine(
        candidate_date,
        rule.delivery_time,
        tzinfo=selected_timezone,
    ).astimezone(UTC)
