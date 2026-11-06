from django.db import migrations


def align_django_admin_flags(apps, _schema_editor):
    user_model = apps.get_model("accounts", "User")
    progress_model = apps.get_model("accounts", "TierActivityProgress")
    user_model.objects.filter(is_superuser=True, is_staff=False).update(is_staff=True)
    user_model.objects.filter(is_superuser=False, is_staff=True).update(is_staff=False)
    administrator_ids = user_model.objects.filter(is_superuser=True).values_list("id", flat=True)
    user_model.objects.filter(id__in=administrator_ids).exclude(tier="god").update(tier="god")
    progress_model.objects.filter(user_id__in=administrator_ids).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0025_accountexport"),
    ]

    operations = [
        migrations.RunPython(align_django_admin_flags, migrations.RunPython.noop),
    ]
