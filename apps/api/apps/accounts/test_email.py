from unittest.mock import patch

import pytest

from apps.accounts.email import runtime_email_connection
from apps.adminpanel.runtime_settings import set_runtime_override


@pytest.mark.django_db
def test_runtime_email_connection_builds_smtp_backend(monkeypatch):
    for env_name in (
        "DJANGO_EMAIL_BACKEND",
        "DJANGO_EMAIL_HOST",
        "DJANGO_EMAIL_PORT",
        "DJANGO_EMAIL_HOST_USER",
        "DJANGO_EMAIL_HOST_PASSWORD",
        "DJANGO_EMAIL_USE_TLS",
        "DJANGO_EMAIL_USE_SSL",
        "DJANGO_EMAIL_TIMEOUT",
    ):
        monkeypatch.delenv(env_name, raising=False)
    set_runtime_override("email_backend", "smtp")
    set_runtime_override("email_host", "smtp.example.test")
    set_runtime_override("email_port", 587)
    set_runtime_override("email_host_user", "quillum")
    set_runtime_override("email_host_password", "smtp-password")
    set_runtime_override("email_use_tls", True)
    set_runtime_override("email_use_ssl", False)
    set_runtime_override("email_timeout_seconds", 10)

    with (
        patch("apps.accounts.email.running_pytest", return_value=False),
        patch("apps.accounts.email.get_connection") as get_connection,
    ):
        runtime_email_connection()

    get_connection.assert_called_once_with(
        backend="django.core.mail.backends.smtp.EmailBackend",
        host="smtp.example.test",
        port=587,
        username="quillum",
        password="smtp-password",
        use_tls=True,
        use_ssl=False,
        timeout=10,
        fail_silently=False,
    )
