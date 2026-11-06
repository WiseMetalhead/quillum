import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0027_editor_foundation"),
        ("manuscripts", "0041_audio_recordings"),
    ]

    operations = [
        migrations.CreateModel(
            name="ManuscriptEditorGrant",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "public_id",
                    models.UUIDField(default=uuid.uuid4, editable=False, unique=True),
                ),
                ("granted_at", models.DateTimeField(auto_now_add=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                (
                    "editor_connection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="manuscript_grants",
                        to="accounts.editorconnection",
                    ),
                ),
                (
                    "manuscript",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="editor_grants",
                        to="manuscripts.manuscript",
                    ),
                ),
            ],
            options={"ordering": ["-granted_at"]},
        ),
        migrations.AddConstraint(
            model_name="manuscripteditorgrant",
            constraint=models.UniqueConstraint(
                condition=models.Q(revoked_at__isnull=True),
                fields=("manuscript", "editor_connection"),
                name="unique_active_manuscript_editor_grant",
            ),
        ),
        migrations.AddIndex(
            model_name="manuscripteditorgrant",
            index=models.Index(
                fields=["manuscript", "revoked_at"],
                name="manuscripts_manuscr_ab2088_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="manuscripteditorgrant",
            index=models.Index(
                fields=["editor_connection", "revoked_at"],
                name="manuscripts_editor__e7834f_idx",
            ),
        ),
    ]
