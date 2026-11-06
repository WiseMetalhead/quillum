from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0023_finalize_plaintext"),
        ("adminpanel", "0001_squashed_0005_plaintext_bridge"),
    ]

    operations = [
        migrations.RenameField(
            model_name="servicesetting",
            old_name="value_plaintext",
            new_name="value",
        ),
        migrations.AlterField(
            model_name="servicesetting",
            name="value",
            field=models.JSONField(editable=False),
        ),
        migrations.RemoveField(model_name="servicesetting", name="encrypted_data_key"),
        migrations.RemoveField(model_name="servicesetting", name="value_ciphertext"),
    ]
