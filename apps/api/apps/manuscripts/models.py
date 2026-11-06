from __future__ import annotations

import gzip
import json
import uuid

from django.conf import settings
from django.db import models

from .defaults import (
    dashboard_settings_default,
    planner_metadata_default,
    planner_settings_default,
)


def audio_note_upload_to(_instance, filename: str) -> str:
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    if extension not in {"webm", "ogg", "m4a", "mp4"}:
        extension = "bin"
    return f"audio-notes/{uuid.uuid4()}.{extension}"


class Workspace(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="writing_workspaces",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]


class Series(models.Model):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    workspace = models.OneToOneField(
        Workspace,
        on_delete=models.CASCADE,
        related_name="series",
    )
    title = models.TextField(editable=False)
    synopsis = models.TextField(blank=True, default="", editable=False)
    cover_content_type = models.CharField(max_length=32, blank=True, editable=False)
    cover_width = models.PositiveIntegerField(null=True, blank=True, editable=False)
    cover_height = models.PositiveIntegerField(null=True, blank=True, editable=False)
    cover_media = models.ForeignKey(
        "accounts.UserMediaAsset",
        null=True,
        blank=True,
        on_delete=models.RESTRICT,
        related_name="series_covers",
    )
    drawer_at = models.DateTimeField(null=True, blank=True, editable=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]


class Manuscript(models.Model):
    KIND_ONESHOT = "oneshot"
    KIND_BOOK = "book"
    KIND_CHOICES = [(KIND_ONESHOT, "One-Shot"), (KIND_BOOK, "Book")]

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="manuscripts",
    )
    kind = models.CharField(max_length=24, choices=KIND_CHOICES)
    title = models.TextField(editable=False)
    synopsis = models.TextField(blank=True, default="", editable=False)
    language = models.CharField(max_length=16, blank=True, default="")
    genres = models.JSONField(default=list, editable=False)
    planner_settings = models.JSONField(default=planner_settings_default, editable=False)
    dashboard_memo = models.TextField(blank=True, default="", editable=False)
    dashboard_settings = models.JSONField(default=dashboard_settings_default, editable=False)
    structure_generation = models.PositiveBigIntegerField(default=0, editable=False)
    planner_generation = models.PositiveBigIntegerField(default=0, editable=False)
    plan_statuses_initialized = models.BooleanField(default=False, editable=False)
    cover_content_type = models.CharField(max_length=32, blank=True, editable=False)
    cover_width = models.PositiveIntegerField(null=True, blank=True, editable=False)
    cover_height = models.PositiveIntegerField(null=True, blank=True, editable=False)
    cover_media = models.ForeignKey(
        "accounts.UserMediaAsset",
        null=True,
        blank=True,
        on_delete=models.RESTRICT,
        related_name="manuscript_covers",
    )
    first_edited_at = models.DateTimeField(null=True, blank=True, editable=False, db_index=True)
    drawer_at = models.DateTimeField(null=True, blank=True, editable=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["workspace", "kind", "-updated_at"]),
        ]

    @property
    def document(self):
        """Compatibility accessor for the single-document One-Shot contract."""
        return self.documents.get()


class ManuscriptEditorGrant(models.Model):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="editor_grants",
    )
    editor_connection = models.ForeignKey(
        "accounts.EditorConnection",
        on_delete=models.CASCADE,
        related_name="manuscript_grants",
    )
    granted_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-granted_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["manuscript", "editor_connection"],
                condition=models.Q(revoked_at__isnull=True),
                name="unique_active_manuscript_editor_grant",
            ),
        ]
        indexes = [
            models.Index(fields=["manuscript", "revoked_at"]),
            models.Index(fields=["editor_connection", "revoked_at"]),
        ]


class SeriesMembership(models.Model):
    series = models.ForeignKey(
        Series,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    manuscript = models.OneToOneField(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="series_membership",
    )
    position = models.PositiveIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["series", "position"],
                name="unique_series_book_position",
            ),
            models.CheckConstraint(
                condition=models.Q(position__gte=1),
                name="series_book_position_positive",
            ),
        ]
        indexes = [
            models.Index(
                fields=["series", "position"],
                name="series_membership_position_idx",
            ),
        ]


