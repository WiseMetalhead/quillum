from django.core.management.base import BaseCommand

from apps.audit.retention import purge_expired_audit_events


class Command(BaseCommand):
    help = "Delete audit events older than QUILLUM_AUDIT_RETENTION_DAYS."

    def handle(self, *args, **options):
        deleted = purge_expired_audit_events()
        self.stdout.write(self.style.SUCCESS(f"Deleted {deleted} expired audit events."))
