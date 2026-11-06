from __future__ import annotations

import json

from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods

from apps.accounts.capabilities import has_editor_workspace
from apps.accounts.media import media_variant_bytes, media_variant_metadata
from apps.accounts.models import EditorConnection
from apps.audit.service import write_audit_event
from apps.notifications.service import create_notification
from config.media_responses import private_media_response

from .collaboration import publish_access_revoked
from .media_cache import cover_cache_version
from .models import Manuscript, ManuscriptEditorGrant
from .views import manuscript_lifecycle_status


def notify_editor_manuscript_access(
    grant: ManuscriptEditorGrant,
    *,
    granted: bool,
) -> None:
    connection = grant.editor_connection
    manuscript = grant.manuscript
    author = connection.author
    event = "granted" if granted else "revoked"
    create_notification(
        recipient=connection.editor,
        kind=f"service.editor_manuscript_access_{event}",
        payload={
            "manuscriptId": str(manuscript.public_id),
            "manuscriptTitle": manuscript.title,
            "authorName": author.display_name.strip() or author.get_username(),
            "actionPath": (
                f"/manuscripts/{manuscript.public_id}/editor?workspace=editor"
                if granted
                else "/manuscripts?workspace=editor"
            ),
        },
        deduplication_key=f"editor-manuscript-access:{grant.public_id}:{event}",
        email=True,
    )


def _editor_identity(connection: EditorConnection) -> dict:
    editor = connection.editor
    return {
        "connectionId": connection.id,
        "displayName": editor.display_name,
        "username": editor.get_username(),
        "avatarUrl": f"/api/auth/profile/avatar/{editor.id}/" if editor.avatar else "",
    }


def _grant_payload(grant: ManuscriptEditorGrant) -> dict:
    return {
        "id": str(grant.public_id),
        "editor": _editor_identity(grant.editor_connection),
        "grantedAt": grant.granted_at.isoformat(),
    }


def _grant_state(manuscript: Manuscript, author) -> dict:
    connections = list(
        EditorConnection.objects.select_related("editor")
        .filter(
            author=author,
            disconnected_at__isnull=True,
            editor__editor_workspace_enabled_at__isnull=False,
        )
        .order_by("-connected_at")
    )
    grants = list(
        ManuscriptEditorGrant.objects.select_related("editor_connection__editor")
        .filter(
            manuscript=manuscript,
            revoked_at__isnull=True,
            editor_connection__author=author,
            editor_connection__disconnected_at__isnull=True,
        )
        .order_by("-granted_at")
    )
    granted_connection_ids = {grant.editor_connection_id for grant in grants}
    return {
        "eligibleEditors": [
            _editor_identity(connection)
            for connection in connections
            if connection.id not in granted_connection_ids
        ],
        "grants": [_grant_payload(grant) for grant in grants],
    }


def _owned_manuscript(manuscript_id: int, author, *, lock: bool = False):
    queryset = Manuscript.objects.filter(
        id=manuscript_id,
        workspace__owner=author,
    ).select_related("workspace")
    if lock:
        queryset = queryset.select_for_update()
    return queryset.first()


@require_http_methods(["GET", "POST"])
def manuscript_editor_grants(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    if request.method == "GET":
        manuscript = _owned_manuscript(manuscript_id, request.user)
        if manuscript is None:
            return JsonResponse({"error": "manuscript_not_found"}, status=404)
        return JsonResponse(_grant_state(manuscript, request.user))

    try:
        payload = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "invalid_json"}, status=400)
    if not isinstance(payload, dict):
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        connection_id = int(payload.get("connectionId"))
    except (TypeError, ValueError):
        return JsonResponse({"error": "editor_connection_not_found"}, status=404)

    with transaction.atomic():
        manuscript = _owned_manuscript(manuscript_id, request.user, lock=True)
        if manuscript is None:
            return JsonResponse({"error": "manuscript_not_found"}, status=404)
        connection = (
            EditorConnection.objects.select_for_update()
            .select_related("editor")
            .filter(
                id=connection_id,
                author=request.user,
                disconnected_at__isnull=True,
                editor__editor_workspace_enabled_at__isnull=False,
            )
            .first()
        )
        if connection is None:
            return JsonResponse({"error": "editor_connection_not_found"}, status=404)
        if ManuscriptEditorGrant.objects.filter(
            manuscript=manuscript,
            editor_connection=connection,
            revoked_at__isnull=True,
        ).exists():
            return JsonResponse(
                {"error": "manuscript_editor_grant_already_exists"},
                status=409,
            )
        try:
            with transaction.atomic():
                grant = ManuscriptEditorGrant.objects.create(
                    manuscript=manuscript,
                    editor_connection=connection,
                )
        except IntegrityError:
            return JsonResponse(
                {"error": "manuscript_editor_grant_already_exists"},
                status=409,
            )
        write_audit_event(
            request,
            "manuscript.editor_access_granted",
            actor=request.user,
            subject=f"manuscript-editor-grant:{grant.public_id}",
            payload={
                "manuscriptId": str(manuscript.public_id),
                "connectionId": connection.id,
                "editorUserId": connection.editor_id,
            },
        )
        notify_editor_manuscript_access(grant, granted=True)
    return JsonResponse(_grant_state(manuscript, request.user), status=201)