class IdeaItem(models.Model):
    KIND_IMAGE = "image"
    KIND_TEXT = "text"
    KIND_AUDIO = "audio"
    KIND_CHOICES = [
        (KIND_IMAGE, "Image"),
        (KIND_TEXT, "Text"),
        (KIND_AUDIO, "Audio"),
    ]

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="ideas",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    title = models.TextField(blank=True, default="", editable=False)
    text = models.TextField(blank=True, default="", editable=False)
    image_media = models.ForeignKey(
        "accounts.UserMediaAsset",
        null=True,
        blank=True,
        on_delete=models.RESTRICT,
        related_name="idea_items",
    )
    save_generation = models.PositiveBigIntegerField(default=0, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "image_media"],
                condition=models.Q(image_media__isnull=False),
                name="unique_owner_idea_image",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(kind="image", image_media__isnull=False)
                    | models.Q(kind="text", image_media__isnull=True)
                    | models.Q(kind="audio", image_media__isnull=True)
                ),
                name="idea_kind_media_shape",
            ),
        ]
        indexes = [
            models.Index(
                fields=["owner", "kind", "-updated_at", "-id"],
                name="idea_owner_kind_updated_idx",
            ),
        ]


class ManuscriptItem(models.Model):
    KIND_FOLDER = "folder"
    KIND_DOCUMENT = "document"
    KIND_CHOICES = [(KIND_FOLDER, "Folder"), (KIND_DOCUMENT, "Document")]
    POSITION_STEP = 1024

    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="items",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    parent = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="children",
    )
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    title = models.TextField(editable=False)
    planner_metadata = models.JSONField(default=planner_metadata_default, editable=False)
    position = models.PositiveBigIntegerField(default=POSITION_STEP)
    trashed_at = models.DateTimeField(null=True, blank=True, db_index=True)
    trash_batch_id = models.UUIDField(null=True, blank=True, db_index=True, editable=False)
    previous_parent = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="restorable_children",
    )
    previous_position = models.PositiveBigIntegerField(null=True, blank=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [
            models.Index(fields=["manuscript", "parent", "trashed_at", "position"]),
        ]


class ManuscriptPlanStatus(models.Model):
    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="plan_statuses",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    name = models.TextField(editable=False)
    color = models.CharField(max_length=16)
    position = models.PositiveIntegerField(default=0)
    counts_as_complete = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]


class ManuscriptTask(models.Model):
    PRIORITY_LOW = "low"
    PRIORITY_MEDIUM = "medium"
    PRIORITY_HIGH = "high"
    PRIORITY_CHOICES = [
        (PRIORITY_LOW, "Low"),
        (PRIORITY_MEDIUM, "Medium"),
        (PRIORITY_HIGH, "High"),
    ]

    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="tasks",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    associated_item = models.ForeignKey(
        ManuscriptItem,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="tasks",
    )
    content = models.JSONField(default=dict, editable=False)
    priority = models.CharField(max_length=12, choices=PRIORITY_CHOICES)
    is_pinned = models.BooleanField(default=False)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-is_pinned", "-created_at"]
        indexes = [
            models.Index(fields=["manuscript", "completed_at", "is_pinned", "created_at"]),
        ]


class ManuscriptBoard(models.Model):
    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="boards",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    name = models.TextField(editable=False)
    position = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [models.Index(fields=["manuscript", "position", "created_at"])]


class ManuscriptNoteTag(models.Model):
    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="note_tags",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    name = models.TextField(editable=False)
    color = models.CharField(max_length=16, default="blue")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["manuscript", "created_at"])]


