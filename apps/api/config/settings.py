from __future__ import annotations

import os
import sys
from pathlib import Path

from celery.schedules import crontab
from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

from .deployment import load_deployment_profile

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent.parent

load_dotenv(REPO_ROOT / ".env")
load_dotenv(BASE_DIR / ".env")


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def env_or_file(name: str, file_name: str, default: str = "") -> str:
    direct_value = os.getenv(name)
    if direct_value is not None:
        return direct_value.strip()
    file_path = os.getenv(file_name)
    if not file_path:
        return default
    try:
        return Path(file_path).read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ImproperlyConfigured(f"Unable to read {file_name}: {file_path}") from exc


def running_pytest() -> bool:
    return any("pytest" in arg for arg in sys.argv)


DEPLOYMENT = load_deployment_profile(
    os.getenv("QUILLUM_ENVIRONMENT"),
    os.getenv("QUILLUM_PUBLIC_ORIGIN"),
)
QUILLUM_ENVIRONMENT = DEPLOYMENT.environment
QUILLUM_PUBLIC_ORIGIN = DEPLOYMENT.public_origin

SECRET_KEY = env_or_file(
    "DJANGO_SECRET_KEY",
    "DJANGO_SECRET_KEY_FILE",
    "dev-secret-change-me",
)
DEBUG = not DEPLOYMENT.is_production
if DEPLOYMENT.is_production and SECRET_KEY == "dev-secret-change-me":
    raise ImproperlyConfigured("DJANGO_SECRET_KEY must be set to a strong unique value.")

QUILLUM_COLLABORATION_MODE = os.getenv("QUILLUM_COLLABORATION_MODE", "disabled").strip()
if QUILLUM_COLLABORATION_MODE not in {"disabled", "pilot", "enabled"}:
    raise ImproperlyConfigured(
        "QUILLUM_COLLABORATION_MODE must be disabled, pilot, or enabled."
    )
QUILLUM_COLLABORATION_INTERNAL_SECRET = env_or_file(
    "QUILLUM_COLLABORATION_INTERNAL_SECRET",
    "QUILLUM_COLLABORATION_INTERNAL_SECRET_FILE",
    "dev-collaboration-secret" if not DEPLOYMENT.is_production else "",
)
if QUILLUM_COLLABORATION_MODE != "disabled" and not QUILLUM_COLLABORATION_INTERNAL_SECRET:
    raise ImproperlyConfigured(
        "QUILLUM_COLLABORATION_INTERNAL_SECRET is required when collaboration is enabled."
    )
QUILLUM_COLLABORATION_INTERNAL_ORIGIN = os.getenv(
    "QUILLUM_COLLABORATION_INTERNAL_ORIGIN",
    "http://127.0.0.1:8003",
).rstrip("/")
QUILLUM_COLLABORATION_PUBLIC_PATH = "/collaboration/ws"
QUILLUM_COLLABORATION_TICKET_TTL_SECONDS = 60
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", ",".join(DEPLOYMENT.allowed_hosts))
QUILLUM_TRUSTED_PROXY_IPS = env_list("QUILLUM_TRUSTED_PROXY_IPS", "")

OIDC_ENABLED = env_bool("QUILLUM_OIDC_ENABLED", False)
OIDC_DISCOVERY_URL = os.getenv("OIDC_DISCOVERY_URL", "").strip()
OIDC_ISSUER = os.getenv("OIDC_ISSUER", "").strip()
OIDC_CLIENT_ID = os.getenv("OIDC_CLIENT_ID", "").strip()
OIDC_CLIENT_SECRET = env_or_file(
    "OIDC_CLIENT_SECRET",
    "OIDC_CLIENT_SECRET_FILE",
)
OIDC_PROVIDER_NAME = os.getenv("OIDC_PROVIDER_NAME", "OpenID Connect").strip()
if DEPLOYMENT.is_production and OIDC_ENABLED and not (
    OIDC_DISCOVERY_URL and OIDC_ISSUER and OIDC_CLIENT_ID and OIDC_CLIENT_SECRET
):
    raise ImproperlyConfigured(
        "OIDC_DISCOVERY_URL, OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET or "
        "OIDC_CLIENT_SECRET_FILE are required when OIDC is enabled in production."
    )
