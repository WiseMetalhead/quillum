from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime
from io import BytesIO

from django.contrib.auth.hashers import check_password, make_password
from django.core import signing
from django.db import transaction
from django.http import FileResponse, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods

from apps.accounts.media import media_variant_bytes
from apps.audit.service import write_audit_event

from .annotations import MESSAGE_MAX_LENGTH, QUOTE_MAX_LENGTH, _read_json
from .document_schema import (
    InvalidDocument,
    annotation_ids,
    illustration_asset_ids,
    remove_annotation_mark,
    validate_document_content,
    without_annotation_marks,
)
from .models import (
    AnnotationReply,
    Document,
    DocumentAnnotation,
    Manuscript,
    ManuscriptAsset,
    ManuscriptItem,
    ManuscriptShareLink,
    ShareParticipant,
)
from .versioning import mark_history_changed

SHARE_TOKEN_BYTES = 32
PARTICIPANT_TOKEN_BYTES = 32
UNLOCK_COOKIE_AGE = 60 * 60 * 24 * 30
PUBLIC_REVIEW_CACHE_CONTROL = "private, no-store"


def _review_document_payload(document: Document) -> dict:
    return {
        "id": str(document.public_id),
        "content": document.content,
        "schemaVersion": document.schema_version,
        "saveGeneration": document.save_generation,
        "updatedAt": document.updated_at.isoformat(),
    }


def _private_no_store(response: HttpResponse) -> HttpResponse:
    response["Cache-Control"] = PUBLIC_REVIEW_CACHE_CONTROL
    return response


def _hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(SHARE_TOKEN_BYTES)


def _cookie_name(prefix: str, share: ManuscriptShareLink) -> str:
    return f"quillum_{prefix}_{share.public_id.hex}"


def _is_active(share: ManuscriptShareLink) -> bool:
    return share.revoked_at is None and (
        share.expires_at is None or share.expires_at > timezone.now()
    )


def _share_payload(share: ManuscriptShareLink, raw_token: str | None = None) -> dict:
    url_token = raw_token if raw_token is not None else share.token
    payload = {
        "id": str(share.public_id),
        "accessLevel": share.access_level,
        "scopeType": share.scope_type,
        "authorDisplay": share.author_display,
        "itemId": str(share.item.public_id) if share.item_id else None,
        "itemTitle": share.item.title if share.item_id else "",
        "hasPassword": bool(share.password_hash),
        "expiresAt": share.expires_at.isoformat() if share.expires_at else None,
        "revokedAt": share.revoked_at.isoformat() if share.revoked_at else None,
        "createdAt": share.created_at.isoformat(),
        "lastUsedAt": share.last_used_at.isoformat() if share.last_used_at else None,
    }
    if url_token is not None:
        payload["urlToken"] = url_token
    return payload


def _find_share(raw_token: str) -> ManuscriptShareLink | None:
    return (
        ManuscriptShareLink.objects.filter(token_hash=_hash_token(raw_token))
        .select_related("manuscript__workspace", "created_by", "item")
        .first()
    )


def _is_unlocked(request, share: ManuscriptShareLink) -> bool:
    if not share.password_hash:
        return True
    value = request.COOKIES.get(_cookie_name("review_unlock", share))
    if not value:
        return False
    try:
        signed = signing.loads(value, salt="quillum.review.unlock", max_age=UNLOCK_COOKIE_AGE)
    except signing.BadSignature:
        return False
    return signed == str(share.public_id)


def _set_unlocked_cookie(response: JsonResponse, share: ManuscriptShareLink) -> None:
    value = signing.dumps(str(share.public_id), salt="quillum.review.unlock")
    response.set_cookie(
        _cookie_name("review_unlock", share),
        value,
        max_age=UNLOCK_COOKIE_AGE,
        httponly=True,
        samesite="Lax",
    )


def _participant_from_cookie(request, share: ManuscriptShareLink) -> ShareParticipant | None:
    raw_token = request.COOKIES.get(_cookie_name("review_participant", share))
    if not raw_token:
        return None
    return ShareParticipant.objects.filter(
        share_link=share,
        session_token_hash=_hash_token(raw_token),
    ).first()