class ManuscriptNote(models.Model):
    CURRENT_SCHEMA_VERSION = 2
    EMPTY_CONTENT = {"type": "doc", "content": [{"type": "paragraph"}]}
    KIND_TEXT = "text"
    KIND_AUDIO = "audio"
    KIND_CHOICES = [(KIND_TEXT, "Text"), (KIND_AUDIO, "Audio")]

    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="notes",
    )
    board = models.ForeignKey(
        ManuscriptBoard,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="notes",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    source_idea_id = models.UUIDField(
        null=True,
        blank=True,
        unique=True,
        editable=False,
    )
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default=KIND_TEXT)
    title = models.TextField(editable=False)
    content = models.JSONField(editable=False)
    schema_version = models.PositiveSmallIntegerField(default=CURRENT_SCHEMA_VERSION)
    save_generation = models.PositiveBigIntegerField(default=0, editable=False)
    color = models.CharField(max_length=16, default="blue")
    is_pinned = models.BooleanField(default=False)
    is_favourite = models.BooleanField(default=False)
    archived_at = models.DateTimeField(null=True, blank=True, db_index=True)
    trashed_at = models.DateTimeField(null=True, blank=True, db_index=True)
    tags = models.ManyToManyField(ManuscriptNoteTag, blank=True, related_name="notes")
    associated_items = models.ManyToManyField(
        ManuscriptItem,
        blank=True,
        through="ManuscriptNoteAssociation",
        related_name="notes",
    )
    assets = models.ManyToManyField("ManuscriptAsset", blank=True, related_name="notes")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-is_pinned", "-updated_at"]
        indexes = [
            models.Index(fields=["manuscript", "trashed_at", "archived_at", "-updated_at"]),
            models.Index(fields=["manuscript", "is_favourite", "-updated_at"]),
        ]


class AudioRecording(models.Model):
    note = models.OneToOneField(
        ManuscriptNote,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="audio",
    )
    idea = models.OneToOneField(
        IdeaItem,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="audio",
    )
    file = models.FileField(upload_to=audio_note_upload_to)
    content_type = models.CharField(max_length=32, editable=False)
    codec = models.CharField(max_length=16, editable=False)
    byte_size = models.PositiveBigIntegerField(editable=False)
    duration_ms = models.PositiveIntegerField(editable=False)
    waveform = models.JSONField(default=list, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(note__isnull=False, idea__isnull=True)
                    | models.Q(note__isnull=True, idea__isnull=False)
                ),
                name="audio_recording_single_owner",
            ),
        ]


class AudioTranscriptionState(models.Model):
    STATUS_QUEUED = "queued"
    STATUS_PROCESSING = "processing"
    STATUS_READY = "ready"
    STATUS_FAILED = "failed"
    STATUS_CHOICES = (
        (STATUS_QUEUED, "Queued"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_READY, "Ready"),
        (STATUS_FAILED, "Failed"),
    )

    audio = models.OneToOneField(
        AudioRecording,
        on_delete=models.CASCADE,
        related_name="transcription",
    )
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, db_index=True)
    text = models.TextField(blank=True, editable=False)
    language = models.CharField(max_length=2, blank=True, editable=False)
    error_code = models.CharField(max_length=80, blank=True, editable=False)
    generation = models.PositiveBigIntegerField(default=1, editable=False)
    task_id = models.CharField(max_length=255, blank=True, editable=False)
    requested_at = models.DateTimeField(db_index=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    text_updated_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["requested_at", "id"]
        indexes = [
            models.Index(
                fields=["status", "requested_at", "id"],
                name="note_trans_status_queue_idx",
            )
        ]


# Compatibility aliases keep existing Board integrations and third-party imports working while
# the persistence model is generalized for Ideas.
ManuscriptNoteAudio = AudioRecording
ManuscriptNoteTranscription = AudioTranscriptionState


class ManuscriptNoteAssociation(models.Model):
    note = models.ForeignKey(ManuscriptNote, on_delete=models.CASCADE)
    item = models.ForeignKey(ManuscriptItem, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["note", "item"], name="unique_note_item")]


class Document(models.Model):
    CURRENT_SCHEMA_VERSION = 3
    EMPTY_DOCUMENT = {"type": "doc", "content": [{"type": "paragraph"}]}

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="documents",
    )
    item = models.OneToOneField(
        ManuscriptItem,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="document",
    )
    content = models.JSONField(editable=False)
    schema_version = models.PositiveSmallIntegerField(default=CURRENT_SCHEMA_VERSION)
    save_generation = models.PositiveBigIntegerField(default=0, editable=False)
    history_generation = models.PositiveBigIntegerField(default=0, editable=False)
    last_drafted_history_generation = models.PositiveBigIntegerField(default=0, editable=False)
    draft_due_at = models.DateTimeField(null=True, blank=True, editable=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]

    @property
    def title(self) -> str:
        return self.item.title if self.item_id else self.manuscript.title


