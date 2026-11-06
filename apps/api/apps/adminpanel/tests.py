from types import SimpleNamespace
from unittest.mock import patch

import pytest
from celery import states
from django.conf import settings
from django.core import mail
from django.core.cache import cache
from django.test import Client
from django.utils import timezone

from apps.accounts.models import OidcIdentity, RegistrationCounter, TierActivityProgress
from apps.accounts.views import AUTH_METHOD_SESSION_KEY, RECENT_AUTH_SESSION_KEY
from apps.adminpanel.models import (
    BackgroundTaskRun,
    ServiceSetting,
    TierProgressionPolicy,
    TierQuotaOverride,
)
from apps.adminpanel.runtime_settings import invalidate_runtime_setting, runtime_setting
from apps.adminpanel.task_monitor import record_task_finished, record_task_started
from apps.audit.models import AuditEvent


def mark_recent_auth(client) -> None:
    session = client.session
    session[RECENT_AUTH_SESSION_KEY] = timezone.now().isoformat()
    session.save()


@pytest.mark.django_db
def test_background_task_monitor_records_safe_summary():
    sender = SimpleNamespace(
        name="apps.manuscripts.tasks.cleanup_expired_exports",
        request=SimpleNamespace(hostname="celery@test"),
    )

    record_task_started(sender=sender, task=sender, task_id="tracked-task")
    record_task_finished(
        sender=sender,
        task=sender,
        task_id="tracked-task",
        state=states.SUCCESS,
    )

    run = BackgroundTaskRun.objects.get(task_id="tracked-task")
    assert run.task_name == "apps.manuscripts.tasks.cleanup_expired_exports"
    assert run.worker == "celery@test"
    assert run.status == BackgroundTaskRun.STATUS_SUCCEEDED
    assert run.finished_at is not None
    assert run.duration_ms is not None
    assert run.error_type == ""


def test_celery_ignores_results_tracked_in_postgresql():
    assert settings.CELERY_TASK_IGNORE_RESULT is True
    assert settings.CELERY_RESULT_BACKEND == settings.REDIS_URL


@pytest.mark.django_db
def test_admin_status_requires_authentication(client):
    response = client.get("/api/admin/status/")

    assert response.status_code == 401
    assert response.json()["error"] == "authentication_required"


