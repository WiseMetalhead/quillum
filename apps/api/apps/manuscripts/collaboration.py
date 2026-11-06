from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from redis import Redis

from apps.accounts.models import User
from apps.accounts.tier_progression import record_tier_activity

from .document_schema import (
    InvalidDocument,
    annotation_ids,
    illustration_asset_ids,
    validate_document_content,
)
from .models import (
    Document,
    DocumentAnnotation,
    DocumentCollaborationState,
    DocumentCollaborationUpdate,
    Manuscript,
    ManuscriptAsset,
    ManuscriptEditorGrant,
)
from .planner import local_date, record_words_written
from .versioning import document_statistics, mark_history_changed

logger = logging.getLogger(__name__)

CONTROL_CHANNEL = "quillum:collaboration:control:v1"
TICKET_PREFIX = "quillum:collaboration:ticket:v1:"
MAX_YDOC_STATE_BYTES = 20 * 1024 * 1024
MAX_YDOC_UPDATE_BYTES = 2 * 1024 * 1024


class CollaborationError(ValueError):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class CollaborationCommitResult:
    sequence: int
    save_generation: int
    history_generation: int
    materialized_at: str


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


def collaboration_mode() -> str:
    return settings.QUILLUM_COLLABORATION_MODE


def _existing_state(document: Document) -> DocumentCollaborationState | None:
    try:
        return document.collaboration_state
    except DocumentCollaborationState.DoesNotExist:
        return None


def document_uses_collaboration(document: Document) -> bool:
    mode = collaboration_mode()
    if mode == "disabled":
        return False
    state = _existing_state(document)
    if mode == "pilot":
        return bool(state and state.status == DocumentCollaborationState.STATUS_ACTIVE)
    return not state or state.status == DocumentCollaborationState.STATUS_ACTIVE


def ensure_collaboration_state(document: Document) -> DocumentCollaborationState:
    if collaboration_mode() == "disabled":
        raise CollaborationError("collaboration_unavailable", 503)
    state, _created = DocumentCollaborationState.objects.get_or_create(
        document=document,
        defaults={
            "status": DocumentCollaborationState.STATUS_ACTIVE,
            "schema_version": document.schema_version,
        },
    )
    if state.status != DocumentCollaborationState.STATUS_ACTIVE:
        raise CollaborationError("collaboration_unavailable", 503)
    if state.diagnostic_status != DocumentCollaborationState.DIAGNOSTIC_READY:
        raise CollaborationError("collaboration_materialization_failed", 503)
    return state


def collaboration_metadata(document: Document) -> dict:
    state = _existing_state(document)
    collaborative = document_uses_collaboration(document)
    epoch = state.epoch if state else 1
    return {
        "syncMode": "collaborative" if collaborative else "legacy",
        "collaborationEpoch": epoch if collaborative else None,
        "collaborationRoom": (
            collaboration_room(document.public_id, epoch) if collaborative else None
        ),
        "collaborationMaterialization": (
            state.diagnostic_status if state else "ready"
        ),
    }


def collaboration_room(document_id, epoch: int) -> str:
    return f"document:{document_id}:{epoch}"


def _ticket_key(ticket: str) -> str:
    digest = hashlib.sha256(ticket.encode("utf-8")).hexdigest()
    return f"{TICKET_PREFIX}{digest}"


def _websocket_url() -> str:
    origin = urlsplit(settings.QUILLUM_PUBLIC_ORIGIN)
    scheme = "wss" if origin.scheme == "https" else "ws"
    return urlunsplit((scheme, origin.netloc, settings.QUILLUM_COLLABORATION_PUBLIC_PATH, "", ""))


def _presence_color(user_id: int) -> str:
    palette = ("#2563eb", "#7c3aed", "#db2777", "#dc2626", "#d97706", "#059669", "#0891b2")
    return palette[user_id % len(palette)]


