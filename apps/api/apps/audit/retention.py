from datetime import timedelta

from django.utils import timezone

from apps.adminpanel.runtime_settings import runtime_setting

from .models import AuditEvent


def purge_expired_audit_events() -> int:
    cutoff = timezone.now() - timedelta(days=runtime_setting("audit_retention_days"))
    deleted, _details = AuditEvent.objects.filter(created_at__lt=cutoff).delete()
    return deleted