def _set_participant_cookie(
    response: JsonResponse,
    share: ManuscriptShareLink,
    raw_token: str,
) -> None:
    response.set_cookie(
        _cookie_name("review_participant", share),
        raw_token,
        max_age=UNLOCK_COOKIE_AGE,
        httponly=True,
        samesite="Lax",
    )


def _participant_payload(participant: ShareParticipant | None) -> dict | None:
    if participant is None:
        return None
    return {
        "id": str(participant.public_id),
        "displayName": participant.display_name,
    }


def _guest_author_payload(participant: ShareParticipant | None) -> dict | None:
    if participant is None:
        return None
    return {
        "id": str(participant.public_id),
        "kind": "guest",
        "username": participant.display_name,
        "displayName": participant.display_name,
        "avatarUrl": "",
    }


def _registered_author_payload(user) -> dict | None:
    if user is None:
        return None
    return {
        "id": user.id,
        "kind": "user",
        "username": user.get_username(),
        "displayName": user.display_name,
        "avatarUrl": f"/api/auth/profile/avatar/{user.id}/" if user.avatar else "",
    }


def _reply_payload(reply: AnnotationReply, participant: ShareParticipant | None) -> dict:
    own = participant is not None and reply.guest_author_id == participant.id
    return {
        "id": str(reply.public_id),
        "author": (
            _guest_author_payload(reply.guest_author) or _registered_author_payload(reply.author)
        ),
        "body": reply.body,
        "version": reply.version,
        "canEdit": own,
        "canDelete": own,
        "createdAt": reply.created_at.isoformat(),
        "updatedAt": reply.updated_at.isoformat(),
    }


def _annotation_payload(
    annotation: DocumentAnnotation,
    participant: ShareParticipant | None,
) -> dict:
    own = participant is not None and annotation.guest_author_id == participant.id
    return {
        "id": str(annotation.public_id),
        "documentId": str(annotation.document.public_id),
        "quote": annotation.quote,
        "comment": annotation.comment,
        "author": (
            _guest_author_payload(annotation.guest_author)
            or _registered_author_payload(annotation.author)
        ),
        "status": annotation.status,
        "detached": str(annotation.public_id) not in annotation_ids(annotation.document.content),
        "version": annotation.version,
        "canEdit": own,
        "canDelete": own,
        "canResolve": False,
        "resolvedBy": _registered_author_payload(annotation.resolved_by),
        "resolvedAt": annotation.resolved_at.isoformat() if annotation.resolved_at else None,
        "createdAt": annotation.created_at.isoformat(),
        "updatedAt": annotation.updated_at.isoformat(),
        "replies": [_reply_payload(reply, participant) for reply in annotation.replies.all()],
    }


def _folder_documents(root: ManuscriptItem) -> list[Document]:
    items = list(
        ManuscriptItem.objects.filter(manuscript_id=root.manuscript_id, trashed_at__isnull=True)
        .select_related("manuscript__workspace")
        .order_by("position", "created_at")
    )
    by_parent: dict[int | None, list[ManuscriptItem]] = {}
    for item in items:
        by_parent.setdefault(item.parent_id, []).append(item)
    ordered_item_ids: list[int] = []

    def visit(parent_id: int) -> None:
        for child in by_parent.get(parent_id, []):
            if child.kind == ManuscriptItem.KIND_DOCUMENT:
                ordered_item_ids.append(child.id)
            elif child.kind == ManuscriptItem.KIND_FOLDER:
                visit(child.id)

    visit(root.id)
    documents = list(
        Document.objects.filter(item_id__in=ordered_item_ids).select_related(
            "manuscript__workspace", "item"
        )
    )
    by_item = {document.item_id: document for document in documents}
    return [by_item[item_id] for item_id in ordered_item_ids if item_id in by_item]


