import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("manuscripts", "0042_manuscript_editor_grants"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="DocumentCollaborationState",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("legacy", "Legacy")],
                        default="active",
                        max_length=16,
                    ),
                ),
                ("epoch", models.PositiveBigIntegerField(default=1, editable=False)),
                ("ydoc_state", models.BinaryField(default=bytes, editable=False)),
                ("snapshot_sequence", models.PositiveBigIntegerField(default=0, editable=False)),
                ("latest_sequence", models.PositiveBigIntegerField(default=0, editable=False)),
                (
                    "materialized_sequence",
                    models.PositiveBigIntegerField(default=0, editable=False),
                ),
                ("schema_version", models.PositiveSmallIntegerField(default=3)),
                (
                    "diagnostic_status",
                    models.CharField(
                        choices=[("ready", "Ready"), ("failed", "Failed")],
                        default="ready",
                        max_length=16,
                    ),
                ),
                (
                    "diagnostic_code",
                    models.CharField(blank=True, default="", editable=False, max_length=64),
                ),
                ("materialized_at", models.DateTimeField(blank=True, editable=False, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "document",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="collaboration_state",
                        to="manuscripts.document",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="DocumentCollaborationUpdate",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("update_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("epoch", models.PositiveBigIntegerField(editable=False)),
                ("sequence", models.PositiveBigIntegerField(editable=False)),
                ("update_data", models.BinaryField(editable=False)),
                (
                    "role",
                    models.CharField(
                        choices=[("owner", "Owner"), ("editor", "Editor"), ("system", "System")],
                        max_length=16,
                    ),
                ),
                ("timezone", models.CharField(blank=True, default="UTC", max_length=64)),
                ("positive_word_delta", models.PositiveIntegerField(default=0, editable=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "actor",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="document_collaboration_updates",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "state",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="updates",
                        to="manuscripts.documentcollaborationstate",
                    ),
                ),
            ],
            options={
                "ordering": ["sequence"],
                "indexes": [
                    models.Index(
                        fields=["state", "epoch", "sequence"], name="collab_update_replay_idx"
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("state", "epoch", "sequence"),
                        name="unique_collaboration_update_sequence",
                    )
                ],
            },
        ),
    ]
