from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def create_service_pages(apps, schema_editor):
    ServicePage = apps.get_model("servicepages", "ServicePage")
    ServicePage.objects.bulk_create(
        [ServicePage(slug=slug) for slug in ("privacy", "terms", "contact")]
    )


class Migration(migrations.Migration):
    initial = True

    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]

    operations = [
        migrations.CreateModel(
            name="ServicePage",
            fields=[
                (
                    "slug",
                    models.CharField(
                        choices=[
                            ("privacy", "Privacy"),
                            ("terms", "Terms"),
                            ("contact", "Contact"),
                        ],
                        max_length=16,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("draft_markdown", models.TextField(blank=True)),
                ("is_published", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "updated_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="updated_service_pages",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"ordering": ["slug"]},
        ),
        migrations.CreateModel(
            name="ServicePageRevision",
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
                ("version", models.PositiveIntegerField()),
                ("markdown", models.TextField()),
                ("published_at", models.DateTimeField(auto_now_add=True)),
                (
                    "page",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="revisions",
                        to="servicepages.servicepage",
                    ),
                ),
                (
                    "published_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="published_service_page_revisions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["page_id", "-version"],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("page", "version"),
                        name="unique_service_page_revision_version",
                    )
                ],
            },
        ),
        migrations.AddField(
            model_name="servicepage",
            name="active_revision",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="active_for_pages",
                to="servicepages.servicepagerevision",
            ),
        ),
        migrations.RunPython(create_service_pages, migrations.RunPython.noop),
    ]
