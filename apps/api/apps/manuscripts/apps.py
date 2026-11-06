from django.apps import AppConfig


class ManuscriptsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.manuscripts"

    def ready(self) -> None:
        from . import signals  # noqa: F401
