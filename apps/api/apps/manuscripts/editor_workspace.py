from __future__ import annotations

import json

from django.db import transaction
from django.http import HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods

from apps.accounts.capabilities import has_editor_workspace
from apps.accounts.media import media_variant_bytes, media_variant_metadata
from apps.audit.service import write_audit_event
from config.media_responses import private_media_response

from .annotations import (
    MESSAGE_MAX_LENGTH,
    QUOTE_MAX_LENGTH,
    _author_payload,
    _guest_author_payload,
)
from .book_views import tree_payload
from .collaboration import document_uses_collaboration
from .document_schema import (
    InvalidDocument,
    annotation_ids,
    illustration_asset_ids,
    remove_annotation_mark,
    validate_document_content,
)
from .models import (
    AnnotationReply,
    Document,
    DocumentAnnotation,
    DocumentVersion,
    EditorPreference,
    Manuscript,
    ManuscriptAsset,
)
from .versioning import mark_history_changed
from .versions import version_payload
from .views import (
    EDITOR_FONT_SIZES,
    document_payload,
    editor_preferences_payload,
    manuscript_payload,
)


def _private_no_store(response: HttpResponse) -> HttpResponse:
    response["Cache-Control"] = "private, no-store"
    return response


def _json(payload: dict, *, status: int = 200) -> JsonResponse:
    return _private_no_store(JsonResponse(payload, status=status))


