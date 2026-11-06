import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
import uuid


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0025_accountexport"),
        ("manuscripts", "0038_audio_note_transcriptions"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="IdeaItem",
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
                ("public_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                (
                    "kind",
                    models.CharField(
                        choices=[("image", "Image"), ("text", "Text"), ("audio", "Audio")],
                        max_length=16,
                    ),
                ),
                ("title", models.TextField(blank=True, default="", editable=False)),
                ("text", models.TextField(blank=True, default="", editable=False)),
                ("save_generation", models.PositiveBigIntegerField(default=0, editable=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "image_media",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.RESTRICT,
                        related_name="idea_items",
                        to="accounts.usermediaasset",
                    ),
                ),
                (
                    "owner",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ideas",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-updated_at", "-id"],
            },
        ),
        migrations.AddConstraint(
            model_name="ideaitem",
            constraint=models.UniqueConstraint(
                condition=models.Q(("image_media__isnull", False)),
                fields=("owner", "image_media"),
                name="unique_owner_idea_image",
            ),
        ),
        migrations.AddConstraint(
            model_name="ideaitem",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(("image_media__isnull", False), ("kind", "image")),
                    models.Q(("image_media__isnull", True), ("kind", "text")),
                    models.Q(("image_media__isnull", True), ("kind", "audio")),
                    _connector="OR",
                ),
                name="idea_kind_media_shape",
            ),
        ),
        migrations.AddIndex(
            model_name="ideaitem",
            index=models.Index(
                fields=["owner", "kind", "-updated_at", "-id"],
                name="idea_owner_kind_updated_idx",
            ),
        ),
    ]
