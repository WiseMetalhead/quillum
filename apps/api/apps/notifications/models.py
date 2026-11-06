from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class Notification(models.Model):
    CATEGORY_SERVICE = "service"
    CATEGORY_ADMIN = "admin"
    CATEGORY_USER = "user"
    CATEGORY_CHOICES = (
        (CATEGORY_SERVICE, "Service"),
        (CATEGORY_ADMIN, "Administrator"),
        (CATEGORY_USER, "User configured"),
    )

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notifications",
    )
    category = models.CharField(max_length=16, choices=CATEGORY_CHOICES)
    kind = models.CharField(max_length=80)
    payload = models.JSONField(default=dict, editable=False)
    deduplication_hash = models.CharField(max_length=64)
    read_at = models.DateTimeField(null=True, blank=True)
    email_requested_at = models.DateTimeField(null=True, blank=True)
    email_sent_at = models.DateTimeField(null=True, blank=True)
    email_attempts = models.PositiveSmallIntegerField(default=0)
    email_error_code = models.CharField(max_length=80, blank=True)
    expires_at = models.DateTimeField(db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["recipient", "deduplication_hash"],
                name="unique_notification_recipient_dedup",
            )
        ]
        indexes = [
            models.Index(
                fields=["recipient", "read_at", "-created_at"],
                name="notificatio_recipie_ce9d56_idx",
            ),
            models.Index(
                fields=["kind", "-created_at"],
                name="notificatio_kind_87ba1b_idx",
            ),
        ]


class ServiceReminderState(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_reminder_states",
    )
    kind = models.CharField(max_length=80)
    active = models.BooleanField(default=False)
    last_sent_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "kind"],
                name="unique_service_reminder_user_kind",
            )
        ]


class ServiceEventReceipt(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_event_receipts",
    )
    kind = models.CharField(max_length=80)
    source_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "kind", "source_hash"],
                name="unique_service_event_receipt",
            )
        ]


class NotificationRule(models.Model):
    KIND_MANUSCRIPT_DEADLINE = "user.manuscript_deadline"
    KIND_ITEM_DEADLINE = "user.item_deadline"
    KIND_TASK_DEADLINE = "user.task_deadline"
    KIND_REVIEW_COMMENT = "user.review_comment"
    KIND_DAILY_GOAL = "user.daily_goal"
    KIND_MANUSCRIPT_DIGEST = "user.manuscript_digest"
    KIND_CHOICES = (
        (KIND_MANUSCRIPT_DEADLINE, "Manuscript deadline"),
        (KIND_ITEM_DEADLINE, "Plan item deadline"),
        (KIND_TASK_DEADLINE, "Task deadline"),
        (KIND_REVIEW_COMMENT, "Public Review comment"),
        (KIND_DAILY_GOAL, "Daily writing goal"),
        (KIND_MANUSCRIPT_DIGEST, "Manuscript digest"),
    )

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_rules",
    )
    kind = models.CharField(max_length=80, choices=KIND_CHOICES)
    enabled = models.BooleanField(default=False)
    email_enabled = models.BooleanField(default=False)
    delivery_time = models.TimeField(null=True, blank=True)
    weekdays = models.JSONField(default=list)
    checkpoints = models.JSONField(default=list)
    manuscripts = models.ManyToManyField(
        "manuscripts.Manuscript",
        blank=True,
        related_name="notification_rules",
    )
    enabled_at = models.DateTimeField(null=True, blank=True)
    last_processed_local_date = models.DateField(null=True, blank=True)
    next_run_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["id"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "kind"],
                name="unique_notification_rule_user_kind",
            )
        ]
        indexes = [models.Index(fields=["enabled", "next_run_at"])]


class AdminNotificationCampaign(models.Model):
    STATUS_DRAFT = "draft"
    STATUS_SCHEDULED = "scheduled"
    STATUS_PROCESSING = "processing"
    STATUS_SENT = "sent"
    STATUS_CANCELED = "canceled"
    STATUS_FAILED = "failed"
    STATUS_CHOICES = (
        (STATUS_DRAFT, "Draft"),
        (STATUS_SCHEDULED, "Scheduled"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_SENT, "Sent"),
        (STATUS_CANCELED, "Canceled"),
        (STATUS_FAILED, "Failed"),
    )

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    title = models.TextField(editable=False)
    body = models.TextField(editable=False)
    tiers = models.JSONField(default=list)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_DRAFT)
    scheduled_for = models.DateTimeField(null=True, blank=True, db_index=True)
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        on_delete=models.SET_NULL,
        related_name="admin_notification_campaigns",
    )
    recipient_count = models.PositiveIntegerField(default=0)
    sent_count = models.PositiveIntegerField(default=0)
    failed_count = models.PositiveIntegerField(default=0)
    processing_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    canceled_at = models.DateTimeField(null=True, blank=True)
    failed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["status", "scheduled_for"])]


class AdminNotificationRecipient(models.Model):
    STATUS_PENDING = "pending"
    STATUS_SENT = "sent"
    STATUS_FAILED = "failed"
    STATUS_CHOICES = (
        (STATUS_PENDING, "Pending"),
        (STATUS_SENT, "Sent"),
        (STATUS_FAILED, "Failed"),
    )

    campaign = models.ForeignKey(
        AdminNotificationCampaign,
        on_delete=models.CASCADE,
        related_name="recipients",
    )
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="admin_notification_deliveries",
    )
    notification = models.ForeignKey(
        Notification,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="campaign_deliveries",
    )
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    error_code = models.CharField(max_length=80, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["campaign", "recipient"],
                name="unique_campaign_recipient",
            )
        ]
        indexes = [models.Index(fields=["campaign", "status"])]
