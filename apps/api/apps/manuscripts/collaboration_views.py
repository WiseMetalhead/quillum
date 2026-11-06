from __future__ import annotations

import base64
import json
import secrets
from uuid import UUID

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .collaboration import (
    CollaborationError,
    commit_collaboration_update,
    consume_collaboration_ticket,
    document_uses_collaboration,
    ensure_collaboration_state,
    initialize_collaboration_document,
    issue_collaboration_ticket,
    load_collaboration_document,
    mark_collaboration_failed,
    replace_collaboration_document,
)
from .editor_workspace import _editor_document, resolve_editor_manuscript
from .models import Document, DocumentCollaborationUpdate, Manuscript
from .views import document_payload


def _json_body(request) -> dict | None:
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _error(exc: CollaborationError) -> JsonResponse:
    return JsonResponse({"error": exc.code}, status=exc.status)


def _owner_document(request, manuscript_id, item_id=None):
    if not request.user.is_authenticated:
        return None, JsonResponse({"error": "authentication_required"}, status=401)
    query = Document.objects.filter(
        manuscript__id=manuscript_id,
        manuscript__workspace__owner=request.user,
    ).select_related("manuscript__workspace", "item")
    if item_id is None:
        query = query.filter(manuscript__kind=Manuscript.KIND_ONESHOT)
    else:
        query = query.filter(
            manuscript__kind=Manuscript.KIND_BOOK,
            item__public_id=item_id,
            item__trashed_at__isnull=True,
        )
    document = query.first()
    if document is None:
        return None, JsonResponse({"error": "manuscript_not_found"}, status=404)
    return document, None


@require_POST
def owner_collaboration_ticket(request, manuscript_id, item_id=None):
    document, error = _owner_document(request, manuscript_id, item_id)
    if error is not None:
        return error
    payload = _json_body(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        ticket = issue_collaboration_ticket(
            document=document,
            user=request.user,
            role=DocumentCollaborationUpdate.ROLE_OWNER,
            timezone_name=payload.get("timezone") or "UTC",
        )
    except CollaborationError as exc:
        return _error(exc)
    response = JsonResponse({"collaboration": ticket})
    response["Cache-Control"] = "private, no-store"
    return response


@require_POST
def editor_collaboration_ticket(request, manuscript_id, item_id=None):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    document = _editor_document(manuscript, item_id)
    if document is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    payload = _json_body(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        ticket = issue_collaboration_ticket(
            document=document,
            user=request.user,
            role=DocumentCollaborationUpdate.ROLE_EDITOR,
            timezone_name=payload.get("timezone") or "UTC",
        )
    except CollaborationError as exc:
        return _error(exc)
    response = JsonResponse({"collaboration": ticket})
    response["Cache-Control"] = "private, no-store"
    return response


def _flush_response(document):
    if not document_uses_collaboration(document):
        return JsonResponse({"error": "collaboration_unavailable"}, status=409)
    try:
        state = ensure_collaboration_state(document)
    except CollaborationError as exc:
        return _error(exc)
    if state.latest_sequence != state.materialized_sequence:
        return JsonResponse({"error": "collaboration_sync_pending"}, status=409)
    document.refresh_from_db()
    response = JsonResponse({"document": document_payload(document)})
    response["Cache-Control"] = "private, no-store"
    return response


@require_POST
def owner_collaboration_flush(request, manuscript_id, item_id=None):
    document, error = _owner_document(request, manuscript_id, item_id)
    if error is not None:
        return error
    return _flush_response(document)


@require_POST
def owner_collaboration_replace(request, manuscript_id, item_id=None):
    document, error = _owner_document(request, manuscript_id, item_id)
    if error is not None:
        return error
    payload = _json_body(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    expected_generation = payload.get("expectedGeneration")
    if isinstance(expected_generation, bool) or not isinstance(expected_generation, int):
        return JsonResponse({"error": "save_generation_required"}, status=400)
    if payload.get("schemaVersion") != Document.CURRENT_SCHEMA_VERSION:
        return JsonResponse({"error": "document_schema_unsupported"}, status=400)
    try:
        replaced = replace_collaboration_document(
            document=document,
            content=payload.get("content"),
            expected_generation=expected_generation,
            actor=request.user,
        )
    except CollaborationError as exc:
        return _error(exc)
    return JsonResponse({"document": document_payload(replaced)})


@require_POST
def editor_collaboration_flush(request, manuscript_id, item_id=None):
    manuscript, error = resolve_editor_manuscript(request, manuscript_id)
    if error is not None:
        return error
    document = _editor_document(manuscript, item_id)
    if document is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    return _flush_response(document)


def _internal_authorized(request) -> bool:
    supplied = request.headers.get("X-Quillum-Collaboration-Secret", "")
    configured = settings.QUILLUM_COLLABORATION_INTERNAL_SECRET
    return bool(configured and secrets.compare_digest(supplied, configured))


def _internal_payload(request):
    if not _internal_authorized(request):
        return None, JsonResponse({"error": "not_found"}, status=404)
    payload = _json_body(request)
    if payload is None:
        return None, JsonResponse({"error": "invalid_json"}, status=400)
    return payload, None


@csrf_exempt
@require_POST
def internal_collaboration_ticket_consume(request):
    payload, error = _internal_payload(request)
    if error is not None:
        return error
    try:
        context = consume_collaboration_ticket(payload.get("ticket"), payload.get("room"))
    except CollaborationError as exc:
        return _error(exc)
    response = JsonResponse({"context": context})
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_POST
def internal_collaboration_load(request):
    payload, error = _internal_payload(request)
    if error is not None:
        return error
    try:
        result = load_collaboration_document(payload.get("documentId"), int(payload.get("epoch")))
    except (TypeError, ValueError):
        return JsonResponse({"error": "collaboration_load_invalid"}, status=400)
    except CollaborationError as exc:
        return _error(exc)
    response = JsonResponse({"collaboration": result})
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_POST
def internal_collaboration_initialize(request):
    payload, error = _internal_payload(request)
    if error is not None:
        return error
    try:
        snapshot = initialize_collaboration_document(payload)
    except CollaborationError as exc:
        return _error(exc)
    response = JsonResponse(
        {"collaboration": {"snapshot": base64.b64encode(snapshot).decode("ascii")}}
    )
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_POST
def internal_collaboration_commit(request):
    payload, error = _internal_payload(request)
    if error is not None:
        return error
    try:
        result = commit_collaboration_update(payload)
    except CollaborationError as exc:
        return _error(exc)
    response = JsonResponse(
        {
            "commit": {
                "sequence": result.sequence,
                "saveGeneration": result.save_generation,
                "historyGeneration": result.history_generation,
                "materializedAt": result.materialized_at,
            }
        }
    )
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_POST
def internal_collaboration_fail(request):
    payload, error = _internal_payload(request)
    if error is not None:
        return error
    try:
        document_id = UUID(str(payload.get("documentId")))
        epoch = int(payload.get("epoch"))
    except (AttributeError, TypeError, ValueError):
        return JsonResponse({"error": "collaboration_failure_invalid"}, status=400)
    code = payload.get("code")
    if not isinstance(code, str) or not code:
        return JsonResponse({"error": "collaboration_failure_invalid"}, status=400)
    mark_collaboration_failed(document_id, epoch, code)
    response = JsonResponse({"reported": True})
    response["Cache-Control"] = "no-store"
    return response
