from __future__ import annotations

import json

from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from apps.audit.service import write_audit_event

from .collaboration import document_uses_collaboration
from .document_schema import annotation_ids, remove_annotation_mark
from .models import AnnotationReply, Document, DocumentAnnotation, Manuscript
from .versioning import mark_history_changed

QUOTE_MAX_LENGTH = 20_000
MESSAGE_MAX_LENGTH = 10_000


def _read_json(request):
    try:
        value = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _author_payload(user) -> dict | None:
    if user is None:
        return None
    return {
        "id": user.id,
        "kind": "user",
        "username": user.get_username(),
        "displayName": user.display_name,
        "avatarUrl": f"/api/auth/profile/avatar/{user.id}/" if user.avatar else "",
    }


def _guest_author_payload(participant) -> dict | None:
    if participant is None:
        return None
    return {
        "id": str(participant.public_id),
        "kind": "guest",
        "username": participant.display_name,
        "displayName": participant.display_name,
        "avatarUrl": "",
    }


def _reply_payload(reply: AnnotationReply, request_user) -> dict:
    return {
        "id": str(reply.public_id),
        "author": _guest_author_payload(reply.guest_author) or _author_payload(reply.author),
        "body": reply.body,
        "version": reply.version,
        "canEdit": reply.author_id == request_user.id,
        "canDelete": reply.author_id == request_user.id,
        "createdAt": reply.created_at.isoformat(),
        "updatedAt": reply.updated_at.isoformat(),
    }


def _annotation_payload(
    annotation: DocumentAnnotation,
    request_user,
    anchored_ids: set[str] | None = None,
) -> dict:
    if anchored_ids is None:
        anchored_ids = annotation_ids(annotation.document.content)
    return {
        "id": str(annotation.public_id),
        "quote": annotation.quote,
        "comment": annotation.comment,
        "author": (
            _guest_author_payload(annotation.guest_author) or _author_payload(annotation.author)
        ),
        "status": annotation.status,
        "detached": str(annotation.public_id) not in anchored_ids,
        "version": annotation.version,
        "canEdit": annotation.author_id == request_user.id,
        "canDelete": annotation.author_id == request_user.id,
        "canResolve": True,
        "resolvedBy": _author_payload(annotation.resolved_by),
        "resolvedAt": annotation.resolved_at.isoformat() if annotation.resolved_at else None,
        "createdAt": annotation.created_at.isoformat(),
        "updatedAt": annotation.updated_at.isoformat(),
        "replies": [_reply_payload(reply, request_user) for reply in annotation.replies.all()],
    }


def _document_for_owner(manuscript_id: int, user, item_id=None):
    query = Document.objects.filter(
        manuscript_id=manuscript_id,
        manuscript__workspace__owner=user,
    )
    if item_id is None:
        query = query.filter(manuscript__kind=Manuscript.KIND_ONESHOT)
    else:
        query = query.filter(
            manuscript__kind=Manuscript.KIND_BOOK,
            item__public_id=item_id,
            item__trashed_at__isnull=True,
        )
    return query.select_related("manuscript__workspace").first()


def _annotation_for_owner(annotation_id, user, *, for_update: bool = False):
    query = DocumentAnnotation.objects.filter(
        public_id=annotation_id,
        document__manuscript__workspace__owner=user,
    )
    if for_update:
        query = query.select_for_update(of=("self",))
    return (
        query.select_related(
            "document__manuscript__workspace",
            "author",
            "guest_author",
            "resolved_by",
        )
        .prefetch_related("replies__author", "replies__guest_author")
        .first()
    )


