import json
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.http import JsonResponse
from django.test import RequestFactory
from django.utils import timezone

from apps.adminpanel.runtime_settings import set_runtime_override
from apps.audit.middleware import ErrorSupportContextMiddleware
from apps.audit.models import AuditEvent
from apps.audit.service import client_ip, sanitized_payload
from apps.audit.support import error_support_context
from apps.audit.tasks import purge_expired_audit_events


def test_client_ip_ignores_forwarded_for_without_trusted_proxy(settings):
    settings.QUILLUM_TRUSTED_PROXY_IPS = []
    request = RequestFactory().get(
        "/",
        HTTP_X_FORWARDED_FOR="203.0.113.10",
        REMOTE_ADDR="127.0.0.1",
    )

    assert client_ip(request) == "127.0.0.1"


def test_client_ip_uses_forwarded_for_from_trusted_proxy(settings):
    settings.QUILLUM_TRUSTED_PROXY_IPS = ["127.0.0.1"]
    request = RequestFactory().get(
        "/",
        HTTP_X_FORWARDED_FOR="203.0.113.10, 198.51.100.20",
        REMOTE_ADDR="127.0.0.1",
    )

    assert client_ip(request) == "203.0.113.10"


def test_client_ip_uses_forwarded_for_from_trusted_proxy_network(settings):
    settings.QUILLUM_TRUSTED_PROXY_IPS = ["172.28.0.0/16"]
    request = RequestFactory().get(
        "/",
        REMOTE_ADDR="172.28.0.4",
        HTTP_X_FORWARDED_FOR="203.0.113.12",
    )

    assert client_ip(request) == "203.0.113.12"


def test_client_ip_rejects_malformed_forwarded_address(settings):
    settings.QUILLUM_TRUSTED_PROXY_IPS = ["172.28.0.0/16"]
    request = RequestFactory().get(
        "/",
        REMOTE_ADDR="172.28.0.4",
        HTTP_X_FORWARDED_FOR="not-an-ip",
    )

    assert client_ip(request) == "172.28.0.4"


def test_error_support_context_uses_submitted_login_for_anonymous_request():
    request = RequestFactory().post(
        "/api/auth/login/",
        {"username": "writer", "password": "not-copied"},
        content_type="application/json",
        REMOTE_ADDR="203.0.113.10",
    )

    context = error_support_context(request)

    assert context["username"] == "writer"
    assert context["userId"] is None
    assert context["ipAddress"] == "203.0.113.10"
    assert context["occurredAt"]


@pytest.mark.django_db
def test_error_support_context_uses_authenticated_user(django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        password="development-password",
    )
    request = RequestFactory().get("/api/manuscripts/", REMOTE_ADDR="203.0.113.10")
    request.user = user

    context = error_support_context(request)

    assert context["username"] == "writer"
    assert context["userId"] == user.id
    assert context["ipAddress"] == "203.0.113.10"


def test_error_support_context_is_added_to_json_error_response():
    request = RequestFactory().get("/api/auth/session/", REMOTE_ADDR="203.0.113.10")

    middleware = ErrorSupportContextMiddleware(
        lambda _request: JsonResponse({"error": "authentication_required"}, status=401)
    )
    response = middleware(request)

    payload = json.loads(response.content)

    assert payload["support"]["ipAddress"] == "203.0.113.10"


def test_audit_payload_removes_sensitive_values():
    payload = sanitized_payload(
        {
            "email": "writer@example.test",
            "newPassword": "secret",
            "method": "totp",
        }
    )

    assert payload == {"method": "totp"}


@pytest.mark.django_db
def test_purge_audit_events_applies_retention(monkeypatch):
    monkeypatch.delenv("QUILLUM_AUDIT_RETENTION_DAYS", raising=False)
    set_runtime_override("audit_retention_days", 30)
    expired = AuditEvent.objects.create(event="expired")
    recent = AuditEvent.objects.create(event="recent")
    AuditEvent.objects.filter(id=expired.id).update(created_at=timezone.now() - timedelta(days=31))

    call_command("purge_audit_events")

    assert not AuditEvent.objects.filter(id=expired.id).exists()
    assert AuditEvent.objects.filter(id=recent.id).exists()


@pytest.mark.django_db
def test_periodic_audit_retention_task_uses_same_policy(monkeypatch):
    monkeypatch.delenv("QUILLUM_AUDIT_RETENTION_DAYS", raising=False)
    set_runtime_override("audit_retention_days", 7)
    expired = AuditEvent.objects.create(event="expired-task")
    AuditEvent.objects.filter(id=expired.id).update(created_at=timezone.now() - timedelta(days=8))

    assert purge_expired_audit_events() == 1
    assert not AuditEvent.objects.filter(id=expired.id).exists()


@pytest.mark.django_db
def test_audit_sensitive_fields_are_stored_as_plaintext():
    event = AuditEvent.objects.create(
        event="auth.test",
        ip_address="203.0.113.10",
        user_agent="Sensitive Browser",
        payload={"method": "totp"},
    )

    stored = AuditEvent.objects.filter(id=event.id).values().get()

    assert stored["ip_address"] == "203.0.113.10"
    assert stored["user_agent"] == "Sensitive Browser"
    assert stored["payload"] == {"method": "totp"}
    assert event.ip_address == "203.0.113.10"
    assert event.user_agent == "Sensitive Browser"
    assert event.payload == {"method": "totp"}
