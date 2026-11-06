from __future__ import annotations

from django.conf import settings
from django.db import models


class ServiceSetting(models.Model):
    key = models.CharField(max_length=120, primary_key=True)
    value = models.JSONField(editable=False)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        blank=True,
        null=True,
        on_delete=models.SET_NULL,
        related_name="updated_service_settings",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["key"]

    def __str__(self) -> str:
        return self.key


class TierQuotaOverride(models.Model):
    tier = models.CharField(max_length=16)
    key = models.CharField(max_length=64)
    value = models.PositiveBigIntegerField()
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        blank=True,
        null=True,
        on_delete=models.SET_NULL,
        related_name="updated_tier_quotas",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["tier", "key"]
        constraints = [
            models.UniqueConstraint(fields=["tier", "key"], name="unique_tier_quota_override"),
        ]

    def __str__(self) -> str:
        return f"{self.tier}.{self.key}"


class TierProgressionPolicy(models.Model):
    enabled = models.BooleanField(default=False)
    novice_to_author_days = models.PositiveSmallIntegerField(default=45)
    author_to_believer_days = models.PositiveSmallIntegerField(default=90)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "tier progression policy"

    def __str__(self) -> str:
        return "Tier progression policy"


class BackgroundTaskRun(models.Model):
    STATUS_RUNNING = "running"
    STATUS_SUCCEEDED = "succeeded"
    STATUS_FAILED = "failed"
    STATUS_RETRYING = "retrying"
    STATUS_REVOKED = "revoked"
    STATUS_CHOICES = (
        (STATUS_RUNNING, "Running"),
        (STATUS_SUCCEEDED, "Succeeded"),
        (STATUS_FAILED, "Failed"),
        (STATUS_RETRYING, "Retrying"),
        (STATUS_REVOKED, "Revoked"),
    )

    task_id = models.CharField(max_length=255, unique=True)
    task_name = models.CharField(max_length=255)
    worker = models.CharField(max_length=255, blank=True)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES)
    started_at = models.DateTimeField()
    finished_at = models.DateTimeField(blank=True, null=True)
    duration_ms = models.PositiveBigIntegerField(blank=True, null=True)
    error_type = models.CharField(max_length=160, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-finished_at", "-started_at"]
        indexes = [
            models.Index(
                fields=["status", "-started_at"],
                name="admin_task_status_started_idx",
            ),
            models.Index(fields=["-finished_at"], name="admin_task_finished_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.task_name}: {self.status}"
