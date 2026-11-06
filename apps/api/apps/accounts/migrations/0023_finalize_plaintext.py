from django.db import migrations, models


def require_verified_plaintext(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    MigrationState = apps.get_model("accounts", "PlaintextMigrationState")
    if not User.objects.exists():
        return
    marker = MigrationState.objects.filter(singleton_id=1).first()
    if marker is None or marker.verified_at is None:
        raise RuntimeError(
            "Quillum 0.1.3 requires a successful migrate_to_plaintext --verify "
            "run from version 0.1.2 before final schema migration."
        )


def finalize_field(model_name, old_name, new_name, field):
    return [
        migrations.RenameField(
            model_name=model_name,
            old_name=old_name,
            new_name=new_name,
        ),
        migrations.AlterField(
            model_name=model_name,
            name=new_name,
            field=field,
        ),
    ]


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0001_squashed_0022_plaintext_email_types"),
        ("adminpanel", "0001_squashed_0005_plaintext_bridge"),
        ("audit", "0001_squashed_0003_plaintext_bridge"),
        ("manuscripts", "0001_squashed_0033_plaintext_bridge"),
        ("notifications", "0001_squashed_0004_plaintext_bridge"),
    ]

    operations = [
        migrations.RunPython(require_verified_plaintext, migrations.RunPython.noop),
        migrations.RemoveConstraint(
            model_name="user",
            name="unique_user_plaintext_email",
        ),
        migrations.RemoveIndex(
            model_name="emailchangerequest",
            name="accounts_em_new_ema_376da0_idx",
        ),
        *finalize_field(
            "user",
            "email_plaintext",
            "email",
            models.EmailField(blank=True, default="", editable=False, max_length=254),
        ),
        *finalize_field(
            "user",
            "display_name_plaintext",
            "display_name",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "first_name_plaintext",
            "first_name",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "last_name_plaintext",
            "last_name",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "author_name_plaintext",
            "author_name",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "author_email_plaintext",
            "author_email",
            models.EmailField(blank=True, default="", editable=False, max_length=254),
        ),
        *finalize_field(
            "user",
            "author_website_plaintext",
            "author_website",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "author_today_profile_plaintext",
            "author_today_profile",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "author_litres_profile_plaintext",
            "author_litres_profile",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "author_proza_profile_plaintext",
            "author_proza_profile",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "author_samizdat_profile_plaintext",
            "author_samizdat_profile",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "author_cellulosa_profile_plaintext",
            "author_cellulosa_profile",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "author_wattpad_profile_plaintext",
            "author_wattpad_profile",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "user",
            "workspace_useful_links_plaintext",
            "workspace_useful_links",
            models.JSONField(default=list, editable=False),
        ),
        *finalize_field(
            "user",
            "totp_secret_plaintext",
            "totp_secret",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "emailchangerequest",
            "new_email_plaintext",
            "new_email",
            models.EmailField(editable=False, max_length=254),
        ),
        migrations.RemoveField(model_name="user", name="encrypted_data_key"),
        migrations.RemoveField(model_name="user", name="email_ciphertext"),
        migrations.RemoveField(model_name="user", name="email_index"),
        migrations.RemoveField(model_name="user", name="display_name_ciphertext"),
        migrations.RemoveField(model_name="user", name="first_name_ciphertext"),
        migrations.RemoveField(model_name="user", name="last_name_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_name_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_email_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_website_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_today_profile_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_litres_profile_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_proza_profile_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_samizdat_profile_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_cellulosa_profile_ciphertext"),
        migrations.RemoveField(model_name="user", name="author_wattpad_profile_ciphertext"),
        migrations.RemoveField(model_name="user", name="workspace_useful_links_ciphertext"),
        migrations.RemoveField(model_name="user", name="totp_secret_ciphertext"),
        migrations.RemoveField(model_name="emailchangerequest", name="new_email_ciphertext"),
        migrations.RemoveField(model_name="emailchangerequest", name="new_email_index"),
        migrations.AddConstraint(
            model_name="user",
            constraint=models.UniqueConstraint(
                condition=~models.Q(email=""),
                fields=("email",),
                name="unique_user_email",
            ),
        ),
        migrations.AddIndex(
            model_name="emailchangerequest",
            index=models.Index(
                fields=["new_email", "-created_at"],
                name="accounts_em_new_ema_93c932_idx",
            ),
        ),
        migrations.DeleteModel(name="PlaintextMigrationState"),
    ]