def issue_collaboration_ticket(
    *,
    document: Document,
    user,
    role: str,
    timezone_name: str,
) -> dict:
    if not document_uses_collaboration(document):
        raise CollaborationError("collaboration_unavailable", 409)
    try:
        local_date(timezone_name)
    except ValueError as exc:
        raise CollaborationError(str(exc), 400) from exc
    with transaction.atomic():
        locked_document = Document.objects.select_for_update().get(id=document.id)
        state = ensure_collaboration_state(locked_document)
        room = collaboration_room(locked_document.public_id, state.epoch)
        ticket = secrets.token_urlsafe(32)
        identity_name = user.display_name.strip() or user.get_username()
        payload = {
            "documentId": str(locked_document.public_id),
            "manuscriptId": str(locked_document.manuscript.public_id),
            "epoch": state.epoch,
            "room": room,
            "userId": user.id,
            "role": role,
            "timezone": timezone_name,
            "identity": {
                "id": str(user.id),
                "name": identity_name,
                "color": _presence_color(user.id),
            },
        }
        cache.set(
            _ticket_key(ticket),
            payload,
            timeout=settings.QUILLUM_COLLABORATION_TICKET_TTL_SECONDS,
        )
    return {
        "ticket": ticket,
        "room": room,
        "epoch": state.epoch,
        "url": _websocket_url(),
        "user": payload["identity"],
        "expiresIn": settings.QUILLUM_COLLABORATION_TICKET_TTL_SECONDS,
    }


def consume_collaboration_ticket(ticket: str, room: str) -> dict:
    if not isinstance(ticket, str) or not ticket:
        raise CollaborationError("collaboration_ticket_invalid", 403)
    key = _ticket_key(ticket)
    consumed_key = f"{key}:consumed"
    if not cache.add(
        consumed_key,
        True,
        timeout=settings.QUILLUM_COLLABORATION_TICKET_TTL_SECONDS,
    ):
        raise CollaborationError("collaboration_ticket_invalid", 403)
    payload = cache.get(key)
    cache.delete(key)
    if not isinstance(payload, dict) or payload.get("room") != room:
        raise CollaborationError("collaboration_ticket_invalid", 403)
    document = Document.objects.filter(public_id=payload.get("documentId")).first()
    if document is None:
        raise CollaborationError("collaboration_access_revoked", 404)
    _verify_actor(document, payload.get("userId"), payload.get("role"))
    state = ensure_collaboration_state(document)
    if state.epoch != payload.get("epoch"):
        raise CollaborationError("collaboration_epoch_stale", 409)
    return payload


def _verify_actor(document: Document, actor_id: int, role: str) -> User:
    actor = User.objects.filter(id=actor_id, is_active=True).first()
    if actor is None:
        raise CollaborationError("collaboration_access_revoked", 404)
    if role == DocumentCollaborationUpdate.ROLE_OWNER:
        if document.manuscript.workspace.owner_id != actor.id:
            raise CollaborationError("collaboration_access_revoked", 404)
        return actor
    if role == DocumentCollaborationUpdate.ROLE_EDITOR:
        allowed = ManuscriptEditorGrant.objects.filter(
            manuscript_id=document.manuscript_id,
            editor_connection__editor_id=actor.id,
            editor_connection__disconnected_at__isnull=True,
            revoked_at__isnull=True,
        ).exists()
        if not allowed:
            raise CollaborationError("collaboration_access_revoked", 404)
        return actor
    raise CollaborationError("collaboration_access_revoked", 404)


def _decode_binary(value: object, *, maximum: int, error: str) -> bytes:
    if not isinstance(value, str):
        raise CollaborationError(error, 400)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise CollaborationError(error, 400) from exc
    if not decoded or len(decoded) > maximum:
        raise CollaborationError(error, 400)
    return decoded


