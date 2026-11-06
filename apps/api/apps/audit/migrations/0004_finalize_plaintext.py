from django.db import migrations, models


def normalize_missing_ip_addresses(apps, schema_editor):
    AuditEvent = apps.get_model("audit", "AuditEvent")
    AuditEvent.objects.filter(ip_address="").update(ip_address=None)


def restore_bridge_ip_addresses(apps, schema_editor):
    AuditEvent = apps.get_model("audit", "AuditEvent")
    AuditEvent.objects.filter(ip_address__isnull=True).update(ip_address="")


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0023_finalize_plaintext"),
        ("audit", "0001_squashed_0003_plaintext_bridge"),
    ]

    operations = [
        migrations.RenameField(
            model_name="auditevent",
            old_name="ip_address_plaintext",
            new_name="ip_address",
        ),
        migrations.RunPython(
            normalize_missing_ip_addresses,
            restore_bridge_ip_addresses,
        ),
        migrations.AlterField(
            model_name="auditevent",
            name="ip_address",
            field=models.TextField(blank=True, db_index=True, editable=False, null=True),
        ),
        migrations.RenameField(
            model_name="auditevent",
            old_name="user_agent_plaintext",
            new_name="user_agent",
        ),
        migrations.AlterField(
            model_name="auditevent",
            name="user_agent",
            field=models.TextField(blank=True, default="", editable=False),
        ),
        migrations.RenameField(
            model_name="auditevent",
            old_name="payload_plaintext",
            new_name="payload",
        ),
        migrations.AlterField(
            model_name="auditevent",
            name="payload",
            field=models.JSONField(default=dict, editable=False),
        ),
        migrations.RemoveField(model_name="auditevent", name="encrypted_data_key"),
        migrations.RemoveField(model_name="auditevent", name="ip_address_ciphertext"),
        migrations.RemoveField(model_name="auditevent", name="ip_address_index"),
        migrations.RemoveField(model_name="auditevent", name="user_agent_ciphertext"),
        migrations.RemoveField(model_name="auditevent", name="payload_ciphertext"),
    ]
