import json
from datetime import UTC, datetime, time, timedelta
from types import SimpleNamespace

import pytest
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.test import override_settings
from django.utils import timezone

from apps.accounts.views import RECENT_AUTH_SESSION_KEY
from apps.audit.models import AuditEvent
from apps.manuscripts.models import (
    AnnotationReply,
    Document,
    DocumentAnnotation,
    Manuscript,
    ManuscriptItem,
    ManuscriptShareLink,
    ManuscriptTask,
    ManuscriptWritingDay,
    ShareParticipant,
    Workspace,
)

from .consumers import NotificationConsumer
from .models import (
    AdminNotificationCampaign,
    AdminNotificationRecipient,
    Notification,
    NotificationRule,
)
from .preferences import RULE_KINDS
from .scheduling import next_rule_run
from .service import create_notification, user_group
from .user_rules import notify_public_review_comment, process_timed_rule

IN_MEMORY_CHANNEL_LAYER = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}


def notification_manuscript(user, *, title="Notification manuscript"):
    workspace = Workspace.objects.create(owner=user)
    return Manuscript.objects.create(
        workspace=workspace,
        kind=Manuscript.KIND_BOOK,
        title=title,
        synopsis="",
    )


@pytest.mark.django_db
def test_notification_payload_is_plaintext_and_deduplicated(django_user_model):
    user = django_user_model.objects.create_user(
        username="notified-user",
        email="notified@example.test",
        password="Strong-notification-password-123!",
    )
    first, created = create_notification(
        recipient=user,
        kind="service.new_login",
        payload={"ipAddress": "203.0.113.45"},
        deduplication_key="login:test:one",
    )
    second, duplicated = create_notification(
        recipient=user,
        kind="service.new_login",
        payload={"ipAddress": "203.0.113.45"},
        deduplication_key="login:test:one",
    )

    stored = Notification.objects.values().get(id=first.id)
    assert created is True
    assert duplicated is False
    assert second.id == first.id
    assert stored["payload"] == {"ipAddress": "203.0.113.45"}
    assert first.payload["ipAddress"] == "203.0.113.45"


@pytest.mark.django_db
def test_notification_api_is_recipient_scoped_and_marks_read(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="notification-owner",
        email="notification-owner@example.test",
        password="Strong-notification-password-123!",
    )
    other = django_user_model.objects.create_user(
        username="notification-other",
        email="notification-other@example.test",
        password="Strong-notification-password-123!",
    )
    own, _ = create_notification(
        recipient=user,
        kind="service.password_stale",
        payload={"actionPath": "/settings?tab=security"},
        deduplication_key="password:owner",
    )
    foreign, _ = create_notification(
        recipient=other,
        kind="service.password_stale",
        payload={"actionPath": "/settings?tab=security"},
        deduplication_key="password:other",
    )
    client.force_login(user)

    listing = client.get("/api/notifications/?filter=unread")
    assert listing.status_code == 200
    assert [item["id"] for item in listing.json()["items"]] == [str(own.public_id)]
    assert client.patch(f"/api/notifications/{foreign.public_id}/read/", {}).status_code == 404
    assert client.patch(f"/api/notifications/{own.public_id}/read/", {}).status_code == 200
    assert Notification.objects.get(id=own.id).read_at is not None


@pytest.mark.django_db
def test_read_all_and_expiry_cleanup(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="notification-cleanup",
        email="notification-cleanup@example.test",
        password="Strong-notification-password-123!",
    )
    item, _ = create_notification(
        recipient=user,
        kind="service.two_factor_missing",
        payload={"actionPath": "/settings?tab=security"},
        deduplication_key="two-factor:cleanup",
    )
    client.force_login(user)
    response = client.post("/api/notifications/read-all/", {}, content_type="application/json")
    assert response.status_code == 200
    assert response.json()["updated"] == 1

    Notification.objects.filter(id=item.id).update(expires_at=timezone.now())
    from .tasks import purge_expired_notifications

    assert purge_expired_notifications() == 1
    assert not Notification.objects.filter(id=item.id).exists()


@pytest.mark.django_db
def test_cursor_pagination_returns_twenty_items(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="notification-pagination",
        email="notification-pagination@example.test",
        password="Strong-notification-password-123!",
    )
    for index in range(21):
        create_notification(
            recipient=user,
            kind="service.password_stale",
            payload={"actionPath": "/settings?tab=security"},
            deduplication_key=f"password:pagination:{index}",
        )
    client.force_login(user)

    first = client.get("/api/notifications/").json()
    second = client.get("/api/notifications/", {"cursor": first["nextCursor"]}).json()

    assert len(first["items"]) == 20
    assert first["nextCursor"]
    assert len(second["items"]) == 1
    assert second["nextCursor"] is None