def load_collaboration_document(document_id, epoch: int) -> dict:
    document = (
        Document.objects.filter(public_id=document_id)
        .select_related("manuscript__workspace")
        .first()
    )
    if document is None:
        raise CollaborationError("collaboration_document_not_found", 404)
    state = ensure_collaboration_state(document)
    if state.epoch != epoch:
        raise CollaborationError("collaboration_epoch_stale", 409)
    updates = state.updates.filter(
        epoch=state.epoch,
        sequence__gt=state.snapshot_sequence,
    ).order_by("sequence")
    return {
        "documentId": str(document.public_id),
        "epoch": state.epoch,
        "schemaVersion": document.schema_version,
        "content": document.content,
        "snapshot": (
            base64.b64encode(bytes(state.ydoc_state)).decode("ascii")
            if state.ydoc_state
            else None
        ),
        "snapshotSequence": state.snapshot_sequence,
        "latestSequence": state.latest_sequence,
        "updates": [
            {
                "sequence": item.sequence,
                "data": base64.b64encode(bytes(item.update_data)).decode("ascii"),
            }
            for item in updates
        ],
    }


def initialize_collaboration_document(payload: dict) -> bytes:
    try:
        document_id = UUID(str(payload.get("documentId")))
        epoch = int(payload.get("epoch"))
    except (TypeError, ValueError, AttributeError) as exc:
        raise CollaborationError("collaboration_initialize_invalid", 400) from exc
    proposed_state = _decode_binary(
        payload.get("state"),
        maximum=MAX_YDOC_STATE_BYTES,
        error="collaboration_state_invalid",
    )
    with transaction.atomic():
        document = (
            Document.objects.select_for_update()
            .filter(public_id=document_id)
            .first()
        )
        if document is None:
            raise CollaborationError("collaboration_document_not_found", 404)
        state = (
            DocumentCollaborationState.objects.select_for_update()
            .filter(document=document)
            .first()
        )
        if state is None or state.status != DocumentCollaborationState.STATUS_ACTIVE:
            raise CollaborationError("collaboration_unavailable", 503)
        if state.epoch != epoch:
            raise CollaborationError("collaboration_epoch_stale", 409)
        if state.diagnostic_status != DocumentCollaborationState.DIAGNOSTIC_READY:
            raise CollaborationError("collaboration_materialization_failed", 503)
        if state.ydoc_state:
            return bytes(state.ydoc_state)
        state.ydoc_state = proposed_state
        state.snapshot_sequence = state.latest_sequence
        state.materialized_sequence = state.latest_sequence
        state.schema_version = document.schema_version
        state.materialized_at = state.materialized_at or timezone.now()
        state.save(
            update_fields=[
                "ydoc_state",
                "snapshot_sequence",
                "materialized_sequence",
                "schema_version",
                "materialized_at",
                "updated_at",
            ]
        )
        return bytes(state.ydoc_state)