@require_http_methods(["GET", "POST"])
def document_annotations(request, manuscript_id: int, item_id=None):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    document = _document_for_owner(manuscript_id, request.user, item_id)
    if document is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    if request.method == "GET":
        anchored_ids = annotation_ids(document.content)
        annotations = (
            DocumentAnnotation.objects.filter(document=document)
            .select_related(
                "document__manuscript__workspace",
                "author",
                "guest_author",
                "resolved_by",
            )
            .prefetch_related("replies__author", "replies__guest_author")
        )
        return JsonResponse(
            {
                "items": [
                    _annotation_payload(item, request.user, anchored_ids) for item in annotations
                ]
            }
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
    with transaction.atomic():
        document = (
            Document.objects.select_for_update()
            .select_related("manuscript__workspace")
            .get(id=document.id)
        )
        annotation = DocumentAnnotation(document=document, author=request.user)
        annotation.quote = quote.strip()
        annotation.comment = comment.strip()
        annotation.save()
        mark_history_changed(document)
        document.save(update_fields=["history_generation", "draft_due_at"])
    write_audit_event(
        request,
        "manuscript.annotation_created",
        actor=request.user,
        subject=f"annotation:{annotation.public_id}",
        payload={
            "source": "editor",
            "manuscriptId": str(document.manuscript.public_id),
            "documentId": str(document.public_id),
        },
    )
    return JsonResponse(
        {"annotation": _annotation_payload(annotation, request.user, set())},
        status=201,
    )


@require_http_methods(["PATCH", "DELETE"])
def annotation_detail(request, annotation_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    if request.method == "DELETE":
        expected_generation = payload.get("expectedGeneration")
        with transaction.atomic():
            candidate = (
                DocumentAnnotation.objects.filter(
                    public_id=annotation_id,
                    document__manuscript__workspace__owner=request.user,
                )
                .values(
                    "document_id",
                    "document__public_id",
                    "document__manuscript__public_id",
                )
                .first()
            )
            if candidate is None:
                return JsonResponse({"error": "annotation_not_found"}, status=404)
            document = Document.objects.select_for_update().get(id=candidate["document_id"])
            annotation = (
                DocumentAnnotation.objects.select_for_update()
                .filter(
                    public_id=annotation_id,
                    document_id=document.id,
                )
                .first()
            )
            if annotation is None:
                return JsonResponse({"error": "annotation_not_found"}, status=404)
            if annotation.author_id != request.user.id:
                return JsonResponse({"error": "annotation_delete_forbidden"}, status=403)
            collaborative = document_uses_collaboration(document)
            if not collaborative and (
                isinstance(expected_generation, bool)
                or not isinstance(expected_generation, int)
            ):
                return JsonResponse({"error": "save_generation_required"}, status=400)
            if not collaborative and document.save_generation != expected_generation:
                return JsonResponse(
                    {
                        "error": "document_save_conflict",
                        "saveGeneration": document.save_generation,
                    },
                    status=409,
                )
            if collaborative and str(annotation.public_id) in annotation_ids(document.content):
                return JsonResponse({"error": "collaboration_sync_pending"}, status=409)
            content = (
                document.content
                if collaborative
                else remove_annotation_mark(document.content, str(annotation.public_id))
            )
            content_changed = content != document.content
            if content_changed:
                document.content = content
                document.save_generation += 1
                Manuscript.objects.filter(id=document.manuscript_id).update(
                    updated_at=timezone.now()
                )
            annotation.delete()
            update_fields = []
            if not collaborative:
                mark_history_changed(document)
                update_fields.extend(["history_generation", "draft_due_at"])
            if content_changed:
                update_fields.extend(["content", "save_generation", "updated_at"])
            if update_fields:
                document.save(update_fields=update_fields)
        write_audit_event(
            request,
            "manuscript.annotation_deleted",
            actor=request.user,
            subject=f"annotation:{annotation_id}",
            payload={
                "source": "editor",
                "manuscriptId": str(candidate["document__manuscript__public_id"]),
                "documentId": str(candidate["document__public_id"]),
            },
        )
        return JsonResponse(
            {
                "document": {
                    "content": document.content,
                    "schemaVersion": document.schema_version,
                    "saveGeneration": document.save_generation,
                    "updatedAt": document.updated_at.isoformat(),
                }
            }
        )

    candidate = (
        DocumentAnnotation.objects.filter(
            public_id=annotation_id,
            document__manuscript__workspace__owner=request.user,
        )
        .values("document_id")
        .first()
    )
    if candidate is None:
        return JsonResponse({"error": "annotation_not_found"}, status=404)
    changed_fields = []
    with transaction.atomic():
        document = Document.objects.select_for_update().get(id=candidate["document_id"])
        annotation = _annotation_for_owner(annotation_id, request.user, for_update=True)
        if annotation is None:
            return JsonResponse({"error": "annotation_not_found"}, status=404)
        expected_version = payload.get("expectedVersion")
        if isinstance(expected_version, bool) or expected_version != annotation.version:
            return JsonResponse({"error": "annotation_update_conflict"}, status=409)
        update_fields = []
        if "comment" in payload:
            if annotation.author_id != request.user.id:
                return JsonResponse({"error": "annotation_edit_forbidden"}, status=403)
            comment = payload["comment"]
            if not isinstance(comment, str) or not comment.strip():
                return JsonResponse({"error": "annotation_comment_required"}, status=400)
            if len(comment) > MESSAGE_MAX_LENGTH:
                return JsonResponse({"error": "annotation_comment_too_long"}, status=400)
            annotation.comment = comment.strip()
            update_fields.append("comment")
            changed_fields.append("comment")
        if "status" in payload:
            status = payload["status"]
            if status not in {
                DocumentAnnotation.STATUS_OPEN,
                DocumentAnnotation.STATUS_RESOLVED,
            }:
                return JsonResponse({"error": "annotation_status_invalid"}, status=400)
            annotation.status = status
            annotation.resolved_by = (
                request.user if status == DocumentAnnotation.STATUS_RESOLVED else None
            )
            annotation.resolved_at = (
                timezone.now() if status == DocumentAnnotation.STATUS_RESOLVED else None
            )
            update_fields.extend(["status", "resolved_by", "resolved_at"])
            changed_fields.append("status")
        allowed_fields = {"comment", "status", "expectedVersion"}
        if not update_fields or not set(payload).issubset(allowed_fields):
            return JsonResponse({"error": "annotation_update_invalid"}, status=400)
        annotation.version += 1
        annotation.save(update_fields=[*update_fields, "version", "updated_at"])
        mark_history_changed(document)
        document.save(update_fields=["history_generation", "draft_due_at"])
    annotation = _annotation_for_owner(annotation_id, request.user)
    write_audit_event(
        request,
        "manuscript.annotation_updated",
        actor=request.user,
        subject=f"annotation:{annotation.public_id}",
        payload={
            "source": "editor",
            "manuscriptId": str(annotation.document.manuscript.public_id),
            "documentId": str(annotation.document.public_id),
            "changedFields": changed_fields,
        },
    )
    return JsonResponse({"annotation": _annotation_payload(annotation, request.user)})


@require_http_methods(["POST"])
def annotation_replies(request, annotation_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    annotation = _annotation_for_owner(annotation_id, request.user)
    if annotation is None:
        return JsonResponse({"error": "annotation_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None or not isinstance(payload.get("body"), str) or not payload["body"].strip():
        return JsonResponse({"error": "annotation_reply_required"}, status=400)
    if len(payload["body"]) > MESSAGE_MAX_LENGTH:
        return JsonResponse({"error": "annotation_reply_too_long"}, status=400)
    with transaction.atomic():
        document = Document.objects.select_for_update().get(id=annotation.document_id)
        reply = AnnotationReply(annotation=annotation, author=request.user)
        reply.body = payload["body"].strip()
        reply.save()
        mark_history_changed(document)
        document.save(update_fields=["history_generation", "draft_due_at"])
    write_audit_event(
        request,
        "manuscript.annotation_reply_created",
        actor=request.user,
        subject=f"annotation-reply:{reply.public_id}",
        payload={
            "source": "editor",
            "manuscriptId": str(document.manuscript.public_id),
            "documentId": str(document.public_id),
            "annotationId": str(annotation.public_id),
        },
    )
    return JsonResponse({"reply": _reply_payload(reply, request.user)}, status=201)


@require_http_methods(["PATCH", "DELETE"])
def annotation_reply_detail(request, reply_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    reply_query = AnnotationReply.objects.filter(
        public_id=reply_id,
        annotation__document__manuscript__workspace__owner=request.user,
    )
    reply = reply_query.select_related(
        "annotation__document__manuscript__workspace",
        "author",
    ).first()
    if reply is None:
        return JsonResponse({"error": "annotation_reply_not_found"}, status=404)
    if reply.author_id != request.user.id:
        return JsonResponse({"error": "annotation_reply_forbidden"}, status=403)
    if request.method == "DELETE":
        reply_public_id = str(reply.public_id)
        manuscript_public_id = str(reply.annotation.document.manuscript.public_id)
        document_public_id = str(reply.annotation.document.public_id)
        with transaction.atomic():
            document = Document.objects.select_for_update().get(id=reply.annotation.document_id)
            reply = reply_query.select_for_update().get(id=reply.id)
            reply.delete()
            mark_history_changed(document)
            document.save(update_fields=["history_generation", "draft_due_at"])
        write_audit_event(
            request,
            "manuscript.annotation_reply_deleted",
            actor=request.user,
            subject=f"annotation-reply:{reply_public_id}",
            payload={
                "source": "editor",
                "manuscriptId": manuscript_public_id,
                "documentId": document_public_id,
            },
        )
        return JsonResponse({"ok": True})
    payload = _read_json(request)
    if payload is None or set(payload) != {"body", "expectedVersion"}:
        return JsonResponse({"error": "annotation_reply_update_invalid"}, status=400)
    with transaction.atomic():
        document_id = reply.annotation.document_id
        document = Document.objects.select_for_update().get(id=document_id)
        reply = (
            reply_query.select_for_update(of=("self",))
            .select_related(
                "annotation__document__manuscript__workspace",
                "author",
            )
            .first()
        )
        if reply is None:
            return JsonResponse({"error": "annotation_reply_not_found"}, status=404)
        expected_version = payload["expectedVersion"]
        if isinstance(expected_version, bool) or expected_version != reply.version:
            return JsonResponse({"error": "annotation_reply_update_conflict"}, status=409)
        body = payload["body"]
        if not isinstance(body, str) or not body.strip():
            return JsonResponse({"error": "annotation_reply_required"}, status=400)
        if len(body) > MESSAGE_MAX_LENGTH:
            return JsonResponse({"error": "annotation_reply_too_long"}, status=400)
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
        payload={
            "source": "editor",
            "manuscriptId": str(document.manuscript.public_id),
            "documentId": str(document.public_id),
            "changedFields": ["body"],
        },
    )
    return JsonResponse({"reply": _reply_payload(reply, request.user)})
