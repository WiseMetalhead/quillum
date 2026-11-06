from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID

from django.conf import settings
from django.core import signing
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.adminpanel.runtime_settings import runtime_setting

from .capabilities import has_author_workspace, has_editor_workspace
from .models import EditorConnection, EditorInvitation, User
from .oidc import oidc_configured
from .tiers import tier_quotas

EDITOR_INVITATION_TTL = timedelta(hours=48)
EDITOR_INVITATION_SIGNING_SALT = "quillum.editor-invitation.v1"
EDITOR_INVITATION_SESSION_KEY = "quillum_editor_invitation"


@dataclass(frozen=True)
class EditorFlowError(Exception):
    code: str
    status: int = 400
    details: dict | None = None


def identity_payload(user, *, include_avatar: bool = False) -> dict:
    payload = {
        "displayName": user.display_name,
        "username": user.get_username(),
    }
    if include_avatar:
        payload["avatarUrl"] = (
            f"/api/auth/profile/avatar/{user.id}/" if user.avatar else ""
        )
    return payload


def invitation_token(invitation: EditorInvitation) -> str:
    return signing.Signer(salt=EDITOR_INVITATION_SIGNING_SALT).sign(str(invitation.public_id))


def invitation_share_url(invitation: EditorInvitation) -> str:
    origin = settings.QUILLUM_PUBLIC_ORIGIN.rstrip("/")
    return f"{origin}/editor-invitation#{invitation_token(invitation)}"


def invitation_is_pending(invitation: EditorInvitation, *, now=None) -> bool:
    now = now or timezone.now()
    return bool(
        invitation.revoked_at is None
        and invitation.accepted_at is None
        and invitation.expires_at > now
    )


def resolve_invitation_token(token: str, *, lock: bool = False) -> EditorInvitation:
    try:
        raw_public_id = signing.Signer(salt=EDITOR_INVITATION_SIGNING_SALT).unsign(token)
        public_id = UUID(raw_public_id)
    except (signing.BadSignature, ValueError, TypeError) as exc:
        raise EditorFlowError("editor_invitation_invalid", 400) from exc
    queryset = EditorInvitation.objects.select_related("author")
    if lock:
        queryset = queryset.select_for_update()
    invitation = queryset.filter(public_id=public_id).first()
    if invitation is None:
        raise EditorFlowError("editor_invitation_invalid", 404)
    validate_pending_invitation(invitation)
    return invitation


def validate_pending_invitation(invitation: EditorInvitation) -> None:
    if invitation.revoked_at is not None:
        raise EditorFlowError("editor_invitation_revoked", 410)
    if invitation.accepted_at is not None:
        raise EditorFlowError("editor_invitation_already_accepted", 409)
    if invitation.expires_at <= timezone.now():
        raise EditorFlowError("editor_invitation_expired", 410)
    if not invitation.author.is_active or not has_author_workspace(invitation.author):
        raise EditorFlowError("editor_invitation_unavailable", 410)


def invitation_from_session(request, *, lock: bool = False) -> EditorInvitation:
    raw_public_id = request.session.get(EDITOR_INVITATION_SESSION_KEY)
    try:
        public_id = UUID(str(raw_public_id))
    except (ValueError, TypeError) as exc:
        raise EditorFlowError("editor_invitation_claim_required", 400) from exc
    queryset = EditorInvitation.objects.select_related("author")
    if lock:
        queryset = queryset.select_for_update()
    invitation = queryset.filter(public_id=public_id).first()
    if invitation is None:
        raise EditorFlowError("editor_invitation_invalid", 404)
    validate_pending_invitation(invitation)
    return invitation


def store_invitation_claim(request, invitation: EditorInvitation) -> None:
    request.session[EDITOR_INVITATION_SESSION_KEY] = str(invitation.public_id)
    request.session.modified = True


def clear_invitation_claim(request) -> None:
    request.session.pop(EDITOR_INVITATION_SESSION_KEY, None)
    request.session.modified = True


def invitation_claim_payload(invitation: EditorInvitation) -> dict:
    return {
        "invitation": {
            "id": str(invitation.public_id),
            "author": identity_payload(invitation.author),
            "expiresAt": invitation.expires_at.isoformat(),
        },
        "localPasswordLoginEnabled": runtime_setting("local_password_login_enabled"),
        "oidcEnabled": oidc_configured(),
        "oidcProviderName": settings.OIDC_PROVIDER_NAME or "OpenID Connect",
    }