AUTH_MODE = os.getenv(
    "QUILLUM_AUTH_MODE",
    "hybrid" if OIDC_ENABLED else "local",
).strip()
if AUTH_MODE not in {"local", "hybrid"}:
    raise ImproperlyConfigured("QUILLUM_AUTH_MODE must be local or hybrid.")
QUILLUM_DJANGO_ADMIN_ENABLED = env_bool("QUILLUM_DJANGO_ADMIN_ENABLED", False)
AUTH_USER_MODEL = "accounts.User"
QUILLUM_VERSION = os.getenv("QUILLUM_VERSION", "1.0.1")
QUILLUM_BOOTSTRAP_ADMIN_ENABLED = env_bool(
    "QUILLUM_BOOTSTRAP_ADMIN_ENABLED",
    not running_pytest(),
)
QUILLUM_BOOTSTRAP_ADMIN_USERNAME = os.getenv("QUILLUM_BOOTSTRAP_ADMIN_USERNAME", "admin")
QUILLUM_BOOTSTRAP_ADMIN_EMAIL = os.getenv("QUILLUM_BOOTSTRAP_ADMIN_EMAIL", "admin@localhost")
QUILLUM_BOOTSTRAP_ADMIN_PASSWORD = env_or_file(
    "QUILLUM_BOOTSTRAP_ADMIN_PASSWORD",
    "QUILLUM_BOOTSTRAP_ADMIN_PASSWORD_FILE",
    "changeme",
)
if (
    DEPLOYMENT.is_production
    and QUILLUM_BOOTSTRAP_ADMIN_ENABLED
    and QUILLUM_BOOTSTRAP_ADMIN_PASSWORD in {"", "changeme"}
):
    raise ImproperlyConfigured(
        "QUILLUM_BOOTSTRAP_ADMIN_PASSWORD or QUILLUM_BOOTSTRAP_ADMIN_PASSWORD_FILE "
        "must contain a non-default value in production."
    )

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 12},
    },
    {"NAME": "apps.accounts.validators.PasswordCompositionValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

INSTALLED_APPS = [
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "apps.accounts",
    "apps.adminpanel",
    "apps.audit",
    "apps.health",
    "apps.manuscripts",
    "apps.notifications",
    "apps.servicepages",
    "apps.sources",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "config.indexing.NoIndexMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "apps.accounts.capabilities.AuthorWorkspaceCapabilityMiddleware",
    "apps.audit.middleware.ErrorSupportContextMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("POSTGRES_DB", "quillum"),
        "USER": os.getenv("POSTGRES_USER", "quillum"),
        "PASSWORD": env_or_file(
            "POSTGRES_PASSWORD",
            "POSTGRES_PASSWORD_FILE",
            "quillum",
        ),
        "HOST": os.getenv("POSTGRES_HOST", "localhost"),
        "PORT": os.getenv("POSTGRES_PORT", "5432"),
    }
}

LANGUAGE_CODE = "en"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

MEDIA_URL = "media/"
MEDIA_ROOT = Path(os.getenv("QUILLUM_MEDIA_ROOT", str(BASE_DIR / "media")))
QUILLUM_TRANSCRIPTION_MODEL_PATH = Path(
    os.getenv(
        "QUILLUM_TRANSCRIPTION_MODEL_PATH",
        str(REPO_ROOT / ".run" / "transcription-models" / "faster-whisper-small"),
    )
)

EMAIL_BACKEND = os.getenv(
    "DJANGO_EMAIL_BACKEND",
    "django.core.mail.backends.console.EmailBackend",
)
EMAIL_HOST = os.getenv("DJANGO_EMAIL_HOST", "localhost")
EMAIL_PORT = int(os.getenv("DJANGO_EMAIL_PORT", "25"))
EMAIL_HOST_USER = os.getenv("DJANGO_EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.getenv("DJANGO_EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = env_bool("DJANGO_EMAIL_USE_TLS", False)
EMAIL_USE_SSL = env_bool("DJANGO_EMAIL_USE_SSL", False)
DEFAULT_FROM_EMAIL = os.getenv("DJANGO_DEFAULT_FROM_EMAIL", "Quillum <noreply@localhost>")

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CACHES = {
    "default": (
        {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "quillum-test-cache",
        }
        if running_pytest()
        else {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": os.getenv("REDIS_URL", "redis://localhost:6379/0"),
        }
    )
}

REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": [
        "rest_framework.renderers.JSONRenderer",
    ],
    "DEFAULT_PARSER_CLASSES": [
        "rest_framework.parsers.JSONParser",
    ],
}

