from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from email.utils import parseaddr
from typing import Literal

from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.validators import validate_email
from django.db import transaction

from .models import ServiceSetting

SettingKind = Literal["boolean", "choice", "email", "integer", "rate", "secret", "string"]
SettingSection = Literal["primary", "advanced"]
TRUE_VALUES = {"1", "true", "yes", "on"}
FALSE_VALUES = {"0", "false", "no", "off"}
RATE_PATTERN = re.compile(
    r"^(?P<count>\d+)\s*/\s*(?P<period>\d+)?"
    r"(?P<unit>s|m|h|d|second|minute|hour|day)s?$"
)
CACHE_TTL_SECONDS = 300
CACHE_PREFIX = "quillum:service-setting:v1"


@dataclass(frozen=True)
class SettingDefinition:
    key: str
    label: str
    section: SettingSection
    kind: SettingKind
    env_name: str
    default: bool | int | str
    minimum: int | None = None
    maximum: int | None = None
    max_length: int | None = None
    allow_blank: bool = False
    choices: tuple[str, ...] = ()
    environment_aliases: tuple[tuple[str, str], ...] = ()

    def validate(self, value):
        if self.kind == "boolean":
            if not isinstance(value, bool):
                raise ValueError("boolean_required")
            return value
        if self.kind == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError("integer_required")
            if self.minimum is not None and value < self.minimum:
                raise ValueError("value_too_small")
            if self.maximum is not None and value > self.maximum:
                raise ValueError("value_too_large")
            return value
        if not isinstance(value, str):
            raise ValueError("string_required")
        normalized = value.strip()
        if not normalized and not self.allow_blank:
            raise ValueError("value_required")
        if self.max_length is not None and len(normalized) > self.max_length:
            raise ValueError("value_too_long")
        if self.kind == "choice" and normalized not in self.choices:
            raise ValueError("choice_invalid")
        if self.kind == "email":
            if "\r" in normalized or "\n" in normalized:
                raise ValueError("email_invalid")
            _display_name, address = parseaddr(normalized)
            if address.endswith("@localhost") and address != "@localhost":
                return normalized
            try:
                validate_email(address)
            except ValidationError as exc:
                raise ValueError("email_invalid") from exc
        if self.kind == "rate":
            match = RATE_PATTERN.fullmatch(normalized)
            if match is None or int(match.group("count")) < 1:
                raise ValueError("rate_invalid")
            if match.group("period") and int(match.group("period")) < 1:
                raise ValueError("rate_invalid")
        return normalized

    def parse_environment(self, raw_value: str):
        if self.kind == "boolean":
            normalized = raw_value.strip().lower()
            if normalized in TRUE_VALUES:
                return True
            if normalized in FALSE_VALUES:
                return False
            raise ImproperlyConfigured(f"{self.env_name} must be a boolean.")
        if self.kind == "integer":
            try:
                value = int(raw_value)
            except ValueError as exc:
                raise ImproperlyConfigured(f"{self.env_name} must be an integer.") from exc
        else:
            value = dict(self.environment_aliases).get(raw_value.strip(), raw_value)
        try:
            return self.validate(value)
        except ValueError as exc:
            raise ImproperlyConfigured(f"{self.env_name} is invalid: {exc}.") from exc


