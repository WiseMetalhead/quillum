from uuid import uuid4

from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone

from .lookups import normalize_email


class User(AbstractUser):
    LANGUAGE_EN = "en"
    LANGUAGE_RU = "ru"
    THEME_SYSTEM = "system"
    THEME_LIGHT = "light"
    THEME_DARK = "dark"
    TIER_NOVICE = "novice"
    TIER_AUTHOR = "author"
    TIER_BELIEVER = "believer"
    TIER_GOD = "god"
    TWO_FACTOR_NONE = "none"
    TWO_FACTOR_TOTP = "totp"
    TWO_FACTOR_EMAIL = "email"
    LANGUAGE_CHOICES = [
        (LANGUAGE_EN, "English"),
        (LANGUAGE_RU, "Russian"),
    ]
    THEME_CHOICES = [
        (THEME_SYSTEM, "System"),
        (THEME_LIGHT, "Light"),
        (THEME_DARK, "Dark"),
    ]
    TIER_CHOICES = [
        (TIER_NOVICE, "Novice"),
        (TIER_AUTHOR, "Author"),
        (TIER_BELIEVER, "Believer"),
        (TIER_GOD, "God"),
    ]
    TWO_FACTOR_CHOICES = [
        (TWO_FACTOR_NONE, "Disabled"),
        (TWO_FACTOR_TOTP, "TOTP"),
        (TWO_FACTOR_EMAIL, "Email"),
    ]

    email = models.EmailField(max_length=254, blank=True, default="", editable=False)
    display_name = models.TextField(blank=True, default="", editable=False)
    first_name = models.TextField(blank=True, default="", editable=False)
    last_name = models.TextField(blank=True, default="", editable=False)
    avatar = models.FileField(upload_to="avatars/%Y/%m/", blank=True)
    language = models.CharField(max_length=16, choices=LANGUAGE_CHOICES, default=LANGUAGE_EN)
    theme = models.CharField(max_length=16, choices=THEME_CHOICES, default=THEME_SYSTEM)
    tier = models.CharField(max_length=16, choices=TIER_CHOICES, default=TIER_NOVICE)
    author_name = models.TextField(blank=True, default="", editable=False)
    author_email = models.EmailField(max_length=254, blank=True, default="", editable=False)
    author_website = models.TextField(blank=True, default="", editable=False)
    author_today_profile = models.TextField(blank=True, default="", editable=False)
    author_litres_profile = models.TextField(blank=True, default="", editable=False)
    author_proza_profile = models.TextField(blank=True, default="", editable=False)
    author_samizdat_profile = models.TextField(blank=True, default="", editable=False)
    author_cellulosa_profile = models.TextField(blank=True, default="", editable=False)
    author_wattpad_profile = models.TextField(blank=True, default="", editable=False)
    workspace_useful_links = models.JSONField(default=list, editable=False)
    onboarding_completed_at = models.DateTimeField(
        blank=True,
        null=True,
        default=timezone.now,
        editable=False,
    )
    author_workspace_enabled_at = models.DateTimeField(
        blank=True,
        null=True,
        default=timezone.now,
        editable=False,
    )
    editor_workspace_enabled_at = models.DateTimeField(
        blank=True,
        null=True,
        editable=False,
    )
    password_changed_at = models.DateTimeField(default=timezone.now)
    timezone = models.CharField(max_length=64, default="UTC")
    two_factor_method = models.CharField(
        max_length=16,
        choices=TWO_FACTOR_CHOICES,
        default=TWO_FACTOR_NONE,
    )
    totp_secret = models.TextField(blank=True, default="", editable=False)
    totp_confirmed_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["username"]
        constraints = [
            models.UniqueConstraint(
                fields=["email"],
                condition=~models.Q(email=""),
                name="unique_user_email",
            )
        ]

    def save(self, *args, **kwargs):
        self.email = normalize_email(self.email)
        self.is_staff = self.is_superuser
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and "is_staff" not in update_fields:
            kwargs["update_fields"] = [*update_fields, "is_staff"]
        if self.is_superuser and self.tier != self.TIER_GOD:
            self.tier = self.TIER_GOD
            update_fields = kwargs.get("update_fields")
            if update_fields is not None and "tier" not in update_fields:
                kwargs["update_fields"] = [*update_fields, "tier"]
        return super().save(*args, **kwargs)


class TierActivityProgress(models.Model):
    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name="tier_activity_progress",
    )
    tier = models.CharField(max_length=16, choices=User.TIER_CHOICES)
    active_days = models.PositiveIntegerField(default=0)
    last_activity_date = models.DateField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["user_id"]

    def __str__(self) -> str:
        return f"{self.user_id}:{self.tier}:{self.active_days}"


class RegistrationCounter(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    total_registrations = models.PositiveBigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class OidcIdentity(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="oidc_identities",
    )
    issuer = models.CharField(max_length=500)
    subject = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    last_login_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["issuer", "subject"]
        constraints = [
            models.UniqueConstraint(
                fields=["issuer", "subject"],
                name="unique_oidc_issuer_subject",
            )
        ]
        indexes = [models.Index(fields=["user", "issuer"])]


class EditorInvitation(models.Model):
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="editor_invitations",
    )
    public_id = models.UUIDField(default=uuid4, unique=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(db_index=True)
    revoked_at = models.DateTimeField(blank=True, null=True)
    accepted_at = models.DateTimeField(blank=True, null=True)
    accepted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        blank=True,
        null=True,
        on_delete=models.SET_NULL,
        related_name="accepted_editor_invitations",
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["author", "expires_at"])]


