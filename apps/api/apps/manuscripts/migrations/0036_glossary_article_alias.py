import django.db.models.deletion
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("manuscripts", "0035_consolidate_media_storage"),
    ]

    operations = [
        migrations.CreateModel(
            name="GlossaryArticleAlias",
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
                ("name", models.TextField(editable=False)),
                ("normalized_name", models.TextField(editable=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "article",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="aliases",
                        to="manuscripts.glossaryarticle",
                    ),
                ),
            ],
            options={
                "ordering": ["created_at"],
                "indexes": [
                    models.Index(
                        fields=["article", "created_at"],
                        name="manuscripts_article_31b106_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("article", "normalized_name"),
                        name="unique_glossary_article_alias",
                    ),
                ],
            },
        ),
    ]