DEFINITIONS = (
    SettingDefinition(
        "open_registration",
        "Open registration",
        "primary",
        "boolean",
        "QUILLUM_OPEN_REGISTRATION",
        False,
    ),
    SettingDefinition(
        "local_password_login_enabled",
        "Local password login",
        "primary",
        "boolean",
        "QUILLUM_LOCAL_PASSWORD_LOGIN_ENABLED",
        True,
    ),
    SettingDefinition(
        "audio_transcription_enabled",
        "Audio-note speech recognition",
        "primary",
        "boolean",
        "QUILLUM_AUDIO_TRANSCRIPTION_ENABLED",
        False,
    ),
    SettingDefinition(
        "email_backend",
        "Email delivery backend",
        "primary",
        "choice",
        "DJANGO_EMAIL_BACKEND",
        "console",
        choices=("console", "smtp"),
        environment_aliases=(
            ("django.core.mail.backends.console.EmailBackend", "console"),
            ("django.core.mail.backends.smtp.EmailBackend", "smtp"),
        ),
    ),
    SettingDefinition(
        "email_host",
        "SMTP host",
        "primary",
        "string",
        "DJANGO_EMAIL_HOST",
        "localhost",
        max_length=253,
    ),
    SettingDefinition(
        "email_port",
        "SMTP port",
        "primary",
        "integer",
        "DJANGO_EMAIL_PORT",
        25,
        minimum=1,
        maximum=65535,
    ),
    SettingDefinition(
        "email_host_user",
        "SMTP username",
        "primary",
        "string",
        "DJANGO_EMAIL_HOST_USER",
        "",
        max_length=320,
        allow_blank=True,
    ),
    SettingDefinition(
        "email_host_password",
        "SMTP password",
        "primary",
        "secret",
        "DJANGO_EMAIL_HOST_PASSWORD",
        "",
        max_length=4096,
        allow_blank=True,
    ),
    SettingDefinition(
        "email_use_tls",
        "Use SMTP STARTTLS",
        "primary",
        "boolean",
        "DJANGO_EMAIL_USE_TLS",
        False,
    ),
    SettingDefinition(
        "email_use_ssl",
        "Use implicit SMTP TLS",
        "primary",
        "boolean",
        "DJANGO_EMAIL_USE_SSL",
        False,
    ),
    SettingDefinition(
        "email_timeout_seconds",
        "SMTP timeout (seconds)",
        "primary",
        "integer",
        "DJANGO_EMAIL_TIMEOUT",
        10,
        minimum=1,
        maximum=120,
    ),
    SettingDefinition(
        "email_default_from",
        "Default sender",
        "primary",
        "email",
        "DJANGO_DEFAULT_FROM_EMAIL",
        "Quillum <noreply@localhost>",
        max_length=320,
    ),
    SettingDefinition(
        "email_change_code_ttl_minutes",
        "Confirmation code lifetime (minutes)",
        "advanced",
        "integer",
        "QUILLUM_EMAIL_CHANGE_CODE_TTL_MINUTES",
        15,
        minimum=1,
        maximum=1440,
    ),
    SettingDefinition(
        "login_ip_rate_limit",
        "Login attempts per IP",
        "advanced",
        "rate",
        "QUILLUM_LOGIN_IP_RATE_LIMIT",
        "50/hour",
        max_length=64,
    ),
    SettingDefinition(
        "login_account_rate_limit",
        "Login attempts per account",
        "advanced",
        "rate",
        "QUILLUM_LOGIN_ACCOUNT_RATE_LIMIT",
        "5/15m",
        max_length=64,
    ),
    SettingDefinition(
        "registration_ip_rate_limit",
        "Registrations per IP",
        "advanced",
        "rate",
        "QUILLUM_REGISTRATION_IP_RATE_LIMIT",
        "10/hour",
        max_length=64,
    ),
    SettingDefinition(
        "registration_email_rate_limit",
        "Registrations per email",
        "advanced",
        "rate",
        "QUILLUM_REGISTRATION_EMAIL_RATE_LIMIT",
        "5/hour",
        max_length=64,
    ),
    SettingDefinition(
        "code_request_rate_limit",
        "Confirmation code requests",
        "advanced",
        "rate",
        "QUILLUM_CODE_REQUEST_RATE_LIMIT",
        "3/15m",
        max_length=64,
    ),
    SettingDefinition(
        "code_confirm_rate_limit",
        "Confirmation code attempts",
        "advanced",
        "rate",
        "QUILLUM_CODE_CONFIRM_RATE_LIMIT",
        "10/15m",
        max_length=64,
    ),
    SettingDefinition(
        "reauthentication_rate_limit",
        "Reauthentication attempts",
        "advanced",
        "rate",
        "QUILLUM_REAUTHENTICATION_RATE_LIMIT",
        "5/15m",
        max_length=64,
    ),
    SettingDefinition(
        "account_delete_rate_limit",
        "Account deletion attempts",
        "advanced",
        "rate",
        "QUILLUM_ACCOUNT_DELETE_RATE_LIMIT",
        "5/15m",
        max_length=64,
    ),
    SettingDefinition(
        "audit_retention_days",
        "Audit retention (days)",
        "advanced",
        "integer",
        "QUILLUM_AUDIT_RETENTION_DAYS",
        90,
        minimum=1,
        maximum=3650,
    ),
    SettingDefinition(
        "recent_auth_ttl_seconds",
        "Recent authentication lifetime (seconds)",
        "advanced",
        "integer",
        "QUILLUM_RECENT_AUTH_TTL_SECONDS",
        900,
        minimum=60,
        maximum=86400,
    ),
    SettingDefinition(
        "confirmation_code_max_attempts",
        "Confirmation code maximum attempts",
        "advanced",
        "integer",
        "QUILLUM_CONFIRMATION_CODE_MAX_ATTEMPTS",
        5,
        minimum=1,
        maximum=100,
    ),
    SettingDefinition(
        "two_factor_challenge_ttl_seconds",
        "Two-factor challenge lifetime (seconds)",
        "advanced",
        "integer",
        "QUILLUM_TWO_FACTOR_CHALLENGE_TTL_SECONDS",
        300,
        minimum=30,
        maximum=86400,
    ),
    SettingDefinition(
        "two_factor_challenge_max_attempts",
        "Two-factor challenge maximum attempts",
        "advanced",
        "integer",
        "QUILLUM_TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS",
        5,
        minimum=1,
        maximum=100,
    ),
    SettingDefinition(
        "totp_issuer",
        "TOTP issuer",
        "advanced",
        "string",
        "QUILLUM_TOTP_ISSUER",
        "Quillum",
        max_length=120,
    ),
    SettingDefinition(
        "webauthn_rp_name",
        "WebAuthn relying-party name",
        "advanced",
        "string",
        "QUILLUM_WEBAUTHN_RP_NAME",
        "Quillum",
        max_length=120,
    ),
    SettingDefinition(
        "session_cookie_age",
        "Remembered session lifetime (seconds)",
        "advanced",
        "integer",
        "DJANGO_SESSION_COOKIE_AGE",
        60 * 60 * 24 * 14,
        minimum=300,
        maximum=60 * 60 * 24 * 365,
    ),
)
DEFINITIONS_BY_KEY = {definition.key: definition for definition in DEFINITIONS}