def _scope_documents(share: ManuscriptShareLink) -> list[Document]:
    if share.scope_type == ManuscriptShareLink.SCOPE_ONESHOT:
        return list(
            Document.objects.filter(
                manuscript=share.manuscript,
                manuscript__kind=Manuscript.KIND_ONESHOT,
            ).select_related("manuscript__workspace", "item")
        )
    if share.item is None or share.item.trashed_at is not None:
        return []
    if share.scope_type == ManuscriptShareLink.SCOPE_DOCUMENT:
        if share.item.kind != ManuscriptItem.KIND_DOCUMENT:
            return []
        document = (
            Document.objects.filter(item=share.item)
            .select_related("manuscript__workspace", "item")
            .first()
        )
        return [document] if document is not None else []
    if share.scope_type == ManuscriptShareLink.SCOPE_FOLDER:
        if share.item.kind != ManuscriptItem.KIND_FOLDER:
            return []
        return _folder_documents(share.item)
    return []


def _share_title(share: ManuscriptShareLink) -> str:
    if share.scope_type == ManuscriptShareLink.SCOPE_ONESHOT:
        return share.manuscript.title
    if share.item_id:
        return share.item.title
    return share.manuscript.title


def _share_author_name(share: ManuscriptShareLink) -> str:
    if share.author_display == ManuscriptShareLink.AUTHOR_DISPLAY_PEN_NAME:
        return (
            share.created_by.author_name
            or share.created_by.display_name
            or share.created_by.get_username()
        )
    return share.created_by.display_name or share.created_by.get_username()


def _document_in_scope(share: ManuscriptShareLink, document_id: int) -> Document | None:
    for document in _scope_documents(share):
        if document.id == document_id:
            return document
    return None


def _asset_in_scope(share: ManuscriptShareLink, asset_id) -> ManuscriptAsset | None:
    documents = _scope_documents(share)
    for document in documents:
        if str(asset_id) in illustration_asset_ids(document.content):
            return (
                ManuscriptAsset.objects.filter(
                    public_id=asset_id,
                    manuscript=share.manuscript,
                )
                .select_related("manuscript__workspace", "media")
                .first()
            )
    return None


def _parse_expires_at(value) -> datetime | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError("share_expiration_invalid")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    if parsed <= timezone.now():
        raise ValueError("share_expiration_invalid")
    return parsed