class DocumentCollaborationState(models.Model):
    STATUS_ACTIVE = "active"
    STATUS_LEGACY = "legacy"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "Active"),
        (STATUS_LEGACY, "Legacy"),
    ]

    DIAGNOSTIC_READY = "ready"
    DIAGNOSTIC_FAILED = "failed"
    DIAGNOSTIC_CHOICES = [
        (DIAGNOSTIC_READY, "Ready"),
        (DIAGNOSTIC_FAILED, "Failed"),
    ]

    document = models.OneToOneField(
        Document,
        on_delete=models.CASCADE,
        related_name="collaboration_state",
    )
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    epoch = models.PositiveBigIntegerField(default=1, editable=False)
    ydoc_state = models.BinaryField(default=bytes, editable=False)
    snapshot_sequence = models.PositiveBigIntegerField(default=0, editable=False)
    latest_sequence = models.PositiveBigIntegerField(default=0, editable=False)
    materialized_sequence = models.PositiveBigIntegerField(default=0, editable=False)
    schema_version = models.PositiveSmallIntegerField(default=Document.CURRENT_SCHEMA_VERSION)
    diagnostic_status = models.CharField(
        max_length=16,
        choices=DIAGNOSTIC_CHOICES,
        default=DIAGNOSTIC_READY,
    )
    diagnostic_code = models.CharField(max_length=64, blank=True, default="", editable=False)
    materialized_at = models.DateTimeField(null=True, blank=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class DocumentCollaborationUpdate(models.Model):
    ROLE_OWNER = "owner"
    ROLE_EDITOR = "editor"
    ROLE_SYSTEM = "system"
    ROLE_CHOICES = [
        (ROLE_OWNER, "Owner"),
        (ROLE_EDITOR, "Editor"),
        (ROLE_SYSTEM, "System"),
    ]

    state = models.ForeignKey(
        DocumentCollaborationState,
        on_delete=models.CASCADE,
        related_name="updates",
    )
    update_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    epoch = models.PositiveBigIntegerField(editable=False)
    sequence = models.PositiveBigIntegerField(editable=False)
    update_data = models.BinaryField(editable=False)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="document_collaboration_updates",
    )
    role = models.CharField(max_length=16, choices=ROLE_CHOICES)
    timezone = models.CharField(max_length=64, blank=True, default="UTC")
    positive_word_delta = models.PositiveIntegerField(default=0, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(
                fields=["state", "epoch", "sequence"],
                name="unique_collaboration_update_sequence",
            )
        ]
        indexes = [
            models.Index(
                fields=["state", "epoch", "sequence"],
                name="collab_update_replay_idx",
            )
        ]


class ManuscriptExport(models.Model):
    FORMAT_MARKDOWN = "markdown"
    FORMAT_EPUB = "epub"
    FORMAT_DOCX = "docx"
    FORMAT_ODT = "odt"
    FORMAT_FB2 = "fb2"
    FORMAT_CHOICES = [
        (FORMAT_MARKDOWN, "Markdown"),
        (FORMAT_EPUB, "EPUB"),
        (FORMAT_DOCX, "DOCX"),
        (FORMAT_ODT, "ODT"),
        (FORMAT_FB2, "FB2"),
    ]
    STATUS_PENDING = "pending"
    STATUS_BUILDING = "building"
    STATUS_READY = "ready"
    STATUS_FAILED = "failed"
    STATUS_EXPIRED = "expired"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_BUILDING, "Building"),
        (STATUS_READY, "Ready"),
        (STATUS_FAILED, "Failed"),
        (STATUS_EXPIRED, "Expired"),
    ]

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="manuscript_exports",
    )
    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="exports",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    export_format = models.CharField(max_length=16, choices=FORMAT_CHOICES)
    epub_version = models.PositiveSmallIntegerField(null=True, blank=True)
    options = models.JSONField(default=dict)
    selected_item_ids = models.JSONField(default=list)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING)
    artifact = models.FileField(upload_to="exports/%Y/%m/", blank=True)
    file_name = models.CharField(max_length=255, blank=True)
    content_type = models.CharField(max_length=96, blank=True)
    byte_size = models.PositiveBigIntegerField(default=0)
    error_code = models.CharField(max_length=64, blank=True)
    expires_at = models.DateTimeField(db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["owner", "-created_at"]),
            models.Index(fields=["status", "expires_at"]),
        ]


