from celery import shared_task

from .retention import purge_expired_audit_events as purge


@shared_task(name="apps.audit.tasks.purge_expired_audit_events")
def purge_expired_audit_events() -> int:
    return purge()