@require_http_methods(["GET", "POST"])
def manuscript_review_shares(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = (
        Manuscript.objects.filter(id=manuscript_id, workspace__owner=request.user)
        .select_related("workspace")
        .first()
    )
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    if request.method == "GET":
        shares = (
            ManuscriptShareLink.objects.filter(manuscript=manuscript)
            .select_related("item")
            .order_by("-created_at")
        )
        return JsonResponse({"items": [_share_payload(share) for share in shares]})

    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    access_level = payload.get("accessLevel")
    if access_level not in {ManuscriptShareLink.ACCESS_VIEW, ManuscriptShareLink.ACCESS_COMMENT}:
        return JsonResponse({"error": "share_access_invalid"}, status=400)
    author_display = payload.get("authorDisplay", ManuscriptShareLink.AUTHOR_DISPLAY_ACCOUNT)
    if author_display not in {
        ManuscriptShareLink.AUTHOR_DISPLAY_ACCOUNT,
        ManuscriptShareLink.AUTHOR_DISPLAY_PEN_NAME,
    }:
        return JsonResponse({"error": "share_author_display_invalid"}, status=400)
    scope_type = payload.get("scopeType")
    if manuscript.kind == Manuscript.KIND_ONESHOT:
        scope_type = ManuscriptShareLink.SCOPE_ONESHOT
        item = None
    elif scope_type in {ManuscriptShareLink.SCOPE_DOCUMENT, ManuscriptShareLink.SCOPE_FOLDER}:
        try:
            item_id = uuid.UUID(str(payload.get("itemId")))
        except (TypeError, ValueError, AttributeError):
            return JsonResponse({"error": "share_item_required"}, status=400)
        item = ManuscriptItem.objects.filter(
            manuscript=manuscript,
            public_id=item_id,
            trashed_at__isnull=True,
        ).first()
        if item is None:
            return JsonResponse({"error": "share_item_not_found"}, status=404)
        if (
            scope_type == ManuscriptShareLink.SCOPE_DOCUMENT
            and item.kind != ManuscriptItem.KIND_DOCUMENT
        ):
            return JsonResponse({"error": "share_scope_invalid"}, status=400)
        if (
            scope_type == ManuscriptShareLink.SCOPE_FOLDER
            and item.kind != ManuscriptItem.KIND_FOLDER
        ):
            return JsonResponse({"error": "share_scope_invalid"}, status=400)
    else:
        return JsonResponse({"error": "share_scope_invalid"}, status=400)
    password = str(payload.get("password") or "")
    if len(password) > 256:
        return JsonResponse({"error": "share_password_too_long"}, status=400)
    try:
        expires_at = _parse_expires_at(payload.get("expiresAt"))
    except (TypeError, ValueError):
        return JsonResponse({"error": "share_expiration_invalid"}, status=400)

    raw_token = _new_token()
    share = ManuscriptShareLink.objects.create(
        manuscript=manuscript,
        created_by=request.user,
        item=item,
        token_hash=_hash_token(raw_token),
        access_level=access_level,
        scope_type=scope_type,
        author_display=author_display,
        password_hash=make_password(password) if password else "",
        expires_at=expires_at,
    )
    share.token = raw_token
    share.save(update_fields=["token"])
    write_audit_event(
        request,
        "manuscript.review_share_created",
        actor=request.user,
        subject=f"review-share:{share.public_id}",
        payload={
            "manuscriptId": str(manuscript.public_id),
            "accessLevel": share.access_level,
            "scopeType": share.scope_type,
            "itemId": str(item.public_id) if item is not None else None,
            "hasPassword": bool(share.password_hash),
        },
    )
    return JsonResponse({"share": _share_payload(share, raw_token)}, status=201)


@require_http_methods(["DELETE"])
def review_share_detail(request, share_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    share = (
        ManuscriptShareLink.objects.filter(
            public_id=share_id,
            manuscript__workspace__owner=request.user,
        )
        .select_related("item")
        .first()
    )
    if share is None:
        return JsonResponse({"error": "share_not_found"}, status=404)
    if share.revoked_at is None:
        share.revoked_at = timezone.now()
        share.save(update_fields=["revoked_at", "updated_at"])
        write_audit_event(
            request,
            "manuscript.review_share_revoked",
            actor=request.user,
            subject=f"review-share:{share.public_id}",
            payload={
                "manuscriptId": str(share.manuscript.public_id),
                "accessLevel": share.access_level,
                "scopeType": share.scope_type,
            },
        )
    return JsonResponse({"share": _share_payload(share)})


@require_GET
def public_review_detail(request, token: str):
    share = _find_share(token)
    if share is None or not _is_active(share):
        return _private_no_store(
            JsonResponse({"error": "review_share_not_found"}, status=404)
        )
    if not _is_unlocked(request, share):
        return _private_no_store(JsonResponse({"locked": True, "hasPassword": True}))

    documents = _scope_documents(share)
    participant = _participant_from_cookie(request, share)
    annotations = []
    if participant is not None:
        annotations = list(
            DocumentAnnotation.objects.filter(
                document__in=documents,
                guest_author=participant,
            )
            .select_related(
                "document__manuscript__workspace",
                "guest_author",
                "author",
                "resolved_by",
            )
            .prefetch_related("replies__guest_author", "replies__author")
        )
    ManuscriptShareLink.objects.filter(id=share.id).update(last_used_at=timezone.now())
    return _private_no_store(
        JsonResponse(
            {
                "locked": False,
                "share": {
                    "id": str(share.public_id),
                    "title": _share_title(share),
                    "manuscriptTitle": share.manuscript.title,
                    "accessLevel": share.access_level,
                    "scopeType": share.scope_type,
                    "authorName": _share_author_name(share),
                },
                "participant": _participant_payload(participant),
                "documents": [
                    {
                        **_review_document_payload(document),
                        "title": (
                            document.item.title
                            if document.item_id
                            else share.manuscript.title
                        ),
                    }
                    for document in documents
                ],
                "annotations": [
                    _annotation_payload(annotation, participant) for annotation in annotations
                ],
            }
        )
    )


@require_GET
def public_review_asset(request, token: str, asset_id, variant: str):
    share = _find_share(token)
    if share is None or not _is_active(share):
        return _private_no_store(
            JsonResponse({"error": "review_share_not_found"}, status=404)
        )
    if not _is_unlocked(request, share):
        return _private_no_store(
            JsonResponse({"error": "review_password_required"}, status=403)
        )
    asset = _asset_in_scope(share, asset_id)
    if asset is None:
        return _private_no_store(JsonResponse({"error": "asset_not_found"}, status=404))
    media_variant = "editor-medium" if variant == "medium" else variant
    value = media_variant_bytes(asset.media, media_variant)
    if value is None:
        return _private_no_store(
            JsonResponse({"error": "asset_variant_not_found"}, status=404)
        )
    plaintext, content_type = value
    response = FileResponse(BytesIO(plaintext), content_type=content_type)
    response["X-Robots-Tag"] = "noindex, nofollow, noimageindex"
    return _private_no_store(response)


@require_http_methods(["POST"])
def public_review_unlock(request, token: str):
    share = _find_share(token)
    if share is None or not _is_active(share):
        return JsonResponse({"error": "review_share_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None or not isinstance(payload.get("password"), str):
        return JsonResponse({"error": "review_password_required"}, status=400)
    if not share.password_hash or not check_password(payload["password"], share.password_hash):
        return JsonResponse({"error": "review_password_invalid"}, status=403)
    response = JsonResponse({"ok": True})
    _set_unlocked_cookie(response, share)
    return response


@require_http_methods(["POST"])
def public_review_participant(request, token: str):
    share = _find_share(token)
    if share is None or not _is_active(share):
        return JsonResponse({"error": "review_share_not_found"}, status=404)
    if not _is_unlocked(request, share):
        return JsonResponse({"error": "review_password_required"}, status=403)
    if share.access_level != ManuscriptShareLink.ACCESS_COMMENT:
        return JsonResponse({"error": "review_comments_disabled"}, status=403)
    payload = _read_json(request)
    display_name = str(payload.get("displayName") if payload else "").strip()
    if not display_name:
        return JsonResponse({"error": "review_display_name_required"}, status=400)
    if len(display_name) > 80:
        return JsonResponse({"error": "review_display_name_too_long"}, status=400)
    raw_token = secrets.token_urlsafe(PARTICIPANT_TOKEN_BYTES)
    participant = ShareParticipant.objects.create(
        share_link=share,
        display_name=display_name,
        session_token_hash=_hash_token(raw_token),
    )
    response = JsonResponse({"participant": _participant_payload(participant)}, status=201)
    _set_participant_cookie(response, share, raw_token)
    return response


@require_http_methods(["GET", "POST"])
def public_review_annotations(request, token: str, document_id: int):
    share = _find_share(token)
    if share is None or not _is_active(share):
        return JsonResponse({"error": "review_share_not_found"}, status=404)
    if not _is_unlocked(request, share):
        return JsonResponse({"error": "review_password_required"}, status=403)
    if share.access_level != ManuscriptShareLink.ACCESS_COMMENT:
        return JsonResponse({"error": "review_comments_disabled"}, status=403)
    participant = _participant_from_cookie(request, share)
    if participant is None:
        return JsonResponse({"error": "review_participant_required"}, status=403)
    document = _document_in_scope(share, document_id)
    if document is None:
        return JsonResponse({"error": "review_document_not_found"}, status=404)

    if request.method == "GET":
        annotations = (
            DocumentAnnotation.objects.filter(document=document, guest_author=participant)
            .select_related(
                "document__manuscript__workspace",
                "guest_author",
                "author",
                "resolved_by",
            )
            .prefetch_related("replies__guest_author", "replies__author")
        )
        return JsonResponse(
            {"items": [_annotation_payload(item, participant) for item in annotations]}
        )

    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    quote = payload.get("quote")
    comment = payload.get("comment")
    if not isinstance(quote, str) or not quote.strip():
        return JsonResponse({"error": "annotation_quote_required"}, status=400)
    if len(quote) > QUOTE_MAX_LENGTH:
        return JsonResponse({"error": "annotation_quote_too_long"}, status=400)
    if not isinstance(comment, str) or not comment.strip():
        return JsonResponse({"error": "annotation_comment_required"}, status=400)
    if len(comment) > MESSAGE_MAX_LENGTH:
        return JsonResponse({"error": "annotation_comment_too_long"}, status=400)
    annotation = DocumentAnnotation(document=document, guest_author=participant)
    annotation.quote = quote.strip()
    annotation.comment = comment.strip()
    annotation.save()
    mark_history_changed(document)
    document.save(update_fields=["history_generation", "draft_due_at"])
    annotation = (
        DocumentAnnotation.objects.filter(id=annotation.id)
        .select_related("document__manuscript__workspace", "guest_author", "author", "resolved_by")
        .prefetch_related("replies__guest_author", "replies__author")
        .get()
    )
    write_audit_event(
        request,
        "manuscript.annotation_created",
        subject=f"annotation:{annotation.public_id}",
        payload={
            "source": "public_review",
            "manuscriptId": str(share.manuscript.public_id),
            "documentId": str(document.public_id),
            "shareId": str(share.public_id),
            "participantId": str(participant.public_id),
        },
    )
    from apps.notifications.user_rules import notify_public_review_comment

    notify_public_review_comment(annotation=annotation)
    return JsonResponse({"annotation": _annotation_payload(annotation, participant)}, status=201)


@require_http_methods(["PUT"])
def public_review_document_anchors(request, token: str, document_id: int):
    share = _find_share(token)
    if share is None or not _is_active(share):
        return JsonResponse({"error": "review_share_not_found"}, status=404)
    if not _is_unlocked(request, share):
        return JsonResponse({"error": "review_password_required"}, status=403)
    if share.access_level != ManuscriptShareLink.ACCESS_COMMENT:
        return JsonResponse({"error": "review_comments_disabled"}, status=403)
    participant = _participant_from_cookie(request, share)
    if participant is None:
        return JsonResponse({"error": "review_participant_required"}, status=403)
    document = _document_in_scope(share, document_id)
    if document is None:
        return JsonResponse({"error": "review_document_not_found"}, status=404)
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "invalid_json"}, status=400)
    expected_generation = payload.get("expectedGeneration")
    if isinstance(expected_generation, bool) or not isinstance(expected_generation, int):
        return JsonResponse({"error": "save_generation_required"}, status=400)
    if payload.get("schemaVersion") != Document.CURRENT_SCHEMA_VERSION:
        return JsonResponse({"error": "document_schema_unsupported"}, status=400)
    try:
        content = validate_document_content(payload.get("content"))
    except InvalidDocument as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    with transaction.atomic():
        locked_document = (
            Document.objects.select_for_update()
            .select_related("manuscript__workspace")
            .get(id=document.id)
        )
        if locked_document.save_generation != expected_generation:
            return JsonResponse(
                {
                    "error": "document_save_conflict",
                    "saveGeneration": locked_document.save_generation,
                },
                status=409,
            )
        if without_annotation_marks(locked_document.content) != without_annotation_marks(content):
            return JsonResponse({"error": "review_document_text_changed"}, status=400)
        new_annotation_ids = annotation_ids(content) - annotation_ids(locked_document.content)
        if new_annotation_ids and DocumentAnnotation.objects.filter(
            document=locked_document,
            guest_author=participant,
            public_id__in=new_annotation_ids,
        ).count() != len(new_annotation_ids):
            return JsonResponse({"error": "document_annotation_not_found"}, status=400)
        if locked_document.content != content:
            locked_document.content = content
            locked_document.save_generation += 1
            mark_history_changed(locked_document)
            locked_document.save(
                update_fields=[
                    "content",
                    "save_generation",
                    "history_generation",
                    "draft_due_at",
                    "updated_at",
                ]
            )
            Manuscript.objects.filter(id=locked_document.manuscript_id).update(
                updated_at=timezone.now()
            )
            from .collaboration import document_uses_collaboration, reset_collaboration_epoch

            if document_uses_collaboration(locked_document):
                reset_collaboration_epoch(locked_document)
    return JsonResponse({"document": _review_document_payload(locked_document)})


@require_http_methods(["POST"])
def public_review_replies(request, token: str, annotation_id):
    share = _find_share(token)
    if share is None or not _is_active(share):
        return JsonResponse({"error": "review_share_not_found"}, status=404)
    if not _is_unlocked(request, share):
        return JsonResponse({"error": "review_password_required"}, status=403)
    if share.access_level != ManuscriptShareLink.ACCESS_COMMENT:
        return JsonResponse({"error": "review_comments_disabled"}, status=403)
    participant = _participant_from_cookie(request, share)
    if participant is None:
        return JsonResponse({"error": "review_participant_required"}, status=403)
    annotation = (
        DocumentAnnotation.objects.filter(
            public_id=annotation_id,
            guest_author=participant,
            document__in=_scope_documents(share),
        )
        .select_related("document__manuscript__workspace")
        .first()
    )
    if annotation is None:
        return JsonResponse({"error": "annotation_not_found"}, status=404)
    payload = _read_json(request)
    body = payload.get("body") if payload else None
    if not isinstance(body, str) or not body.strip():
        return JsonResponse({"error": "annotation_reply_required"}, status=400)
    if len(body) > MESSAGE_MAX_LENGTH:
        return JsonResponse({"error": "annotation_reply_too_long"}, status=400)
    reply = AnnotationReply(annotation=annotation, guest_author=participant)
    reply.body = body.strip()
    reply.save()
    mark_history_changed(annotation.document)
    annotation.document.save(update_fields=["history_generation", "draft_due_at"])
    reply = AnnotationReply.objects.select_related("guest_author", "author").get(id=reply.id)
    write_audit_event(
        request,
        "manuscript.annotation_reply_created",
        subject=f"annotation-reply:{reply.public_id}",
        payload={
            "source": "public_review",
            "manuscriptId": str(share.manuscript.public_id),
            "documentId": str(annotation.document.public_id),
            "annotationId": str(annotation.public_id),
            "shareId": str(share.public_id),
            "participantId": str(participant.public_id),
        },
    )
    from apps.notifications.user_rules import notify_public_review_comment

    notify_public_review_comment(annotation=annotation, reply=reply)
    return JsonResponse({"reply": _reply_payload(reply, participant)}, status=201)


@require_http_methods(["DELETE"])
def public_review_annotation_detail(request, token: str, annotation_id):
    share = _find_share(token)
    if share is None or not _is_active(share):
        return JsonResponse({"error": "review_share_not_found"}, status=404)
    if not _is_unlocked(request, share):
        return JsonResponse({"error": "review_password_required"}, status=403)
    participant = _participant_from_cookie(request, share)
    if participant is None:
        return JsonResponse({"error": "review_participant_required"}, status=403)
    annotation = (
        DocumentAnnotation.objects.filter(
            public_id=annotation_id,
            guest_author=participant,
            document__in=_scope_documents(share),
        )
        .select_related("document__manuscript__workspace")
        .first()
    )
    if annotation is None:
        return JsonResponse({"error": "annotation_not_found"}, status=404)
    annotation_public_id = str(annotation.public_id)
    manuscript_public_id = str(share.manuscript.public_id)
    document_public_id = str(annotation.document.public_id)
    with transaction.atomic():
        document = Document.objects.select_for_update().get(id=annotation.document_id)
        content = remove_annotation_mark(document.content, str(annotation.public_id))
        content_changed = content != document.content
        annotation.delete()
        mark_history_changed(document)
        update_fields = ["history_generation", "draft_due_at"]
        if content_changed:
            document.content = content
            document.save_generation += 1
            update_fields.extend(["content", "save_generation", "updated_at"])
            Manuscript.objects.filter(id=document.manuscript_id).update(updated_at=timezone.now())
            from .collaboration import document_uses_collaboration, reset_collaboration_epoch

            if document_uses_collaboration(document):
                reset_collaboration_epoch(document)
        document.save(update_fields=update_fields)
    write_audit_event(
        request,
        "manuscript.annotation_deleted",
        subject=f"annotation:{annotation_public_id}",
        payload={
            "source": "public_review",
            "manuscriptId": manuscript_public_id,
            "documentId": document_public_id,
            "shareId": str(share.public_id),
            "participantId": str(participant.public_id),
        },
    )
    return JsonResponse({"document": _review_document_payload(document)})