def commit_collaboration_update(payload: dict) -> CollaborationCommitResult:
    try:
        document_id = UUID(str(payload.get("documentId")))
        update_id = UUID(str(payload.get("updateId")))
        epoch = int(payload.get("epoch"))
        actor_id = int(payload.get("actorId"))
    except (TypeError, ValueError, AttributeError) as exc:
        raise CollaborationError("collaboration_commit_invalid", 400) from exc
    role = payload.get("role")
    timezone_name = payload.get("timezone") or "UTC"
    update_data = _decode_binary(
        payload.get("update"),
        maximum=MAX_YDOC_UPDATE_BYTES,
        error="collaboration_update_invalid",
    )
    ydoc_state = _decode_binary(
        payload.get("state"),
        maximum=MAX_YDOC_STATE_BYTES,
        error="collaboration_state_invalid",
    )
    try:
        content = validate_document_content(payload.get("content"))
    except InvalidDocument as exc:
        raise CollaborationError(str(exc), 400) from exc

    with transaction.atomic():
        document = (
            Document.objects.select_for_update()
            .select_related("manuscript__workspace")
            .filter(public_id=document_id)
            .first()
        )
        if document is None:
            raise CollaborationError("collaboration_document_not_found", 404)
        state = (
            DocumentCollaborationState.objects.select_for_update()
            .filter(document=document)
            .first()
        )
        if state is None or state.status != DocumentCollaborationState.STATUS_ACTIVE:
            raise CollaborationError("collaboration_unavailable", 503)
        if state.epoch != epoch:
            raise CollaborationError("collaboration_epoch_stale", 409)
        actor = _verify_actor(document, actor_id, role)
        existing = DocumentCollaborationUpdate.objects.filter(update_id=update_id).first()
        if existing is not None:
            if existing.state_id != state.id or existing.epoch != state.epoch:
                raise CollaborationError("collaboration_update_invalid", 409)
            return CollaborationCommitResult(
                sequence=existing.sequence,
                save_generation=document.save_generation,
                history_generation=document.history_generation,
                materialized_at=(state.materialized_at or state.updated_at).isoformat(),
            )
        asset_ids = illustration_asset_ids(content)
        if asset_ids and ManuscriptAsset.objects.filter(
            manuscript_id=document.manuscript_id,
            public_id__in=asset_ids,
        ).count() != len(asset_ids):
            raise CollaborationError("document_asset_not_found", 400)
        content_annotation_ids = annotation_ids(content)
        if content_annotation_ids and DocumentAnnotation.objects.filter(
            document=document,
            public_id__in=content_annotation_ids,
        ).count() != len(content_annotation_ids):
            raise CollaborationError("document_annotation_not_found", 400)
        if (
            role == DocumentCollaborationUpdate.ROLE_EDITOR
            and _illustration_projection(document.content) != _illustration_projection(content)
        ):
            raise CollaborationError("editor_illustration_mutation_forbidden", 403)

        previous_word_count = document_statistics(document.content)[0]
        next_word_count = document_statistics(content)[0]
        positive_word_delta = max(0, next_word_count - previous_word_count)
        sequence = state.latest_sequence + 1
        DocumentCollaborationUpdate.objects.create(
            state=state,
            update_id=update_id,
            epoch=state.epoch,
            sequence=sequence,
            update_data=update_data,
            actor=actor,
            role=role,
            timezone=timezone_name,
            positive_word_delta=(
                positive_word_delta
                if role == DocumentCollaborationUpdate.ROLE_OWNER
                else 0
            ),
        )

        content_changed = document.content != content
        if content_changed:
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
            if document.manuscript.first_edited_at is None:
                manuscript_updates["first_edited_at"] = manuscript_updated_at
            Manuscript.objects.filter(id=document.manuscript_id).update(**manuscript_updates)
            if role == DocumentCollaborationUpdate.ROLE_OWNER:
                try:
                    writing_date = local_date(timezone_name)
                except ValueError as exc:
                    raise CollaborationError(str(exc), 400) from exc
                record_words_written(
                    manuscript_id=document.manuscript_id,
                    writing_date=writing_date,
                    words=positive_word_delta,
                )
                record_tier_activity(actor)

        materialized_at = timezone.now()
        state.ydoc_state = ydoc_state
        state.latest_sequence = sequence
        state.snapshot_sequence = sequence
        state.materialized_sequence = sequence
        state.schema_version = document.schema_version
        state.materialized_at = materialized_at
        state.diagnostic_status = DocumentCollaborationState.DIAGNOSTIC_READY
        state.diagnostic_code = ""
        state.save(
            update_fields=[
                "ydoc_state",
                "latest_sequence",
                "snapshot_sequence",
                "materialized_sequence",
                "schema_version",
                "materialized_at",
                "diagnostic_status",
                "diagnostic_code",
                "updated_at",
            ]
        )
        # The current snapshot contains every committed update. Retain a small replay tail for
        # diagnostics without allowing an unbounded per-keystroke table to grow forever.
        state.updates.filter(
            epoch=state.epoch,
            sequence__lte=max(0, sequence - 64),
        ).delete()
    return CollaborationCommitResult(
        sequence=sequence,
        save_generation=document.save_generation,
        history_generation=document.history_generation,
        materialized_at=materialized_at.isoformat(),
    )


