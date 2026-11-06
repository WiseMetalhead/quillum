from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("manuscripts", "0039_idea_items"),
    ]

    operations = [
        migrations.AddField(
            model_name="manuscriptnote",
            name="source_idea_id",
            field=models.UUIDField(blank=True, editable=False, null=True, unique=True),
        ),
    ]