class EditorConnection(models.Model):
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="editor_connections",
    )
    editor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="writer_connections",
    )
    invitation = models.OneToOneField(
        EditorInvitation,
        on_delete=models.CASCADE,
        related_name="connection",
    )
    connected_at = models.DateTimeField(auto_now_add=True)
    disconnected_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-connected_at"]
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(author=models.F("editor")),
                name="editor_connection_users_differ",
            ),
            models.UniqueConstraint(
                fields=["author", "editor"],
                condition=models.Q(disconnected_at__isnull=True),
                name="unique_active_editor_connection",
            ),
        ]
        indexes = [
            models.Index(fields=["author", "disconnected_at"]),
            models.Index(fields=["editor", "disconnected_at"]),
        ]


class UserMediaAsset(models.Model):
    """One private plaintext image object reusable across a user's workspaces."""

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="media_assets",
    )
    public_id = models.UUIDField(default=uuid4, unique=True, editable=False)
    content_hash = models.CharField(max_length=64, editable=False)
    original = models.FileField(upload_to="media/original/%Y/%m/")
    thumbnail_small = models.FileField(upload_to="media/thumbnail-small/%Y/%m/")
    thumbnail_medium = models.FileField(upload_to="media/thumbnail-medium/%Y/%m/")
    editor_medium = models.FileField(upload_to="media/editor-medium/%Y/%m/")
    editor_large = models.FileField(upload_to="media/editor-large/%Y/%m/")
    content_type = models.CharField(max_length=32, editable=False)
    width = models.PositiveIntegerField(editable=False)
    height = models.PositiveIntegerField(editable=False)
    byte_size = models.PositiveBigIntegerField(editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "content_hash"],
                name="unique_user_media_content_hash",
            )
        ]
        indexes = [models.Index(fields=["owner", "-updated_at"])]


class AccountExport(models.Model):
    MANUSCRIPT_FORMAT_MARKDOWN = "markdown"
    MANUSCRIPT_FORMAT_DOCX = "docx"
    MANUSCRIPT_FORMAT_ODT = "odt"
    MANUSCRIPT_FORMAT_CHOICES = (
        (MANUSCRIPT_FORMAT_MARKDOWN, "Markdown"),
        (MANUSCRIPT_FORMAT_DOCX, "DOCX"),
        (MANUSCRIPT_FORMAT_ODT, "ODT"),
    )
    GLOSSARY_FORMAT_MARKDOWN = "markdown"
    GLOSSARY_FORMAT_HTML = "html"
    GLOSSARY_FORMAT_CHOICES = (
        (GLOSSARY_FORMAT_MARKDOWN, "Markdown"),
        (GLOSSARY_FORMAT_HTML, "HTML"),
    )
    STATUS_PENDING = "pending"
    STATUS_BUILDING = "building"
    STATUS_READY = "ready"
    STATUS_FAILED = "failed"
    STATUS_EXPIRED = "expired"
    STATUS_CHOICES = (
        (STATUS_PENDING, "Pending"),
        (STATUS_BUILDING, "Building"),
        (STATUS_READY, "Ready"),
        (STATUS_FAILED, "Failed"),
        (STATUS_EXPIRED, "Expired"),
    )

    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="account_export",
    )
    public_id = models.UUIDField(default=uuid4, unique=True, editable=False)
    manuscript_format = models.CharField(max_length=16, choices=MANUSCRIPT_FORMAT_CHOICES)
    glossary_format = models.CharField(max_length=16, choices=GLOSSARY_FORMAT_CHOICES)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING)
    artifact = models.FileField(upload_to="account-exports/%Y/%m/", blank=True)
    file_name = models.CharField(max_length=255, blank=True)
    content_type = models.CharField(max_length=96, blank=True)
    byte_size = models.PositiveBigIntegerField(default=0)
    error_code = models.CharField(max_length=80, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["status", "expires_at"],
                name="accounts_ac_status_4b9b5e_idx",
            )
        ]


class EmailChangeRequest(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    new_email = models.EmailField(max_length=254, editable=False)
    code_hash = models.CharField(max_length=256)
    attempt_count = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "-created_at"]),
            models.Index(fields=["new_email", "-created_at"]),
        ]

    @property
    def is_consumed(self) -> bool:
        return self.consumed_at is not None

    def save(self, *args, **kwargs):
        self.new_email = normalize_email(self.new_email)
        return super().save(*args, **kwargs)


class BootstrapState(models.Model):
    singleton_id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    completed_at = models.DateTimeField(blank=True, null=True)

    def save(self, *args, **kwargs):
        self.singleton_id = 1
        return super().save(*args, **kwargs)


class PasswordChangeRequest(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    password_hash = models.CharField(max_length=256)
    code_hash = models.CharField(max_length=256)
    attempt_count = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "-created_at"]),
        ]

    @property
    def is_consumed(self) -> bool:
        return self.consumed_at is not None


class PasskeyCredential(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="passkey_credentials",
    )
    name = models.CharField(max_length=120)
    credential_id = models.TextField(blank=True)
    public_key = models.TextField(blank=True)
    sign_count = models.BigIntegerField(default=0)
    aaguid = models.CharField(max_length=64, blank=True)
    transports = models.JSONField(default=list, blank=True)
    backup_eligible = models.BooleanField(default=False)
    backup_state = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["name", "created_at"]
        indexes = [
            models.Index(fields=["user", "name"]),
            models.Index(fields=["credential_id"]),
        ]

    def __str__(self) -> str:
        return self.name