@pytest.mark.django_db
@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_websocket_sends_only_invalidation_signal():
    user = SimpleNamespace(id=42, is_authenticated=True, is_active=True)

    async def scenario():
        async def authenticated_consumer(scope, receive, send):
            scope["user"] = user
            await NotificationConsumer.as_asgi()(scope, receive, send)

        communicator = WebsocketCommunicator(authenticated_consumer, "/ws/notifications/")
        connected, _detail = await communicator.connect()
        assert connected is True

        await get_channel_layer().group_send(
            user_group(user.id),
            {"type": "notifications.changed", "ignored": "secret"},
        )
        assert await communicator.receive_json_from() == {"type": "notifications.changed"}
        await communicator.disconnect()

    async_to_sync(scenario)()


@pytest.mark.django_db
@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_anonymous_websocket_is_rejected():
    async def scenario():
        communicator = WebsocketCommunicator(NotificationConsumer.as_asgi(), "/ws/notifications/")
        connected, close_code = await communicator.connect()
        assert connected is False
        assert close_code == 4401

    async_to_sync(scenario)()


@pytest.mark.django_db
def test_admin_self_test_requires_superuser(client, django_user_model):
    administrator = django_user_model.objects.create_user(
        username="notification-administrator",
        email="notification-administrator@example.test",
        password="Strong-notification-password-123!",
    )
    client.force_login(administrator)
    denied = client.post(
        "/api/admin/notifications/test/",
        {"kind": "service.review_share_expired"},
        content_type="application/json",
    )
    assert denied.status_code == 403
    assert client.get("/api/admin/notifications/campaigns/").status_code == 403

    administrator.is_superuser = True
    administrator.save(update_fields=["is_superuser"])
    accepted = client.post(
        "/api/admin/notifications/test/",
        {"kind": "service.review_share_expired"},
        content_type="application/json",
    )
    assert accepted.status_code == 201


@pytest.mark.django_db
def test_admin_campaign_content_is_plaintext_and_actions_require_recent_auth(
    client,
    django_user_model,
):
    admin = django_user_model.objects.create_superuser(
        username="campaign-admin",
        email="campaign-admin@example.test",
        password="Strong-campaign-password-123!",
    )
    client.force_login(admin)

    created = client.post(
        "/api/admin/notifications/campaigns/",
        {
            "title": "Maintenance window",
            "body": "The service will be **read-only**.",
            "tiers": ["author"],
        },
        content_type="application/json",
    )
    assert created.status_code == 201
    campaign = AdminNotificationCampaign.objects.get()
    stored = AdminNotificationCampaign.objects.values().get(id=campaign.id)
    assert stored["title"] == "Maintenance window"
    assert stored["body"] == "The service will be **read-only**."

    denied = client.post(
        f"/api/admin/notifications/campaigns/{campaign.public_id}/send/",
        {},
        content_type="application/json",
    )
    assert denied.status_code == 403
    assert denied.json()["error"] == "recent_authentication_required"

    session = client.session
    session[RECENT_AUTH_SESSION_KEY] = timezone.now().isoformat()
    session.save()
    accepted = client.post(
        f"/api/admin/notifications/campaigns/{campaign.public_id}/send/",
        {},
        content_type="application/json",
    )
    assert accepted.status_code == 202

    audit_payloads = [
        event.payload
        for event in AuditEvent.objects.filter(
            subject=f"notification-campaign:{campaign.public_id}"
        )
    ]
    assert audit_payloads
    assert all("title" not in value and "body" not in value for value in audit_payloads)


@pytest.mark.django_db
@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_admin_campaign_targets_active_tiers_at_send_time_and_retry_is_idempotent(
    django_user_model,
):
    author = django_user_model.objects.create_user(
        username="campaign-author",
        email="campaign-author@example.test",
        password="Strong-campaign-password-123!",
        tier="author",
    )
    django_user_model.objects.create_user(
        username="campaign-novice",
        email="campaign-novice@example.test",
        password="Strong-campaign-password-123!",
        tier="novice",
    )
    django_user_model.objects.create_user(
        username="campaign-inactive-author",
        email="campaign-inactive-author@example.test",
        password="Strong-campaign-password-123!",
        tier="author",
        is_active=False,
    )
    campaign = AdminNotificationCampaign(
        tiers=["author"],
        status=AdminNotificationCampaign.STATUS_SCHEDULED,
        scheduled_for=timezone.now(),
    )
    campaign.title = "Author news"
    campaign.body = "A single announcement."
    campaign.save()

    from .tasks import process_admin_notification_campaign

    assert process_admin_notification_campaign(campaign.id) == 1
    campaign.refresh_from_db()
    assert campaign.status == AdminNotificationCampaign.STATUS_SENT
    delivery = campaign.recipients.get()
    assert delivery.recipient == author
    assert delivery.notification.payload == {
        "campaignId": str(campaign.public_id),
        "title": "Author news",
        "body": "A single announcement.",
    }
    assert Notification.objects.filter(kind="admin.announcement").count() == 1

    delivery.status = AdminNotificationRecipient.STATUS_FAILED
    delivery.save(update_fields=["status", "updated_at"])
    campaign.status = AdminNotificationCampaign.STATUS_PROCESSING
    campaign.save(update_fields=["status", "updated_at"])
    assert process_admin_notification_campaign(campaign.id) == 1
    assert Notification.objects.filter(kind="admin.announcement").count() == 1


