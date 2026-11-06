from __future__ import annotations

import hashlib
from dataclasses import dataclass

from authlib.integrations.django_client import OAuth
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .lookups import email_lookup_q, normalize_email
from .models import OidcIdentity, RegistrationCounter, User
from .timezones import validate_timezone_name


class OidcLoginError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ResolvedOidcUser:
    user: User
    identity: OidcIdentity
    created: bool
    linked: bool


def oidc_configured() -> bool:
    return bool(
        settings.OIDC_ENABLED
        and settings.OIDC_DISCOVERY_URL
        and settings.OIDC_CLIENT_ID
        and settings.OIDC_CLIENT_SECRET
    )


def oidc_status_payload() -> dict:
    return {
        "enabled": settings.OIDC_ENABLED,
        "configured": oidc_configured(),
        "providerName": settings.OIDC_PROVIDER_NAME or "OpenID Connect",
        "issuer": settings.OIDC_ISSUER,
        "discoveryUrl": settings.OIDC_DISCOVERY_URL,
        "callbackPath": "/api/auth/oidc/callback/",
    }


def oidc_client():
    if not oidc_configured():
        raise OidcLoginError("oidc_not_configured")
    oauth = OAuth()
    return oauth.register(
        name="oidc",
        client_id=settings.OIDC_CLIENT_ID,
        client_secret=settings.OIDC_CLIENT_SECRET,
        server_metadata_url=settings.OIDC_DISCOVERY_URL,
        client_kwargs={"scope": "openid profile email"},
    )


def _claim(claims: dict, key: str) -> str:
    return str(claims.get(key, "") or "").strip()


def _username_candidates(claims: dict) -> list[str]:
    values = [_claim(claims, "preferred_username"), _claim(claims, "username")]
    return list(dict.fromkeys(value for value in values if value))


def _matching_local_user(claims: dict) -> User | None:
    username_users = {
        user.id: user
        for username in _username_candidates(claims)
        for user in User.objects.filter(username__iexact=username)
    }
    email_users = {}
    email = normalize_email(_claim(claims, "email"))
    if email and claims.get("email_verified") is True:
        email_users = {user.id: user for user in User.objects.filter(email_lookup_q(email))}

    matched = {**username_users, **email_users}
    if len(matched) > 1:
        raise OidcLoginError("oidc_identity_ambiguous")
    return next(iter(matched.values()), None)


def _available_username(claims: dict) -> str:
    max_length = User._meta.get_field("username").max_length
    fallback = f"oidc-{hashlib.sha256(_claim(claims, 'sub').encode()).hexdigest()[:24]}"
    base = (next(iter(_username_candidates(claims)), "") or fallback)[:max_length]
    try:
        User.username_validator(base)
    except ValidationError:
        base = fallback
    if not User.objects.filter(username__iexact=base).exists():
        return base
    for suffix in range(2, 10_000):
        suffix_text = f"-{suffix}"
        candidate = f"{base[: max_length - len(suffix_text)]}{suffix_text}"
        if not User.objects.filter(username__iexact=candidate).exists():
            return candidate
    raise OidcLoginError("oidc_username_unavailable")


def _create_user(
    claims: dict,
    *,
    language: str,
    theme: str,
    timezone_name: str,
    author_workspace_enabled: bool,
) -> User:
    email = normalize_email(_claim(claims, "email"))
    if claims.get("email_verified") is not True:
        email = ""
    user = User(
        username=_available_username(claims),
        email=email,
        language=(
            language
            if language in {value for value, _ in User.LANGUAGE_CHOICES}
            else User.LANGUAGE_EN
        ),
        theme=theme if theme in {value for value, _ in User.THEME_CHOICES} else User.THEME_SYSTEM,
        timezone=timezone_name,
        onboarding_completed_at=None,
        author_workspace_enabled_at=timezone.now() if author_workspace_enabled else None,
        editor_workspace_enabled_at=None if author_workspace_enabled else timezone.now(),
    )
    user.display_name = _claim(claims, "name") or user.username
    user.set_unusable_password()
    user.save()
    RegistrationCounter.objects.get_or_create(pk=1)
    RegistrationCounter.objects.filter(pk=1).update(
        total_registrations=F("total_registrations") + 1
    )
    return user


@transaction.atomic
def resolve_oidc_user(
    claims: dict,
    *,
    language: str = "en",
    theme: str = "system",
    timezone_name: str = "UTC",
    expected_user_id: int | None = None,
    author_workspace_enabled: bool = True,
    require_editor_only: bool = False,
) -> ResolvedOidcUser:
    issuer = _claim(claims, "iss") or settings.OIDC_ISSUER
    subject = _claim(claims, "sub")
    if not issuer or not subject:
        raise OidcLoginError("oidc_identity_invalid")
    if settings.OIDC_ISSUER and issuer != settings.OIDC_ISSUER:
        raise OidcLoginError("oidc_issuer_invalid")

    identity = (
        OidcIdentity.objects.select_related("user")
        .filter(
            issuer=issuer,
            subject=subject,
        )
        .first()
    )
    if identity is not None:
        if expected_user_id is not None and identity.user_id != expected_user_id:
            raise OidcLoginError("oidc_reauthentication_user_mismatch")
        return ResolvedOidcUser(identity.user, identity, False, False)

    user = _matching_local_user(claims)
    if expected_user_id is not None and (user is None or user.id != expected_user_id):
        raise OidcLoginError("oidc_reauthentication_user_mismatch")
    created = user is None
    if user is None:
        try:
            timezone_name = validate_timezone_name(timezone_name)
        except ValueError:
            timezone_name = "UTC"
        user = _create_user(
            claims,
            language=language,
            theme=theme,
            timezone_name=timezone_name,
            author_workspace_enabled=author_workspace_enabled,
        )
    identity = OidcIdentity.objects.create(user=user, issuer=issuer, subject=subject)
    return ResolvedOidcUser(user, identity, created, not created)


def mark_oidc_login(identity: OidcIdentity) -> None:
    identity.last_login_at = timezone.now()
    identity.save(update_fields=["last_login_at"])
