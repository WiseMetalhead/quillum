from django.apps import apps
from django.db.models.signals import post_migrate
from django.dispatch import receiver

from .bootstrap import ensure_bootstrap_admin


@receiver(post_migrate)
def create_bootstrap_admin(sender, **_kwargs):
    if sender.name != "apps.accounts":
        return

    user_model = apps.get_model("accounts", "User")
    ensure_bootstrap_admin(user_model)

