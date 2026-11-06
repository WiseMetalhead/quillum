import json
import logging
import secrets
from datetime import UTC, datetime, timedelta
from io import BytesIO
from typing import Literal
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import pyotp
from django.conf import settings
from django.contrib.auth import (
    authenticate,
    get_user_model,
    login,
    logout,
    update_session_auth_hash,
)
from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.db.models import F, Q, Subquery
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_http_methods, require_POST
from PIL import Image, ImageOps, UnidentifiedImageError
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url, options_to_json
from webauthn.helpers.exceptions import InvalidAuthenticationResponse, InvalidRegistrationResponse
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from apps.adminpanel.runtime_settings import runtime_setting
from apps.audit.models import AuditEvent
from apps.audit.service import write_audit_event
from apps.manuscripts.quotas import image_size_response, storage_quota_response, stored_file_size
from apps.notifications.service import service_notification_for_login
from config.media_responses import private_media_response

from .capabilities import (
    WORKSPACE_AUTHOR,
    WORKSPACE_EDITOR,
    active_workspace,
    has_author_workspace,
    has_editor_workspace,
    set_active_workspace,
    workspace_available,
)
from .email import format_email_minutes, send_templated_runtime_email
from .lookups import email_lookup_q
from .models import (
    EditorConnection,
    EmailChangeRequest,
    PasskeyCredential,
    PasswordChangeRequest,
    RegistrationCounter,
)
from .oidc import (
    OidcLoginError,
    mark_oidc_login,
    oidc_client,
    oidc_configured,
    resolve_oidc_user,
)
from .rate_limit import (
    login_account_limited,
    login_ip_limited,
    rate_limit_exceeded,
    rate_limited_response,
    record_failed_login,
    record_rate_limit_hit,
    request_ip,
)
from .services import delete_account_data
from .sessions import revoke_user_sessions
from .tiers import image_upload_limit, user_tier_payload
from .timezones import validate_timezone_name

User = get_user_model()
AVATAR_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
AVATAR_ALLOWED_FORMATS = ("JPEG", "PNG", "WEBP", "GIF")
AVATAR_MAX_PIXELS = 4096 * 4096
AVATAR_MAX_DIMENSION = 1024
AVATAR_OUTPUT_FORMAT = "WEBP"
AVATAR_OUTPUT_CONTENT_TYPE = "image/webp"
EDITOR_AVATAR_MAX_BYTES = 2 * 1024 * 1024
EMAIL_MAX_LENGTH = 254
DISPLAY_NAME_MAX_LENGTH = 160
RECENT_AUTH_SESSION_KEY = "quillum_recent_auth_at"
AUTH_METHOD_SESSION_KEY = "quillum_auth_method"
TOTP_SETUP_SESSION_KEY = "quillum_totp_setup_secret"
EMAIL_TWO_FACTOR_SETUP_SESSION_KEY = "quillum_email_two_factor_setup"
TWO_FACTOR_CHALLENGE_SESSION_KEY = "quillum_two_factor_challenge"
PASSKEY_REGISTRATION_SESSION_KEY = "quillum_passkey_registration"
PASSKEY_AUTHENTICATION_SESSION_KEY = "quillum_passkey_authentication"
OIDC_FLOW_SESSION_KEY = "quillum_oidc_flow"
CodeKind = Literal["email_change", "password_change"]
logger = logging.getLogger(__name__)


def user_payload(user):
    from apps.sources.views import (
        has_enabled_contest_sources,
        has_enabled_news_sources,
    )

    avatar_url = f"/api/auth/profile/avatar/{user.id}/" if user.avatar else ""
    author_workspace_enabled = has_author_workspace(user)
    news_enabled = has_enabled_news_sources(user) if author_workspace_enabled else False
    contests_enabled = has_enabled_contest_sources(user) if author_workspace_enabled else False
    return {
        "id": user.id,
        "username": user.get_username(),
        "email": user.email,
        "displayName": user.display_name,
        "avatarUrl": avatar_url,
        "language": user.language,
        "timezone": user.timezone,
        "theme": user.theme,
        "tier": user.tier,
        "authorName": user.author_name,
        "authorEmail": user.author_email,
        "authorWebsite": user.author_website,
        "authorTodayProfile": user.author_today_profile,
        "authorLitresProfile": user.author_litres_profile,
        "authorProzaProfile": user.author_proza_profile,
        "authorSamizdatProfile": user.author_samizdat_profile,
        "authorCellulosaProfile": user.author_cellulosa_profile,
        "authorWattpadProfile": user.author_wattpad_profile,
        "passwordChangedAt": user.password_changed_at.isoformat(),
        "hasUsablePassword": user.has_usable_password(),
        "twoFactorMethod": user.two_factor_method,
        "isSuperuser": user.is_superuser,
        "authorWorkspaceEnabled": author_workspace_enabled,
        "editorWorkspaceEnabled": has_editor_workspace(user),
        "oidcLinked": user.oidc_identities.exists(),
        "onboardingCompleted": user.onboarding_completed_at is not None,
        "newsEnabled": news_enabled,
        "contestsEnabled": contests_enabled,
        "feedEnabled": news_enabled or contests_enabled,
    }


def passkey_payload(passkey: PasskeyCredential) -> dict:
    return {
        "id": passkey.id,
        "name": passkey.name,
        "backupEligible": passkey.backup_eligible,
        "backupState": passkey.backup_state,
        "createdAt": passkey.created_at.isoformat(),
        "lastUsedAt": passkey.last_used_at.isoformat() if passkey.last_used_at else None,
    }


def security_payload(user) -> dict:
    return {
        "twoFactorMethod": user.two_factor_method,
        "totpEnabled": bool(user.totp_secret and user.totp_confirmed_at),
        "emailTwoFactorEnabled": user.two_factor_method == User.TWO_FACTOR_EMAIL,
        "passkeys": [passkey_payload(item) for item in user.passkey_credentials.all()],
        "passkeyLimit": 5,
    }


