from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0023_finalize_plaintext"),
        ("notifications", "0001_squashed_0004_plaintext_bridge"),
    ]

    operations = [
        migrations.RenameField(
            model_name="notification",
            old_name="payload_plaintext",
            new_name="payload",
        ),
        migrations.AlterField(
            model_name="notification",
            name="payload",
            field=models.JSONField(default=dict, editable=False),
        ),
        migrations.RenameField(
            model_name="adminnotificationcampaign",
            old_name="title_plaintext",
            new_name="title",
        ),
        migrations.AlterField(
            model_name="adminnotificationcampaign",
            name="title",
            field=models.TextField(editable=False),
        ),
        migrations.RenameField(
            model_name="adminnotificationcampaign",
            old_name="body_plaintext",
            new_name="body",
        ),
        migrations.AlterField(
            model_name="adminnotificationcampaign",
            name="body",
            field=models.TextField(editable=False),
        ),
        migrations.RemoveField(model_name="notification", name="payload_ciphertext"),
        migrations.RemoveField(
            model_name="adminnotificationcampaign",
            name="encrypted_data_key",
        ),
        migrations.RemoveField(
            model_name="adminnotificationcampaign",
            name="title_ciphertext",
        ),
        migrations.RemoveField(
            model_name="adminnotificationcampaign",
            name="body_ciphertext",
        ),
    ]
