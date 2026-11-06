from django.conf import settings
from django.db import models


class AuditEvent(models.Model):
    event = models.CharField(max_length=120)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        blank=True,
        null=True,
        on_delete=models.SET_NULL,
        related_name="audit_events",
    )
    subject = models.CharField(max_length=160, blank=True)
    ip_address = models.TextField(blank=True, null=True, editable=False, db_index=True)
    user_agent = models.TextField(blank=True, default="", editable=False)
    payload = models.JSONField(default=dict, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["event", "-created_at"]),
            models.Index(fields=["actor", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.event} at {self.created_at:%Y-%m-%d %H:%M:%S}"

    def save(self, *args, **kwargs):
        self.ip_address = str(self.ip_address or "").strip() or None
        self.user_agent = str(self.user_agent or "")
        self.payload = self.payload or {}
        return super().save(*args, **kwargs)
