# Generated manually for the external news source foundation.

import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]

    operations = [
        migrations.CreateModel(
            name="NewsItem",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("public_id", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("source_key", models.CharField(max_length=80)),
                ("external_id", models.CharField(max_length=120)),
                ("canonical_url", models.URLField(max_length=1000)),
                ("title", models.TextField(editable=False)),
                ("author_name", models.TextField(editable=False)),
                ("summary", models.TextField(editable=False)),
                ("published_at", models.DateTimeField(db_index=True)),
                ("content_hash", models.CharField(editable=False, max_length=64)),
                ("first_seen_at", models.DateTimeField(auto_now_add=True)),
                ("last_seen_at", models.DateTimeField()),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["-published_at", "-id"]},
        ),
        migrations.CreateModel(
            name="SourceSyncState",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("source_key", models.CharField(max_length=80, unique=True)),
                ("last_attempted_at", models.DateTimeField(blank=True, null=True)),
                ("last_succeeded_at", models.DateTimeField(blank=True, null=True)),
                ("last_item_count", models.PositiveIntegerField(default=0)),
                ("consecutive_failures", models.PositiveIntegerField(default=0)),
                ("last_error_code", models.CharField(blank=True, max_length=80)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["source_key"]},
        ),
        migrations.CreateModel(
            name="NewsSourceSubscription",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("source_key", models.CharField(max_length=80)),
                ("enabled", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="news_source_subscriptions", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["source_key"]},
        ),
        migrations.AddConstraint(
            model_name="newsitem",
            constraint=models.UniqueConstraint(fields=("source_key", "external_id"), name="unique_news_source_external_id"),
        ),
        migrations.AddIndex(
            model_name="newsitem",
            index=models.Index(fields=["source_key", "-published_at", "-id"], name="sources_news_source_date_idx"),
        ),
        migrations.AddConstraint(
            model_name="newssourcesubscription",
            constraint=models.UniqueConstraint(fields=("user", "source_key"), name="unique_news_source_subscription"),
        ),
        migrations.AddIndex(
            model_name="newssourcesubscription",
            index=models.Index(fields=["user", "enabled"], name="sources_new_user_id_f2713f_idx"),
        ),
    ]
