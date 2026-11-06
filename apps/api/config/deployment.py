from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

DEVELOPMENT = "development"
PRODUCTION = "production"
SUPPORTED_ENVIRONMENTS = {DEVELOPMENT, PRODUCTION}
LOCAL_BROWSER_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


@dataclass(frozen=True)
class DeploymentProfile:
    environment: str
    public_origin: str
    public_host: str
    allowed_hosts: tuple[str, ...]
    browser_origins: tuple[str, ...]
    webauthn_rp_id: str

    @property
    def is_production(self) -> bool:
        return self.environment == PRODUCTION


def load_deployment_profile(
    environment_value: str | None,
    public_origin_value: str | None,
) -> DeploymentProfile:
    environment = (environment_value or DEVELOPMENT).strip().lower()
    if environment not in SUPPORTED_ENVIRONMENTS:
        choices = ", ".join(sorted(SUPPORTED_ENVIRONMENTS))
        raise ImproperlyConfigured(
            f"QUILLUM_ENVIRONMENT must be one of: {choices}."
        )

    raw_origin = (public_origin_value or "").strip()
    if not raw_origin:
        if environment == PRODUCTION:
            raise ImproperlyConfigured(
                "QUILLUM_PUBLIC_ORIGIN is required in production."
            )
        raw_origin = LOCAL_BROWSER_ORIGINS[0]

    parsed = urlsplit(raw_origin)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ImproperlyConfigured(
            "QUILLUM_PUBLIC_ORIGIN contains an invalid port."
        ) from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ImproperlyConfigured(
            "QUILLUM_PUBLIC_ORIGIN must be an http(s) origin without credentials, "
            "a path, query, or fragment."
        )
    if environment == PRODUCTION and parsed.scheme != "https":
        raise ImproperlyConfigured(
            "QUILLUM_PUBLIC_ORIGIN must use https in production."
        )

    hostname = parsed.hostname.lower()
    formatted_host = f"[{hostname}]" if ":" in hostname else hostname
    netloc = f"{formatted_host}:{port}" if port is not None else formatted_host
    public_origin = f"{parsed.scheme}://{netloc}"

    if environment == DEVELOPMENT and hostname in {"localhost", "127.0.0.1"}:
        allowed_hosts = ("localhost", "127.0.0.1")
        browser_origins = LOCAL_BROWSER_ORIGINS
    else:
        allowed_hosts = (hostname,)
        browser_origins = (public_origin,)

    return DeploymentProfile(
        environment=environment,
        public_origin=public_origin,
        public_host=hostname,
        allowed_hosts=allowed_hosts,
        browser_origins=browser_origins,
        webauthn_rp_id=hostname,
    )
