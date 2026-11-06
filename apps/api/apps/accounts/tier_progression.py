from __future__ import annotations

import logging
from datetime import date
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.utils import timezone

from apps.adminpanel.models import TierProgressionPolicy

from .models import TierActivityProgress, User

logger = logging.getLogger(__name__)

MINIMUM_DAYS = 1
MAXIMUM_DAYS = 3650
POLICY_ID = 1
NEXT_TIER = {
    User.TIER_NOVICE: User.TIER_AUTHOR,
    User.TIER_AUTHOR: User.TIER_BELIEVER,
}
QUALIFYING_AUDIT_EVENTS = {
    "manuscript.board_created",
    "manuscript.board_deleted",
    "manuscript.book_created",
    "manuscript.book_item_created",
    "manuscript.book_item_permanently_deleted",
    "manuscript.book_item_trashed",
    "manuscript.deleted",
    "manuscript.glossary_article_assets_updated",
    "manuscript.glossary_article_created",
    "manuscript.glossary_article_deleted",
    "manuscript.glossary_article_linked",
    "manuscript.glossary_article_metadata_updated",
    "manuscript.glossary_article_unlinked",
    "manuscript.glossary_category_created",
    "manuscript.glossary_category_deleted",
    "manuscript.glossary_category_updated",
    "manuscript.metadata_updated",
    "manuscript.note_created",
    "manuscript.note_permanently_deleted",
    "manuscript.note_trash_emptied",
    "manuscript.oneshot_created",
    "manuscript.plan_item_updated",
    "manuscript.planner_updated",
    "manuscript.renamed",
    "manuscript.revision_created",
    "manuscript.revision_deleted",
    "manuscript.series_book_added",
    "manuscript.series_book_created",
    "manuscript.series_book_removed",
    "manuscript.series_book_updated",
    "manuscript.series_created",
    "manuscript.series_deleted",
    "manuscript.series_updated",
    "manuscript.task_created",
    "manuscript.task_deleted",
    "manuscript.task_updated",
    "manuscript.version_restored",
}


def progression_policy() -> TierProgressionPolicy:
    policy, _created = TierProgressionPolicy.objects.get_or_create(pk=POLICY_ID)
    return policy


def required_days(policy: TierProgressionPolicy, tier: str) -> int:
    if tier == User.TIER_NOVICE:
        return policy.novice_to_author_days
    if tier == User.TIER_AUTHOR:
        return policy.author_to_believer_days
    raise ValueError("tier_progression_unavailable")


def policy_payload() -> dict:
    policy = progression_policy()
    return {
        "enabled": policy.enabled,
        "noviceToAuthorDays": policy.novice_to_author_days,
        "authorToBelieverDays": policy.author_to_believer_days,
        "minimumDays": MINIMUM_DAYS,
        "maximumDays": MAXIMUM_DAYS,
    }


def automatic_promotion_payload(user) -> dict | None:
    if (
        user.is_superuser
        or user.author_workspace_enabled_at is None
        or not user.is_active
        or user.tier not in NEXT_TIER
    ):
        return None
    policy = progression_policy()
    if not policy.enabled:
        return None
    progress = TierActivityProgress.objects.filter(user=user, tier=user.tier).first()
    active_days = progress.active_days if progress is not None else 0
    target = required_days(policy, user.tier)
    return {
        "nextTier": NEXT_TIER[user.tier],
        "activeDays": active_days,
        "requiredDays": target,
        "remainingDays": max(0, target - active_days),
    }


def reset_tier_activity(user) -> None:
    TierActivityProgress.objects.filter(user=user).delete()


def _promote_user(user: User, progress: TierActivityProgress) -> None:
    previous_tier = user.tier
    next_tier = NEXT_TIER[previous_tier]
    user.tier = next_tier
    user.save(update_fields=["tier"])
    if next_tier in NEXT_TIER:
        progress.tier = next_tier
        progress.active_days = 0
        progress.save()
    else:
        progress.delete()

    from apps.audit.service import write_system_audit_event
    from apps.notifications.service import service_notification_for_tier_change

    write_system_audit_event(
        "system.user_tier_auto_promoted",
        subject=f"user:{user.id}",
        payload={"previousTier": previous_tier, "nextTier": next_tier},
    )
    service_notification_for_tier_change(user, previous_tier, next_tier)


def _activity_date(user) -> date:
    try:
        zone = ZoneInfo(user.timezone)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        logger.warning(
            "Invalid account timezone for tier activity user_id=%s timezone=%r; using UTC",
            user.id,
            user.timezone,
        )
        zone = ZoneInfo("UTC")
    return timezone.localtime(timezone.now(), zone).date()


def record_tier_activity(user) -> bool:
    if not getattr(user, "is_authenticated", False):
        return False
    policy = progression_policy()
    if not policy.enabled:
        return False

    with transaction.atomic():
        locked_user = User.objects.select_for_update().get(pk=user.pk)
        if (
            not locked_user.is_active
            or locked_user.is_superuser
            or locked_user.author_workspace_enabled_at is None
            or locked_user.tier not in NEXT_TIER
        ):
            return False

        activity_date = _activity_date(locked_user)
        progress, _created = TierActivityProgress.objects.select_for_update().get_or_create(
            user=locked_user,
            defaults={"tier": locked_user.tier},
        )
        if progress.tier != locked_user.tier:
            progress.tier = locked_user.tier
            progress.active_days = 0
            progress.last_activity_date = None
        threshold = required_days(policy, locked_user.tier)
        if progress.active_days >= threshold:
            _promote_user(locked_user, progress)
            return True
        if progress.last_activity_date is not None and activity_date <= progress.last_activity_date:
            return False

        progress.active_days += 1
        progress.last_activity_date = activity_date
        if progress.active_days < threshold:
            progress.save()
            return True

        _promote_user(locked_user, progress)
        return True


def record_tier_activity_for_event(user, event: str) -> bool:
    if event not in QUALIFYING_AUDIT_EVENTS and not event.startswith("manuscript.note_bulk_"):
        return False
    return record_tier_activity(user)