class ManuscriptWritingDay(models.Model):
    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="writing_days",
    )
    date = models.DateField()
    words_written = models.PositiveIntegerField(default=0, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-date"]
        constraints = [
            models.UniqueConstraint(
                fields=["manuscript", "date"],
                name="unique_manuscript_writing_day",
            ),
        ]


class DocumentVersion(models.Model):
    KIND_DRAFT = "draft"
    KIND_REVISION = "revision"
    KIND_CHOICES = [(KIND_DRAFT, "Draft"), (KIND_REVISION, "Revision")]

    document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="versions",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    name = models.TextField(blank=True, default="", editable=False)
    description = models.TextField(blank=True, default="", editable=False)
    snapshot_data = models.BinaryField(editable=False)
    schema_version = models.PositiveSmallIntegerField()
    source_history_generation = models.PositiveBigIntegerField(editable=False)
    word_count = models.PositiveIntegerField(default=0, editable=False)
    character_count = models.PositiveIntegerField(default=0, editable=False)
    metadata_version = models.PositiveBigIntegerField(default=0, editable=False)
    assets = models.ManyToManyField(
        "ManuscriptAsset",
        blank=True,
        related_name="document_versions",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["document", "kind", "-created_at"]),
        ]

    @property
    def snapshot(self) -> dict:
        return json.loads(gzip.decompress(bytes(self.snapshot_data)).decode("utf-8"))

    @snapshot.setter
    def snapshot(self, value: dict) -> None:
        serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.snapshot_data = gzip.compress(serialized)


class ManuscriptAsset(models.Model):
    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="assets",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    media = models.ForeignKey(
        "accounts.UserMediaAsset",
        on_delete=models.RESTRICT,
        related_name="manuscript_attachments",
    )
    content_type = models.CharField(max_length=32, editable=False)
    width = models.PositiveIntegerField(editable=False)
    height = models.PositiveIntegerField(editable=False)
    byte_size = models.PositiveBigIntegerField(editable=False)
    alt_text = models.TextField(blank=True, default="", editable=False)
    caption = models.TextField(blank=True, default="", editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(
                fields=["manuscript", "created_at"],
                name="manuscript_manuscr_dfb0db_idx",
            )
        ]


class Glossary(models.Model):
    manuscript = models.OneToOneField(
        Manuscript,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="glossary",
    )
    series = models.OneToOneField(
        Series,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="glossary",
    )
    spellcheck_revision = models.PositiveBigIntegerField(default=0, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(manuscript__isnull=False, series__isnull=True)
                    | models.Q(manuscript__isnull=True, series__isnull=False)
                ),
                name="glossary_exactly_one_scope",
            ),
        ]

    @property
    def workspace(self) -> Workspace:
        return self.series.workspace if self.series_id else self.manuscript.workspace

    @property
    def scope_type(self) -> str:
        return "series" if self.series_id else "manuscript"

    @property
    def scope_id(self) -> int:
        return self.series_id or self.manuscript_id


class GlossaryCustomWord(models.Model):
    glossary = models.ForeignKey(
        Glossary,
        on_delete=models.CASCADE,
        related_name="custom_words",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    word = models.TextField(editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["glossary", "created_at"])]


class GlossaryCategory(models.Model):
    glossary = models.ForeignKey(
        Glossary,
        on_delete=models.CASCADE,
        related_name="categories",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    system_key = models.CharField(max_length=32, blank=True, editable=False)
    name = models.TextField(blank=True, default="", editable=False)
    description = models.TextField(blank=True, default="", editable=False)
    icon = models.CharField(max_length=96, blank=True)
    position = models.PositiveIntegerField(default=0)
    is_hidden = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["glossary", "system_key"],
                condition=~models.Q(system_key=""),
                name="unique_glossary_system_category",
            ),
        ]
        indexes = [models.Index(fields=["glossary", "position", "created_at"])]


