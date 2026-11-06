import logging
from ipaddress import ip_address, ip_network
from typing import Any

from django.conf import settings
from django.http import HttpRequest

from .models import AuditEvent

logger = logging.getLogger(__name__)
SENSITIVE_PAYLOAD_KEYS = {
    "email",
    "newEmail",
    "password",
    "currentPassword",
    "newPassword",
    "code",
    "secret",
    "token",
}


def sanitized_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not payload:
        return {}
    return {key: value for key, value in payload.items() if key not in SENSITIVE_PAYLOAD_KEYS}


def client_ip(request: HttpRequest) -> str | None:
    remote_addr = request.META.get("REMOTE_ADDR")
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded_for and remote_addr and trusted_proxy(remote_addr):
        candidate = forwarded_for.split(",", 1)[0].strip()
        try:
            return str(ip_address(candidate))
        except ValueError:
            return remote_addr
    return remote_addr


def trusted_proxy(remote_addr: str) -> bool:
    try:
        address = ip_address(remote_addr)
    except ValueError:
        return False
    for value in settings.QUILLUM_TRUSTED_PROXY_IPS:
        try:
            if address in ip_network(value, strict=False):
                return True
        except ValueError:
            continue
    return False


def write_audit_event(
    request: HttpRequest,
    event: str,
    *,
    actor=None,
    subject: str = "",
    payload: dict[str, Any] | None = None,
) -> AuditEvent:
    audit_event = AuditEvent.objects.create(
        event=event,
        actor=actor if getattr(actor, "is_authenticated", False) else None,
        subject=subject,
        ip_address=client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", ""),
        payload=sanitized_payload(payload),
    )
    logger.info("audit event=%s actor=%s subject=%s", event, audit_event.actor_id, subject)
    if audit_event.actor_id is not None:
        from apps.accounts.tier_progression import record_tier_activity_for_event

        record_tier_activity_for_event(audit_event.actor, event)
    return audit_event


def write_system_audit_event(
    event: str,
    *,
    subject: str = "",
    payload: dict[str, Any] | None = None,
) -> AuditEvent:
    audit_event = AuditEvent.objects.create(
        event=event,
        subject=subject,
        payload=sanitized_payload(payload),
    )
    logger.info("audit event=%s actor=system subject=%s", event, subject)
    return audit_event