def replace_collaboration_document(
    *,
    document: Document,
    content: object,
    expected_generation: int,
    actor: User,
) -> Document:
    try:
        validated_content = validate_document_content(content)
    except InvalidDocument as exc:
        raise CollaborationError(str(exc), 400) from exc
    with transaction.atomic():
        locked_document = (
            Document.objects.select_for_update()
            .select_related("manuscript__workspace")
            .get(id=document.id)
        )
        if locked_document.manuscript.workspace.owner_id != actor.id:
            raise CollaborationError("collaboration_access_revoked", 404)
        if not document_uses_collaboration(locked_document):
            raise CollaborationError("collaboration_unavailable", 409)
        ensure_collaboration_state(locked_document)
        if locked_document.save_generation != expected_generation:
            raise CollaborationError("document_save_conflict", 409)
        asset_ids = illustration_asset_ids(validated_content)
        if asset_ids and ManuscriptAsset.objects.filter(
            manuscript_id=locked_document.manuscript_id,
            public_id__in=asset_ids,
        ).count() != len(asset_ids):
            raise CollaborationError("document_asset_not_found", 400)
        content_annotation_ids = annotation_ids(validated_content)
        if content_annotation_ids and DocumentAnnotation.objects.filter(
            document=locked_document,
            public_id__in=content_annotation_ids,
        ).count() != len(content_annotation_ids):
            raise CollaborationError("document_annotation_not_found", 400)
        if locked_document.content != validated_content:
            locked_document.content = validated_content
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
        reset_collaboration_epoch(locked_document)
    return locked_document


def mark_collaboration_failed(document_id, epoch: int, code: str) -> None:
    DocumentCollaborationState.objects.filter(
        document__public_id=document_id,
        epoch=epoch,
        status=DocumentCollaborationState.STATUS_ACTIVE,
    ).update(
        diagnostic_status=DocumentCollaborationState.DIAGNOSTIC_FAILED,
        diagnostic_code=code[:64],
        updated_at=timezone.now(),
    )


def reset_collaboration_epoch(document: Document) -> int | None:
    state = (
        DocumentCollaborationState.objects.select_for_update()
        .filter(document=document, status=DocumentCollaborationState.STATUS_ACTIVE)
        .first()
    )
    if state is None:
        return None
    state.epoch += 1
    state.ydoc_state = b""
    state.snapshot_sequence = 0
    state.latest_sequence = 0
    state.materialized_sequence = 0
    state.schema_version = document.schema_version
    state.diagnostic_status = DocumentCollaborationState.DIAGNOSTIC_READY
    state.diagnostic_code = ""
    state.materialized_at = None
    state.save(
        update_fields=[
            "epoch",
            "ydoc_state",
            "snapshot_sequence",
            "latest_sequence",
            "materialized_sequence",
            "schema_version",
            "diagnostic_status",
            "diagnostic_code",
            "materialized_at",
            "updated_at",
        ]
    )
    state.updates.all().delete()
    transaction.on_commit(
        lambda: publish_collaboration_event(
            {
                "type": "epoch.changed",
                "documentId": str(document.public_id),
                "epoch": state.epoch,
            }
        )
    )
    return state.epoch


def publish_collaboration_event(payload: dict) -> None:
    if collaboration_mode() == "disabled":
        return
    try:
        Redis.from_url(
            settings.REDIS_URL,
            socket_connect_timeout=1,
            socket_timeout=1,
        ).publish(CONTROL_CHANNEL, json.dumps(payload, separators=(",", ":")))
    except Exception:
        logger.warning("Unable to publish collaboration control event", exc_info=True)


def publish_annotation_change(document_id) -> None:
    transaction.on_commit(
        lambda: publish_collaboration_event(
            {"type": "annotations.changed", "documentId": str(document_id)}
        )
    )


def publish_access_revoked(*, manuscript_id, editor_id: int) -> None:
    transaction.on_commit(
        lambda: publish_collaboration_event(
            {
                "type": "access.revoked",
                "manuscriptId": str(manuscript_id),
                "userId": editor_id,
            }
        )
    )
