import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.utils import timezone


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0026_remove_staff_role"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="author_workspace_enabled_at",
            field=models.DateTimeField(
                blank=True,
                default=timezone.now,
                editable=False,
                null=True,
            ),
        ),
        migrations.CreateModel(
            name="EditorInvitation",
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
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("accepted_at", models.DateTimeField(blank=True, null=True)),
                (
                    "accepted_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="accepted_editor_invitations",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "author",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="editor_invitations",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["author", "expires_at"],
                        name="accounts_ed_author__132f76_idx",
                    )
                ],
            },
        ),
        migrations.CreateModel(
            name="EditorConnection",
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
                ("connected_at", models.DateTimeField(auto_now_add=True)),
                ("disconnected_at", models.DateTimeField(blank=True, null=True)),
                (
                    "author",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="editor_connections",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "editor",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="writer_connections",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "invitation",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="connection",
                        to="accounts.editorinvitation",
                    ),
                ),
            ],
            options={
                "ordering": ["-connected_at"],
                "indexes": [
                    models.Index(
                        fields=["author", "disconnected_at"],
                        name="accounts_ed_author__d5361b_idx",
                    ),
                    models.Index(
                        fields=["editor", "disconnected_at"],
                        name="accounts_ed_editor__8d7ff8_idx",
                    ),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=~models.Q(("author", models.F("editor"))),
                        name="editor_connection_users_differ",
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(("disconnected_at__isnull", True)),
                        fields=("author", "editor"),
                        name="unique_active_editor_connection",
                    ),
                ],
            },
        ),
    ]
