import re
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pyotp
import pytest
from django.contrib.auth.hashers import check_password, make_password
from django.core import mail
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client
from django.utils import timezone
from PIL import Image

from apps.accounts.bootstrap import ensure_bootstrap_admin
from apps.accounts.models import (
    BootstrapState,
    EmailChangeRequest,
    PasskeyCredential,
    PasswordChangeRequest,
    RegistrationCounter,
    UserMediaAsset,
)
from apps.accounts.tiers import tier_quotas
from apps.accounts.views import RECENT_AUTH_SESSION_KEY
from apps.adminpanel.runtime_settings import set_runtime_override
from apps.audit.models import AuditEvent
from apps.manuscripts.models import Series


def mark_recent_auth(client) -> None:
    session = client.session
    session[RECENT_AUTH_SESSION_KEY] = timezone.now().isoformat()
    session.save()


def image_upload(name: str = "avatar.png", content_type: str = "image/png") -> SimpleUploadedFile:
    buffer = BytesIO()
    Image.new("RGB", (16, 16), color="#245b47").save(buffer, format="PNG")
    return SimpleUploadedFile(name, buffer.getvalue(), content_type=content_type)


def latest_mail_code() -> str:
    match = re.search(r"\b\d{6}\b", mail.outbox[-1].body)
    assert match is not None
    return match.group()


def latest_html_mail_body() -> str:
    assert len(mail.outbox[-1].alternatives) == 1
    html_body, mimetype = mail.outbox[-1].alternatives[0]
    assert mimetype == "text/html"
    return html_body


def totp_secret(response) -> str:
    payload = response.json()
    assert "devSecret" not in payload
    values = parse_qs(urlparse(payload["provisioningUri"]).query).get("secret")
    assert values
    return values[0]


@pytest.mark.django_db
def test_bootstrap_admin_created_when_no_users_exist(django_user_model, settings):
    settings.QUILLUM_BOOTSTRAP_ADMIN_ENABLED = True
    settings.QUILLUM_BOOTSTRAP_ADMIN_USERNAME = "admin"
    settings.QUILLUM_BOOTSTRAP_ADMIN_EMAIL = "admin@localhost"
    settings.QUILLUM_BOOTSTRAP_ADMIN_PASSWORD = "changeme"

    ensure_bootstrap_admin(django_user_model)
    user = django_user_model.objects.get(username="admin")

    assert user.email == "admin@localhost"
    assert user.is_superuser is True
    assert user.is_staff is True
    assert user.password != "changeme"
    assert user.check_password("changeme")
    assert BootstrapState.objects.get().completed_at is not None

    user.delete()
    ensure_bootstrap_admin(django_user_model)

    assert not django_user_model.objects.exists()


@pytest.mark.django_db
def test_new_users_ignore_legacy_staff_flag_while_superusers_use_god(
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="tier-user",
        email="tier-user@example.test",
        password="correct-password",
    )
    legacy_flag_user = django_user_model.objects.create_user(
        username="tier-legacy-flag",
        email="tier-legacy-flag@example.test",
        password="correct-password",
        is_staff=True,
    )
    administrator = django_user_model.objects.create_superuser(
        username="tier-administrator",
        email="tier-administrator@example.test",
        password="correct-password",
    )

    assert user.tier == "novice"
    assert legacy_flag_user.tier == "novice"
    assert legacy_flag_user.is_staff is False
    assert administrator.tier == "god"


@pytest.mark.django_db
def test_tier_endpoint_returns_current_usage(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="tier-profile",
        email="tier-profile@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.get("/api/auth/tier/")

    assert response.status_code == 200
    payload = response.json()["tier"]
    assert payload["tier"] == "novice"
    assert next(item for item in payload["quotas"] if item["key"] == "books")[
        "limit"
    ] == 3
    editor_invites = next(
        item for item in payload["quotas"] if item["key"] == "editor_invites"
    )
    assert editor_invites == {
        "key": "editor_invites",
        "label": "Editor invitations",
        "used": 0,
        "limit": 1,
    }


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("tier", "limit"),
    [
        ("novice", 1),
        ("author", 2),
        ("believer", 3),
        ("god", 5),
    ],
)
def test_editor_invitation_default_quota_follows_tier(tier, limit):
    assert tier_quotas(tier)["editor_invites"] == limit


@pytest.mark.django_db
def test_login_requires_valid_credentials(client, django_user_model):
    django_user_model.objects.create_user(username="writer", password="correct-password")

    response = client.post(
        "/api/auth/login/",
        {"username": "writer", "password": "wrong-password"},
        content_type="application/json",
    )

    assert response.status_code == 401
    assert response.json()["error"] == "invalid_credentials"
    assert AuditEvent.objects.filter(event="auth.login_failed").exists()


