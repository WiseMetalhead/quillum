import django.db.models.deletion
import django.utils.timezone
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("sources", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="ContestItem",
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
                ("source_key", models.CharField(max_length=80)),
                ("external_id", models.CharField(max_length=120)),
                ("canonical_url", models.URLField(max_length=1000)),
                ("title", models.TextField(editable=False)),
                ("description", models.TextField(editable=False)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("accepting", "Accepting entries"),
                            ("preparation", "Preparation"),
                            ("in_progress", "In progress"),
                            ("finished", "Finished"),
                        ],
                        max_length=24,
                    ),
                ),
                ("discussion_url", models.URLField(blank=True, max_length=1000)),
                (
                    "action_kind",
                    models.CharField(
                        blank=True,
                        choices=[
                            ("works", "Contest works"),
                            ("results", "Results"),
                        ],
                        max_length=16,
                    ),
                ),
                ("action_url", models.URLField(blank=True, max_length=1000)),
                ("source_position", models.PositiveSmallIntegerField(default=0)),
                ("content_hash", models.CharField(editable=False, max_length=64)),
                (
                    "first_seen_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("last_seen_at", models.DateTimeField()),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["-first_seen_at", "source_position", "id"]},
        ),
        migrations.CreateModel(
            name="ContestSourceSubscription",
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
                ("source_key", models.CharField(max_length=80)),
                ("enabled", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="contest_source_subscriptions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"ordering": ["source_key"]},
        ),
        migrations.AddConstraint(
            model_name="contestitem",
            constraint=models.UniqueConstraint(
                fields=("source_key", "external_id"),
                name="unique_contest_source_external_id",
            ),
        ),
        migrations.AddIndex(
            model_name="contestitem",
            index=models.Index(
                fields=["source_key", "status", "-first_seen_at"],
                name="sources_contest_feed_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="contestsourcesubscription",
            constraint=models.UniqueConstraint(
                fields=("user", "source_key"),
                name="unique_contest_source_subscription",
            ),
        ),
        migrations.AddIndex(
            model_name="contestsourcesubscription",
            index=models.Index(
                fields=["user", "enabled"],
                name="sources_cont_user_enabled_idx",
            ),
        ),
    ]