class GlossaryArticle(models.Model):
    CURRENT_SCHEMA_VERSION = 2
    EMPTY_CONTENT = {"type": "doc", "content": [{"type": "paragraph"}]}

    glossary = models.ForeignKey(
        Glossary,
        on_delete=models.CASCADE,
        related_name="articles",
    )
    category = models.ForeignKey(
        GlossaryCategory,
        on_delete=models.RESTRICT,
        related_name="articles",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    title = models.TextField(editable=False)
    synopsis = models.TextField(blank=True, default="", editable=False)
    content = models.JSONField(editable=False)
    schema_version = models.PositiveSmallIntegerField(default=CURRENT_SCHEMA_VERSION)
    save_generation = models.PositiveBigIntegerField(default=0, editable=False)
    is_favourite = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["glossary", "category", "-updated_at"]),
            models.Index(fields=["glossary", "is_favourite", "-updated_at"]),
        ]


class GlossaryArticleAlias(models.Model):
    article = models.ForeignKey(
        GlossaryArticle,
        on_delete=models.CASCADE,
        related_name="aliases",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    name = models.TextField(editable=False)
    normalized_name = models.TextField(editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["article", "normalized_name"],
                name="unique_glossary_article_alias",
            ),
        ]
        indexes = [models.Index(fields=["article", "created_at"])]


class GlossaryAsset(models.Model):
    KIND_THUMBNAIL = "thumbnail"
    KIND_COVER = "cover"
    KIND_ILLUSTRATION = "illustration"
    KIND_CHOICES = [
        (KIND_THUMBNAIL, "Thumbnail"),
        (KIND_COVER, "Cover"),
        (KIND_ILLUSTRATION, "Illustration"),
    ]

    article = models.ForeignKey(
        GlossaryArticle,
        on_delete=models.CASCADE,
        related_name="assets",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    media = models.ForeignKey(
        "accounts.UserMediaAsset",
        on_delete=models.RESTRICT,
        related_name="glossary_attachments",
    )
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    content_type = models.CharField(max_length=32, editable=False)
    width = models.PositiveIntegerField(editable=False)
    height = models.PositiveIntegerField(editable=False)
    byte_size = models.PositiveBigIntegerField(editable=False)
    alt_text = models.TextField(blank=True, default="", editable=False)
    caption = models.TextField(blank=True, default="", editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["article", "kind"],
                condition=models.Q(kind="thumbnail"),
                name="unique_glossary_article_thumbnail",
            ),
            models.UniqueConstraint(
                fields=["article", "kind"],
                condition=models.Q(kind="cover"),
                name="unique_glossary_article_cover",
            ),
        ]
        indexes = [models.Index(fields=["article", "kind", "created_at"])]


class GlossaryArticleLink(models.Model):
    source = models.ForeignKey(
        GlossaryArticle,
        on_delete=models.CASCADE,
        related_name="outgoing_links",
    )
    target = models.ForeignKey(
        GlossaryArticle,
        on_delete=models.RESTRICT,
        related_name="incoming_links",
    )
    position = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["source", "target"],
                name="unique_glossary_article_link",
            ),
            models.CheckConstraint(
                condition=~models.Q(source=models.F("target")),
                name="glossary_article_link_not_self",
            ),
        ]


class DocumentGlossaryAssociation(models.Model):
    document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="glossary_associations",
    )
    article = models.ForeignKey(
        GlossaryArticle,
        on_delete=models.CASCADE,
        related_name="document_associations",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["document", "article"],
                name="unique_document_glossary_article",
            ),
        ]
        indexes = [models.Index(fields=["document", "created_at"])]


class DocumentAnnotation(models.Model):
    STATUS_OPEN = "open"
    STATUS_RESOLVED = "resolved"
    STATUS_CHOICES = [(STATUS_OPEN, "Open"), (STATUS_RESOLVED, "Resolved")]

    document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="annotations",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        on_delete=models.SET_NULL,
        related_name="document_annotations",
    )
    guest_author = models.ForeignKey(
        "ShareParticipant",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="document_annotations",
    )
    quote = models.TextField(editable=False)
    comment = models.TextField(editable=False)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_OPEN)
    version = models.PositiveBigIntegerField(default=0, editable=False)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="resolved_document_annotations",
    )
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(
                fields=["document", "status", "created_at"],
                name="manuscript_annotat_6e4ca9_idx",
            )
        ]