def setting_definition(key: str) -> SettingDefinition:
    try:
        return DEFINITIONS_BY_KEY[key]
    except KeyError as exc:
        raise KeyError(f"Unknown runtime setting: {key}") from exc


def environment_value(definition: SettingDefinition):
    raw_value = os.getenv(definition.env_name)
    if raw_value is None:
        return None
    return definition.parse_environment(raw_value)


def _cache_key(key: str) -> str:
    return f"{CACHE_PREFIX}:{key}"


def _cache_enabled() -> bool:
    return not any("pytest" in argument for argument in sys.argv)


def _stored_payload(key: str) -> dict:
    key_name = _cache_key(key)
    cached = None
    if _cache_enabled():
        try:
            cached = cache.get(key_name)
        except Exception:
            pass
    if isinstance(cached, dict) and "exists" in cached:
        return cached

    row = ServiceSetting.objects.filter(key=key).only("key", "value").first()
    payload = (
        {
            "exists": True,
            "value": row.value,
        }
        if row is not None
        else {"exists": False}
    )
    if _cache_enabled():
        try:
            cache.set(key_name, payload, timeout=CACHE_TTL_SECONDS)
        except Exception:
            pass
    return payload


def _stored_value(key: str):
    payload = _stored_payload(key)
    if not payload["exists"]:
        return None
    return payload.get("value")


def runtime_setting(key: str):
    definition = setting_definition(key)
    value = environment_value(definition)
    if value is not None:
        return value
    value = _stored_value(key)
    return definition.default if value is None else definition.validate(value)


def runtime_setting_source(key: str) -> str:
    definition = setting_definition(key)
    if os.getenv(definition.env_name) is not None:
        return "environment"
    return "database" if _stored_payload(key)["exists"] else "default"


def invalidate_runtime_setting(key: str) -> None:
    if not _cache_enabled():
        return
    try:
        cache.delete(_cache_key(key))
    except Exception:
        pass


def invalidate_runtime_settings(keys: list[str]) -> None:
    for key in keys:
        invalidate_runtime_setting(key)


def set_runtime_override(key: str, value, *, updated_by=None) -> ServiceSetting:
    definition = setting_definition(key)
    validated = definition.validate(value)
    row = ServiceSetting.objects.filter(key=key).first() or ServiceSetting(key=key)
    row.value = validated
    row.updated_by = updated_by
    row.save()
    invalidate_runtime_setting(key)
    transaction.on_commit(lambda: invalidate_runtime_setting(key))
    return row


def delete_runtime_override(key: str) -> None:
    setting_definition(key)
    ServiceSetting.objects.filter(key=key).delete()
    invalidate_runtime_setting(key)
    transaction.on_commit(lambda: invalidate_runtime_setting(key))


def setting_payload(definition: SettingDefinition) -> dict:
    source = runtime_setting_source(definition.key)
    secret = definition.kind == "secret"
    effective_value = runtime_setting(definition.key)
    return {
        "key": definition.key,
        "label": definition.label,
        "section": definition.section,
        "type": definition.kind,
        "value": None if secret else effective_value,
        "configured": bool(effective_value) if secret else None,
        "secret": secret,
        "source": source,
        "locked": source == "environment",
        "editable": source != "environment",
        "minimum": definition.minimum,
        "maximum": definition.maximum,
        "maxLength": definition.max_length,
        "choices": list(definition.choices),
    }


def settings_payload() -> list[dict]:
    return [setting_payload(definition) for definition in DEFINITIONS]
