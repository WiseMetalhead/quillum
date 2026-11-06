from django.core.checks import Error, Tags, register
from django.core.exceptions import ImproperlyConfigured

from .runtime_settings import DEFINITIONS, environment_value


@register(Tags.security)
def runtime_environment_settings_check(app_configs, **kwargs):
    errors = []
    environment_values = {}
    for definition in DEFINITIONS:
        try:
            value = environment_value(definition)
            environment_values[definition.key] = definition.default if value is None else value
        except ImproperlyConfigured as exc:
            errors.append(
                Error(
                    str(exc),
                    id="adminpanel.E001",
                )
            )
    if environment_values.get("email_use_tls") and environment_values.get("email_use_ssl"):
        errors.append(
            Error(
                "DJANGO_EMAIL_USE_TLS and DJANGO_EMAIL_USE_SSL cannot both be enabled.",
                id="adminpanel.E002",
            )
        )
    return errors
