from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class NewsItem(models.Model):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    source_key = models.CharField(max_length=80)
    external_id = models.CharField(max_length=120)
    canonical_url = models.URLField(max_length=1000)
    title = models.TextField(editable=False)
    author_name = models.TextField(editable=False)
    summary = models.TextField(editable=False)
    published_at = models.DateTimeField(db_index=True)
    content_hash = models.CharField(max_length=64, editable=False)
    first_seen_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-published_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["source_key", "external_id"],
                name="unique_news_source_external_id",
            )
        ]
        indexes = [
            models.Index(
                fields=["source_key", "-published_at", "-id"],
                name="sources_news_source_date_idx",
            )
        ]


class NewsSourceSubscription(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="news_source_subscriptions",
    )
    source_key = models.CharField(max_length=80)
    enabled = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["source_key"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "source_key"],
                name="unique_news_source_subscription",
            )
        ]
        indexes = [
            models.Index(
                fields=["user", "enabled"],
                name="sources_new_user_id_f2713f_idx",
            )
        ]


class ContestStatus(models.TextChoices):
    ACCEPTING = "accepting", "Accepting entries"
    PREPARATION = "preparation", "Preparation"
    IN_PROGRESS = "in_progress", "In progress"
    FINISHED = "finished", "Finished"


class ContestActionKind(models.TextChoices):
    WORKS = "works", "Contest works"
    RESULTS = "results", "Results"


class ContestItem(models.Model):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    source_key = models.CharField(max_length=80)
    external_id = models.CharField(max_length=120)
    canonical_url = models.URLField(max_length=1000)
    title = models.TextField(editable=False)
    description = models.TextField(editable=False)
    status = models.CharField(max_length=24, choices=ContestStatus.choices)
    discussion_url = models.URLField(max_length=1000, blank=True)
    action_kind = models.CharField(
        max_length=16,
        choices=ContestActionKind.choices,
        blank=True,
    )
    action_url = models.URLField(max_length=1000, blank=True)
    source_position = models.PositiveSmallIntegerField(default=0)
    content_hash = models.CharField(max_length=64, editable=False)
    first_seen_at = models.DateTimeField(default=timezone.now)
    last_seen_at = models.DateTimeField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-first_seen_at", "source_position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["source_key", "external_id"],
                name="unique_contest_source_external_id",
            )
        ]
        indexes = [
            models.Index(
                fields=["source_key", "status", "-first_seen_at"],
                name="sources_contest_feed_idx",
            )
        ]


class ContestPhaseKind(models.TextChoices):
    SUBMISSION = "submission", "Submission"
    LONGLIST = "longlist", "Longlist"
    SHORTLIST = "shortlist", "Shortlist"
    JUDGING = "judging", "Judging"
    JUDGING_SHORTLIST = "judging_shortlist", "Judging and shortlist"
    RESULTS = "results", "Results"
    SYNOPSIS = "synopsis", "Synopsis"
    MANUSCRIPT_COMPLETION = "manuscript_completion", "Manuscript completion"
    OTHER = "other", "Other"


class ContestDatePrecision(models.TextChoices):
    EXACT = "exact", "Exact"
    MONTH = "month", "Month"
    MONTH_RANGE = "month_range", "Month range"
    APPROXIMATE = "approximate", "Approximate"
    UNPARSED = "unparsed", "Unparsed"


class ContestDetail(models.Model):
    contest = models.OneToOneField(
        ContestItem,
        on_delete=models.CASCADE,
        related_name="detail",
    )
    conditions_sections = models.JSONField(default=list)
    condition_facts = models.JSONField(default=list)
    content_hash = models.CharField(max_length=64, blank=True, editable=False)
    status_at_last_sync = models.CharField(
        max_length=24,
        choices=ContestStatus.choices,
        blank=True,
    )
    last_attempted_at = models.DateTimeField(null=True, blank=True)
    last_succeeded_at = models.DateTimeField(null=True, blank=True)
    consecutive_failures = models.PositiveIntegerField(default=0)
    last_error_code = models.CharField(max_length=80, blank=True)
    updated_at = models.DateTimeField(auto_now=True)


class ContestPhase(models.Model):
    detail = models.ForeignKey(
        ContestDetail,
        on_delete=models.CASCADE,
        related_name="phases",
    )
    key = models.CharField(max_length=80)
    kind = models.CharField(max_length=32, choices=ContestPhaseKind.choices)
    label = models.TextField()
    raw_text = models.TextField()
    starts_on = models.DateField(null=True, blank=True)
    ends_on = models.DateField(null=True, blank=True)
    deadline_at = models.DateTimeField(null=True, blank=True)
    precision = models.CharField(max_length=20, choices=ContestDatePrecision.choices)
    source_section = models.CharField(max_length=40)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["detail", "key"],
                name="unique_contest_detail_phase_key",
            )
        ]


class ContestParticipation(models.Model):
    contest = models.ForeignKey(
        ContestItem,
        on_delete=models.CASCADE,
        related_name="participations",
    )
    manuscript = models.ForeignKey(
        "manuscripts.Manuscript",
        on_delete=models.CASCADE,
        related_name="contest_participations",
    )
    track_deadlines = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["contest", "manuscript"],
                name="unique_contest_manuscript_participation",
            )
        ]


class ContestSourceSubscription(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="contest_source_subscriptions",
    )
    source_key = models.CharField(max_length=80)
    enabled = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["source_key"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "source_key"],
                name="unique_contest_source_subscription",
            )
        ]
        indexes = [
            models.Index(
                fields=["user", "enabled"],
                name="sources_cont_user_enabled_idx",
            )
        ]


class SourceSyncState(models.Model):
    source_key = models.CharField(max_length=80, unique=True)
    last_attempted_at = models.DateTimeField(null=True, blank=True)
    last_succeeded_at = models.DateTimeField(null=True, blank=True)
    last_item_count = models.PositiveIntegerField(default=0)
    consecutive_failures = models.PositiveIntegerField(default=0)
    last_error_code = models.CharField(max_length=80, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["source_key"]
