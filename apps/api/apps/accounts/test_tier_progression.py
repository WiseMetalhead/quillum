from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from django.db import close_old_connections

from apps.accounts.models import TierActivityProgress
from apps.accounts.tier_progression import (
    automatic_promotion_payload,
    progression_policy,
    record_tier_activity,
    record_tier_activity_for_event,
)
from apps.audit.models import AuditEvent
from apps.notifications.models import Notification


@pytest.mark.django_db
def test_activity_counts_once_per_local_day_and_keeps_missed_days(django_user_model):
    user = django_user_model.objects.create_user(
        username="active-writer",
        password="correct-password",
        timezone="Europe/Moscow",
    )
    policy = progression_policy()
    policy.enabled = True
    policy.novice_to_author_days = 5
    policy.save()

    with patch(
        "apps.accounts.tier_progression.timezone.now",
        return_value=datetime(2026, 7, 17, 20, 0, tzinfo=UTC),
    ):
        assert record_tier_activity(user) is True
        assert record_tier_activity(user) is False

    progress = TierActivityProgress.objects.get(user=user)
    assert progress.active_days == 1
    assert progress.last_activity_date.isoformat() == "2026-07-17"

    with patch(
        "apps.accounts.tier_progression.timezone.now",
        return_value=datetime(2026, 7, 24, 20, 0, tzinfo=UTC),
    ):
        assert record_tier_activity(user) is True

    progress.refresh_from_db()
    assert progress.active_days == 2
    assert progress.last_activity_date.isoformat() == "2026-07-24"


@pytest.mark.django_db
def test_activity_promotes_one_tier_and_starts_next_transition_next_day(django_user_model):
    user = django_user_model.objects.create_user(
        username="promoted-writer",
        password="correct-password",
        timezone="UTC",
    )
    policy = progression_policy()
    policy.enabled = True
    policy.novice_to_author_days = 2
    policy.author_to_believer_days = 2
    policy.save()

    with patch(
        "apps.accounts.tier_progression.timezone.now",
        return_value=datetime(2026, 7, 17, 12, 0, tzinfo=UTC),
    ):
        record_tier_activity(user)
    with patch(
        "apps.accounts.tier_progression.timezone.now",
        return_value=datetime(2026, 7, 18, 12, 0, tzinfo=UTC),
    ):
        record_tier_activity(user)
        assert record_tier_activity(user) is False

    user.refresh_from_db()
    progress = TierActivityProgress.objects.get(user=user)
    assert user.tier == user.TIER_AUTHOR
    assert progress.tier == user.TIER_AUTHOR
    assert progress.active_days == 0
    assert progress.last_activity_date.isoformat() == "2026-07-18"
    assert Notification.objects.filter(recipient=user, kind="service.tier_changed").exists()
    assert AuditEvent.objects.filter(
        event="system.user_tier_auto_promoted",
        subject=f"user:{user.id}",
    ).exists()

    with patch(
        "apps.accounts.tier_progression.timezone.now",
        return_value=datetime(2026, 7, 19, 12, 0, tzinfo=UTC),
    ):
        record_tier_activity(user)
    progress.refresh_from_db()
    assert progress.active_days == 1


@pytest.mark.django_db
def test_activity_excludes_non_writing_events_and_administrators(django_user_model):
    user = django_user_model.objects.create_user(username="excluded-event-writer")
    administrator = django_user_model.objects.create_superuser(
        username="excluded-administrator",
        password="correct-password",
    )
    policy = progression_policy()
    policy.enabled = True
    policy.save()

    assert record_tier_activity_for_event(user, "manuscript.export_requested") is False
    assert record_tier_activity_for_event(user, "manuscript.review_share_created") is False
    assert record_tier_activity_for_event(user, "manuscript.annotation_created") is False
    assert record_tier_activity(administrator) is False
    assert not TierActivityProgress.objects.exists()

    assert record_tier_activity_for_event(user, "manuscript.planner_updated") is True
    assert TierActivityProgress.objects.get(user=user).active_days == 1


@pytest.mark.django_db
def test_invalid_legacy_timezone_falls_back_to_utc(django_user_model):
    user = django_user_model.objects.create_user(
        username="legacy-timezone-writer",
        timezone="Invalid/Legacy",
    )
    policy = progression_policy()
    policy.enabled = True
    policy.save()

    with (
        patch(
            "apps.accounts.tier_progression.timezone.now",
            return_value=datetime(2026, 7, 17, 23, 30, tzinfo=UTC),
        ),
        patch("apps.accounts.tier_progression.logger.warning") as warning,
    ):
        assert record_tier_activity(user) is True

    assert (
        TierActivityProgress.objects.get(user=user).last_activity_date.isoformat()
        == "2026-07-17"
    )
    warning.assert_called_once()
    assert "using UTC" in warning.call_args.args[0]


@pytest.mark.django_db
def test_lower_threshold_promotes_on_next_action_even_after_today_tick(django_user_model):
    user = django_user_model.objects.create_user(username="lowered-threshold-writer")
    policy = progression_policy()
    policy.enabled = True
    policy.novice_to_author_days = 2
    policy.save()
    TierActivityProgress.objects.create(
        user=user,
        tier=user.tier,
        active_days=1,
        last_activity_date=datetime(2026, 7, 17, tzinfo=UTC).date(),
    )
    policy.novice_to_author_days = 1
    policy.save()

    with patch(
        "apps.accounts.tier_progression.timezone.now",
        return_value=datetime(2026, 7, 17, 12, 0, tzinfo=UTC),
    ):
        record_tier_activity(user)

    user.refresh_from_db()
    assert user.tier == user.TIER_AUTHOR


@pytest.mark.django_db(transaction=True)
def test_concurrent_actions_create_only_one_daily_tick(django_user_model):
    user = django_user_model.objects.create_user(username="concurrent-writer")
    policy = progression_policy()
    policy.enabled = True
    policy.save()

    def tick():
        close_old_connections()
        try:
            current_user = django_user_model.objects.get(pk=user.pk)
            return record_tier_activity(current_user)
        finally:
            close_old_connections()

    with patch(
        "apps.accounts.tier_progression.timezone.now",
        return_value=datetime(2026, 7, 17, 12, 0, tzinfo=UTC),
    ):
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _index: tick(), range(2)))

    assert sorted(results) == [False, True]
    assert TierActivityProgress.objects.get(user=user).active_days == 1


@pytest.mark.django_db
def test_automatic_promotion_payload_is_hidden_when_disabled_or_ineligible(django_user_model):
    user = django_user_model.objects.create_user(username="payload-writer")
    policy = progression_policy()

    assert automatic_promotion_payload(user) is None

    policy.enabled = True
    policy.novice_to_author_days = 45
    policy.save()
    TierActivityProgress.objects.create(user=user, tier=user.tier, active_days=8)

    assert automatic_promotion_payload(user) == {
        "nextTier": "author",
        "activeDays": 8,
        "requiredDays": 45,
        "remainingDays": 37,
    }

    user.tier = user.TIER_BELIEVER
    user.save(update_fields=["tier"])
    assert automatic_promotion_payload(user) is None