@pytest.mark.django_db
def test_login_remember_controls_session_expiry(client, django_user_model):
    django_user_model.objects.create_user(username="writer", password="correct-password")

    response = client.post(
        "/api/auth/login/",
        {"username": "writer", "password": "correct-password", "remember": False},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert client.session.get_expire_at_browser_close() is True

    client.post("/api/auth/logout/", {}, content_type="application/json")
    response = client.post(
        "/api/auth/login/",
        {"username": "writer", "password": "correct-password", "remember": True},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert client.session.get_expire_at_browser_close() is False


@pytest.mark.django_db
def test_blocked_account_gets_specific_error_only_with_valid_password(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="blocked-writer",
        email="blocked@example.test",
        password="correct-password",
        is_active=False,
    )

    wrong_response = client.post(
        "/api/auth/login/",
        {"username": user.username, "password": "wrong-password"},
        content_type="application/json",
    )
    blocked_response = client.post(
        "/api/auth/login/",
        {"username": user.username, "password": "correct-password"},
        content_type="application/json",
    )

    assert wrong_response.status_code == 401
    assert wrong_response.json()["error"] == "invalid_credentials"
    assert blocked_response.status_code == 403
    assert blocked_response.json()["error"] == "account_blocked"
    assert AuditEvent.objects.filter(event="auth.login_blocked", actor=user).exists()


@pytest.mark.django_db
def test_account_delete_requires_valid_password(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/auth/account/delete/",
        {"password": "wrong-password"},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "current_password_invalid"
    assert django_user_model.objects.filter(id=user.id).exists()


@pytest.mark.django_db
def test_account_delete_removes_user_data_and_all_sessions(
    client,
    django_user_model,
    django_capture_on_commit_callbacks,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    PasskeyCredential.objects.create(user=user, name="Device")
    PasswordChangeRequest.objects.create(
        user=user,
        password_hash=make_password("new-password"),
        code_hash=make_password("123456"),
        expires_at=timezone.now() + timedelta(minutes=10),
    )
    EmailChangeRequest.objects.create(
        user=user,
        new_email="pending@example.test",
        code_hash=make_password("123456"),
        expires_at=timezone.now() + timedelta(minutes=10),
    )
    second_client = Client()
    client.force_login(user)
    second_client.force_login(user)
    avatar_response = client.post(
        "/api/auth/profile/avatar/",
        {"avatar": image_upload()},
    )
    assert avatar_response.status_code == 200
    user.refresh_from_db()
    avatar_path = user.avatar.path
    series_response = client.post(
        "/api/manuscripts/series/",
        {"title": "Private Series", "cover": image_upload("series.png")},
    )
    assert series_response.status_code == 201
    series_id = series_response.json()["series"]["id"]
    series = Series.objects.select_related("cover_media").get(public_id=series_id)
    series_cover_path = series.cover_media.original.path

    with django_capture_on_commit_callbacks(execute=True):
        response = client.post(
            "/api/auth/account/delete/",
            {"password": "correct-password"},
            content_type="application/json",
        )

    assert response.status_code == 200
    assert not django_user_model.objects.filter(id=user.id).exists()
    assert not PasskeyCredential.objects.filter(user_id=user.id).exists()
    assert not EmailChangeRequest.objects.filter(user_id=user.id).exists()
    assert not PasswordChangeRequest.objects.filter(user_id=user.id).exists()
    assert not Series.objects.filter(id=series.id).exists()
    assert not UserMediaAsset.objects.filter(owner_id=user.id).exists()
    assert not Path(avatar_path).exists()
    assert not Path(series_cover_path).exists()
    assert client.get("/api/auth/session/").json()["authenticated"] is False
    assert second_client.get("/api/auth/session/").json()["authenticated"] is False
    deletion_event = AuditEvent.objects.get(event="auth.account_deleted")
    assert deletion_event.actor is None
    assert deletion_event.subject == f"deleted-user:{user.id}"
    assert deletion_event.ip_address is None
    assert deletion_event.user_agent == ""

    replacement = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="new-password",
    )
    assert replacement.id != user.id


@pytest.mark.django_db
def test_registration_closed_after_first_admin_by_default(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_OPEN_REGISTRATION", raising=False)
    set_runtime_override("open_registration", False)
    django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )

    response = client.post(
        "/api/auth/register/",
        {
            "username": "writer",
            "email": "writer@example.test",
            "password": "long-development-password1!",
        },
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "registration_closed"


@pytest.mark.django_db
def test_registration_creates_user_when_enabled(client, django_user_model, monkeypatch):
    monkeypatch.delenv("QUILLUM_OPEN_REGISTRATION", raising=False)
    set_runtime_override("open_registration", True)
    django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )

    response = client.post(
        "/api/auth/register/",
        {
            "username": "writer",
            "email": "writer@example.test",
            "displayName": "Writer Name",
            "password": "long-development-password1!",
            "language": "ru",
            "theme": "dark",
        },
        content_type="application/json",
    )

    assert response.status_code == 201
    user = django_user_model.objects.get(username="writer")
    assert user.display_name == "Writer Name"
    assert user.language == "ru"
    assert user.theme == "dark"
    assert user.onboarding_completed_at is None
    assert response.json()["user"]["onboardingCompleted"] is False
    assert user.check_password("long-development-password1!")
    assert AuditEvent.objects.filter(event="auth.user_registered").exists()
    assert RegistrationCounter.objects.get(pk=1).total_registrations == 1


@pytest.mark.django_db
def test_existing_users_default_to_completed_onboarding(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="existing-writer",
        password="development-password",
    )
    client.force_login(user)

    response = client.get("/api/auth/session/")

    assert user.onboarding_completed_at is not None
    assert response.json()["user"]["onboardingCompleted"] is True


@pytest.mark.django_db
def test_complete_onboarding_updates_profile_atomically(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="new-writer",
        password="development-password",
        timezone="UTC",
        onboarding_completed_at=None,
    )
    client.force_login(user)

    with patch("apps.notifications.user_rules.reschedule_user_rules") as reschedule:
        response = client.post(
            "/api/auth/onboarding/complete/",
            {
                "language": "ru",
                "timezone": "Europe/Moscow",
                "theme": "dark",
                "displayName": "New Writer",
                "authorName": "N. Writer",
                "authorWebsite": "https://writer.example.test",
                "authorTodayProfile": "https://author.today/u/writer",
                "authorLitresProfile": "https://litres.ru/author/writer/",
                "authorProzaProfile": "https://proza.ru/avtor/writer",
                "authorSamizdatProfile": "https://samlib.ru/w/writer/",
                "authorCellulosaProfile": "https://zelluloza.ru/authors/writer/",
                "authorWattpadProfile": "https://www.wattpad.com/user/writer",
            },
            content_type="application/json",
        )

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.onboarding_completed_at is not None
    assert user.language == "ru"
    assert user.timezone == "Europe/Moscow"
    assert user.theme == "dark"
    assert user.display_name == "New Writer"
    assert user.author_name == "N. Writer"
    assert user.author_wattpad_profile == "https://www.wattpad.com/user/writer"
    assert response.json()["user"]["onboardingCompleted"] is True
    reschedule.assert_called_once_with(user)
    assert AuditEvent.objects.filter(event="auth.onboarding_completed", actor=user).exists()


@pytest.mark.django_db
def test_complete_onboarding_rejects_invalid_values_without_partial_update(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="new-writer",
        password="development-password",
        onboarding_completed_at=None,
    )
    client.force_login(user)

    response = client.post(
        "/api/auth/onboarding/complete/",
        {
            "language": "ru",
            "timezone": "Invalid/Timezone",
            "theme": "dark",
            "displayName": "Changed",
        },
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "timezone_invalid"
    user.refresh_from_db()
    assert user.onboarding_completed_at is None
    assert user.language == "en"
    assert user.display_name == ""


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("field", "value", "error"),
    [
        ("language", "de", "language_unsupported"),
        ("theme", "midnight", "theme_unsupported"),
        ("displayName", "x" * 161, "display_name_too_long"),
    ],
)
def test_complete_onboarding_validates_profile_choices(
    client,
    django_user_model,
    field,
    value,
    error,
):
    user = django_user_model.objects.create_user(
        username=f"new-{field}",
        password="development-password",
        onboarding_completed_at=None,
    )
    client.force_login(user)
    payload = {
        "language": "en",
        "timezone": "UTC",
        "theme": "system",
        "displayName": "Writer",
        field: value,
    }

    response = client.post(
        "/api/auth/onboarding/complete/",
        payload,
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == error
    user.refresh_from_db()
    assert user.onboarding_completed_at is None


@pytest.mark.django_db
def test_complete_onboarding_is_idempotent(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="existing-writer",
        password="development-password",
        display_name="Existing name",
    )
    completed_at = user.onboarding_completed_at
    client.force_login(user)

    response = client.post(
        "/api/auth/onboarding/complete/",
        {
            "language": "ru",
            "timezone": "Europe/Moscow",
            "theme": "dark",
            "displayName": "Replacement",
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.display_name == "Existing name"
    assert user.onboarding_completed_at == completed_at
    assert not AuditEvent.objects.filter(event="auth.onboarding_completed", actor=user).exists()


@pytest.mark.django_db
def test_profile_update_changes_display_name_and_language(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="old-development-password",
    )
    client.force_login(user)

    response = client.patch(
        "/api/auth/profile/",
        {
            "displayName": "New Writer",
            "language": "ru",
            "theme": "light",
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.email == "writer@example.test"
    assert user.display_name == "New Writer"
    assert user.language == "ru"
    assert user.theme == "light"
    assert user.check_password("old-development-password")
    assert AuditEvent.objects.filter(event="auth.profile_updated").exists()


@pytest.mark.django_db
def test_profile_rejects_unsupported_theme(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="theme-writer",
        email="theme-writer@example.test",
        password="old-development-password",
    )
    client.force_login(user)

    response = client.patch(
        "/api/auth/profile/",
        {"theme": "midnight"},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "theme_unsupported"
    user.refresh_from_db()
    assert user.theme == "system"


@pytest.mark.django_db
def test_profile_rejects_direct_password_change(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="old-development-password",
    )
    client.force_login(user)

    response = client.patch(
        "/api/auth/profile/",
        {
            "currentPassword": "old-development-password",
            "newPassword": "new-development-password1!",
        },
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "password_change_endpoint_required"
    user.refresh_from_db()
    assert user.check_password("old-development-password")


@pytest.mark.django_db
def test_avatar_upload_rejects_invalid_image_content(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    upload = SimpleUploadedFile("avatar.png", b"not an image", content_type="image/png")

    response = client.post("/api/auth/profile/avatar/", {"avatar": upload})

    assert response.status_code == 400
    assert response.json()["error"] == "avatar_invalid_image"
    user.refresh_from_db()
    assert not user.avatar


@pytest.mark.django_db
def test_avatar_upload_rejects_disallowed_image_format(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    buffer = BytesIO()
    Image.new("RGB", (16, 16), color="#245b47").save(buffer, format="BMP")
    upload = SimpleUploadedFile("avatar.png", buffer.getvalue(), content_type="image/png")

    response = client.post("/api/auth/profile/avatar/", {"avatar": upload})

    assert response.status_code == 400
    assert response.json()["error"] == "avatar_invalid_image"
    user.refresh_from_db()
    assert not user.avatar


@pytest.mark.django_db
def test_avatar_upload_normalizes_image_to_webp(client, django_user_model, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)

    response = client.post("/api/auth/profile/avatar/", {"avatar": image_upload()})

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.avatar.name.endswith(".webp")
    assert user.avatar.file.read(12).startswith(b"RIFF")

    content_response = client.get(f"/api/auth/profile/avatar/{user.id}/")
    content = b"".join(content_response.streaming_content)
    assert content_response.status_code == 200
    assert content.startswith(b"RIFF")
    assert content_response["Cache-Control"] == "private, no-cache"
    assert content_response["ETag"]

    revalidated = client.get(
        f"/api/auth/profile/avatar/{user.id}/",
        headers={"If-None-Match": content_response["ETag"]},
    )
    assert revalidated.status_code == 304
    assert revalidated["ETag"] == content_response["ETag"]


@pytest.mark.django_db
def test_email_change_requires_confirmation(client, django_user_model, settings):
    settings.DEBUG = True
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)

    request_response = client.post(
        "/api/auth/profile/email/request/",
        {"email": "new-writer@example.test"},
        content_type="application/json",
    )

    assert request_response.status_code == 200
    assert "devCode" not in request_response.json()
    user.refresh_from_db()
    assert user.email == "writer@example.test"
    assert len(mail.outbox) == 1
    assert mail.outbox[-1].subject == "Confirm your Quillum email address"
    html_body = latest_html_mail_body()
    assert "Confirm your email address" in html_body
    assert "border-left:" not in html_body
    assert "<span style=" not in html_body

    pending = EmailChangeRequest.objects.get(user=user)
    assert pending.new_email == "new-writer@example.test"
    assert check_password(latest_mail_code(), pending.code_hash)
    assert not check_password("000000", pending.code_hash)


@pytest.mark.django_db
def test_email_change_request_requires_recent_auth(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/auth/profile/email/request/",
        {"email": "new-writer@example.test"},
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "recent_authentication_required"
    assert not EmailChangeRequest.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_reauthentication_allows_sensitive_action(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/auth/reauthenticate/",
        {"password": "development-password"},
        content_type="application/json",
    )
    email_response = client.post(
        "/api/auth/profile/email/request/",
        {"email": "new-writer@example.test"},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert email_response.status_code == 200
    assert AuditEvent.objects.filter(event="auth.reauthentication_succeeded").exists()


@pytest.mark.django_db
def test_reauthentication_rejects_invalid_password(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/auth/reauthenticate/",
        {"password": "wrong-password"},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "current_password_invalid"
    assert RECENT_AUTH_SESSION_KEY not in client.session
    assert AuditEvent.objects.filter(event="auth.reauthentication_failed").exists()


@pytest.mark.django_db
def test_email_change_confirm_updates_email(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    pending = EmailChangeRequest.objects.create(
        user=user,
        new_email="new-writer@example.test",
        code_hash=make_password("123456"),
        expires_at=timezone.now() + timedelta(minutes=10),
    )
    client.force_login(user)

    response = client.post(
        "/api/auth/profile/email/confirm/",
        {"code": "123456"},
        content_type="application/json",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    pending.refresh_from_db()
    assert user.email == "new-writer@example.test"
    assert pending.consumed_at is not None


@pytest.mark.django_db
def test_email_change_code_consumed_after_too_many_invalid_attempts(
    client,
    django_user_model,
    monkeypatch,
):
    monkeypatch.delenv("QUILLUM_CONFIRMATION_CODE_MAX_ATTEMPTS", raising=False)
    set_runtime_override("confirmation_code_max_attempts", 2)
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    pending = EmailChangeRequest.objects.create(
        user=user,
        new_email="new-writer@example.test",
        code_hash=make_password("123456"),
        expires_at=timezone.now() + timedelta(minutes=10),
    )
    client.force_login(user)

    first_response = client.post(
        "/api/auth/profile/email/confirm/",
        {"code": "000000"},
        content_type="application/json",
    )
    second_response = client.post(
        "/api/auth/profile/email/confirm/",
        {"code": "000000"},
        content_type="application/json",
    )

    assert first_response.status_code == 400
    assert first_response.json()["error"] == "email_change_code_invalid"
    assert second_response.status_code == 400
    assert second_response.json()["error"] == "email_change_code_attempts_exceeded"
    pending.refresh_from_db()
    assert pending.attempt_count == 2
    assert pending.consumed_at is not None


@pytest.mark.django_db
def test_password_change_requires_email_confirmation(client, django_user_model, settings):
    settings.DEBUG = True
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="old-development-password",
        language="ru",
    )
    client.force_login(user)
    mark_recent_auth(client)

    request_response = client.post(
        "/api/auth/security/password/request/",
        {
            "currentPassword": "old-development-password",
            "newPassword": "new-development-password1!",
        },
        content_type="application/json",
    )

    assert request_response.status_code == 200
    assert "devCode" not in request_response.json()
    code = latest_mail_code()
    html_body = latest_html_mail_body()
    assert mail.outbox[-1].subject == "Подтвердите смену пароля Quillum"
    assert "<html lang=\"ru\">" in html_body
    assert "Подтвердите смену пароля" in html_body
    assert code in html_body
    user.refresh_from_db()
    assert user.check_password("old-development-password")
    assert len(mail.outbox) == 1
    pending = PasswordChangeRequest.objects.get(user=user)
    assert pending.password_hash != "new-development-password1!"

    confirm_response = client.post(
        "/api/auth/security/password/confirm/",
        {"code": code},
        content_type="application/json",
    )

    assert confirm_response.status_code == 200
    user.refresh_from_db()
    pending.refresh_from_db()
    assert user.check_password("new-development-password1!")
    assert pending.consumed_at is not None
    assert AuditEvent.objects.filter(event="auth.password_changed").exists()


@pytest.mark.django_db
def test_password_change_returns_validation_messages(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="old-development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)

    response = client.post(
        "/api/auth/security/password/request/",
        {
            "currentPassword": "old-development-password",
            "newPassword": "short",
        },
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "password_validation_failed"
    assert response.json()["messages"]
    user.refresh_from_db()
    assert user.check_password("old-development-password")


@pytest.mark.django_db
def test_password_reset_flow_sets_new_password(client, django_user_model, settings):
    settings.DEBUG = True
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="old-development-password",
    )

    request_response = client.post(
        "/api/auth/password-reset/request/",
        {"email": "writer@example.test"},
        content_type="application/json",
    )

    assert request_response.status_code == 200
    assert len(mail.outbox) == 1
    assert mail.outbox[-1].subject == "Reset your Quillum password"
    assert "devCode" not in request_response.json()
    code = latest_mail_code()
    html_body = latest_html_mail_body()
    assert "<html lang=\"en\">" in html_body
    assert code in html_body

    verify_response = client.post(
        "/api/auth/password-reset/verify/",
        {"email": "writer@example.test", "code": code},
        content_type="application/json",
    )

    assert verify_response.status_code == 200

    confirm_response = client.post(
        "/api/auth/password-reset/confirm/",
        {
            "email": "writer@example.test",
            "code": code,
            "newPassword": "reset-development-password1!",
        },
        content_type="application/json",
    )

    assert confirm_response.status_code == 200
    user.refresh_from_db()
    assert user.check_password("reset-development-password1!")
    assert AuditEvent.objects.filter(event="auth.password_reset_confirmed").exists()

    reused_response = client.post(
        "/api/auth/password-reset/verify/",
        {"email": "writer@example.test", "code": code},
        content_type="application/json",
    )

    assert reused_response.status_code == 400


@pytest.mark.django_db
def test_password_reset_request_does_not_reveal_unknown_email(client, settings):
    settings.DEBUG = True
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"

    response = client.post(
        "/api/auth/password-reset/request/",
        {"email": "missing@example.test"},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert len(mail.outbox) == 0


@pytest.mark.django_db
def test_password_change_request_requires_recent_auth(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="old-development-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/auth/security/password/request/",
        {
            "currentPassword": "old-development-password",
            "newPassword": "new-development-password1!",
        },
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "recent_authentication_required"
    assert not PasswordChangeRequest.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_login_rate_limit_blocks_repeated_failures(client, django_user_model, monkeypatch):
    cache.clear()
    monkeypatch.delenv("QUILLUM_LOGIN_IP_RATE_LIMIT", raising=False)
    monkeypatch.delenv("QUILLUM_LOGIN_ACCOUNT_RATE_LIMIT", raising=False)
    set_runtime_override("login_ip_rate_limit", "20/hour")
    set_runtime_override("login_account_rate_limit", "2/15m")
    django_user_model.objects.create_user(username="writer", password="correct-password")

    for _index in range(2):
        response = client.post(
            "/api/auth/login/",
            {"username": "writer", "password": "wrong-password"},
            content_type="application/json",
        )
        assert response.status_code == 401

    blocked_response = client.post(
        "/api/auth/login/",
        {"username": "writer", "password": "wrong-password"},
        content_type="application/json",
    )

    assert blocked_response.status_code == 429
    assert blocked_response.json()["error"] == "rate_limited"


@pytest.mark.django_db
def test_password_confirmation_rate_limit_blocks_repeated_failures(
    client,
    django_user_model,
    monkeypatch,
):
    cache.clear()
    monkeypatch.delenv("QUILLUM_CODE_CONFIRM_RATE_LIMIT", raising=False)
    set_runtime_override("code_confirm_rate_limit", "2/15m")
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="old-development-password",
    )
    PasswordChangeRequest.objects.create(
        user=user,
        password_hash=make_password("new-development-password"),
        code_hash=make_password("123456"),
        expires_at=timezone.now() + timedelta(minutes=10),
    )
    client.force_login(user)

    for _index in range(2):
        response = client.post(
            "/api/auth/security/password/confirm/",
            {"code": "000000"},
            content_type="application/json",
        )
        assert response.status_code == 400

    blocked_response = client.post(
        "/api/auth/security/password/confirm/",
        {"code": "000000"},
        content_type="application/json",
    )

    assert blocked_response.status_code == 429
    assert blocked_response.json()["error"] == "rate_limited"


@pytest.mark.django_db
def test_profile_update_changes_author_profile(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)

    response = client.patch(
        "/api/auth/profile/",
        {
            "authorName": "V. Writer",
            "authorEmail": "author@example.test",
            "authorWebsite": "https://example.test",
            "authorTodayProfile": "https://author.today/u/writer",
            "authorLitresProfile": "https://litres.ru/author/writer/",
            "authorProzaProfile": "https://proza.ru/avtor/writer",
            "authorSamizdatProfile": "https://samlib.ru/w/writer/",
            "authorCellulosaProfile": "https://zelluloza.ru/authors/writer/",
            "authorWattpadProfile": "https://www.wattpad.com/user/writer",
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.author_name == "V. Writer"
    assert user.author_email == "author@example.test"
    assert user.author_website == "https://example.test"
    assert user.author_today_profile == "https://author.today/u/writer"
    assert user.author_litres_profile == "https://litres.ru/author/writer/"
    assert user.author_proza_profile == "https://proza.ru/avtor/writer"
    assert user.author_samizdat_profile == "https://samlib.ru/w/writer/"
    assert user.author_cellulosa_profile == "https://zelluloza.ru/authors/writer/"
    assert user.author_wattpad_profile == "https://www.wattpad.com/user/writer"
    assert response.json()["user"]["authorName"] == "V. Writer"
    assert response.json()["user"]["authorLitresProfile"] == "https://litres.ru/author/writer/"
    assert AuditEvent.objects.filter(event="auth.profile_updated").exists()


@pytest.mark.django_db
def test_security_settings_store_two_factor_method(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)

    response = client.patch(
        "/api/auth/security/",
        {"twoFactorMethod": "email"},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "two_factor_setup_required"
    user.refresh_from_db()
    assert user.two_factor_method == "none"


@pytest.mark.django_db
def test_security_settings_allow_disabling_two_factor(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
        two_factor_method="email",
    )
    client.force_login(user)
    mark_recent_auth(client)

    response = client.patch(
        "/api/auth/security/",
        {"twoFactorMethod": "none"},
        content_type="application/json",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.two_factor_method == "none"
    assert response.json()["twoFactorMethod"] == "none"


@pytest.mark.django_db
def test_totp_setup_confirm_enables_totp(client, django_user_model, settings):
    settings.DEBUG = True
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)

    start_response = client.post(
        "/api/auth/security/totp/start/",
        {},
        content_type="application/json",
    )

    assert start_response.status_code == 200
    start_payload = start_response.json()
    assert start_payload["provisioningUri"].startswith("otpauth://totp/")
    code = pyotp.TOTP(totp_secret(start_response)).now()

    confirm_response = client.post(
        "/api/auth/security/totp/confirm/",
        {"code": code},
        content_type="application/json",
    )

    assert confirm_response.status_code == 200
    user.refresh_from_db()
    assert user.two_factor_method == "totp"
    assert user.totp_secret
    assert user.totp_confirmed_at is not None
    assert confirm_response.json()["security"]["totpEnabled"] is True
    assert confirm_response.json()["user"]["twoFactorMethod"] == "totp"


@pytest.mark.django_db
def test_totp_login_requires_second_step(client, django_user_model, settings):
    settings.DEBUG = True
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)
    start_response = client.post(
        "/api/auth/security/totp/start/",
        {},
        content_type="application/json",
    )
    secret = totp_secret(start_response)
    client.post(
        "/api/auth/security/totp/confirm/",
        {"code": pyotp.TOTP(secret).now()},
        content_type="application/json",
    )
    client.post("/api/auth/logout/", {}, content_type="application/json")

    password_response = client.post(
        "/api/auth/login/",
        {"username": "writer", "password": "development-password"},
        content_type="application/json",
    )
    session_response = client.get("/api/auth/session/")

    assert password_response.status_code == 200
    assert password_response.json() == {"twoFactorRequired": True, "method": "totp"}
    assert session_response.json()["authenticated"] is False

    code_response = client.post(
        "/api/auth/login/2fa/",
        {"code": pyotp.TOTP(secret).now()},
        content_type="application/json",
    )

    assert code_response.status_code == 200
    assert code_response.json()["user"]["username"] == "writer"
    assert client.get("/api/auth/session/").json()["authenticated"] is True


@pytest.mark.django_db
def test_totp_login_rejects_invalid_code(client, django_user_model, settings):
    settings.DEBUG = True
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)
    start_response = client.post(
        "/api/auth/security/totp/start/",
        {},
        content_type="application/json",
    )
    client.post(
        "/api/auth/security/totp/confirm/",
        {"code": pyotp.TOTP(totp_secret(start_response)).now()},
        content_type="application/json",
    )
    client.post("/api/auth/logout/", {}, content_type="application/json")
    client.post(
        "/api/auth/login/",
        {"username": "writer", "password": "development-password"},
        content_type="application/json",
    )

    response = client.post(
        "/api/auth/login/2fa/",
        {"code": "000000"},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "two_factor_code_invalid"
    assert client.get("/api/auth/session/").json()["authenticated"] is False


@pytest.mark.django_db
def test_totp_disable_clears_secret(client, django_user_model, settings):
    settings.DEBUG = True
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)
    start_response = client.post(
        "/api/auth/security/totp/start/",
        {},
        content_type="application/json",
    )
    client.post(
        "/api/auth/security/totp/confirm/",
        {"code": pyotp.TOTP(totp_secret(start_response)).now()},
        content_type="application/json",
    )

    response = client.post("/api/auth/security/totp/disable/", {}, content_type="application/json")

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.two_factor_method == "none"
    assert user.totp_secret == ""
    assert user.totp_confirmed_at is None
    assert response.json()["security"]["totpEnabled"] is False


@pytest.mark.django_db
def test_email_two_factor_setup_confirm_enables_email_method(
    client,
    django_user_model,
    settings,
):
    settings.DEBUG = True
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)

    start_response = client.post(
        "/api/auth/security/email-2fa/start/",
        {},
        content_type="application/json",
    )

    assert start_response.status_code == 200
    assert start_response.json()["email"] == "writer@example.test"
    assert len(mail.outbox) == 1
    assert mail.outbox[-1].subject == "Confirm Quillum email two-factor authentication"
    assert "Confirm email two-factor authentication" in latest_html_mail_body()
    assert "devCode" not in start_response.json()

    confirm_response = client.post(
        "/api/auth/security/email-2fa/confirm/",
        {"code": latest_mail_code()},
        content_type="application/json",
    )

    assert confirm_response.status_code == 200
    user.refresh_from_db()
    assert user.two_factor_method == "email"
    assert confirm_response.json()["security"]["emailTwoFactorEnabled"] is True


@pytest.mark.django_db
def test_email_two_factor_login_requires_second_step(client, django_user_model, settings):
    settings.DEBUG = True
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
        two_factor_method="email",
    )

    password_response = client.post(
        "/api/auth/login/",
        {"username": "writer", "password": "development-password"},
        content_type="application/json",
    )
    session_response = client.get("/api/auth/session/")

    assert password_response.status_code == 200
    assert password_response.json()["twoFactorRequired"] is True
    assert password_response.json()["method"] == "email"
    assert len(mail.outbox) == 1
    assert mail.outbox[-1].subject == "Your Quillum sign-in code"
    assert "Finish signing in" in latest_html_mail_body()
    assert "devCode" not in password_response.json()
    assert session_response.json()["authenticated"] is False

    code_response = client.post(
        "/api/auth/login/2fa/",
        {"code": latest_mail_code()},
        content_type="application/json",
    )

    assert code_response.status_code == 200
    assert code_response.json()["user"]["username"] == "writer"
    assert client.get("/api/auth/session/").json()["authenticated"] is True


@pytest.mark.django_db
def test_email_two_factor_login_rejects_invalid_code(client, django_user_model, settings):
    settings.DEBUG = True
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
        two_factor_method="email",
    )
    client.post(
        "/api/auth/login/",
        {"username": "writer", "password": "development-password"},
        content_type="application/json",
    )

    response = client.post(
        "/api/auth/login/2fa/",
        {"code": "000000"},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "two_factor_code_invalid"
    assert client.get("/api/auth/session/").json()["authenticated"] is False


def passkey_registration_result():
    return SimpleNamespace(
        credential_id=b"credential-id",
        credential_public_key=b"public-key",
        sign_count=1,
        aaguid="00000000-0000-0000-0000-000000000000",
        credential_device_type=SimpleNamespace(value="single_device"),
        credential_backed_up=False,
    )


def passkey_authentication_result():
    return SimpleNamespace(
        new_sign_count=2,
        credential_device_type=SimpleNamespace(value="single_device"),
        credential_backed_up=False,
    )


@pytest.mark.django_db
def test_passkey_registration_start_returns_creation_options(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)

    response = client.post(
        "/api/auth/security/passkeys/start/",
        {"name": "Windows Hello"},
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["options"]["rp"]["name"] == "Quillum"
    assert payload["options"]["user"]["name"] == "writer@example.test"
    assert payload["options"]["challenge"]


@pytest.mark.django_db
def test_passkey_registration_finish_stores_verified_credential(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    client.force_login(user)
    mark_recent_auth(client)
    client.post(
        "/api/auth/security/passkeys/start/",
        {"name": "Windows Hello"},
        content_type="application/json",
    )

    with patch(
        "apps.accounts.views.verify_registration_response",
        return_value=passkey_registration_result(),
    ):
        response = client.post(
            "/api/auth/security/passkeys/finish/",
            {"credential": {"id": "Y3JlZGVudGlhbC1pZA", "response": {"transports": ["internal"]}}},
            content_type="application/json",
        )

    assert response.status_code == 200
    passkey = PasskeyCredential.objects.get(user=user)
    assert passkey.name == "Windows Hello"
    assert passkey.credential_id == "Y3JlZGVudGlhbC1pZA"
    assert passkey.public_key == "cHVibGljLWtleQ"
    assert passkey.transports == ["internal"]


@pytest.mark.django_db
def test_passkey_login_completes_session(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    PasskeyCredential.objects.create(
        user=user,
        name="Windows Hello",
        credential_id="Y3JlZGVudGlhbC1pZA",
        public_key="cHVibGljLWtleQ",
        sign_count=1,
    )
    client.post(
        "/api/auth/login/passkey/start/",
        {"username": "writer"},
        content_type="application/json",
    )

    with patch(
        "apps.accounts.views.verify_authentication_response",
        return_value=passkey_authentication_result(),
    ):
        response = client.post(
            "/api/auth/login/passkey/finish/",
            {"credential": {"id": "Y3JlZGVudGlhbC1pZA"}},
            content_type="application/json",
        )

    assert response.status_code == 200
    assert response.json()["user"]["username"] == "writer"
    assert client.get("/api/auth/session/").json()["authenticated"] is True
    passkey = PasskeyCredential.objects.get(user=user)
    assert passkey.sign_count == 2
    assert passkey.last_used_at is not None


@pytest.mark.django_db
def test_passkey_registration_start_respects_limit(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="development-password",
    )
    for index in range(5):
        PasskeyCredential.objects.create(
            user=user,
            name=f"Device {index + 1}",
            credential_id=f"credential-{index + 1}",
            public_key="public-key",
        )
    client.force_login(user)
    mark_recent_auth(client)
    blocked_response = client.post(
        "/api/auth/security/passkeys/start/",
        {"name": "Device 6"},
        content_type="application/json",
    )

    assert blocked_response.status_code == 400
    assert blocked_response.json()["error"] == "passkey_limit_reached"
    assert PasskeyCredential.objects.filter(user=user).count() == 5
