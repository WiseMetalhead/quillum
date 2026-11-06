from django.apps import AppConfig


class AdminPanelConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.adminpanel"

    def ready(self):
        from . import checks, task_monitor  # noqa: F401
