from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sources", "0005_contestparticipation"),
    ]

    operations = [
        migrations.AddField(
            model_name="contestparticipation",
            name="track_deadlines",
            field=models.BooleanField(default=False),
        ),
    ]
