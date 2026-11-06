from django.db import migrations, models
from django.utils import timezone


def backfill_editor_workspace(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    EditorConnection = apps.get_model("accounts", "EditorConnection")
    now = timezone.now()
    User.objects.filter(author_workspace_enabled_at__isnull=True).update(
        editor_workspace_enabled_at=now,
    )
    connected_editor_ids = EditorConnection.objects.values_list("editor_id", flat=True)
    User.objects.filter(id__in=connected_editor_ids).update(
        editor_workspace_enabled_at=now,
    )


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0027_editor_foundation"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="editor_workspace_enabled_at",
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.RunPython(backfill_editor_workspace, migrations.RunPython.noop),
    ]
