import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0024_user_onboarding_completed_at"),
    ]

    operations = [
        migrations.CreateModel(
            name="AccountExport",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("public_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                (
                    "manuscript_format",
                    models.CharField(
                        choices=[("markdown", "Markdown"), ("docx", "DOCX"), ("odt", "ODT")],
                        max_length=16,
                    ),
                ),
                (
                    "glossary_format",
                    models.CharField(
                        choices=[("markdown", "Markdown"), ("html", "HTML")], max_length=16
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("building", "Building"),
                            ("ready", "Ready"),
                            ("failed", "Failed"),
                            ("expired", "Expired"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("artifact", models.FileField(blank=True, upload_to="account-exports/%Y/%m/")),
                ("file_name", models.CharField(blank=True, max_length=255)),
                ("content_type", models.CharField(blank=True, max_length=96)),
                ("byte_size", models.PositiveBigIntegerField(default=0)),
                ("error_code", models.CharField(blank=True, max_length=80)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                ("expires_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "owner",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="account_export",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["status", "expires_at"], name="accounts_ac_status_4b9b5e_idx"
                    )
                ],
            },
        ),
    ]