@pytest.mark.django_db
def test_campaign_retention_keeps_drafts_and_removes_terminal_campaigns():
    old = timezone.now() - timedelta(days=91)
    terminal = AdminNotificationCampaign(status=AdminNotificationCampaign.STATUS_SENT)
    terminal.title = "Sent campaign"
    terminal.body = "Already delivered"
    terminal.save()
    draft = AdminNotificationCampaign()
    draft.title = "Draft campaign"
    draft.body = "Still being edited"
    draft.save()
    AdminNotificationCampaign.objects.filter(id__in=[terminal.id, draft.id]).update(updated_at=old)

    from .tasks import purge_expired_notifications

    purge_expired_notifications()
    assert not AdminNotificationCampaign.objects.filter(id=terminal.id).exists()
    assert AdminNotificationCampaign.objects.filter(id=draft.id).exists()


@pytest.mark.django_db
def test_notification_preferences_default_off_and_validate_enabled_rules(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="rule-owner",
        password="Strong-rule-password-123!",
        timezone="Europe/Moscow",
    )
    manuscript = notification_manuscript(user)
    client.force_login(user)

    initial = client.get("/api/notifications/preferences/")
    assert initial.status_code == 200
    rules = initial.json()["preferences"]["rules"]
    assert {rule["kind"] for rule in rules} == set(RULE_KINDS)
    assert all(not rule["enabled"] and not rule["emailEnabled"] for rule in rules)
    assert all(not rule["manuscriptIds"] for rule in rules)

    deadline_rule = next(
        rule for rule in rules if rule["kind"] == NotificationRule.KIND_MANUSCRIPT_DEADLINE
    )
    deadline_rule.update(
        enabled=True,
        emailEnabled=True,
        time="10:00",
        manuscriptIds=[str(manuscript.public_id)],
    )
    saved = client.patch(
        "/api/notifications/preferences/",
        data=json.dumps({"rules": rules}),
        content_type="application/json",
    )
    assert saved.status_code == 200
    stored = NotificationRule.objects.get(
        user=user,
        kind=NotificationRule.KIND_MANUSCRIPT_DEADLINE,
    )
    assert stored.enabled is True
    assert stored.email_enabled is True
    assert stored.next_run_at is not None
    assert list(stored.manuscripts.all()) == [manuscript]

    deadline_rule["manuscriptIds"] = []
    invalid = client.patch(
        "/api/notifications/preferences/",
        data=json.dumps({"rules": rules}),
        content_type="application/json",
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "notification_rule_manuscript_required"


@pytest.mark.django_db
def test_account_timezone_is_validated_and_reschedules_rules(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="timezone-owner",
        password="Strong-timezone-password-123!",
    )
    rule = NotificationRule.objects.create(
        user=user,
        kind=NotificationRule.KIND_DAILY_GOAL,
        enabled=True,
        delivery_time=time(10),
    )
    client.force_login(user)

    invalid = client.patch(
        "/api/auth/profile/",
        data=json.dumps({"timezone": "Mars/Olympus"}),
        content_type="application/json",
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "timezone_invalid"

    updated = client.patch(
        "/api/auth/profile/",
        data=json.dumps({"timezone": "America/New_York"}),
        content_type="application/json",
    )
    assert updated.status_code == 200
    assert updated.json()["user"]["timezone"] == "America/New_York"
    rule.refresh_from_db()
    assert rule.next_run_at is not None


def test_next_rule_run_uses_account_timezone_dst_and_skips_enable_time_backfill():
    rule = SimpleNamespace(
        enabled=True,
        kind=NotificationRule.KIND_DAILY_GOAL,
        delivery_time=time(10),
        weekdays=[],
        user=SimpleNamespace(timezone="America/New_York"),
    )
    after = datetime(2026, 3, 7, 16, tzinfo=UTC)

    assert next_rule_run(rule, after=after) == datetime(2026, 3, 8, 14, tzinfo=UTC)


@pytest.mark.django_db
def test_timed_rules_create_separate_plaintext_notifications(django_user_model):
    now = datetime(2026, 7, 16, 9, tzinfo=UTC)
    today = now.date()
    user = django_user_model.objects.create_user(
        username="timed-rule-owner",
        password="Strong-timed-rule-password-123!",
    )
    manuscript = notification_manuscript(user, title="Private schedule")
    manuscript.first_edited_at = now
    manuscript.planner_settings = {
        "deadline": (today + timedelta(days=1)).isoformat(),
        "dailyWordGoal": 500,
        "manuscriptWordGoal": 10_000,
    }
    manuscript.save(update_fields=["first_edited_at", "planner_settings"])
    item = ManuscriptItem.objects.create(
        manuscript=manuscript,
        kind=ManuscriptItem.KIND_DOCUMENT,
        title="Chapter deadline",
    )
    item.planner_metadata = {
        "role": "chapter",
        "synopsis": "",
        "deadline": (today + timedelta(days=1)).isoformat(),
        "wordGoal": 1_000,
        "statusId": None,
        "completedDate": None,
    }
    item.save(update_fields=["planner_metadata"])
    Document.objects.create(
        manuscript=manuscript,
        item=item,
        content={"type": "doc", "content": [{"type": "paragraph"}]},
    )
    task = ManuscriptTask(manuscript=manuscript)
    task.content = {
        "title": "Due task",
        "description": "",
        "deadline": today.isoformat(),
    }
    task.save()
    ManuscriptWritingDay.objects.create(
        manuscript=manuscript,
        date=today,
        words_written=600,
    )

    rule_specs = [
        (NotificationRule.KIND_MANUSCRIPT_DEADLINE, [1]),
        (NotificationRule.KIND_ITEM_DEADLINE, [1]),
        (NotificationRule.KIND_TASK_DEADLINE, [0]),
        (NotificationRule.KIND_DAILY_GOAL, []),
        (NotificationRule.KIND_MANUSCRIPT_DIGEST, []),
    ]
    for kind, checkpoints in rule_specs:
        rule = NotificationRule.objects.create(
            user=user,
            kind=kind,
            enabled=True,
            delivery_time=time(9),
            checkpoints=checkpoints,
            weekdays=[today.weekday()] if kind == NotificationRule.KIND_MANUSCRIPT_DIGEST else [],
        )
        rule.manuscripts.add(manuscript)
        assert process_timed_rule(rule, now=now) == 1

    notifications = list(Notification.objects.filter(recipient=user).order_by("kind"))
    assert {notification.kind for notification in notifications} == {
        kind for kind, _checkpoints in rule_specs
    }
    assert any("Private schedule" in str(notification.payload) for notification in notifications)
    daily = next(
        notification
        for notification in notifications
        if notification.kind == NotificationRule.KIND_DAILY_GOAL
    )
    assert daily.payload["completed"] is True
    assert daily.payload["writtenWords"] == 600

    for rule in NotificationRule.objects.exclude(kind=NotificationRule.KIND_MANUSCRIPT_DIGEST):
        assert process_timed_rule(rule, now=now) == 0


@pytest.mark.django_db
def test_public_review_root_and_reply_create_addressable_notifications(django_user_model):
    user = django_user_model.objects.create_user(
        username="review-rule-owner",
        password="Strong-review-rule-password-123!",
    )
    manuscript = notification_manuscript(user, title="Review target")
    document = Document.objects.create(
        manuscript=manuscript,
        content={"type": "doc", "content": [{"type": "paragraph"}]},
    )
    share = ManuscriptShareLink.objects.create(
        manuscript=manuscript,
        created_by=user,
        token_hash="a" * 64,
        access_level=ManuscriptShareLink.ACCESS_COMMENT,
        scope_type=ManuscriptShareLink.SCOPE_ONESHOT,
    )
    participant = ShareParticipant.objects.create(
        share_link=share,
        display_name="Maria Reader",
        session_token_hash="b" * 64,
    )
    annotation = DocumentAnnotation(
        document=document,
        guest_author=participant,
        quote="Selected text",
        comment="A root guest comment",
    )
    annotation.save()
    reply = AnnotationReply(
        annotation=annotation,
        guest_author=participant,
        body="A guest reply",
    )
    reply.save()
    rule = NotificationRule.objects.create(
        user=user,
        kind=NotificationRule.KIND_REVIEW_COMMENT,
        enabled=True,
    )
    rule.manuscripts.add(manuscript)

    notify_public_review_comment(annotation=annotation)
    notify_public_review_comment(annotation=annotation, reply=reply)

    notifications = list(Notification.objects.filter(kind=rule.kind).order_by("created_at"))
    assert len(notifications) == 2
    assert notifications[0].payload["guestName"] == "Maria Reader"
    assert notifications[0].payload["excerpt"] == "A root guest comment"
    assert notifications[1].payload["guestName"] == "Maria Reader"
    assert notifications[1].payload["excerpt"] == "A guest reply"
    assert f"annotation={annotation.public_id}" in notifications[1].payload["actionPath"]