@pytest.mark.django_db
def test_admin_status_requires_superuser(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.get("/api/admin/status/")

    assert response.status_code == 403
    assert response.json()["error"] == "superuser_required"


@pytest.mark.django_db
def test_admin_status_returns_operational_summary(client, django_user_model, monkeypatch):
    admin = django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    monkeypatch.setattr(
        "apps.adminpanel.views.check_celery_worker",
        lambda: {
            "ok": True,
            "configured": True,
            "broker": "redis",
            "workers": ["celery@test"],
            "workerCount": 1,
            "latencyMs": 1.0,
        },
    )
    BackgroundTaskRun.objects.create(
        task_id="status-task",
        task_name="apps.manuscripts.tasks.cleanup_expired_exports",
        worker="celery@test",
        status=BackgroundTaskRun.STATUS_SUCCEEDED,
        started_at=timezone.now(),
        finished_at=timezone.now(),
        duration_ms=12,
    )

    response = client.get("/api/admin/status/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["app"]["name"] == "Quillum"
    assert payload["auth"]["mode"] == "local"
    assert payload["usage"]["users"] == 1
    assert payload["usage"]["administrators"] == 1
    assert payload["services"]["database"]["ok"] is True
    assert payload["services"]["database"]["version"]
    assert payload["services"]["database"]["sizeBytes"] > 0
    assert payload["services"]["redis"]["ok"] is True
    assert payload["services"]["celery"]["workerCount"] == 1
    assert payload["services"]["storage"]["provider"] == "local"
    assert payload["taskActivity"]["lastTask"]["id"] == "status-task"
    assert payload["taskActivity"]["lastTask"]["errorType"] is None


@pytest.mark.django_db
def test_audit_events_require_superuser(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer-audit@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.get("/api/admin/audit-events/")

    assert response.status_code == 403
    assert response.json()["error"] == "superuser_required"


@pytest.mark.django_db
def test_audit_events_returns_paginated_rows(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin-audit",
        email="admin-audit@example.test",
        password="correct-password",
    )
    AuditEvent.objects.create(
        event="auth.login_succeeded",
        actor=admin,
        subject=f"user:{admin.id}",
        ip_address="127.0.0.1",
        payload={"source": "test"},
    )
    AuditEvent.objects.create(
        event="manuscript.note_created",
        actor=admin,
        subject="manuscript:1",
    )
    client.force_login(admin)

    response = client.get("/api/admin/audit-events/?event=login&pageSize=10")

    assert response.status_code == 200
    payload = response.json()
    assert payload["pagination"]["totalItems"] == 1
    assert payload["items"][0]["event"] == "auth.login_succeeded"
    assert payload["items"][0]["payload"] == {"source": "test"}

    localized_response = client.get(
        "/api/admin/audit-events/?event=%D0%A1%D0%BE%D0%B7%D0%B4%D0%B0%D0%BD%D0%B8%D0%B5"
        "&eventCodes=manuscript.note_created"
    )
    assert localized_response.status_code == 200
    assert localized_response.json()["pagination"]["totalItems"] == 1
    assert localized_response.json()["items"][0]["event"] == "manuscript.note_created"

    ip_response = client.get("/api/admin/audit-events/?ip=127.0.0.1")
    assert ip_response.status_code == 200
    assert ip_response.json()["pagination"]["totalItems"] == 1


@pytest.mark.django_db
def test_users_require_superuser(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer-users",
        email="writer-users@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.get("/api/admin/users/")

    assert response.status_code == 403
    assert response.json()["error"] == "superuser_required"


@pytest.mark.django_db
def test_users_returns_filtered_rows(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin-users",
        email="admin-users@example.test",
        password="correct-password",
    )
    django_user_model.objects.create_user(
        username="regular-writer",
        email="writer@example.test",
        password="correct-password",
    )
    client.force_login(admin)

    response = client.get("/api/admin/users/?search=regular&pageSize=10")

    assert response.status_code == 200
    payload = response.json()
    assert payload["pagination"]["totalItems"] == 1
    assert payload["items"][0]["username"] == "regular-writer"
    assert payload["items"][0]["tier"] == "novice"
    assert payload["items"][0]["usage"]["books"] == 0


@pytest.mark.django_db
def test_users_returns_statistics_and_last_activity(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin-user-stats",
        email="admin-user-stats@example.test",
        password="correct-password",
    )
    user = django_user_model.objects.create_user(
        username="stats-writer",
        email="stats-writer@example.test",
        password="correct-password",
    )
    RegistrationCounter.objects.update_or_create(
        pk=1,
        defaults={"total_registrations": 7},
    )
    activity = AuditEvent.objects.create(
        event="auth.profile_updated",
        actor=user,
        subject=f"user:{user.id}",
        payload={"field": "displayName"},
    )
    client.force_login(admin)

    response = client.get("/api/admin/users/?search=stats-writer")

    assert response.status_code == 200
    payload = response.json()
    assert payload["stats"] == {"registered": 7, "active": 2, "blocked": 0}
    assert payload["items"][0]["lastActivity"] == activity.created_at.isoformat()


@pytest.mark.django_db
def test_users_supports_exact_email_search(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin-email-search",
        email="admin@example.test",
        password="correct-password",
    )
    django_user_model.objects.create_user(
        username="email-writer",
        email="Writer@Example.Test",
        password="correct-password",
    )
    client.force_login(admin)

    response = client.get("/api/admin/users/?search=writer@example.test")

    assert response.status_code == 200
    assert response.json()["pagination"]["totalItems"] == 1
    assert response.json()["items"][0]["username"] == "email-writer"


@pytest.mark.django_db
def test_admin_can_block_and_unblock_user_and_revoke_sessions(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin-actions",
        email="admin-actions@example.test",
        password="correct-password",
    )
    user = django_user_model.objects.create_user(
        username="managed-writer",
        email="managed@example.test",
        password="correct-password",
    )
    user_client = Client()
    user_client.force_login(user)
    client.force_login(admin)

    block_response = client.post(
        f"/api/admin/users/{user.id}/block/",
        {},
        content_type="application/json",
    )

    assert block_response.status_code == 200
    user.refresh_from_db()
    assert user.is_active is False
    assert user_client.get("/api/auth/session/").json()["authenticated"] is False
    blocked_login = user_client.post(
        "/api/auth/login/",
        {"username": user.username, "password": "correct-password"},
        content_type="application/json",
    )
    assert blocked_login.status_code == 403
    assert blocked_login.json()["error"] == "account_blocked"

    unblock_response = client.post(
        f"/api/admin/users/{user.id}/unblock/",
        {},
        content_type="application/json",
    )

    assert unblock_response.status_code == 200
    user.refresh_from_db()
    assert user.is_active is True
    assert AuditEvent.objects.filter(event="admin.user_blocked", actor=admin).exists()
    assert AuditEvent.objects.filter(event="admin.user_unblocked", actor=admin).exists()


@pytest.mark.django_db
def test_admin_can_update_user_tier(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin-tier",
        email="admin-tier@example.test",
        password="correct-password",
    )
    user = django_user_model.objects.create_user(
        username="tier-writer",
        email="tier-writer@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    TierActivityProgress.objects.create(user=user, tier=user.tier, active_days=7)

    response = client.patch(
        f"/api/admin/users/{user.id}/tier/",
        {"tier": "believer"},
        content_type="application/json",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.tier == "believer"
    assert not TierActivityProgress.objects.filter(user=user).exists()
    assert response.json()["user"]["tierLabel"] == "Believer"
    assert AuditEvent.objects.filter(event="admin.user_tier_updated", actor=admin).exists()


@pytest.mark.django_db
def test_superuser_can_promote_and_demote_another_user(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin-role",
        email="admin-role@example.test",
        password="correct-password",
    )
    user = django_user_model.objects.create_user(
        username="role-writer",
        email="role-writer@example.test",
        password="correct-password",
        tier="believer",
    )
    client.force_login(admin)
    mark_recent_auth(client)
    TierActivityProgress.objects.create(user=user, tier=user.tier, active_days=4)

    promote_response = client.patch(
        f"/api/admin/users/{user.id}/role/",
        {"isSuperuser": True},
        content_type="application/json",
    )

    assert promote_response.status_code == 200
    user.refresh_from_db()
    assert user.is_superuser is True
    assert user.is_staff is True
    assert user.tier == user.TIER_GOD
    assert not TierActivityProgress.objects.filter(user=user).exists()

    tier_response = client.patch(
        f"/api/admin/users/{user.id}/tier/",
        {"tier": "believer"},
        content_type="application/json",
    )
    assert tier_response.status_code == 409
    assert tier_response.json()["error"] == "superuser_tier_locked"

    demote_response = client.patch(
        f"/api/admin/users/{user.id}/role/",
        {"isSuperuser": False},
        content_type="application/json",
    )

    assert demote_response.status_code == 200
    user.refresh_from_db()
    assert user.is_superuser is False
    assert user.is_staff is False
    assert user.tier == user.TIER_GOD
    assert AuditEvent.objects.filter(event="admin.user_role_updated", actor=admin).count() == 2


@pytest.mark.django_db
def test_legacy_staff_flag_does_not_grant_product_admin_access(client, django_user_model):
    legacy_flag_user = django_user_model.objects.create_user(
        username="role-legacy-flag",
        email="role-legacy-flag@example.test",
        password="correct-password",
    )
    django_user_model.objects.filter(pk=legacy_flag_user.pk).update(is_staff=True)
    legacy_flag_user.refresh_from_db()
    user = django_user_model.objects.create_user(
        username="role-target",
        email="role-target@example.test",
        password="correct-password",
    )
    client.force_login(legacy_flag_user)

    response = client.patch(
        f"/api/admin/users/{user.id}/role/",
        {"isSuperuser": True},
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "superuser_required"


@pytest.mark.django_db
def test_user_role_update_requires_recent_authentication(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="role-reauth-admin",
        email="role-reauth-admin@example.test",
        password="correct-password",
    )
    user = django_user_model.objects.create_user(
        username="role-reauth-target",
        email="role-reauth-target@example.test",
        password="correct-password",
    )
    client.force_login(admin)

    response = client.patch(
        f"/api/admin/users/{user.id}/role/",
        {"isSuperuser": True},
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "recent_authentication_required"


@pytest.mark.django_db
def test_passwordless_oidc_admin_reauthenticates_with_oidc_while_local_login_is_enabled(
    client,
    django_user_model,
    settings,
):
    settings.OIDC_ENABLED = True
    settings.OIDC_DISCOVERY_URL = (
        "https://idp.example.test/.well-known/openid-configuration"
    )
    settings.OIDC_CLIENT_ID = "quillum"
    settings.OIDC_CLIENT_SECRET = "oidc-secret"
    admin = django_user_model.objects.create_superuser(
        username="passwordless-oidc-admin",
        email="passwordless-oidc-admin@example.test",
        password="temporary-password",
    )
    admin.set_unusable_password()
    admin.save(update_fields=["password"])
    OidcIdentity.objects.create(
        user=admin,
        issuer="https://idp.example.test",
        subject="passwordless-admin-subject",
    )
    user = django_user_model.objects.create_user(
        username="oidc-role-target",
        email="oidc-role-target@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    session = client.session
    session[AUTH_METHOD_SESSION_KEY] = "oidc"
    session.save()

    response = client.patch(
        f"/api/admin/users/{user.id}/role/",
        {"isSuperuser": True},
        content_type="application/json",
    )

    assert response.status_code == 403
    payload = response.json()
    assert payload["error"] == "recent_authentication_required"
    assert payload["reauthenticationMethod"] == "oidc"


@pytest.mark.django_db
def test_superuser_cannot_update_own_role(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="self-role-admin",
        email="self-role-admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.patch(
        f"/api/admin/users/{admin.id}/role/",
        {"isSuperuser": False},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "admin_self_action_forbidden"
    admin.refresh_from_db()
    assert admin.is_superuser is True


@pytest.mark.django_db
@pytest.mark.parametrize("action", ["block", "unblock", "delete"])
def test_admin_cannot_manage_self(client, django_user_model, action):
    admin = django_user_model.objects.create_superuser(
        username="admin-self",
        email="admin-self@example.test",
        password="correct-password",
    )
    client.force_login(admin)

    response = client.post(
        f"/api/admin/users/{admin.id}/{action}/",
        {},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "admin_self_action_forbidden"
    assert django_user_model.objects.filter(id=admin.id).exists()


@pytest.mark.django_db
def test_admin_can_delete_another_admin(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin-actor",
        email="admin-actor@example.test",
        password="correct-password",
    )
    target = django_user_model.objects.create_superuser(
        username="admin-target",
        email="admin-target@example.test",
        password="correct-password",
    )
    target_id = target.id
    client.force_login(admin)

    response = client.post(
        f"/api/admin/users/{target_id}/delete/",
        {},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert not django_user_model.objects.filter(id=target_id).exists()
    event = AuditEvent.objects.get(event="admin.user_deleted")
    assert event.actor == admin
    assert event.subject == f"deleted-user:{target_id}"


@pytest.mark.django_db
def test_service_settings_require_superuser(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_OPEN_REGISTRATION", raising=False)
    user = django_user_model.objects.create_user(
        username="settings-user",
        email="settings-user@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.get("/api/admin/settings/")

    assert response.status_code == 403
    assert response.json()["error"] == "superuser_required"

    patch_response = client.patch(
        "/api/admin/settings/",
        {"values": {"open_registration": True}},
        content_type="application/json",
    )
    assert patch_response.status_code == 403
    assert patch_response.json()["error"] == "superuser_required"


@pytest.mark.django_db
def test_superuser_updates_and_resets_runtime_setting(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_OPEN_REGISTRATION", raising=False)
    admin = django_user_model.objects.create_superuser(
        username="settings-admin",
        email="settings-admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.patch(
        "/api/admin/settings/",
        {"values": {"open_registration": True}},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert runtime_setting("open_registration") is True
    stored = ServiceSetting.objects.values().get(key="open_registration")
    assert stored["value"] is True
    assert stored["updated_by_id"] == admin.id
    event = AuditEvent.objects.get(event="admin.settings_updated")
    assert event.payload == {"keys": ["open_registration"]}

    reset_response = client.patch(
        "/api/admin/settings/",
        {"reset": ["open_registration"]},
        content_type="application/json",
    )

    assert reset_response.status_code == 200
    assert runtime_setting("open_registration") is False
    assert not ServiceSetting.objects.filter(key="open_registration").exists()


@pytest.mark.django_db
def test_audio_transcription_setting_requires_ready_bundled_model(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_AUDIO_TRANSCRIPTION_ENABLED", raising=False)
    admin = django_user_model.objects.create_superuser(
        username="transcription-settings-admin",
        email="transcription-settings@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)
    monkeypatch.setattr(
        "apps.adminpanel.views.transcription_model_status_payload",
        lambda: {
            "engine": "faster-whisper",
            "model": "small",
            "languages": ["en", "ru"],
            "ready": False,
        },
    )

    status = client.get("/api/admin/settings/")
    rejected = client.patch(
        "/api/admin/settings/",
        {"values": {"audio_transcription_enabled": True}},
        content_type="application/json",
    )

    assert status.status_code == 200
    assert status.json()["transcription"] == {
        "engine": "faster-whisper",
        "model": "small",
        "languages": ["en", "ru"],
        "ready": False,
    }
    assert rejected.status_code == 409
    assert rejected.json()["error"] == "audio_transcription_model_unavailable"
    assert not ServiceSetting.objects.filter(key="audio_transcription_enabled").exists()

    monkeypatch.setattr(
        "apps.adminpanel.views.transcription_model_status_payload",
        lambda: {
            "engine": "faster-whisper",
            "model": "small",
            "languages": ["en", "ru"],
            "ready": True,
        },
    )
    enabled = client.patch(
        "/api/admin/settings/",
        {"values": {"audio_transcription_enabled": True}},
        content_type="application/json",
    )
    assert enabled.status_code == 200
    assert runtime_setting("audio_transcription_enabled") is True
    invalidate_runtime_setting("audio_transcription_enabled")


@pytest.mark.django_db
def test_tier_quotas_require_superuser(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="tier-quota-user",
        email="tier-quota-user@example.test",
        password="correct-password",
    )
    admin = django_user_model.objects.create_superuser(
        username="tier-quota-admin",
        email="tier-quota-admin@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.get("/api/admin/tier-quotas/")

    assert response.status_code == 403
    assert response.json()["error"] == "superuser_required"

    denied = client.patch(
        "/api/admin/tier-quotas/",
        {"values": [{"tier": "novice", "key": "books", "value": 4}]},
        content_type="application/json",
    )
    assert denied.status_code == 403

    client.force_login(admin)
    mark_recent_auth(client)
    visible = client.get("/api/admin/tier-quotas/")
    assert visible.status_code == 200
    believer = next(
        tier for tier in visible.json()["tiers"] if tier["id"] == "believer"
    )
    editor_invites = next(
        item for item in believer["quotas"] if item["key"] == "editor_invites"
    )
    assert editor_invites["default"] == 3
    assert editor_invites["value"] == 3

    updated = client.patch(
        "/api/admin/tier-quotas/",
        {"values": [{"tier": "novice", "key": "editor_invites", "value": 4}]},
        content_type="application/json",
    )

    assert updated.status_code == 200
    assert TierQuotaOverride.objects.get(tier="novice", key="editor_invites").value == 4
    changed = next(tier for tier in updated.json()["tiers"] if tier["id"] == "novice")
    assert (
        next(item for item in changed["quotas"] if item["key"] == "editor_invites")[
            "source"
        ]
        == "database"
    )

    reset = client.patch(
        "/api/admin/tier-quotas/",
        {"reset": [{"tier": "novice", "key": "editor_invites"}]},
        content_type="application/json",
    )

    assert reset.status_code == 200
    assert not TierQuotaOverride.objects.filter(
        tier="novice",
        key="editor_invites",
    ).exists()


@pytest.mark.django_db
def test_tier_progression_policy_permissions_validation_and_disable_reset(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="progression-user",
        password="correct-password",
    )
    admin = django_user_model.objects.create_superuser(
        username="progression-admin",
        password="correct-password",
    )
    writer = django_user_model.objects.create_user(username="progression-writer")
    client.force_login(user)

    visible = client.get("/api/admin/tier-progression/")
    assert visible.status_code == 403
    assert visible.json()["error"] == "superuser_required"
    denied = client.patch(
        "/api/admin/tier-progression/",
        {"enabled": True, "noviceToAuthorDays": 30, "authorToBelieverDays": 60},
        content_type="application/json",
    )
    assert denied.status_code == 403

    client.force_login(admin)
    recent_required = client.patch(
        "/api/admin/tier-progression/",
        {"enabled": True, "noviceToAuthorDays": 30, "authorToBelieverDays": 60},
        content_type="application/json",
    )
    assert recent_required.status_code == 403
    assert recent_required.json()["error"] == "recent_authentication_required"
    mark_recent_auth(client)

    invalid = client.patch(
        "/api/admin/tier-progression/",
        {"enabled": True, "noviceToAuthorDays": 0, "authorToBelieverDays": 60},
        content_type="application/json",
    )
    assert invalid.status_code == 400
    assert TierProgressionPolicy.objects.get(pk=1).enabled is False

    enabled = client.patch(
        "/api/admin/tier-progression/",
        {"enabled": True, "noviceToAuthorDays": 30, "authorToBelieverDays": 60},
        content_type="application/json",
    )
    assert enabled.status_code == 200
    TierActivityProgress.objects.create(user=writer, tier=writer.tier, active_days=12)

    disabled = client.patch(
        "/api/admin/tier-progression/",
        {"enabled": False, "noviceToAuthorDays": 30, "authorToBelieverDays": 60},
        content_type="application/json",
    )
    assert disabled.status_code == 200
    assert not TierActivityProgress.objects.exists()
    assert (
        AuditEvent.objects.filter(
            event="admin.tier_progression_updated",
            actor=admin,
        ).count()
        == 2
    )


@pytest.mark.django_db
def test_service_setting_update_requires_recent_authentication(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_OPEN_REGISTRATION", raising=False)
    admin = django_user_model.objects.create_superuser(
        username="settings-reauth",
        email="settings-reauth@example.test",
        password="correct-password",
    )
    client.force_login(admin)

    response = client.patch(
        "/api/admin/settings/",
        {"values": {"open_registration": True}},
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "recent_authentication_required"


@pytest.mark.django_db
def test_environment_owned_setting_is_locked(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.setenv("QUILLUM_OPEN_REGISTRATION", "false")
    admin = django_user_model.objects.create_superuser(
        username="settings-locked",
        email="settings-locked@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    get_response = client.get("/api/admin/settings/")
    registration = next(
        item for item in get_response.json()["items"] if item["key"] == "open_registration"
    )
    assert registration["source"] == "environment"
    assert registration["locked"] is True
    assert registration["editable"] is False

    patch_response = client.patch(
        "/api/admin/settings/",
        {"values": {"open_registration": True}},
        content_type="application/json",
    )
    assert patch_response.status_code == 409
    assert patch_response.json()["error"] == "setting_locked"


@pytest.mark.django_db
def test_only_superuser_can_disable_local_login(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_LOCAL_PASSWORD_LOGIN_ENABLED", raising=False)
    monkeypatch.delenv("QUILLUM_OPEN_REGISTRATION", raising=False)
    admin = django_user_model.objects.create_superuser(
        username="only-superuser",
        email="only-superuser@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.patch(
        "/api/admin/settings/",
        {"values": {"local_password_login_enabled": False}},
        content_type="application/json",
    )

    assert response.status_code == 200
    setting = next(
        item for item in response.json()["items"] if item["key"] == "local_password_login_enabled"
    )
    assert setting["value"] is False


@pytest.mark.django_db
def test_disabling_local_login_accepts_another_active_superuser(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_LOCAL_PASSWORD_LOGIN_ENABLED", raising=False)
    monkeypatch.delenv("QUILLUM_OPEN_REGISTRATION", raising=False)
    admin = django_user_model.objects.create_superuser(
        username="acting-superuser",
        email="acting-superuser@example.test",
        password="correct-password",
    )
    django_user_model.objects.create_superuser(
        username="backup-superuser",
        email="backup-superuser@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.patch(
        "/api/admin/settings/",
        {"values": {"local_password_login_enabled": False}},
        content_type="application/json",
    )

    assert response.status_code == 200
    setting = next(
        item for item in response.json()["items"] if item["key"] == "local_password_login_enabled"
    )
    assert setting["value"] is False


@pytest.mark.django_db
def test_runtime_setting_validation_is_atomic(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_OPEN_REGISTRATION", raising=False)
    monkeypatch.delenv("QUILLUM_RECENT_AUTH_TTL_SECONDS", raising=False)
    admin = django_user_model.objects.create_superuser(
        username="settings-validation",
        email="settings-validation@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.patch(
        "/api/admin/settings/",
        {
            "values": {
                "open_registration": True,
                "recent_auth_ttl_seconds": 1,
            }
        },
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "setting_value_invalid"
    assert not ServiceSetting.objects.exists()


@pytest.mark.django_db
def test_superuser_configures_smtp_without_exposing_password(
    client,
    django_user_model,
    monkeypatch,
):
    for env_name in (
        "DJANGO_EMAIL_BACKEND",
        "DJANGO_EMAIL_HOST",
        "DJANGO_EMAIL_PORT",
        "DJANGO_EMAIL_HOST_USER",
        "DJANGO_EMAIL_HOST_PASSWORD",
        "DJANGO_EMAIL_USE_TLS",
        "DJANGO_EMAIL_USE_SSL",
        "DJANGO_DEFAULT_FROM_EMAIL",
    ):
        monkeypatch.delenv(env_name, raising=False)
    admin = django_user_model.objects.create_superuser(
        username="email-settings-admin",
        email="email-settings-admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.patch(
        "/api/admin/settings/",
        {
            "values": {
                "email_backend": "smtp",
                "email_host": "smtp.example.test",
                "email_port": 587,
                "email_host_user": "quillum",
                "email_host_password": "smtp-password",
                "email_use_tls": True,
                "email_use_ssl": False,
                "email_default_from": "Quillum <noreply@example.test>",
            }
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    password = next(
        item for item in response.json()["items"] if item["key"] == "email_host_password"
    )
    assert password["value"] is None
    assert password["configured"] is True
    assert password["secret"] is True
    assert password["source"] == "database"
    stored = ServiceSetting.objects.get(key="email_host_password")
    assert stored.value == "smtp-password"
    assert stored.value == "smtp-password"


@pytest.mark.django_db
def test_email_tls_modes_are_mutually_exclusive(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("DJANGO_EMAIL_USE_TLS", raising=False)
    monkeypatch.delenv("DJANGO_EMAIL_USE_SSL", raising=False)
    admin = django_user_model.objects.create_superuser(
        username="email-tls-admin",
        email="email-tls-admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.patch(
        "/api/admin/settings/",
        {
            "values": {
                "email_use_tls": True,
                "email_use_ssl": True,
            }
        },
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "settings_combination_invalid"
    assert not ServiceSetting.objects.filter(key__in=["email_use_tls", "email_use_ssl"]).exists()


@pytest.mark.django_db
def test_superuser_sends_email_configuration_test(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("DJANGO_DEFAULT_FROM_EMAIL", raising=False)
    admin = django_user_model.objects.create_superuser(
        username="email-test-admin",
        email="email-test-admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.post(
        "/api/admin/settings/email/test/",
        {"recipient": "operator@example.test"},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "sent": 1}
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["operator@example.test"]
    assert mail.outbox[0].subject == "Quillum email configuration test"
    assert mail.outbox[0].body.startswith("Quillum\n\nEmail delivery is configured")
    assert len(mail.outbox[0].alternatives) == 1
    html_body, mimetype = mail.outbox[0].alternatives[0]
    assert mimetype == "text/html"
    assert "Email delivery is configured" in html_body
    assert AuditEvent.objects.filter(
        event="admin.email_test_succeeded",
        actor=admin,
    ).exists()


@pytest.mark.django_db
def test_maintenance_requires_superuser(client, django_user_model):
    assert client.get("/api/admin/maintenance/").status_code == 401
    assert client.post("/api/admin/maintenance/news/refresh/").status_code == 401

    user = django_user_model.objects.create_user(
        username="maintenance-user",
        password="correct-password",
    )
    client.force_login(user)

    assert client.get("/api/admin/maintenance/").status_code == 403
    assert client.post("/api/admin/maintenance/news/refresh/").status_code == 403


@pytest.mark.django_db
def test_superuser_can_queue_news_maintenance_and_read_status(client, django_user_model):
    cache.clear()
    admin = django_user_model.objects.create_superuser(
        username="maintenance-admin",
        email="maintenance-admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)

    with patch("apps.adminpanel.views.admin_refresh_news_sources.apply_async") as apply_async:
        response = client.post("/api/admin/maintenance/news/refresh/")

    assert response.status_code == 202
    run_payload = response.json()["run"]
    apply_async.assert_called_once_with(task_id=run_payload["taskId"])
    assert run_payload["status"] == "running"
    assert BackgroundTaskRun.objects.filter(
        task_id=run_payload["taskId"],
        task_name="apps.sources.tasks.admin_refresh_news_sources",
    ).exists()
    assert AuditEvent.objects.filter(
        event="admin.maintenance_news_refresh_requested",
        actor=admin,
        payload={"taskId": run_payload["taskId"]},
    ).exists()

    status_response = client.get("/api/admin/maintenance/")

    assert status_response.status_code == 200
    assert status_response.json()["actions"]["news"]["taskId"] == run_payload["taskId"]
    assert status_response.json()["actions"]["contests"] is None
    cache.clear()


@pytest.mark.django_db
def test_maintenance_rejects_overlapping_action(client, django_user_model):
    cache.clear()
    admin = django_user_model.objects.create_superuser(
        username="maintenance-overlap-admin",
        email="maintenance-overlap@example.test",
        password="correct-password",
    )
    client.force_login(admin)

    with (
        patch("apps.adminpanel.views.admin_refresh_contest_sources.apply_async"),
        patch("apps.adminpanel.views.admin_refresh_news_sources.apply_async"),
    ):
        first_response = client.post("/api/admin/maintenance/contests/refresh/")
        independent_response = client.post("/api/admin/maintenance/news/refresh/")
        second_response = client.post("/api/admin/maintenance/contests/refresh/")

    assert first_response.status_code == 202
    assert independent_response.status_code == 202
    assert second_response.status_code == 409
    assert second_response.json()["error"] == "maintenance_already_running"
    assert second_response.json()["run"]["taskId"] == first_response.json()["run"]["taskId"]
    cache.clear()