def _read_json(request):
    try:
        value = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _editor_error(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if not has_editor_workspace(request.user):
        return JsonResponse({"error": "editor_workspace_required"}, status=403)
    return None


def resolve_editor_manuscript(request, manuscript_id):
    error = _editor_error(request)
    if error is not None:
        return None, error
    manuscript = (
        Manuscript.objects.filter(
            public_id=manuscript_id,
            editor_grants__editor_connection__editor=request.user,
            editor_grants__editor_connection__disconnected_at__isnull=True,
            editor_grants__revoked_at__isnull=True,
        )
        .select_related("workspace__owner", "cover_media__owner")
        .prefetch_related("documents")
        .distinct()
        .first()
    )
    if manuscript is None:
        return None, _json({"error": "manuscript_not_found"}, status=404)
    return manuscript, None


def _active_editor_documents(manuscript: Manuscript):
    query = Document.objects.filter(manuscript=manuscript)
    if manuscript.kind == Manuscript.KIND_BOOK:
        query = query.filter(item__trashed_at__isnull=True)
    return query


def _editor_document(manuscript: Manuscript, item_id=None, *, lock: bool = False):
    query = _active_editor_documents(manuscript)
    if item_id is None:
        query = query.filter(manuscript__kind=Manuscript.KIND_ONESHOT)
    else:
        query = query.filter(
            manuscript__kind=Manuscript.KIND_BOOK,
            item__public_id=item_id,
            item__trashed_at__isnull=True,
        )
    if lock:
        query = query.select_for_update(of=("self",))
    return query.select_related("manuscript__workspace", "item").first()


def _illustration_projection(value):
    result = []

    def visit(candidate):
        if isinstance(candidate, dict):
            if candidate.get("type") == "illustration":
                result.append(candidate)
                return
            for child in candidate.values():
                visit(child)
        elif isinstance(candidate, list):
            for child in candidate:
                visit(child)

    visit(value)
    return result


def _editor_author_payload(user) -> dict:
    return {
        "displayName": user.display_name,
        "username": user.get_username(),
        "avatarUrl": f"/api/auth/profile/avatar/{user.id}/" if user.avatar else "",
    }


@require_GET
def editor_manuscript_detail(request, manuscript_id):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    payload = manuscript_payload(manuscript)
    if payload["coverThumbnailSmallUrl"]:
        payload["coverThumbnailSmallUrl"] = (
            f"/api/editor/manuscripts/{manuscript.public_id}/cover/small/"
        )
        payload["coverThumbnailMediumUrl"] = (
            f"/api/editor/manuscripts/{manuscript.public_id}/cover/medium/"
        )
    payload["author"] = _editor_author_payload(manuscript.workspace.owner)
    return _json({"manuscript": payload})


@require_GET
def editor_manuscript_tree(request, manuscript_id):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    if manuscript.kind != Manuscript.KIND_BOOK:
        return _json({"error": "manuscript_not_found"}, status=404)
    payload = tree_payload(manuscript)
    payload["trash"] = []
    return _json({"tree": payload})


@require_http_methods(["GET", "PUT"])
def editor_document_content(request, manuscript_id, item_id=None):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    document = _editor_document(manuscript, item_id)
    if document is None:
        return _json({"error": "manuscript_not_found"}, status=404)
    if request.method == "GET":
        return _json({"document": document_payload(document)})

    payload = _read_json(request)
    if payload is None:
        return _json({"error": "invalid_json"}, status=400)
    expected_generation = payload.get("expectedGeneration")
    schema_version = payload.get("schemaVersion")
    if isinstance(expected_generation, bool) or not isinstance(expected_generation, int):
        return _json({"error": "save_generation_required"}, status=400)
    if expected_generation < 0:
        return _json({"error": "save_generation_invalid"}, status=400)
    if schema_version != Document.CURRENT_SCHEMA_VERSION:
        return _json({"error": "document_schema_unsupported"}, status=400)
    try:
        content = validate_document_content(payload.get("content"))
    except InvalidDocument as exc:
        return _json({"error": str(exc)}, status=400)
    asset_ids = illustration_asset_ids(content)
    if asset_ids and ManuscriptAsset.objects.filter(
        manuscript=manuscript, public_id__in=asset_ids
    ).count() != len(asset_ids):
        return _json({"error": "document_asset_not_found"}, status=400)
    content_annotation_ids = annotation_ids(content)

    with transaction.atomic():
        document = _editor_document(manuscript, item_id, lock=True)
        if document is None:
            return _json({"error": "manuscript_not_found"}, status=404)
        if document_uses_collaboration(document):
            return _json({"error": "collaboration_required"}, status=409)
        if content_annotation_ids and DocumentAnnotation.objects.filter(
            document=document, public_id__in=content_annotation_ids
        ).count() != len(content_annotation_ids):
            return _json({"error": "document_annotation_not_found"}, status=400)
        if document.save_generation != expected_generation:
            return _json(
                {
                    "error": "document_save_conflict",
                    "saveGeneration": document.save_generation,
                },
                status=409,
            )
        if _illustration_projection(document.content) != _illustration_projection(content):
            return _json({"error": "editor_illustration_mutation_forbidden"}, status=403)
        if document.content == content:
            return _json({"document": document_payload(document)})
        document.content = content
        document.save_generation += 1
        mark_history_changed(document)
        document.save(
            update_fields=[
                "content",
                "save_generation",
                "history_generation",
                "draft_due_at",
                "updated_at",
            ]
        )
        manuscript_updated_at = timezone.now()
        manuscript_updates = {"updated_at": manuscript_updated_at}
        if manuscript.first_edited_at is None:
            manuscript_updates["first_edited_at"] = manuscript_updated_at
        Manuscript.objects.filter(id=manuscript.id).update(**manuscript_updates)
    return _json({"document": document_payload(document)})


def _editor_annotation_payload(annotation: DocumentAnnotation, user, anchored=None) -> dict:
    if anchored is None:
        anchored = annotation_ids(annotation.document.content)
    replies = list(annotation.replies.all())
    own = annotation.author_id == user.id
    return {
        "id": str(annotation.public_id),
        "quote": annotation.quote,
        "comment": annotation.comment,
        "author": _guest_author_payload(annotation.guest_author)
        or _author_payload(annotation.author),
        "status": annotation.status,
        "detached": str(annotation.public_id) not in anchored,
        "version": annotation.version,
        "canEdit": own,
        "canDelete": own and not replies,
        "canResolve": True,
        "resolvedBy": _author_payload(annotation.resolved_by),
        "resolvedAt": annotation.resolved_at.isoformat() if annotation.resolved_at else None,
        "createdAt": annotation.created_at.isoformat(),
        "updatedAt": annotation.updated_at.isoformat(),
        "replies": [
            {
                "id": str(reply.public_id),
                "author": _guest_author_payload(reply.guest_author)
                or _author_payload(reply.author),
                "body": reply.body,
                "version": reply.version,
                "canEdit": reply.author_id == user.id,
                "canDelete": reply.author_id == user.id,
                "createdAt": reply.created_at.isoformat(),
                "updatedAt": reply.updated_at.isoformat(),
            }
            for reply in replies
        ],
    }


def _editor_annotation(manuscript, annotation_id, *, lock=False):
    query = DocumentAnnotation.objects.filter(
        public_id=annotation_id,
        document__in=_active_editor_documents(manuscript),
    )
    if lock:
        query = query.select_for_update(of=("self",))
    return (
        query.select_related("document__manuscript", "author", "guest_author", "resolved_by")
        .prefetch_related("replies__author", "replies__guest_author")
        .first()
    )


@require_http_methods(["GET", "POST"])
def editor_document_annotations(request, manuscript_id, item_id=None):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    document = _editor_document(manuscript, item_id)
    if document is None:
        return _json({"error": "manuscript_not_found"}, status=404)
    if request.method == "GET":
        anchored = annotation_ids(document.content)
        annotations = (
            DocumentAnnotation.objects.filter(document=document)
            .select_related("document", "author", "guest_author", "resolved_by")
            .prefetch_related("replies__author", "replies__guest_author")
        )
        return _json(
            {
                "items": [
                    _editor_annotation_payload(item, request.user, anchored)
                    for item in annotations
                ]
            }
        )
    payload = _read_json(request)
    if payload is None:
        return _json({"error": "invalid_json"}, status=400)
    quote = payload.get("quote")
    comment = payload.get("comment")
    if not isinstance(quote, str) or not quote.strip():
        return _json({"error": "annotation_quote_required"}, status=400)
    if len(quote) > QUOTE_MAX_LENGTH:
        return _json({"error": "annotation_quote_too_long"}, status=400)
    if not isinstance(comment, str) or not comment.strip():
        return _json({"error": "annotation_comment_required"}, status=400)
    if len(comment) > MESSAGE_MAX_LENGTH:
        return _json({"error": "annotation_comment_too_long"}, status=400)
    with transaction.atomic():
        document = Document.objects.select_for_update().get(id=document.id)
        annotation = DocumentAnnotation.objects.create(
            document=document,
            author=request.user,
            quote=quote.strip(),
            comment=comment.strip(),
        )
        mark_history_changed(document)
        document.save(update_fields=["history_generation", "draft_due_at"])
    write_audit_event(
        request,
        "manuscript.annotation_created",
        actor=request.user,
        subject=f"annotation:{annotation.public_id}",
        payload={"source": "registered_editor", "manuscriptId": str(manuscript.public_id)},
    )
    return _json(
        {"annotation": _editor_annotation_payload(annotation, request.user, set())},
        status=201,
    )


@require_http_methods(["PATCH", "DELETE"])
def editor_annotation_detail(request, manuscript_id, annotation_id):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    payload = _read_json(request)
    if payload is None:
        return _json({"error": "invalid_json"}, status=400)
    annotation = _editor_annotation(manuscript, annotation_id)
    if annotation is None:
        return _json({"error": "annotation_not_found"}, status=404)
    if request.method == "DELETE":
        expected_generation = payload.get("expectedGeneration")
        if annotation.author_id != request.user.id:
            return _json({"error": "annotation_delete_forbidden"}, status=403)
        if annotation.replies.exists():
            return _json({"error": "annotation_delete_has_replies"}, status=409)
        with transaction.atomic():
            document = Document.objects.select_for_update().get(id=annotation.document_id)
            annotation = _editor_annotation(manuscript, annotation_id, lock=True)
            if annotation is None:
                return _json({"error": "annotation_not_found"}, status=404)
            if annotation.replies.exists():
                return _json({"error": "annotation_delete_has_replies"}, status=409)
            collaborative = document_uses_collaboration(document)
            if not collaborative and (
                isinstance(expected_generation, bool)
                or not isinstance(expected_generation, int)
            ):
                return _json({"error": "save_generation_required"}, status=400)
            if not collaborative and document.save_generation != expected_generation:
                return _json(
                    {"error": "document_save_conflict", "saveGeneration": document.save_generation},
                    status=409,
                )
            if collaborative and str(annotation.public_id) in annotation_ids(document.content):
                return _json({"error": "collaboration_sync_pending"}, status=409)
            content = (
                document.content
                if collaborative
                else remove_annotation_mark(document.content, str(annotation.public_id))
            )
            changed = content != document.content
            if changed:
                document.content = content
                document.save_generation += 1
                Manuscript.objects.filter(id=manuscript.id).update(updated_at=timezone.now())
            annotation.delete()
            fields = []
            if not collaborative:
                mark_history_changed(document)
                fields.extend(["history_generation", "draft_due_at"])
            if changed:
                fields += ["content", "save_generation", "updated_at"]
            if fields:
                document.save(update_fields=fields)
        write_audit_event(
            request,
            "manuscript.annotation_deleted",
            actor=request.user,
            subject=f"annotation:{annotation_id}",
            payload={"source": "registered_editor", "manuscriptId": str(manuscript.public_id)},
        )
        return _json({"document": document_payload(document)})

    expected = payload.get("expectedVersion")
    if isinstance(expected, bool) or expected != annotation.version:
        return _json({"error": "annotation_update_conflict"}, status=409)
    fields = []
    changed_fields = []
    if "comment" in payload:
        if annotation.author_id != request.user.id:
            return _json({"error": "annotation_edit_forbidden"}, status=403)
        comment = payload["comment"]
        if not isinstance(comment, str) or not comment.strip():
            return _json({"error": "annotation_comment_required"}, status=400)
        if len(comment) > MESSAGE_MAX_LENGTH:
            return _json({"error": "annotation_comment_too_long"}, status=400)
        annotation.comment = comment.strip()
        fields.append("comment")
        changed_fields.append("comment")
    if "status" in payload:
        status = payload["status"]
        if status not in {DocumentAnnotation.STATUS_OPEN, DocumentAnnotation.STATUS_RESOLVED}:
            return _json({"error": "annotation_status_invalid"}, status=400)
        annotation.status = status
        annotation.resolved_by = (
            request.user if status == DocumentAnnotation.STATUS_RESOLVED else None
        )
        annotation.resolved_at = (
            timezone.now() if status == DocumentAnnotation.STATUS_RESOLVED else None
        )
        fields += ["status", "resolved_by", "resolved_at"]
        changed_fields.append("status")
    if not fields or not set(payload).issubset({"comment", "status", "expectedVersion"}):
        return _json({"error": "annotation_update_invalid"}, status=400)
    with transaction.atomic():
        document = Document.objects.select_for_update().get(id=annotation.document_id)
        annotation = _editor_annotation(manuscript, annotation_id, lock=True)
        if annotation is None:
            return _json({"error": "annotation_not_found"}, status=404)
        if annotation.version != expected:
            return _json({"error": "annotation_update_conflict"}, status=409)
        for field in fields:
            if field == "comment":
                annotation.comment = payload["comment"].strip()
            elif field == "status":
                annotation.status = payload["status"]
                annotation.resolved_by = (
                    request.user
                    if payload["status"] == DocumentAnnotation.STATUS_RESOLVED
                    else None
                )
                annotation.resolved_at = (
                    timezone.now()
                    if payload["status"] == DocumentAnnotation.STATUS_RESOLVED
                    else None
                )
        annotation.version += 1
        annotation.save(update_fields=[*fields, "version", "updated_at"])
        mark_history_changed(document)
        document.save(update_fields=["history_generation", "draft_due_at"])
    annotation = _editor_annotation(manuscript, annotation_id)
    write_audit_event(
        request,
        "manuscript.annotation_updated",
        actor=request.user,
        subject=f"annotation:{annotation.public_id}",
        payload={"source": "registered_editor", "changedFields": changed_fields},
    )
    return _json({"annotation": _editor_annotation_payload(annotation, request.user)})


@require_http_methods(["POST"])
def editor_annotation_replies(request, manuscript_id, annotation_id):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    annotation = _editor_annotation(manuscript, annotation_id)
    if annotation is None:
        return _json({"error": "annotation_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None or not isinstance(payload.get("body"), str) or not payload["body"].strip():
        return _json({"error": "annotation_reply_required"}, status=400)
    if len(payload["body"]) > MESSAGE_MAX_LENGTH:
        return _json({"error": "annotation_reply_too_long"}, status=400)
    with transaction.atomic():
        document = Document.objects.select_for_update().get(id=annotation.document_id)
        reply = AnnotationReply.objects.create(
            annotation=annotation, author=request.user, body=payload["body"].strip()
        )
        mark_history_changed(document)
        document.save(update_fields=["history_generation", "draft_due_at"])
    write_audit_event(
        request,
        "manuscript.annotation_reply_created",
        actor=request.user,
        subject=f"annotation-reply:{reply.public_id}",
        payload={"source": "registered_editor", "manuscriptId": str(manuscript.public_id)},
    )
    return _json(
        {
            "reply": {
                "id": str(reply.public_id),
                "author": _author_payload(request.user),
                "body": reply.body,
                "version": reply.version,
                "canEdit": True,
                "canDelete": True,
                "createdAt": reply.created_at.isoformat(),
                "updatedAt": reply.updated_at.isoformat(),
            }
        },
        status=201,
    )


@require_http_methods(["PATCH", "DELETE"])
def editor_annotation_reply_detail(request, manuscript_id, reply_id):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    query = AnnotationReply.objects.filter(
        public_id=reply_id,
        annotation__document__in=_active_editor_documents(manuscript),
    ).select_related("annotation__document", "author")
    reply = query.first()
    if reply is None:
        return _json({"error": "annotation_reply_not_found"}, status=404)
    if reply.author_id != request.user.id:
        return _json({"error": "annotation_reply_forbidden"}, status=403)
    if request.method == "DELETE":
        reply_public_id = str(reply.public_id)
        with transaction.atomic():
            document = Document.objects.select_for_update().get(id=reply.annotation.document_id)
            reply = query.select_for_update(of=("self",)).first()
            if reply is None:
                return _json({"error": "annotation_reply_not_found"}, status=404)
            reply.delete()
            mark_history_changed(document)
            document.save(update_fields=["history_generation", "draft_due_at"])
        write_audit_event(
            request,
            "manuscript.annotation_reply_deleted",
            actor=request.user,
            subject=f"annotation-reply:{reply_public_id}",
            payload={"source": "registered_editor", "manuscriptId": str(manuscript.public_id)},
        )
        return _json({"ok": True})
    payload = _read_json(request)
    if payload is None or set(payload) != {"body", "expectedVersion"}:
        return _json({"error": "annotation_reply_update_invalid"}, status=400)
    body = payload["body"]
    if not isinstance(body, str) or not body.strip():
        return _json({"error": "annotation_reply_required"}, status=400)
    if len(body) > MESSAGE_MAX_LENGTH:
        return _json({"error": "annotation_reply_too_long"}, status=400)
    with transaction.atomic():
        document = Document.objects.select_for_update().get(id=reply.annotation.document_id)
        reply = query.select_for_update(of=("self",)).first()
        if reply is None:
            return _json({"error": "annotation_reply_not_found"}, status=404)
        if (
            isinstance(payload["expectedVersion"], bool)
            or payload["expectedVersion"] != reply.version
        ):
            return _json({"error": "annotation_reply_update_conflict"}, status=409)
        reply.body = body.strip()
        reply.version += 1
        reply.save(update_fields=["body", "version", "updated_at"])
        mark_history_changed(document)
        document.save(update_fields=["history_generation", "draft_due_at"])
    write_audit_event(
        request,
        "manuscript.annotation_reply_updated",
        actor=request.user,
        subject=f"annotation-reply:{reply.public_id}",
        payload={"source": "registered_editor", "manuscriptId": str(manuscript.public_id)},
    )
    return _json(
        {
            "reply": {
                "id": str(reply.public_id),
                "author": _author_payload(request.user),
                "body": reply.body,
                "version": reply.version,
                "canEdit": True,
                "canDelete": True,
                "createdAt": reply.created_at.isoformat(),
                "updatedAt": reply.updated_at.isoformat(),
            }
        }
    )


@require_GET
def editor_document_drafts(request, manuscript_id, item_id=None):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    document = _editor_document(manuscript, item_id)
    if document is None:
        return _json({"error": "manuscript_not_found"}, status=404)
    versions = DocumentVersion.objects.filter(
        document=document, kind=DocumentVersion.KIND_DRAFT
    ).select_related("document")
    return _json({"items": [version_payload(version) for version in versions]})


@require_GET
def editor_draft_detail(request, manuscript_id, version_id):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    version = (
        DocumentVersion.objects.filter(
            public_id=version_id,
            kind=DocumentVersion.KIND_DRAFT,
            document__in=_active_editor_documents(manuscript),
        )
        .select_related("document")
        .first()
    )
    if version is None:
        return _json({"error": "version_not_found"}, status=404)
    snapshot = version.snapshot
    return _json(
        {
            "version": version_payload(version),
            "content": snapshot["content"],
            "annotations": snapshot.get("annotations", []),
            "currentContent": version.document.content,
        }
    )


@require_GET
def editor_asset_content(request, manuscript_id, asset_id, variant):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    if variant not in {"medium", "large"}:
        return _json({"error": "asset_variant_not_found"}, status=404)
    asset = (
        ManuscriptAsset.objects.filter(public_id=asset_id, manuscript=manuscript)
        .select_related("media__owner")
        .first()
    )
    if asset is None:
        return _json({"error": "asset_not_found"}, status=404)
    media_variant = "editor-medium" if variant == "medium" else variant
    metadata = media_variant_metadata(asset.media, media_variant)
    if metadata is None:
        return _json({"error": "asset_variant_not_found"}, status=404)
    return private_media_response(
        request,
        cache_key=f"user-media:{asset.media.public_id}:{asset.media.content_hash}:{metadata[1]}",
        load_content=lambda: media_variant_bytes(asset.media, media_variant),
    )


@require_http_methods(["GET", "PATCH"])
def editor_workspace_preferences(request):
    error = _editor_error(request)
    if error is not None:
        return error
    preferences = EditorPreference.objects.filter(user=request.user).first()
    if request.method == "GET":
        if preferences is None:
            preferences = EditorPreference(user=request.user)
        return _json({"preferences": editor_preferences_payload(preferences)})
    payload = _read_json(request)
    if payload is None:
        return _json({"error": "invalid_json"}, status=400)
    allowed = {
        "fontSize",
        "smartQuotes",
        "quoteStyle",
        "autoCapitalize",
        "autoReplace",
        "spellcheckEnabled",
        "spellcheckDictionary",
    }
    if not payload or not set(payload).issubset(allowed):
        return _json({"error": "editor_preferences_invalid"}, status=400)
    if "fontSize" in payload and payload["fontSize"] not in EDITOR_FONT_SIZES:
        return _json({"error": "editor_font_size_invalid"}, status=400)
    if "quoteStyle" in payload and payload["quoteStyle"] not in {
        EditorPreference.QUOTE_STYLE_GUILLEMETS,
        EditorPreference.QUOTE_STYLE_CURLY,
    }:
        return _json({"error": "editor_quote_style_invalid"}, status=400)
    for field in ("smartQuotes", "autoCapitalize", "autoReplace", "spellcheckEnabled"):
        if field in payload and not isinstance(payload[field], bool):
            return _json({"error": "editor_preferences_invalid"}, status=400)
    if "spellcheckDictionary" in payload and payload["spellcheckDictionary"] not in {
        choice[0] for choice in EditorPreference.SPELLCHECK_DICTIONARY_CHOICES
    }:
        return _json({"error": "editor_spellcheck_dictionary_invalid"}, status=400)
    if preferences is None:
        preferences = EditorPreference(user=request.user)
    mapping = {
        "fontSize": "font_size",
        "smartQuotes": "smart_quotes",
        "quoteStyle": "quote_style",
        "autoCapitalize": "auto_capitalize",
        "autoReplace": "auto_replace",
        "spellcheckEnabled": "spellcheck_enabled",
        "spellcheckDictionary": "spellcheck_dictionary",
    }
    fields = []
    for payload_name, model_name in mapping.items():
        if payload_name in payload:
            setattr(preferences, model_name, payload[payload_name])
            fields.append(model_name)
    if preferences.pk:
        preferences.save(update_fields=[*fields, "updated_at"])
    else:
        preferences.save()
    return _json({"preferences": editor_preferences_payload(preferences)})