def editor_slot_usage(author, *, now=None) -> int:
    now = now or timezone.now()
    active_connections = EditorConnection.objects.filter(
        author=author,
        disconnected_at__isnull=True,
    ).count()
    pending_invitations = EditorInvitation.objects.filter(
        author=author,
        revoked_at__isnull=True,
        accepted_at__isnull=True,
        expires_at__gt=now,
    ).count()
    return active_connections + pending_invitations


@transaction.atomic
def create_editor_invitation(author) -> EditorInvitation:
    locked_author = User.objects.select_for_update().get(pk=author.pk)
    if not has_author_workspace(locked_author):
        raise EditorFlowError("author_workspace_required", 403)
    if not runtime_setting("local_password_login_enabled") and not oidc_configured():
        raise EditorFlowError("editor_invitation_auth_unavailable", 409)
    used = editor_slot_usage(locked_author)
    limit = tier_quotas(locked_author.tier)["editor_invites"]
    if used >= limit:
        raise EditorFlowError(
            "quota_limit_reached",
            409,
            {
                "quotaKey": "editor_invites",
                "used": used,
                "limit": limit,
                "tier": locked_author.tier,
            },
        )
    return EditorInvitation.objects.create(
        author=locked_author,
        expires_at=timezone.now() + EDITOR_INVITATION_TTL,
    )


@transaction.atomic
def accept_editor_invitation(invitation: EditorInvitation, editor) -> tuple[EditorConnection, bool]:
    invitation = (
        EditorInvitation.objects.select_for_update()
        .select_related("author")
        .get(pk=invitation.pk)
    )
    validate_pending_invitation(invitation)
    if invitation.author_id == editor.id:
        raise EditorFlowError("editor_invitation_self_connection", 409)
    editor = User.objects.select_for_update().get(pk=editor.pk)
    editor_workspace_activated = not has_editor_workspace(editor)
    if editor_workspace_activated:
        editor.editor_workspace_enabled_at = timezone.now()
        editor.save(update_fields=["editor_workspace_enabled_at"])
    try:
        connection = EditorConnection.objects.create(
            author=invitation.author,
            editor=editor,
            invitation=invitation,
        )
    except IntegrityError as exc:
        raise EditorFlowError("editor_connection_already_exists", 409) from exc
    invitation.accepted_at = timezone.now()
    invitation.accepted_by = editor
    invitation.save(update_fields=["accepted_at", "accepted_by"])
    return connection, editor_workspace_activated


def invitation_payload(invitation: EditorInvitation) -> dict:
    return {
        "id": str(invitation.public_id),
        "shareUrl": invitation_share_url(invitation),
        "createdAt": invitation.created_at.isoformat(),
        "expiresAt": invitation.expires_at.isoformat(),
    }


def connection_person_payload(connection: EditorConnection, *, writer: bool) -> dict:
    person = connection.author if writer else connection.editor
    return {
        "id": connection.id,
        **identity_payload(person, include_avatar=not writer),
        "connectedAt": connection.connected_at.isoformat(),
    }


def editor_section_payload(user) -> dict:
    now = timezone.now()
    is_author = has_author_workspace(user)
    pending = []
    editors = []
    quota = None
    if is_author:
        pending = [
            invitation_payload(invitation)
            for invitation in EditorInvitation.objects.filter(
                author=user,
                revoked_at__isnull=True,
                accepted_at__isnull=True,
                expires_at__gt=now,
            )
        ]
        active_connections = EditorConnection.objects.select_related("editor").filter(
            author=user,
            disconnected_at__isnull=True,
        )
        editors = [
            connection_person_payload(connection, writer=False)
            for connection in active_connections
        ]
        limit = tier_quotas(user.tier)["editor_invites"]
        quota = {"used": len(pending) + len(editors), "limit": limit}
    writer_connections = EditorConnection.objects.select_related("author").filter(
        editor=user,
        disconnected_at__isnull=True,
    )
    return {
        "authorWorkspaceEnabled": is_author,
        "editorWorkspaceEnabled": has_editor_workspace(user),
        "quota": quota,
        "pendingInvitations": pending,
        "editors": editors,
        "writers": [
            connection_person_payload(connection, writer=True)
            for connection in writer_connections
        ],
    }