def read_json(request):
    try:
        return json.loads(request.body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return None


def password_error_response(exc: ValidationError) -> JsonResponse:
    return JsonResponse(
        {
            "error": "password_validation_failed",
            "messages": list(exc.messages),
        },
        status=400,
    )


def mark_recent_auth(request, method: str | None = None) -> None:
    request.session[RECENT_AUTH_SESSION_KEY] = timezone.now().isoformat()
    if method is not None:
        request.session[AUTH_METHOD_SESSION_KEY] = method


def has_recent_auth(request) -> bool:
    raw_value = request.session.get(RECENT_AUTH_SESSION_KEY)
    if not raw_value:
        return False
    try:
        authenticated_at = datetime.fromisoformat(raw_value)
    except ValueError:
        return False
    if timezone.is_naive(authenticated_at):
        authenticated_at = timezone.make_aware(authenticated_at, timezone=UTC)
    return timezone.now() - authenticated_at <= timedelta(
        seconds=runtime_setting("recent_auth_ttl_seconds")
    )


def require_recent_auth(request) -> JsonResponse | None:
    if has_recent_auth(request):
        return None
    local_password_enabled = runtime_setting("local_password_login_enabled")
    session_method = request.session.get(AUTH_METHOD_SESSION_KEY)
    oidc_available = bool(
        request.user.is_authenticated
        and oidc_configured()
        and request.user.oidc_identities.exists()
    )
    if oidc_available and (
        session_method == "oidc"
        or not request.user.has_usable_password()
        or not local_password_enabled
    ):
        method = "oidc"
    elif local_password_enabled and request.user.has_usable_password():
        method = "password"
    elif oidc_available:
        method = "oidc"
    else:
        method = "passkey"
    return JsonResponse(
        {"error": "recent_authentication_required", "reauthenticationMethod": method},
        status=403,
    )


def verify_totp_code(secret: str, code: str) -> bool:
    normalized = code.replace(" ", "").strip()
    if not normalized.isdigit():
        return False
    return pyotp.TOTP(secret).verify(normalized, valid_window=1)


def two_factor_required(user) -> bool:
    if user.two_factor_method == User.TWO_FACTOR_TOTP:
        return bool(user.totp_secret) and bool(user.totp_confirmed_at)
    if user.two_factor_method == User.TWO_FACTOR_EMAIL:
        return bool(user.email)
    return False


def apply_login_session_expiry(request, remember: bool) -> None:
    request.session.set_expiry(runtime_setting("session_cookie_age") if remember else 0)


def create_two_factor_challenge(request, user, remember: bool = False) -> None:
    challenge = {
        "userId": user.id,
        "method": user.two_factor_method,
        "createdAt": timezone.now().isoformat(),
        "attempts": 0,
        "remember": remember,
    }
    if user.two_factor_method == User.TWO_FACTOR_EMAIL:
        code = email_change_code()
        challenge["codeHash"] = make_password(code)
        send_email_two_factor_login_code(user.email, code, language=user.language)
    request.session[TWO_FACTOR_CHALLENGE_SESSION_KEY] = challenge
    request.session.modified = True


def pending_two_factor_challenge(request) -> dict | None:
    challenge = request.session.get(TWO_FACTOR_CHALLENGE_SESSION_KEY)
    if not isinstance(challenge, dict):
        return None
    try:
        created_at = datetime.fromisoformat(str(challenge.get("createdAt", "")))
    except ValueError:
        return None
    if timezone.is_naive(created_at):
        created_at = timezone.make_aware(created_at, timezone=UTC)
    if timezone.now() - created_at > timedelta(
        seconds=runtime_setting("two_factor_challenge_ttl_seconds")
    ):
        request.session.pop(TWO_FACTOR_CHALLENGE_SESSION_KEY, None)
        request.session.modified = True
        return None
    return challenge


def record_two_factor_attempt(request, challenge: dict) -> bool:
    challenge["attempts"] = int(challenge.get("attempts", 0)) + 1
    request.session[TWO_FACTOR_CHALLENGE_SESSION_KEY] = challenge
    if challenge["attempts"] >= runtime_setting("two_factor_challenge_max_attempts"):
        request.session.pop(TWO_FACTOR_CHALLENGE_SESSION_KEY, None)
        request.session.modified = True
        return True
    request.session.modified = True
    return False


def webauthn_origins() -> list[str]:
    return settings.QUILLUM_WEBAUTHN_ORIGINS


def passkey_descriptors(user) -> list[PublicKeyCredentialDescriptor]:
    return [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(item.credential_id))
        for item in user.passkey_credentials.exclude(credential_id="")
    ]


def passkey_registration_options_json(user) -> tuple[str, str]:
    options = generate_registration_options(
        rp_id=settings.QUILLUM_WEBAUTHN_RP_ID,
        rp_name=runtime_setting("webauthn_rp_name"),
        user_id=str(user.id).encode("utf-8"),
        user_name=user.email or user.get_username(),
        user_display_name=user.display_name or user.get_username(),
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
        exclude_credentials=passkey_descriptors(user),
    )
    request_json = options_to_json(options)
    request_payload = json.loads(request_json)
    return request_json, request_payload["challenge"]


def passkey_authentication_options_json(user=None) -> tuple[str, str]:
    allow_credentials = passkey_descriptors(user) if user is not None else []
    options = generate_authentication_options(
        rp_id=settings.QUILLUM_WEBAUTHN_RP_ID,
        allow_credentials=allow_credentials,
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    request_json = options_to_json(options)
    request_payload = json.loads(request_json)
    return request_json, request_payload["challenge"]


def validate_registration_input(data) -> tuple[str, str, str, str] | JsonResponse:
    username = str(data.get("username", "")).strip()
    email = str(data.get("email", "")).strip()
    display_name = str(data.get("displayName", "")).strip()
    password = str(data.get("password", ""))

    if not username:
        return JsonResponse({"error": "username_required"}, status=400)
    if len(username) > User._meta.get_field("username").max_length:
        return JsonResponse({"error": "username_too_long"}, status=400)
    if not email:
        return JsonResponse({"error": "email_required"}, status=400)
    if len(email) > EMAIL_MAX_LENGTH:
        return JsonResponse({"error": "email_too_long"}, status=400)
    if len(display_name) > DISPLAY_NAME_MAX_LENGTH:
        return JsonResponse({"error": "display_name_too_long"}, status=400)
    if User.objects.filter(username__iexact=username).exists():
        return JsonResponse({"error": "username_already_exists"}, status=409)
    if User.objects.filter(email_lookup_q(email)).exists():
        return JsonResponse({"error": "email_already_exists"}, status=409)

    try:
        validate_password(password)
    except ValidationError as exc:
        return password_error_response(exc)

    return username, email, display_name, password


def email_change_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def cleanup_expired_confirmation_codes(user) -> None:
    now = timezone.now()
    EmailChangeRequest.objects.filter(
        user=user,
        consumed_at__isnull=True,
        expires_at__lt=now,
    ).update(consumed_at=now)
    PasswordChangeRequest.objects.filter(
        user=user,
        consumed_at__isnull=True,
        expires_at__lt=now,
    ).update(consumed_at=now)


def reject_invalid_confirmation_code(pending, kind: CodeKind) -> JsonResponse:
    pending.attempt_count += 1
    update_fields = ["attempt_count"]
    if pending.attempt_count >= runtime_setting("confirmation_code_max_attempts"):
        pending.consumed_at = timezone.now()
        update_fields.append("consumed_at")
        pending.save(update_fields=update_fields)
        return JsonResponse({"error": f"{kind}_code_attempts_exceeded"}, status=400)
    pending.save(update_fields=update_fields)
    return JsonResponse({"error": f"{kind}_code_invalid"}, status=400)


def normalized_avatar(file) -> ContentFile | JsonResponse:
    try:
        image = Image.open(file, formats=AVATAR_ALLOWED_FORMATS)
        image.verify()
        file.seek(0)
        image = Image.open(file, formats=AVATAR_ALLOWED_FORMATS)
        image = ImageOps.exif_transpose(image)
        if image.width * image.height > AVATAR_MAX_PIXELS:
            return JsonResponse({"error": "avatar_image_too_large"}, status=400)
        image.thumbnail((AVATAR_MAX_DIMENSION, AVATAR_MAX_DIMENSION))
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        buffer = BytesIO()
        image.save(buffer, format=AVATAR_OUTPUT_FORMAT, quality=85, method=6)
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError):
        return JsonResponse({"error": "avatar_invalid_image"}, status=400)
    return ContentFile(buffer.getvalue(), name=f"{uuid4().hex}.webp")


def send_email_change_code(new_email: str, code: str, *, language: str) -> None:
    send_templated_runtime_email(
        template="email_change_code",
        recipient_list=[new_email],
        language=language,
        context={
            "code": code,
            "expires_in": format_email_minutes(
                runtime_setting("email_change_code_ttl_minutes"),
                "ru" if language == "ru" else "en",
            ),
        },
    )


def send_password_change_code(email: str, code: str, *, language: str) -> None:
    send_templated_runtime_email(
        template="password_change_code",
        recipient_list=[email],
        language=language,
        context={
            "code": code,
            "expires_in": format_email_minutes(
                runtime_setting("email_change_code_ttl_minutes"),
                "ru" if language == "ru" else "en",
            ),
        },
    )


def send_password_reset_code(email: str, code: str, *, language: str) -> None:
    send_templated_runtime_email(
        template="password_reset_code",
        recipient_list=[email],
        language=language,
        context={
            "code": code,
            "expires_in": format_email_minutes(
                runtime_setting("email_change_code_ttl_minutes"),
                "ru" if language == "ru" else "en",
            ),
        },
    )


def send_email_two_factor_setup_code(email: str, code: str, *, language: str) -> None:
    send_templated_runtime_email(
        template="email_two_factor_setup_code",
        recipient_list=[email],
        language=language,
        context={
            "code": code,
            "expires_in": format_email_minutes(
                runtime_setting("two_factor_challenge_ttl_seconds") // 60,
                "ru" if language == "ru" else "en",
            ),
        },
    )