@require_http_methods(["DELETE"])
def manuscript_editor_grant_detail(request, manuscript_id: int, grant_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    with transaction.atomic():
        manuscript = _owned_manuscript(manuscript_id, request.user, lock=True)
        if manuscript is None:
            return JsonResponse({"error": "manuscript_not_found"}, status=404)
        grant = (
            ManuscriptEditorGrant.objects.select_for_update()
            .select_related(
                "manuscript",
                "editor_connection__author",
                "editor_connection__editor",
            )
            .filter(
                public_id=grant_id,
                manuscript=manuscript,
                revoked_at__isnull=True,
            )
            .first()
        )
        if grant is None:
            return JsonResponse(
                {"error": "manuscript_editor_grant_not_found"},
                status=404,
            )
        grant.revoked_at = timezone.now()
        grant.save(update_fields=["revoked_at"])
        write_audit_event(
            request,
            "manuscript.editor_access_revoked",
            actor=request.user,
            subject=f"manuscript-editor-grant:{grant.public_id}",
            payload={
                "manuscriptId": str(manuscript.public_id),
                "connectionId": grant.editor_connection_id,
                "editorUserId": grant.editor_connection.editor_id,
            },
        )
        notify_editor_manuscript_access(grant, granted=False)
        publish_access_revoked(
            manuscript_id=manuscript.public_id,
            editor_id=grant.editor_connection.editor_id,
        )
    return JsonResponse(_grant_state(manuscript, request.user))


def _available_manuscript_payload(manuscript: Manuscript) -> dict:
    has_cover = bool(manuscript.cover_media_id)
    author = manuscript.workspace.owner
    return {
        "id": str(manuscript.public_id),
        "kind": manuscript.kind,
        "status": manuscript_lifecycle_status(manuscript),
        "title": manuscript.title,
        "synopsis": manuscript.synopsis,
        "coverThumbnailSmallUrl": (
            f"/api/editor/manuscripts/{manuscript.public_id}/cover/small/"
            if has_cover
            else ""
        ),
        "coverThumbnailMediumUrl": (
            f"/api/editor/manuscripts/{manuscript.public_id}/cover/medium/"
            if has_cover
            else ""
        ),
        "coverVersion": cover_cache_version(manuscript),
        "coverWidth": manuscript.cover_width,
        "coverHeight": manuscript.cover_height,
        "createdAt": manuscript.created_at.isoformat(),
        "updatedAt": manuscript.updated_at.isoformat(),
        "author": {
            "displayName": author.display_name,
            "username": author.get_username(),
            "avatarUrl": f"/api/auth/profile/avatar/{author.id}/" if author.avatar else "",
        },
    }


@require_GET
def available_manuscripts(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if not has_editor_workspace(request.user):
        return JsonResponse({"error": "editor_workspace_required"}, status=403)
    manuscripts = (
        Manuscript.objects.filter(
            editor_grants__editor_connection__editor=request.user,
            editor_grants__editor_connection__disconnected_at__isnull=True,
            editor_grants__revoked_at__isnull=True,
        )
        .select_related("workspace__owner")
        .distinct()
        .order_by("-updated_at")
    )
    return JsonResponse(
        {"items": [_available_manuscript_payload(manuscript) for manuscript in manuscripts]}
    )


@require_GET
def available_manuscript_cover(request, manuscript_id, variant: str):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if not has_editor_workspace(request.user):
        return JsonResponse({"error": "editor_workspace_required"}, status=403)
    manuscript = (
        Manuscript.objects.filter(
            public_id=manuscript_id,
            editor_grants__editor_connection__editor=request.user,
            editor_grants__editor_connection__disconnected_at__isnull=True,
            editor_grants__revoked_at__isnull=True,
        )
        .select_related("cover_media__owner")
        .first()
    )
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if not manuscript.cover_media_id:
        return JsonResponse({"error": "cover_not_found"}, status=404)
    if variant not in {"small", "medium"}:
        return JsonResponse({"error": "cover_variant_not_found"}, status=404)
    metadata = media_variant_metadata(manuscript.cover_media, variant)
    if metadata is None:
        return JsonResponse({"error": "cover_variant_not_found"}, status=404)
    return private_media_response(
        request,
        cache_key=(
            f"user-media:{manuscript.cover_media.public_id}:"
            f"{manuscript.cover_media.content_hash}:{metadata[1]}"
        ),
        load_content=lambda: media_variant_bytes(manuscript.cover_media, variant),
    )
