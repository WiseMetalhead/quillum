from __future__ import annotations

from django.contrib.auth import login
from django.db import IntegrityError, transaction
from django.db.models import F
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_http_methods, require_POST

from apps.adminpanel.runtime_settings import runtime_setting
from apps.audit.service import write_audit_event

from .capabilities import WORKSPACE_EDITOR, set_active_workspace
from .editor_service import (
    EditorFlowError,
    accept_editor_invitation,
    clear_invitation_claim,
    create_editor_invitation,
    editor_section_payload,
    invitation_claim_payload,
    invitation_from_session,
    resolve_invitation_token,
    store_invitation_claim,
)
from .lookups import email_lookup_q
from .models import EditorConnection, EditorInvitation, RegistrationCounter, User
from .rate_limit import rate_limited_response, record_rate_limit_hit, request_ip
from .timezones import validate_timezone_name
from .views import (
    mark_recent_auth,
    read_json,
    user_payload,
    validate_registration_input,
)


def editor_error_response(exc: EditorFlowError) -> JsonResponse:
    payload = {"error": exc.code}
    if exc.details:
        payload.update(exc.details)
    return JsonResponse(payload, status=exc.status)


@require_http_methods(["GET", "POST"])
def editor_invitations(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if request.method == "GET":
        return JsonResponse(editor_section_payload(request.user))
    try:
        invitation = create_editor_invitation(request.user)
    except EditorFlowError as exc:
        return editor_error_response(exc)
    write_audit_event(
        request,
        "editor.invitation_created",
        actor=request.user,
        subject=f"editor-invitation:{invitation.public_id}",
        payload={"expiresAt": invitation.expires_at.isoformat()},
    )
    return JsonResponse(editor_section_payload(request.user), status=201)


@require_http_methods(["DELETE"])
def editor_invitation_detail(request, invitation_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    with transaction.atomic():
        invitation = EditorInvitation.objects.select_for_update().filter(
            public_id=invitation_id,
            author=request.user,
        ).first()
        if invitation is None:
            return JsonResponse({"error": "editor_invitation_not_found"}, status=404)
        if invitation.accepted_at is not None:
            return JsonResponse({"error": "editor_invitation_already_accepted"}, status=409)
        if invitation.revoked_at is None:
            invitation.revoked_at = timezone.now()
            invitation.save(update_fields=["revoked_at"])
            write_audit_event(
                request,
                "editor.invitation_revoked",
                actor=request.user,
                subject=f"editor-invitation:{invitation.public_id}",
            )
    return JsonResponse(editor_section_payload(request.user))


@require_http_methods(["DELETE"])
def editor_connection_detail(request, connection_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    with transaction.atomic():
        connection = (
            EditorConnection.objects.select_for_update()
            .select_related("author", "editor")
            .filter(
                id=connection_id,
                author=request.user,
                disconnected_at__isnull=True,
            )
            .first()
        )
        if connection is None:
            return JsonResponse({"error": "editor_connection_not_found"}, status=404)
        disconnected_at = timezone.now()
        connection.disconnected_at = disconnected_at
        connection.save(update_fields=["disconnected_at"])
        from apps.manuscripts.editor_grants import notify_editor_manuscript_access
        from apps.manuscripts.models import ManuscriptEditorGrant

        active_grants = list(
            ManuscriptEditorGrant.objects.select_for_update()
            .select_related(
                "manuscript",
                "editor_connection__author",
                "editor_connection__editor",
            )
            .filter(
                editor_connection=connection,
                revoked_at__isnull=True,
            )
        )
        ManuscriptEditorGrant.objects.filter(
            id__in=[grant.id for grant in active_grants],
        ).update(revoked_at=disconnected_at)
        for grant in active_grants:
            notify_editor_manuscript_access(grant, granted=False)
        revoked_grant_count = len(active_grants)
        from apps.manuscripts.collaboration import publish_access_revoked

        for grant in active_grants:
            publish_access_revoked(
                manuscript_id=grant.manuscript.public_id,
                editor_id=connection.editor_id,
            )
        write_audit_event(
            request,
            "editor.connection_disconnected",
            actor=request.user,
            subject=f"editor-connection:{connection.id}",
            payload={"revokedManuscriptGrantCount": revoked_grant_count},
        )
    return JsonResponse(editor_section_payload(request.user))


@require_http_methods(["GET", "POST"])
def editor_invitation_claim(request):
    try:
        if request.method == "POST":
            data = read_json(request)
            if data is None:
                return JsonResponse({"error": "invalid_json"}, status=400)
            token = str(data.get("token", "")).strip()
            if not token:
                return JsonResponse({"error": "editor_invitation_token_required"}, status=400)
            invitation = resolve_invitation_token(token)
            store_invitation_claim(request, invitation)
        else:
            invitation = invitation_from_session(request)
        return JsonResponse(invitation_claim_payload(invitation))
    except EditorFlowError as exc:
        clear_invitation_claim(request)
        return editor_error_response(exc)


@require_POST
def editor_invitation_register(request):
    if not runtime_setting("local_password_login_enabled"):
        return JsonResponse({"error": "local_password_login_disabled"}, status=403)
    if request.user.is_authenticated:
        return JsonResponse({"error": "editor_invitation_registration_requires_guest"}, status=409)
    try:
        invitation_from_session(request)
    except EditorFlowError as exc:
        return editor_error_response(exc)
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
        with transaction.atomic():
            invitation = invitation_from_session(request, lock=True)
            user = User.objects.create_user(
                username=username,
                email=email,
                password=password,
                language=language,
                timezone=timezone_name,
                theme=theme,
                onboarding_completed_at=None,
                author_workspace_enabled_at=None,
                editor_workspace_enabled_at=timezone.now(),
            )
            user.display_name = display_name
            user.save(update_fields=["display_name"])
            connection, _editor_workspace_activated = accept_editor_invitation(invitation, user)
            RegistrationCounter.objects.get_or_create(pk=1)
            RegistrationCounter.objects.filter(pk=1).update(
                total_registrations=F("total_registrations") + 1,
            )
            write_audit_event(
                request,
                "auth.user_registered",
                actor=user,
                subject=f"user:{user.id}",
                payload={"username": user.get_username(), "email": user.email},
            )
            write_audit_event(
                request,
                "editor.invitation_accepted",
                actor=user,
                subject=f"editor-connection:{connection.id}",
                payload={"invitationId": str(invitation.public_id)},
            )
    except EditorFlowError as exc:
        return editor_error_response(exc)
    except IntegrityError:
        if User.objects.filter(email_lookup_q(email)).exists():
            return JsonResponse({"error": "email_already_exists"}, status=409)
        if User.objects.filter(username__iexact=username).exists():
            return JsonResponse({"error": "username_already_exists"}, status=409)
        raise
    login(request, user)
    mark_recent_auth(request, "password")
    clear_invitation_claim(request)
    set_active_workspace(request, WORKSPACE_EDITOR)
    return JsonResponse(
        {"user": user_payload(user), "activeWorkspace": WORKSPACE_EDITOR},
        status=201,
    )


@require_POST
def editor_invitation_accept(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    try:
        with transaction.atomic():
            invitation = invitation_from_session(request, lock=True)
            connection, editor_workspace_activated = accept_editor_invitation(
                invitation,
                request.user,
            )
            if editor_workspace_activated:
                write_audit_event(
                    request,
                    "auth.workspace_activated",
                    actor=request.user,
                    subject=f"user:{request.user.id}",
                    payload={"workspace": WORKSPACE_EDITOR},
                )
            write_audit_event(
                request,
                "editor.invitation_accepted",
                actor=request.user,
                subject=f"editor-connection:{connection.id}",
                payload={"invitationId": str(invitation.public_id)},
            )
    except EditorFlowError as exc:
        return editor_error_response(exc)
    clear_invitation_claim(request)
    request.user.refresh_from_db()
    set_active_workspace(request, WORKSPACE_EDITOR)
    return JsonResponse(
        {"user": user_payload(request.user), "activeWorkspace": WORKSPACE_EDITOR}
    )