def send_email_two_factor_login_code(email: str, code: str, *, language: str) -> None:
    send_templated_runtime_email(
        template="email_two_factor_login_code",
        recipient_list=[email],
        language=language,
        context={
            "code": code,
            "expires_in": format_email_minutes(
                runtime_setting("two_factor_challenge_ttl_seconds") // 60,
                "ru" if language == "ru" else "en",
            ),
        },
    )


@require_GET
@ensure_csrf_cookie
def csrf(request):
    return JsonResponse({"csrfToken": get_token(request)})


@require_GET
def setup_status(_request):
    return JsonResponse(
        {
            "authMode": settings.AUTH_MODE,
            "localPasswordLoginEnabled": runtime_setting("local_password_login_enabled"),
            "oidcEnabled": oidc_configured(),
            "oidcProviderName": settings.OIDC_PROVIDER_NAME or "OpenID Connect",
            "openRegistration": runtime_setting("open_registration"),
        }
    )


@require_POST
def register(request):
    if not runtime_setting("local_password_login_enabled"):
        return JsonResponse({"error": "local_password_login_disabled"}, status=403)
    if not runtime_setting("open_registration"):
        return JsonResponse({"error": "registration_closed"}, status=403)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    language = str(data.get("language", User.LANGUAGE_EN)).strip()
    if language not in {value for value, _label in User.LANGUAGE_CHOICES}:
        return JsonResponse({"error": "language_unsupported"}, status=400)

    try:
        timezone_name = validate_timezone_name(data.get("timezone", "UTC"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    theme = str(data.get("theme", User.THEME_SYSTEM)).strip()
    if theme not in {value for value, _label in User.THEME_CHOICES}:
        return JsonResponse({"error": "theme_unsupported"}, status=400)

    email = str(data.get("email", "")).strip()
    if record_rate_limit_hit(
        "registration-ip",
        runtime_setting("registration_ip_rate_limit"),
        request_ip(request),
    ) or record_rate_limit_hit(
        "registration-email",
        runtime_setting("registration_email_rate_limit"),
        email,
    ):
        return rate_limited_response()

    validated = validate_registration_input(data)
    if isinstance(validated, JsonResponse):
        return validated

    username, email, display_name, password = validated
    try:
        user = User.objects.create_user(
            username=username,
            email=email,
            password=password,
            language=language,
            timezone=timezone_name,
            theme=theme,
            onboarding_completed_at=None,
        )
    except IntegrityError:
        if User.objects.filter(email_lookup_q(email)).exists():
            return JsonResponse({"error": "email_already_exists"}, status=409)
        if User.objects.filter(username=username).exists():
            return JsonResponse({"error": "username_already_exists"}, status=409)
        raise
    user.display_name = display_name
    user.save(update_fields=["display_name"])
    RegistrationCounter.objects.get_or_create(pk=1)
    RegistrationCounter.objects.filter(pk=1).update(
        total_registrations=F("total_registrations") + 1,
    )
    login(request, user)
    mark_recent_auth(request, "password")
    write_audit_event(
        request,
        "auth.user_registered",
        actor=user,
        subject=f"user:{user.id}",
        payload={"username": user.get_username(), "email": user.email},
    )

    return JsonResponse({"user": user_payload(user)}, status=201)


@require_POST
def login_view(request):
    if not runtime_setting("local_password_login_enabled"):
        return JsonResponse({"error": "local_password_login_disabled"}, status=403)
    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    remember = bool(data.get("remember", False))

    if login_ip_limited(request) or login_account_limited(request, username):
        return rate_limited_response()

    blocked_user = User.objects.filter(username__iexact=username, is_active=False).first()
    if blocked_user is not None and blocked_user.check_password(password):
        write_audit_event(
            request,
            "auth.login_blocked",
            actor=blocked_user,
            subject=f"user:{blocked_user.id}",
        )
        return JsonResponse({"error": "account_blocked"}, status=403)

    user = authenticate(request, username=username, password=password)
    if user is None:
        write_audit_event(
            request,
            "auth.login_failed",
            subject=username,
            payload={"username": username},
        )
        if record_failed_login(request, username):
            return rate_limited_response()
        return JsonResponse({"error": "invalid_credentials"}, status=401)

    if two_factor_required(user):
        create_two_factor_challenge(request, user, remember=remember)
        write_audit_event(
            request,
            "auth.two_factor_challenge_created",
            actor=user,
            subject=f"user:{user.id}",
            payload={"method": user.two_factor_method},
        )
        return JsonResponse({"twoFactorRequired": True, "method": user.two_factor_method})

    login(request, user)
    apply_login_session_expiry(request, remember)
    mark_recent_auth(request, "password")
    write_audit_event(request, "auth.login_succeeded", actor=user, subject=f"user:{user.id}")
    service_notification_for_login(request, user, "password")
    return JsonResponse({"user": user_payload(user)})


def _oidc_popup_response(*, ok: bool, error: str = "") -> HttpResponse:
    script_query = urlencode({"ok": "1" if ok else "0", "error": error})
    return HttpResponse(
        '<!doctype html><meta charset="utf-8">'
        f'<script src="/api/auth/oidc/popup.js?{script_query}"></script>',
        content_type="text/html",
        headers={"Cache-Control": "no-store"},
    )


@require_GET
def oidc_popup_script(request):
    ok = request.GET.get("ok") == "1"
    error = str(request.GET.get("error", ""))
    message = json.dumps(
        {"type": "quillum:oidc-reauthentication", "ok": ok, "error": error},
        separators=(",", ":"),
    )
    public_origin = settings.QUILLUM_PUBLIC_ORIGIN or "/"
    split_origin = urlsplit(public_origin)
    target_origin = (
        f"{split_origin.scheme}://{split_origin.netloc}"
        if split_origin.scheme and split_origin.netloc
        else "*"
    )
    return HttpResponse(
        f"window.opener?.postMessage({message}, {json.dumps(target_origin)});window.close();",
        content_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


@require_GET
def oidc_login(request):
    if not oidc_configured():
        return JsonResponse({"error": "oidc_not_configured"}, status=503)
    reauthenticate_flow = request.GET.get("reauthenticate") == "1"
    invitation_flow = request.GET.get("invitation") == "1"
    if reauthenticate_flow and not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if invitation_flow:
        from .editor_service import EditorFlowError, invitation_from_session

        try:
            invitation_from_session(request)
        except EditorFlowError as exc:
            return JsonResponse({"error": exc.code}, status=exc.status)

    request.session[OIDC_FLOW_SESSION_KEY] = {
        "started": True,
        "reauthenticate": reauthenticate_flow,
        "invitation": invitation_flow,
        "userId": request.user.id if reauthenticate_flow else None,
        "language": str(request.GET.get("language", User.LANGUAGE_EN)),
        "theme": str(request.GET.get("theme", User.THEME_SYSTEM)),
        "timezone": str(request.GET.get("timezone", "UTC")),
    }
    callback_uri = request.build_absolute_uri("/api/auth/oidc/callback/")
    parameters = {"prompt": "login", "max_age": 0} if reauthenticate_flow else {}
    try:
        return oidc_client().authorize_redirect(request, callback_uri, **parameters)
    except OidcLoginError as exc:
        return JsonResponse({"error": exc.code}, status=503)


@require_GET
def oidc_callback(request):
    flow = request.session.pop(OIDC_FLOW_SESSION_KEY, {})
    if not isinstance(flow, dict) or flow.get("started") is not True:
        return HttpResponseRedirect("/login?oidcError=oidc_flow_invalid")
    reauthenticate_flow = bool(flow.get("reauthenticate"))
    invitation_flow = bool(flow.get("invitation"))
    try:
        client = oidc_client()
        token = client.authorize_access_token(request)
        claims = token.get("userinfo")
        if not isinstance(claims, dict):
            claims = dict(client.userinfo(token=token))
        if invitation_flow:
            from .editor_service import (
                EditorFlowError,
                accept_editor_invitation,
                clear_invitation_claim,
                invitation_from_session,
            )

            try:
                with transaction.atomic():
                    invitation = invitation_from_session(request, lock=True)
                    resolved = resolve_oidc_user(
                        claims,
                        language=str(flow.get("language", User.LANGUAGE_EN)),
                        theme=str(flow.get("theme", User.THEME_SYSTEM)),
                        timezone_name=str(flow.get("timezone", "UTC")),
                        author_workspace_enabled=False,
                        require_editor_only=True,
                    )
                    if not resolved.user.is_active:
                        raise OidcLoginError("account_blocked")
                    connection, editor_workspace_activated = accept_editor_invitation(
                        invitation,
                        resolved.user,
                    )
                    if editor_workspace_activated:
                        write_audit_event(
                            request,
                            "auth.workspace_activated",
                            actor=resolved.user,
                            subject=f"user:{resolved.user.id}",
                            payload={"workspace": WORKSPACE_EDITOR},
                        )
                    write_audit_event(
                        request,
                        "editor.invitation_accepted",
                        actor=resolved.user,
                        subject=f"editor-connection:{connection.id}",
                        payload={"invitationId": str(invitation.public_id)},
                    )
            except EditorFlowError as exc:
                raise OidcLoginError(exc.code) from exc
        else:
            resolved = resolve_oidc_user(
                claims,
                language=str(flow.get("language", User.LANGUAGE_EN)),
                theme=str(flow.get("theme", User.THEME_SYSTEM)),
                timezone_name=str(flow.get("timezone", "UTC")),
                expected_user_id=int(flow["userId"]) if reauthenticate_flow else None,
            )
        if not resolved.user.is_active:
            raise OidcLoginError("account_blocked")
        mark_oidc_login(resolved.identity)
        if reauthenticate_flow:
            mark_recent_auth(request, "oidc")
            write_audit_event(
                request,
                "auth.oidc_reauthentication_succeeded",
                actor=resolved.user,
                subject=f"user:{resolved.user.id}",
            )
            return _oidc_popup_response(ok=True)

        login(request, resolved.user, backend="django.contrib.auth.backends.ModelBackend")
        mark_recent_auth(request, "oidc")
        write_audit_event(
            request,
            "auth.oidc_login_succeeded",
            actor=resolved.user,
            subject=f"user:{resolved.user.id}",
            payload={"created": resolved.created, "linked": resolved.linked},
        )
        if not resolved.created:
            service_notification_for_login(request, resolved.user, "oidc")
        if invitation_flow:
            clear_invitation_claim(request)
            set_active_workspace(request, WORKSPACE_EDITOR)
            return HttpResponseRedirect("/manuscripts")
        return HttpResponseRedirect("/workspace")
    except Exception as exc:
        code = exc.code if isinstance(exc, OidcLoginError) else "oidc_login_failed"
        if not isinstance(exc, OidcLoginError):
            logger.exception("OIDC callback failed")
        write_audit_event(request, "auth.oidc_login_failed", payload={"error": code})
        if reauthenticate_flow:
            return _oidc_popup_response(ok=False, error=code)
        destination = "/editor-invitation" if invitation_flow else "/login"
        return HttpResponseRedirect(f"{destination}?oidcError={code}")


@require_POST
def login_two_factor(request):
    challenge = pending_two_factor_challenge(request)
    if challenge is None:
        return JsonResponse({"error": "two_factor_challenge_required"}, status=400)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    user = User.objects.filter(id=challenge.get("userId")).first()
    if user is not None and not user.is_active:
        request.session.pop(TWO_FACTOR_CHALLENGE_SESSION_KEY, None)
        request.session.modified = True
        return JsonResponse({"error": "account_blocked"}, status=403)
    if user is None or not two_factor_required(user):
        request.session.pop(TWO_FACTOR_CHALLENGE_SESSION_KEY, None)
        request.session.modified = True
        return JsonResponse({"error": "two_factor_challenge_invalid"}, status=400)

    code = str(data.get("code", ""))
    valid_code = False
    if user.two_factor_method == User.TWO_FACTOR_TOTP:
        secret = user.totp_secret
        valid_code = verify_totp_code(secret, code)
    elif user.two_factor_method == User.TWO_FACTOR_EMAIL:
        valid_code = check_password(code.strip(), str(challenge.get("codeHash", "")))

    if not valid_code:
        attempts_exceeded = record_two_factor_attempt(request, challenge)
        write_audit_event(
            request,
            "auth.two_factor_failed",
            actor=user,
            subject=f"user:{user.id}",
            payload={"method": user.two_factor_method},
        )
        error = "two_factor_attempts_exceeded" if attempts_exceeded else "two_factor_code_invalid"
        return JsonResponse({"error": error}, status=400)

    request.session.pop(TWO_FACTOR_CHALLENGE_SESSION_KEY, None)
    login(request, user)
    apply_login_session_expiry(request, bool(challenge.get("remember", False)))
    mark_recent_auth(request, "password")
    write_audit_event(request, "auth.login_succeeded", actor=user, subject=f"user:{user.id}")
    service_notification_for_login(request, user, "two_factor")
    return JsonResponse({"user": user_payload(user)})


@require_POST
def logout_view(request):
    actor = request.user if request.user.is_authenticated else None
    subject = f"user:{actor.id}" if actor else ""
    write_audit_event(request, "auth.logout", actor=actor, subject=subject)
    logout(request)
    return JsonResponse({"ok": True})


@require_POST
def delete_account(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    user = request.user
    if rate_limit_exceeded(
        "account-delete",
        runtime_setting("account_delete_rate_limit"),
        request_ip(request),
        user.id,
    ):
        return rate_limited_response()

    local_password_enabled = runtime_setting("local_password_login_enabled")
    password = str(data.get("password", ""))
    if not local_password_enabled and (response := require_recent_auth(request)):
        return response
    if local_password_enabled and not user.check_password(password):
        write_audit_event(
            request,
            "auth.account_deletion_failed",
            actor=user,
            subject=f"user:{user.id}",
        )
        if record_rate_limit_hit(
            "account-delete",
            runtime_setting("account_delete_rate_limit"),
            request_ip(request),
            user.id,
        ):
            return rate_limited_response()
        return JsonResponse({"error": "current_password_invalid"}, status=400)

    user_id = user.id
    logout(request)
    revoke_user_sessions(user_id)
    delete_account_data(user)
    AuditEvent.objects.create(
        event="auth.account_deleted",
        subject=f"deleted-user:{user_id}",
        payload={"source": "self"},
    )
    return JsonResponse({"ok": True})


@require_POST
def reauthenticate(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    if not runtime_setting("local_password_login_enabled"):
        return JsonResponse(
            {
                "error": "local_password_login_disabled",
                "reauthenticationMethod": "oidc" if oidc_configured() else "passkey",
            },
            status=403,
        )

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    if rate_limit_exceeded(
        "reauthenticate",
        runtime_setting("reauthentication_rate_limit"),
        request_ip(request),
        request.user.id,
    ):
        return rate_limited_response()

    password = str(data.get("password", ""))
    if not request.user.check_password(password):
        write_audit_event(
            request,
            "auth.reauthentication_failed",
            actor=request.user,
            subject=f"user:{request.user.id}",
        )
        if record_rate_limit_hit(
            "reauthenticate",
            runtime_setting("reauthentication_rate_limit"),
            request_ip(request),
            request.user.id,
        ):
            return rate_limited_response()
        return JsonResponse({"error": "current_password_invalid"}, status=400)

    mark_recent_auth(request, "password")
    write_audit_event(
        request,
        "auth.reauthentication_succeeded",
        actor=request.user,
        subject=f"user:{request.user.id}",
    )
    return JsonResponse({"ok": True})


@require_GET
def session(request):
    auth_capabilities = {
        "localPasswordLoginEnabled": runtime_setting("local_password_login_enabled"),
        "oidcEnabled": oidc_configured(),
        "oidcProviderName": settings.OIDC_PROVIDER_NAME or "OpenID Connect",
    }
    if not request.user.is_authenticated:
        return JsonResponse(
            {
                "authenticated": False,
                "user": None,
                "authMode": settings.AUTH_MODE,
                "openRegistration": runtime_setting("open_registration"),
                **auth_capabilities,
            }
        )

    return JsonResponse(
        {
            "authenticated": True,
            "user": user_payload(request.user),
            "activeWorkspace": active_workspace(request),
            "authMode": settings.AUTH_MODE,
            "openRegistration": runtime_setting("open_registration"),
            **auth_capabilities,
        }
    )


@require_POST
def activate_workspace(request, workspace):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if workspace not in {WORKSPACE_AUTHOR, WORKSPACE_EDITOR}:
        return JsonResponse({"error": "workspace_unavailable"}, status=404)
    current_workspace = active_workspace(request)

    with transaction.atomic():
        user = User.objects.select_for_update().get(pk=request.user.pk)
        field = (
            "author_workspace_enabled_at"
            if workspace == WORKSPACE_AUTHOR
            else "editor_workspace_enabled_at"
        )
        activated = not workspace_available(user, workspace)
        if activated:
            setattr(user, field, timezone.now())
            user.save(update_fields=[field])
            write_audit_event(
                request,
                "auth.workspace_activated",
                actor=user,
                subject=f"user:{user.id}",
                payload={"workspace": workspace},
            )
    return JsonResponse(
        {
            "user": user_payload(user),
            "activeWorkspace": current_workspace,
        }
    )


@require_POST
def switch_workspace(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    workspace = str(data.get("workspace", "")).strip()
    if not workspace_available(request.user, workspace):
        return JsonResponse({"error": "workspace_unavailable"}, status=403)
    set_active_workspace(request, workspace)
    return JsonResponse(
        {
            "user": user_payload(request.user),
            "activeWorkspace": workspace,
        }
    )


@require_GET
def dashboard(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    return JsonResponse(
        {
            "message": "Welcome to Quillum.",
            "user": user_payload(request.user),
            "admin": request.user.is_superuser,
        }
    )


@require_http_methods(["GET", "PATCH"])
def profile(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    if request.method == "GET":
        return JsonResponse({"user": user_payload(request.user)})

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    if "currentPassword" in data or "newPassword" in data:
        return JsonResponse({"error": "password_change_endpoint_required"}, status=400)

    user = request.user
    changed_fields = []

    if "displayName" in data:
        user.display_name = str(data.get("displayName", "")).strip()
        changed_fields.append("display_name")

    if "language" in data:
        language = str(data.get("language", "")).strip()
        allowed_languages = {value for value, _label in User.LANGUAGE_CHOICES}
        if language not in allowed_languages:
            return JsonResponse({"error": "language_unsupported"}, status=400)
        user.language = language
        changed_fields.append("language")

    if "timezone" in data:
        try:
            user.timezone = validate_timezone_name(data.get("timezone"))
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        changed_fields.append("timezone")

    if "theme" in data:
        theme = str(data.get("theme", "")).strip()
        allowed_themes = {value for value, _label in User.THEME_CHOICES}
        if theme not in allowed_themes:
            return JsonResponse({"error": "theme_unsupported"}, status=400)
        user.theme = theme
        changed_fields.append("theme")

    author_fields = {
        "authorName": "author_name",
        "authorEmail": "author_email",
        "authorWebsite": "author_website",
        "authorTodayProfile": "author_today_profile",
        "authorLitresProfile": "author_litres_profile",
        "authorProzaProfile": "author_proza_profile",
        "authorSamizdatProfile": "author_samizdat_profile",
        "authorCellulosaProfile": "author_cellulosa_profile",
        "authorWattpadProfile": "author_wattpad_profile",
    }
    if not has_author_workspace(request.user):
        if any(payload_field in data for payload_field in author_fields):
            return JsonResponse({"error": "author_workspace_required"}, status=403)
    for payload_field, model_field in author_fields.items():
        if payload_field in data:
            setattr(user, model_field, str(data.get(payload_field, "")).strip())
            changed_fields.append(model_field)

    if changed_fields:
        user.save(update_fields=changed_fields)
        if "timezone" in changed_fields:
            from apps.notifications.user_rules import reschedule_user_rules

            reschedule_user_rules(user)
        write_audit_event(
            request,
            "auth.profile_updated",
            actor=user,
            subject=f"user:{user.id}",
            payload={"fields": changed_fields},
        )

    return JsonResponse({"user": user_payload(user)})


@require_POST
def complete_onboarding(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if request.user.onboarding_completed_at is not None:
        return JsonResponse({"user": user_payload(request.user)})

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    language = str(data.get("language", "")).strip()
    if language not in {value for value, _label in User.LANGUAGE_CHOICES}:
        return JsonResponse({"error": "language_unsupported"}, status=400)

    try:
        timezone_name = validate_timezone_name(data.get("timezone"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    theme = str(data.get("theme", "")).strip()
    if theme not in {value for value, _label in User.THEME_CHOICES}:
        return JsonResponse({"error": "theme_unsupported"}, status=400)

    display_name = str(data.get("displayName", "")).strip()
    if len(display_name) > DISPLAY_NAME_MAX_LENGTH:
        return JsonResponse({"error": "display_name_too_long"}, status=400)

    profile_fields = {
        "authorName": "author_name",
        "authorWebsite": "author_website",
        "authorTodayProfile": "author_today_profile",
        "authorLitresProfile": "author_litres_profile",
        "authorProzaProfile": "author_proza_profile",
        "authorSamizdatProfile": "author_samizdat_profile",
        "authorCellulosaProfile": "author_cellulosa_profile",
        "authorWattpadProfile": "author_wattpad_profile",
    }

    with transaction.atomic():
        user = User.objects.select_for_update().get(pk=request.user.pk)
        if user.onboarding_completed_at is not None:
            return JsonResponse({"user": user_payload(user)})

        timezone_changed = user.timezone != timezone_name
        user.language = language
        user.timezone = timezone_name
        user.theme = theme
        user.display_name = display_name
        changed_fields = ["language", "timezone", "theme", "display_name"]
        if has_author_workspace(user):
            for payload_field, model_field in profile_fields.items():
                setattr(user, model_field, str(data.get(payload_field, "")).strip())
                changed_fields.append(model_field)
        user.onboarding_completed_at = timezone.now()
        changed_fields.append("onboarding_completed_at")
        user.save(update_fields=changed_fields)

        write_audit_event(
            request,
            "auth.onboarding_completed",
            actor=user,
            subject=f"user:{user.id}",
            payload={"fields": changed_fields[:-1]},
        )

    if timezone_changed:
        from apps.notifications.user_rules import reschedule_user_rules

        reschedule_user_rules(user)

    return JsonResponse({"user": user_payload(user)})


@require_GET
def tier(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    return JsonResponse({"tier": user_tier_payload(request.user)})


@require_POST
def avatar(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    file = request.FILES.get("avatar")
    if file is None:
        return JsonResponse({"error": "avatar_required"}, status=400)
    editor_only = not has_author_workspace(request.user)
    max_bytes = EDITOR_AVATAR_MAX_BYTES if editor_only else image_upload_limit(request.user)
    if file.size > max_bytes:
        if editor_only:
            return JsonResponse(
                {
                    "error": "editor_avatar_too_large",
                    "limit": EDITOR_AVATAR_MAX_BYTES,
                },
                status=413,
            )
        return image_size_response(request.user, used=file.size, limit=max_bytes)
    if file.content_type not in AVATAR_ALLOWED_CONTENT_TYPES:
        return JsonResponse({"error": "avatar_type_unsupported"}, status=400)
    normalized_file = normalized_avatar(file)
    if isinstance(normalized_file, JsonResponse):
        return normalized_file

    user = request.user
    plaintext_avatar = ContentFile(normalized_file.read(), name=f"{uuid4().hex}.webp")
    if not editor_only:
        storage_error = storage_quota_response(
            user,
            added=plaintext_avatar.size,
            replacing=stored_file_size(user.avatar),
        )
        if storage_error is not None:
            return storage_error
    if user.avatar:
        user.avatar.delete(save=False)
    user.avatar.save(plaintext_avatar.name, plaintext_avatar, save=False)
    user.save(update_fields=["avatar"])
    write_audit_event(
        request,
        "auth.avatar_updated",
        actor=user,
        subject=f"user:{user.id}",
    )

    return JsonResponse({"user": user_payload(user)})


@require_GET
def avatar_content(request, user_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if request.user.id != user_id and not request.user.is_superuser:
        can_view_connected_identity = EditorConnection.objects.filter(
            Q(author=request.user, editor_id=user_id)
            | Q(editor=request.user, author_id=user_id),
            disconnected_at__isnull=True,
        ).exists()
        if not can_view_connected_identity:
            from apps.manuscripts.models import ManuscriptEditorGrant

            request_user_manuscripts = ManuscriptEditorGrant.objects.filter(
                editor_connection__editor=request.user,
                editor_connection__disconnected_at__isnull=True,
                revoked_at__isnull=True,
            ).values("manuscript_id")
            can_view_connected_identity = ManuscriptEditorGrant.objects.filter(
                manuscript_id__in=Subquery(request_user_manuscripts),
                editor_connection__editor_id=user_id,
                editor_connection__disconnected_at__isnull=True,
                revoked_at__isnull=True,
            ).exists()
        if not can_view_connected_identity:
            return JsonResponse({"error": "superuser_required"}, status=403)

    user = User.objects.filter(id=user_id).first()
    if user is None or not user.avatar:
        return JsonResponse({"error": "avatar_not_found"}, status=404)

    def load_avatar():
        with user.avatar.open("rb") as stored_file:
            return stored_file.read(), AVATAR_OUTPUT_CONTENT_TYPE

    return private_media_response(
        request,
        cache_key=f"avatar:{user.id}:{user.avatar.name}",
        load_content=load_avatar,
    )


@require_POST
def request_email_change(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    new_email = str(data.get("email", "")).strip()
    cleanup_expired_confirmation_codes(request.user)
    if record_rate_limit_hit(
        "email-change-request",
        runtime_setting("code_request_rate_limit"),
        request_ip(request),
        request.user.id,
    ):
        return rate_limited_response()

    if not new_email:
        return JsonResponse({"error": "email_required"}, status=400)
    if User.objects.exclude(id=request.user.id).filter(email_lookup_q(new_email)).exists():
        return JsonResponse({"error": "email_already_exists"}, status=409)

    code = email_change_code()
    expires_at = timezone.now() + timedelta(
        minutes=runtime_setting("email_change_code_ttl_minutes")
    )
    EmailChangeRequest.objects.filter(user=request.user, consumed_at__isnull=True).update(
        consumed_at=timezone.now()
    )
    EmailChangeRequest.objects.create(
        user=request.user,
        new_email=new_email,
        code_hash=make_password(code),
        expires_at=expires_at,
    )
    send_email_change_code(new_email, code, language=request.user.language)
    write_audit_event(
        request,
        "auth.email_change_requested",
        actor=request.user,
        subject=f"user:{request.user.id}",
        payload={"newEmail": new_email},
    )

    return JsonResponse({"ok": True, "expiresAt": expires_at.isoformat()})


@require_POST
def confirm_email_change(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    code = str(data.get("code", "")).strip()
    cleanup_expired_confirmation_codes(request.user)
    if record_rate_limit_hit(
        "email-change-confirm",
        runtime_setting("code_confirm_rate_limit"),
        request_ip(request),
        request.user.id,
    ):
        return rate_limited_response()

    pending = (
        EmailChangeRequest.objects.filter(user=request.user, consumed_at__isnull=True)
        .order_by("-created_at")
        .first()
    )
    if pending is None:
        return JsonResponse({"error": "email_change_not_requested"}, status=400)
    if not check_password(code, pending.code_hash):
        return reject_invalid_confirmation_code(pending, "email_change")
    if User.objects.exclude(id=request.user.id).filter(email_lookup_q(pending.new_email)).exists():
        return JsonResponse({"error": "email_already_exists"}, status=409)

    user = request.user
    user.email = pending.new_email
    try:
        user.save(update_fields=["email"])
    except IntegrityError:
        return JsonResponse({"error": "email_already_exists"}, status=409)
    pending.consumed_at = timezone.now()
    pending.save(update_fields=["consumed_at"])
    write_audit_event(
        request,
        "auth.email_changed",
        actor=user,
        subject=f"user:{user.id}",
        payload={"email": user.email},
    )

    return JsonResponse({"user": user_payload(user)})


@require_http_methods(["GET", "PATCH"])
def security(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    if request.method == "GET":
        return JsonResponse(security_payload(request.user))
    if response := require_recent_auth(request):
        return response

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    method = str(data.get("twoFactorMethod", "")).strip()
    allowed_methods = {value for value, _label in User.TWO_FACTOR_CHOICES}
    if method not in allowed_methods:
        return JsonResponse({"error": "two_factor_method_unsupported"}, status=400)
    if method == User.TWO_FACTOR_TOTP and two_factor_required(request.user):
        return JsonResponse(security_payload(request.user))
    if method != User.TWO_FACTOR_NONE:
        return JsonResponse({"error": "two_factor_setup_required"}, status=400)

    request.user.two_factor_method = method
    if method == User.TWO_FACTOR_NONE:
        request.user.totp_secret = ""
        request.user.totp_confirmed_at = None
    request.user.save(update_fields=["two_factor_method", "totp_secret", "totp_confirmed_at"])
    write_audit_event(
        request,
        "auth.two_factor_method_updated",
        actor=request.user,
        subject=f"user:{request.user.id}",
        payload={"method": method},
    )
    return JsonResponse(security_payload(request.user))


@require_POST
def start_totp_setup(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    secret = pyotp.random_base32()
    request.session[TOTP_SETUP_SESSION_KEY] = secret
    request.session.modified = True
    provisioning_uri = pyotp.TOTP(secret).provisioning_uri(
        name=request.user.email or request.user.get_username(),
        issuer_name=runtime_setting("totp_issuer"),
    )
    write_audit_event(
        request,
        "auth.totp_setup_started",
        actor=request.user,
        subject=f"user:{request.user.id}",
    )
    return JsonResponse({"provisioningUri": provisioning_uri})


@require_POST
def confirm_totp_setup(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    secret = request.session.get(TOTP_SETUP_SESSION_KEY)
    if not secret:
        return JsonResponse({"error": "totp_setup_required"}, status=400)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    code = str(data.get("code", ""))
    if not verify_totp_code(secret, code):
        return JsonResponse({"error": "totp_code_invalid"}, status=400)

    request.user.totp_secret = secret
    request.user.totp_confirmed_at = timezone.now()
    request.user.two_factor_method = User.TWO_FACTOR_TOTP
    request.user.save(update_fields=["totp_secret", "totp_confirmed_at", "two_factor_method"])
    request.session.pop(TOTP_SETUP_SESSION_KEY, None)
    request.session.modified = True
    write_audit_event(
        request,
        "auth.totp_enabled",
        actor=request.user,
        subject=f"user:{request.user.id}",
    )
    return JsonResponse(
        {"security": security_payload(request.user), "user": user_payload(request.user)}
    )


@require_POST
def disable_totp(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    request.user.totp_secret = ""
    request.user.totp_confirmed_at = None
    if request.user.two_factor_method == User.TWO_FACTOR_TOTP:
        request.user.two_factor_method = User.TWO_FACTOR_NONE
    request.user.save(update_fields=["totp_secret", "totp_confirmed_at", "two_factor_method"])
    request.session.pop(TOTP_SETUP_SESSION_KEY, None)
    request.session.modified = True
    write_audit_event(
        request,
        "auth.totp_disabled",
        actor=request.user,
        subject=f"user:{request.user.id}",
    )
    return JsonResponse(
        {"security": security_payload(request.user), "user": user_payload(request.user)}
    )


@require_POST
def start_email_two_factor_setup(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response
    if not request.user.email:
        return JsonResponse({"error": "email_required"}, status=400)

    code = email_change_code()
    request.session[EMAIL_TWO_FACTOR_SETUP_SESSION_KEY] = {
        "codeHash": make_password(code),
        "createdAt": timezone.now().isoformat(),
        "attempts": 0,
    }
    request.session.modified = True
    send_email_two_factor_setup_code(request.user.email, code, language=request.user.language)
    write_audit_event(
        request,
        "auth.email_two_factor_setup_started",
        actor=request.user,
        subject=f"user:{request.user.id}",
    )
    return JsonResponse({"ok": True, "email": request.user.email})


def pending_email_two_factor_setup(request) -> dict | None:
    challenge = request.session.get(EMAIL_TWO_FACTOR_SETUP_SESSION_KEY)
    if not isinstance(challenge, dict):
        return None
    try:
        created_at = datetime.fromisoformat(str(challenge.get("createdAt", "")))
    except ValueError:
        return None
    if timezone.is_naive(created_at):
        created_at = timezone.make_aware(created_at, timezone=UTC)
    if timezone.now() - created_at > timedelta(
        seconds=runtime_setting("two_factor_challenge_ttl_seconds")
    ):
        request.session.pop(EMAIL_TWO_FACTOR_SETUP_SESSION_KEY, None)
        request.session.modified = True
        return None
    return challenge


def record_email_two_factor_setup_attempt(request, challenge: dict) -> bool:
    challenge["attempts"] = int(challenge.get("attempts", 0)) + 1
    request.session[EMAIL_TWO_FACTOR_SETUP_SESSION_KEY] = challenge
    if challenge["attempts"] >= runtime_setting("two_factor_challenge_max_attempts"):
        request.session.pop(EMAIL_TWO_FACTOR_SETUP_SESSION_KEY, None)
        request.session.modified = True
        return True
    request.session.modified = True
    return False


@require_POST
def confirm_email_two_factor_setup(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    challenge = pending_email_two_factor_setup(request)
    if challenge is None:
        return JsonResponse({"error": "email_two_factor_setup_required"}, status=400)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    code = str(data.get("code", "")).strip()
    if not check_password(code, str(challenge.get("codeHash", ""))):
        attempts_exceeded = record_email_two_factor_setup_attempt(request, challenge)
        error = (
            "email_two_factor_attempts_exceeded"
            if attempts_exceeded
            else "email_two_factor_code_invalid"
        )
        return JsonResponse({"error": error}, status=400)

    request.user.two_factor_method = User.TWO_FACTOR_EMAIL
    request.user.save(update_fields=["two_factor_method"])
    request.session.pop(EMAIL_TWO_FACTOR_SETUP_SESSION_KEY, None)
    request.session.modified = True
    write_audit_event(
        request,
        "auth.email_two_factor_enabled",
        actor=request.user,
        subject=f"user:{request.user.id}",
    )
    return JsonResponse(
        {"security": security_payload(request.user), "user": user_payload(request.user)}
    )


@require_POST
def request_password_change(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    current_password = str(data.get("currentPassword", ""))
    new_password = str(data.get("newPassword", ""))
    cleanup_expired_confirmation_codes(request.user)
    if record_rate_limit_hit(
        "password-change-request",
        runtime_setting("code_request_rate_limit"),
        request_ip(request),
        request.user.id,
    ):
        return rate_limited_response()

    if not request.user.check_password(current_password):
        return JsonResponse({"error": "current_password_invalid"}, status=400)

    try:
        validate_password(new_password, user=request.user)
    except ValidationError as exc:
        return password_error_response(exc)

    code = email_change_code()
    expires_at = timezone.now() + timedelta(
        minutes=runtime_setting("email_change_code_ttl_minutes")
    )
    PasswordChangeRequest.objects.filter(
        user=request.user,
        consumed_at__isnull=True,
    ).update(consumed_at=timezone.now())
    PasswordChangeRequest.objects.create(
        user=request.user,
        password_hash=make_password(new_password),
        code_hash=make_password(code),
        expires_at=expires_at,
    )
    send_password_change_code(request.user.email, code, language=request.user.language)
    write_audit_event(
        request,
        "auth.password_change_requested",
        actor=request.user,
        subject=f"user:{request.user.id}",
    )

    return JsonResponse({"ok": True, "expiresAt": expires_at.isoformat()})


@require_POST
def confirm_password_change(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    code = str(data.get("code", "")).strip()
    cleanup_expired_confirmation_codes(request.user)
    if record_rate_limit_hit(
        "password-change-confirm",
        runtime_setting("code_confirm_rate_limit"),
        request_ip(request),
        request.user.id,
    ):
        return rate_limited_response()

    pending = (
        PasswordChangeRequest.objects.filter(user=request.user, consumed_at__isnull=True)
        .order_by("-created_at")
        .first()
    )
    if pending is None:
        return JsonResponse({"error": "password_change_not_requested"}, status=400)
    if not check_password(code, pending.code_hash):
        return reject_invalid_confirmation_code(pending, "password_change")

    request.user.password = pending.password_hash
    request.user.password_changed_at = timezone.now()
    request.user.save(update_fields=["password", "password_changed_at"])
    update_session_auth_hash(request, request.user)
    pending.consumed_at = timezone.now()
    pending.save(update_fields=["consumed_at"])
    login(request, request.user)
    mark_recent_auth(request, "password")
    write_audit_event(
        request,
        "auth.password_changed",
        actor=request.user,
        subject=f"user:{request.user.id}",
    )
    return JsonResponse({"user": user_payload(request.user)})


@require_POST
def request_password_reset(request):
    if not runtime_setting("local_password_login_enabled"):
        return JsonResponse({"error": "local_password_login_disabled"}, status=403)
    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    email = str(data.get("email", "")).strip()
    user = User.objects.filter(email_lookup_q(email), is_active=True).first()
    rate_limit_key = user.id if user is not None else email.lower()
    if record_rate_limit_hit(
        "password-reset-request",
        runtime_setting("code_request_rate_limit"),
        request_ip(request),
        rate_limit_key,
    ):
        return rate_limited_response()

    response = {"ok": True}
    if user is None:
        return JsonResponse(response)

    cleanup_expired_confirmation_codes(user)
    code = email_change_code()
    expires_at = timezone.now() + timedelta(
        minutes=runtime_setting("email_change_code_ttl_minutes")
    )
    PasswordChangeRequest.objects.filter(user=user, consumed_at__isnull=True).update(
        consumed_at=timezone.now()
    )
    PasswordChangeRequest.objects.create(
        user=user,
        password_hash="",
        code_hash=make_password(code),
        expires_at=expires_at,
    )
    send_password_reset_code(user.email, code, language=user.language)
    write_audit_event(
        request,
        "auth.password_reset_requested",
        subject=f"user:{user.id}",
        payload={"email": user.email},
    )
    response["expiresAt"] = expires_at.isoformat()
    return JsonResponse(response)


@require_POST
def verify_password_reset(request):
    if not runtime_setting("local_password_login_enabled"):
        return JsonResponse({"error": "local_password_login_disabled"}, status=403)
    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    email = str(data.get("email", "")).strip()
    code = str(data.get("code", "")).strip()
    user = User.objects.filter(email_lookup_q(email), is_active=True).first()
    if user is None:
        return JsonResponse({"error": "password_reset_invalid"}, status=400)

    cleanup_expired_confirmation_codes(user)
    if record_rate_limit_hit(
        "password-reset-confirm",
        runtime_setting("code_confirm_rate_limit"),
        request_ip(request),
        user.id,
    ):
        return rate_limited_response()

    pending = (
        PasswordChangeRequest.objects.filter(
            user=user,
            password_hash="",
            consumed_at__isnull=True,
        )
        .order_by("-created_at")
        .first()
    )
    if pending is None or not check_password(code, pending.code_hash):
        return JsonResponse({"error": "password_reset_invalid"}, status=400)

    return JsonResponse({"ok": True})


@require_POST
def confirm_password_reset(request):
    if not runtime_setting("local_password_login_enabled"):
        return JsonResponse({"error": "local_password_login_disabled"}, status=403)
    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    email = str(data.get("email", "")).strip()
    code = str(data.get("code", "")).strip()
    new_password = str(data.get("newPassword", ""))
    user = User.objects.filter(email_lookup_q(email), is_active=True).first()
    if user is None:
        return JsonResponse({"error": "password_reset_invalid"}, status=400)

    cleanup_expired_confirmation_codes(user)
    if record_rate_limit_hit(
        "password-reset-confirm",
        runtime_setting("code_confirm_rate_limit"),
        request_ip(request),
        user.id,
    ):
        return rate_limited_response()

    pending = (
        PasswordChangeRequest.objects.filter(
            user=user,
            password_hash="",
            consumed_at__isnull=True,
        )
        .order_by("-created_at")
        .first()
    )
    if pending is None or not check_password(code, pending.code_hash):
        return JsonResponse({"error": "password_reset_invalid"}, status=400)

    try:
        validate_password(new_password, user=user)
    except ValidationError as exc:
        return password_error_response(exc)

    user.password = make_password(new_password)
    user.password_changed_at = timezone.now()
    user.save(update_fields=["password", "password_changed_at"])
    pending.consumed_at = timezone.now()
    pending.save(update_fields=["consumed_at"])
    write_audit_event(
        request,
        "auth.password_reset_confirmed",
        subject=f"user:{user.id}",
    )
    return JsonResponse({"ok": True})


@require_POST
def start_passkey_registration(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    if request.user.passkey_credentials.count() >= 5:
        return JsonResponse({"error": "passkey_limit_reached"}, status=400)

    name = str(data.get("name", "")).strip()
    if not name:
        return JsonResponse({"error": "passkey_name_required"}, status=400)
    if len(name) > 120:
        return JsonResponse({"error": "passkey_name_too_long"}, status=400)

    options_json, challenge = passkey_registration_options_json(request.user)
    request.session[PASSKEY_REGISTRATION_SESSION_KEY] = {
        "challenge": challenge,
        "name": name,
        "createdAt": timezone.now().isoformat(),
    }
    request.session.modified = True
    write_audit_event(
        request,
        "auth.passkey_registration_started",
        actor=request.user,
        subject=f"user:{request.user.id}",
        payload={"name": name},
    )
    return JsonResponse({"options": json.loads(options_json)})


@require_POST
def finish_passkey_registration(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    pending = request.session.get(PASSKEY_REGISTRATION_SESSION_KEY)
    if not isinstance(pending, dict):
        return JsonResponse({"error": "passkey_registration_required"}, status=400)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    credential = data.get("credential")
    if not isinstance(credential, dict):
        return JsonResponse({"error": "passkey_credential_required"}, status=400)

    try:
        verification = verify_registration_response(
            credential=credential,
            expected_challenge=base64url_to_bytes(str(pending.get("challenge", ""))),
            expected_rp_id=settings.QUILLUM_WEBAUTHN_RP_ID,
            expected_origin=webauthn_origins(),
            require_user_verification=False,
        )
    except InvalidRegistrationResponse:
        return JsonResponse({"error": "passkey_registration_invalid"}, status=400)

    credential_id = bytes_to_base64url(verification.credential_id)
    if PasskeyCredential.objects.filter(credential_id=credential_id).exists():
        return JsonResponse({"error": "passkey_already_registered"}, status=409)

    transports = credential.get("response", {}).get("transports", [])
    if not isinstance(transports, list):
        transports = []
    passkey = PasskeyCredential.objects.create(
        user=request.user,
        name=str(pending.get("name", "Passkey"))[:120],
        credential_id=credential_id,
        public_key=bytes_to_base64url(verification.credential_public_key),
        sign_count=verification.sign_count,
        aaguid=verification.aaguid,
        transports=transports,
        backup_eligible=verification.credential_device_type.value == "multi_device",
        backup_state=verification.credential_backed_up,
    )
    request.session.pop(PASSKEY_REGISTRATION_SESSION_KEY, None)
    request.session.modified = True
    write_audit_event(
        request,
        "auth.passkey_created",
        actor=request.user,
        subject=f"passkey:{passkey.id}",
        payload={"name": passkey.name},
    )
    return JsonResponse(
        {"passkey": passkey_payload(passkey), "security": security_payload(request.user)}
    )


@require_POST
def start_passkey_login(request):
    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    username = str(data.get("username", "")).strip()
    user = (
        User.objects.filter(username__iexact=username, is_active=True).first() if username else None
    )
    options_json, challenge = passkey_authentication_options_json(user)
    request.session[PASSKEY_AUTHENTICATION_SESSION_KEY] = {
        "challenge": challenge,
        "userId": user.id if user else None,
        "createdAt": timezone.now().isoformat(),
    }
    request.session.modified = True
    return JsonResponse({"options": json.loads(options_json)})


@require_POST
def finish_passkey_login(request):
    pending = request.session.get(PASSKEY_AUTHENTICATION_SESSION_KEY)
    if not isinstance(pending, dict):
        return JsonResponse({"error": "passkey_authentication_required"}, status=400)

    data = read_json(request)
    if data is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    credential = data.get("credential")
    if not isinstance(credential, dict):
        return JsonResponse({"error": "passkey_credential_required"}, status=400)

    credential_id = str(credential.get("id", ""))
    passkey = (
        PasskeyCredential.objects.select_related("user")
        .exclude(credential_id="")
        .filter(credential_id=credential_id)
        .first()
    )
    if passkey is None:
        return JsonResponse({"error": "passkey_not_found"}, status=404)
    if not passkey.user.is_active:
        return JsonResponse({"error": "account_blocked"}, status=403)
    if pending.get("userId") and pending.get("userId") != passkey.user_id:
        return JsonResponse({"error": "passkey_user_mismatch"}, status=400)

    try:
        verification = verify_authentication_response(
            credential=credential,
            expected_challenge=base64url_to_bytes(str(pending.get("challenge", ""))),
            expected_rp_id=settings.QUILLUM_WEBAUTHN_RP_ID,
            expected_origin=webauthn_origins(),
            credential_public_key=base64url_to_bytes(passkey.public_key),
            credential_current_sign_count=passkey.sign_count,
            require_user_verification=False,
        )
    except InvalidAuthenticationResponse:
        return JsonResponse({"error": "passkey_authentication_invalid"}, status=400)

    passkey.sign_count = verification.new_sign_count
    passkey.backup_eligible = verification.credential_device_type.value == "multi_device"
    passkey.backup_state = verification.credential_backed_up
    passkey.last_used_at = timezone.now()
    passkey.save(update_fields=["sign_count", "backup_eligible", "backup_state", "last_used_at"])
    request.session.pop(PASSKEY_AUTHENTICATION_SESSION_KEY, None)
    login(request, passkey.user)
    mark_recent_auth(request, "passkey")
    write_audit_event(
        request,
        "auth.passkey_login_succeeded",
        actor=passkey.user,
        subject=f"user:{passkey.user_id}",
        payload={"passkey": passkey.id},
    )
    service_notification_for_login(request, passkey.user, "passkey")
    return JsonResponse({"user": user_payload(passkey.user)})


@require_POST
def delete_passkey(request, passkey_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if response := require_recent_auth(request):
        return response

    passkey = PasskeyCredential.objects.filter(user=request.user, id=passkey_id).first()
    if passkey is None:
        return JsonResponse({"error": "passkey_not_found"}, status=404)

    passkey.delete()
    write_audit_event(
        request,
        "auth.passkey_deleted",
        actor=request.user,
        subject=f"passkey:{passkey_id}",
    )
    return JsonResponse({"security": security_payload(request.user)})