class AnnotationReply(models.Model):
    annotation = models.ForeignKey(
        DocumentAnnotation,
        on_delete=models.CASCADE,
        related_name="replies",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        on_delete=models.SET_NULL,
        related_name="annotation_replies",
    )
    guest_author = models.ForeignKey(
        "ShareParticipant",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="annotation_replies",
    )
    body = models.TextField(editable=False)
    version = models.PositiveBigIntegerField(default=0, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(
                fields=["annotation", "created_at"],
                name="manuscript_reply_a5f12b_idx",
            )
        ]


class ManuscriptShareLink(models.Model):
    ACCESS_VIEW = "view"
    ACCESS_COMMENT = "comment"
    ACCESS_CHOICES = [(ACCESS_VIEW, "View only"), (ACCESS_COMMENT, "View and comment")]
    AUTHOR_DISPLAY_ACCOUNT = "account"
    AUTHOR_DISPLAY_PEN_NAME = "pen_name"
    AUTHOR_DISPLAY_CHOICES = [
        (AUTHOR_DISPLAY_ACCOUNT, "Account display name"),
        (AUTHOR_DISPLAY_PEN_NAME, "Author name"),
    ]

    SCOPE_ONESHOT = "oneshot"
    SCOPE_DOCUMENT = "document"
    SCOPE_FOLDER = "folder"
    SCOPE_CHOICES = [
        (SCOPE_ONESHOT, "One-Shot"),
        (SCOPE_DOCUMENT, "Document"),
        (SCOPE_FOLDER, "Folder"),
    ]

    manuscript = models.ForeignKey(
        Manuscript,
        on_delete=models.CASCADE,
        related_name="share_links",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="created_manuscript_share_links",
    )
    item = models.ForeignKey(
        ManuscriptItem,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="share_links",
    )
    token_hash = models.CharField(max_length=64, unique=True, editable=False)
    token = models.TextField(editable=False)
    access_level = models.CharField(max_length=16, choices=ACCESS_CHOICES)
    scope_type = models.CharField(max_length=16, choices=SCOPE_CHOICES)
    author_display = models.CharField(
        max_length=16,
        choices=AUTHOR_DISPLAY_CHOICES,
        default=AUTHOR_DISPLAY_ACCOUNT,
    )
    password_hash = models.CharField(max_length=128, blank=True, editable=False)
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["manuscript", "-created_at"]),
            models.Index(fields=["token_hash"]),
        ]


class ShareParticipant(models.Model):
    share_link = models.ForeignKey(
        ManuscriptShareLink,
        on_delete=models.CASCADE,
        related_name="participants",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    display_name = models.CharField(max_length=80)
    session_token_hash = models.CharField(max_length=64, unique=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["share_link", "created_at"]),
        ]


class EditorPreference(models.Model):
    QUOTE_STYLE_GUILLEMETS = "guillemets"
    QUOTE_STYLE_CURLY = "curly"
    QUOTE_STYLE_CHOICES = [
        (QUOTE_STYLE_GUILLEMETS, "Guillemets"),
        (QUOTE_STYLE_CURLY, "Curly quotes"),
    ]
    SPELLCHECK_DICTIONARY_RU = "ru"
    SPELLCHECK_DICTIONARY_EN_US = "en-US"
    SPELLCHECK_DICTIONARY_EN_GB = "en-GB"
    SPELLCHECK_DICTIONARY_CHOICES = [
        (SPELLCHECK_DICTIONARY_RU, "Russian"),
        (SPELLCHECK_DICTIONARY_EN_US, "English (US)"),
        (SPELLCHECK_DICTIONARY_EN_GB, "English (UK)"),
    ]

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="editor_preference",
    )
    font_size = models.PositiveSmallIntegerField(default=16)
    smart_quotes = models.BooleanField(default=False)
    quote_style = models.CharField(
        max_length=16,
        choices=QUOTE_STYLE_CHOICES,
        default=QUOTE_STYLE_GUILLEMETS,
    )
    auto_capitalize = models.BooleanField(default=False)
    auto_replace = models.BooleanField(default=False)
    spellcheck_enabled = models.BooleanField(default=False)
    spellcheck_dictionary = models.CharField(
        max_length=5,
        choices=SPELLCHECK_DICTIONARY_CHOICES,
        default=SPELLCHECK_DICTIONARY_RU,
    )
    updated_at = models.DateTimeField(auto_now=True)