CORS_ALLOWED_ORIGINS = env_list(
    "DJANGO_CORS_ALLOWED_ORIGINS",
    ",".join(DEPLOYMENT.browser_origins),
)
CORS_ALLOW_CREDENTIALS = True
CORS_EXPOSE_HEADERS = ["Content-Disposition"]
CSRF_TRUSTED_ORIGINS = env_list(
    "DJANGO_CSRF_TRUSTED_ORIGINS",
    ",".join(DEPLOYMENT.browser_origins),
)

SECURE_SSL_REDIRECT = DEPLOYMENT.is_production
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 31536000 if DEPLOYMENT.is_production else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
REFERRER_POLICY = "same-origin"
SESSION_COOKIE_SECURE = DEPLOYMENT.is_production
CSRF_COOKIE_SECURE = DEPLOYMENT.is_production
SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_HTTPONLY = False
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = int(os.getenv("DJANGO_SESSION_COOKIE_AGE", str(60 * 60 * 24 * 14)))

QUILLUM_WEBAUTHN_RP_ID = os.getenv(
    "QUILLUM_WEBAUTHN_RP_ID",
    DEPLOYMENT.webauthn_rp_id,
)
QUILLUM_WEBAUTHN_ORIGINS = env_list(
    "QUILLUM_WEBAUTHN_ORIGINS",
    ",".join(DEPLOYMENT.browser_origins),
)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL
CELERY_TASK_IGNORE_RESULT = True
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [REDIS_URL]},
    }
}
CELERY_TASK_ALWAYS_EAGER = env_bool("CELERY_TASK_ALWAYS_EAGER", False)
CELERY_TASK_ROUTES = {
    "apps.manuscripts.tasks.process_audio_transcription_queue": {
        "queue": "transcription",
    },
}
CELERY_BEAT_SCHEDULE = {
    "sync-external-contest-sources": {
        "task": "apps.sources.tasks.sync_all_contest_sources",
        "schedule": crontab(hour=4, minute=17),
    },
    "sync-external-news-sources": {
        "task": "apps.sources.tasks.sync_all_news_sources",
        "schedule": crontab(hour="3,11,19", minute=17),
    },
    "materialize-due-document-drafts": {
        "task": "apps.manuscripts.tasks.materialize_due_drafts",
        "schedule": 30.0,
    },
    "recover-audio-transcription-queue": {
        "task": "apps.manuscripts.tasks.recover_audio_transcription_queue",
        "schedule": 60.0,
    },
    "cleanup-expired-manuscript-exports": {
        "task": "apps.manuscripts.tasks.cleanup_expired_exports",
        "schedule": 300.0,
    },
    "cleanup-expired-account-exports": {
        "task": "apps.accounts.tasks.cleanup_expired_account_exports",
        "schedule": 300.0,
    },
    "scan-service-notifications": {
        "task": "apps.notifications.tasks.scan_service_notifications",
        "schedule": 60.0,
    },
    "scan-scheduled-admin-notification-campaigns": {
        "task": "apps.notifications.tasks.scan_scheduled_admin_notification_campaigns",
        "schedule": 60.0,
    },
    "scan-due-user-notification-rules": {
        "task": "apps.notifications.tasks.scan_due_user_notification_rules",
        "schedule": 60.0,
    },
    "purge-expired-notifications": {
        "task": "apps.notifications.tasks.purge_expired_notifications",
        "schedule": crontab(hour=3, minute=30),
    },
    "purge-expired-audit-events": {
        "task": "apps.audit.tasks.purge_expired_audit_events",
        "schedule": crontab(hour=3, minute=15),
    },
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "standard",
        },
    },
    "loggers": {
        "apps.accounts": {
            "handlers": ["console"],
            "level": "INFO",
            "propagate": False,
        },
        "apps.audit": {
            "handlers": ["console"],
            "level": "INFO",
            "propagate": False,
        },
    },
}
