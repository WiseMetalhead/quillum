from __future__ import annotations

import json
import re
import uuid

from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from apps.accounts.tier_progression import record_tier_activity
from apps.audit.service import write_audit_event

from .audio_recordings import (
    audio_content_response,
    validate_audio_properties,
    validate_audio_upload,
)
from .models import (
    AudioRecording,
    Manuscript,
    ManuscriptAsset,
    ManuscriptBoard,
    ManuscriptItem,
    ManuscriptNote,
    ManuscriptNoteAssociation,
    ManuscriptNoteTag,
)
from .note_schema import (
    NOTE_TITLE_MAX_LENGTH,
    InvalidNote,
    note_asset_ids,
    note_plain_text,
    validate_note_content,
)
from .quotas import storage_quota_response
from .transcription import (
    TranscriptionRequestError,
    delete_audio_transcription,
    queue_audio_transcription,
    transcription_payload,
)

BOARD_NAME_MAX_LENGTH = 80
TAG_NAME_MAX_LENGTH = 40
MAX_BOARDS = 50
MAX_TAGS = 100
MAX_NOTE_TAGS = 20
MAX_NOTE_ITEMS = 20
MAX_NOTE_ASSETS = 20
MAX_BULK_NOTES = 100
NOTE_COLORS = {"yellow", "blue", "green", "purple", "orange", "pink", "gray"}
TAG_COLORS = NOTE_COLORS


def _read_json(request):
    try:
        value = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _manuscript_for_owner(manuscript_id: int, user):
    return Manuscript.objects.filter(
        id=manuscript_id,
        workspace__owner=user,
    ).select_related("workspace").first()


def _owned_board(board_id, user):
    return ManuscriptBoard.objects.filter(
        public_id=board_id,
        manuscript__workspace__owner=user,
    ).select_related("manuscript__workspace").first()


def _owned_tag(tag_id, user):
    return ManuscriptNoteTag.objects.filter(
        public_id=tag_id,
        manuscript__workspace__owner=user,
    ).select_related("manuscript__workspace").first()


def _owned_note(note_id, user, *, lock=False):
    queryset = ManuscriptNote.objects
    if lock:
        queryset = queryset.select_for_update(of=("self",))
    return queryset.filter(
        public_id=note_id,
        manuscript__workspace__owner=user,
    ).select_related("manuscript__workspace", "board", "audio").first()


def _public_ids(values: object, error: str) -> list[uuid.UUID]:
    if not isinstance(values, list):
        raise ValueError(error)
    result = []
    for value in values:
        try:
            result.append(uuid.UUID(str(value)))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError(error) from exc
    if len(set(result)) != len(result):
        raise ValueError(error)
    return result


def _query_public_id(value: str, error: str):
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError(error) from exc


def _valid_color(value: object, allowed: set[str]) -> bool:
    return isinstance(value, str) and (
        value in allowed or bool(re.fullmatch(r"#[0-9a-fA-F]{6}", value))
    )


def board_payload(board: ManuscriptBoard) -> dict:
    return {
        "id": str(board.public_id),
        "name": board.name,
        "position": board.position,
        "createdAt": board.created_at.isoformat(),
        "updatedAt": board.updated_at.isoformat(),
    }


def tag_payload(tag: ManuscriptNoteTag) -> dict:
    return {
        "id": str(tag.public_id),
        "name": tag.name,
        "color": tag.color,
        "createdAt": tag.created_at.isoformat(),
        "updatedAt": tag.updated_at.isoformat(),
    }


def note_payload(note: ManuscriptNote, *, include_content=True) -> dict:
    content = note.content
    audio = getattr(note, "audio", None)
    payload = {
        "id": str(note.public_id),
        "kind": note.kind,
        "title": note.title,
        "preview": note_plain_text(content)[:280],
        "schemaVersion": note.schema_version,
        "saveGeneration": note.save_generation,
        "color": note.color,
        "pinned": note.is_pinned,
        "favourite": note.is_favourite,
        "archivedAt": note.archived_at.isoformat() if note.archived_at else None,
        "trashedAt": note.trashed_at.isoformat() if note.trashed_at else None,
        "boardId": str(note.board.public_id) if note.board_id else None,
        "tags": [tag_payload(tag) for tag in note.tags.all()],
        "associatedItems": [
            {
                "id": str(item.public_id),
                "title": item.title,
                "kind": item.kind,
                "parentId": str(item.parent.public_id) if item.parent_id else None,
            }
            for item in note.associated_items.all()
        ],
        "assets": [str(asset.public_id) for asset in note.assets.all()],
        "createdAt": note.created_at.isoformat(),
        "updatedAt": note.updated_at.isoformat(),
        "audio": (
            {
                "contentType": audio.content_type,
                "codec": audio.codec,
                "byteSize": audio.byte_size,
                "durationMs": audio.duration_ms,
                "waveform": audio.waveform,
                "playbackUrl": f"/api/manuscripts/notes/{note.public_id}/audio/",
                "downloadUrl": f"/api/manuscripts/notes/{note.public_id}/audio/?download=1",
            }
            if audio is not None
            else None
        ),
    }
    if include_content:
        payload["content"] = content
    return payload


def _note_queryset(manuscript: Manuscript):
    return ManuscriptNote.objects.filter(manuscript=manuscript).select_related(
        "manuscript__workspace", "board", "audio"
    ).prefetch_related(
        "tags__manuscript__workspace",
        "assets",
        "associated_items__manuscript__workspace",
        "associated_items__parent",
    )


@require_http_methods(["GET"])
def manuscript_note_context(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    items = ManuscriptItem.objects.filter(
        manuscript=manuscript,
        trashed_at__isnull=True,
    ).select_related("manuscript__workspace", "parent").order_by("position", "created_at")
    return JsonResponse({
        "items": [
            {
                "id": str(item.public_id),
                "title": item.title,
                "kind": item.kind,
                "parentId": str(item.parent.public_id) if item.parent_id else None,
            }
            for item in items
        ]
    })


def _validate_unique_name(items, name: str, *, excluding=None) -> bool:
    folded = name.casefold()
    return all(item.id == excluding or item.name.casefold() != folded for item in items)


@require_http_methods(["GET", "POST"])
def manuscript_boards(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    boards = list(ManuscriptBoard.objects.filter(manuscript=manuscript).select_related(
        "manuscript__workspace"
    ))
    if request.method == "GET":
        return JsonResponse({"items": [board_payload(board) for board in boards]})
    payload = _read_json(request)
    name = str((payload or {}).get("name") or "").strip()
    if not name or len(name) > BOARD_NAME_MAX_LENGTH:
        return JsonResponse({"error": "board_name_invalid"}, status=400)
    if len(boards) >= MAX_BOARDS:
        return JsonResponse({"error": "board_limit_reached"}, status=400)
    if not _validate_unique_name(boards, name):
        return JsonResponse({"error": "board_name_duplicate"}, status=400)
    position = (max((board.position for board in boards), default=0) // 1024 + 1) * 1024
    board = ManuscriptBoard.objects.create(
        manuscript=manuscript,
        name=name,
        position=position,
    )
    write_audit_event(
        request,
        "manuscript.board_created",
        actor=request.user,
        subject=f"manuscript:{manuscript.public_id}",
        payload={"kind": manuscript.kind},
    )
    return JsonResponse({"board": board_payload(board)}, status=201)


@require_http_methods(["PATCH", "DELETE"])
def board_detail(request, board_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    board = _owned_board(board_id, request.user)
    if board is None:
        return JsonResponse({"error": "board_not_found"}, status=404)
    if request.method == "DELETE":
        manuscript_id = board.manuscript_id
        board.delete()
        write_audit_event(
            request,
            "manuscript.board_deleted",
            actor=request.user,
            subject=f"manuscript:{manuscript_id}",
            payload={},
        )
        return JsonResponse({"deleted": True})
    payload = _read_json(request)
    if payload is None or set(payload) != {"name"}:
        return JsonResponse({"error": "board_update_invalid"}, status=400)
    name = str(payload["name"] or "").strip()
    boards = ManuscriptBoard.objects.filter(manuscript=board.manuscript).select_related(
        "manuscript__workspace"
    )
    if (
        not name
        or len(name) > BOARD_NAME_MAX_LENGTH
        or not _validate_unique_name(boards, name, excluding=board.id)
    ):
        return JsonResponse({"error": "board_name_invalid"}, status=400)
    if board.name != name:
        board.name = name
        board.save(update_fields=["name", "updated_at"])
        record_tier_activity(request.user)
    return JsonResponse({"board": board_payload(board)})


@require_http_methods(["GET", "POST"])
def manuscript_note_tags(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    tags = list(ManuscriptNoteTag.objects.filter(manuscript=manuscript).select_related(
        "manuscript__workspace"
    ))
    if request.method == "GET":
        query = request.GET.get("search", "").strip().casefold()
        if query:
            tags = [tag for tag in tags if query in tag.name.casefold()]
        return JsonResponse({"items": [tag_payload(tag) for tag in tags]})
    payload = _read_json(request)
    name = str((payload or {}).get("name") or "").strip()
    color = (payload or {}).get("color", "blue")
    if not name or len(name) > TAG_NAME_MAX_LENGTH or not _valid_color(color, TAG_COLORS):
        return JsonResponse({"error": "note_tag_invalid"}, status=400)
    if len(tags) >= MAX_TAGS:
        return JsonResponse({"error": "note_tag_limit_reached"}, status=400)
    if not _validate_unique_name(tags, name):
        return JsonResponse({"error": "note_tag_duplicate"}, status=400)
    tag = ManuscriptNoteTag.objects.create(manuscript=manuscript, name=name, color=color.lower())
    record_tier_activity(request.user)
    return JsonResponse({"tag": tag_payload(tag)}, status=201)


@require_http_methods(["PATCH", "DELETE"])
def note_tag_detail(request, tag_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    tag = _owned_tag(tag_id, request.user)
    if tag is None:
        return JsonResponse({"error": "note_tag_not_found"}, status=404)
    if request.method == "DELETE":
        tag.delete()
        record_tier_activity(request.user)
        return JsonResponse({"deleted": True})
    payload = _read_json(request)
    if payload is None or not payload or not set(payload).issubset({"name", "color"}):
        return JsonResponse({"error": "note_tag_invalid"}, status=400)
    name = str(payload.get("name", tag.name) or "").strip()
    color = payload.get("color", tag.color)
    tags = ManuscriptNoteTag.objects.filter(manuscript=tag.manuscript).select_related(
        "manuscript__workspace"
    )
    if (
        not name
        or len(name) > TAG_NAME_MAX_LENGTH
        or not _valid_color(color, TAG_COLORS)
        or not _validate_unique_name(tags, name, excluding=tag.id)
    ):
        return JsonResponse({"error": "note_tag_invalid"}, status=400)
    normalized_color = color.lower()
    if tag.name != name or tag.color != normalized_color:
        tag.name = name
        tag.color = normalized_color
        tag.save(update_fields=["name", "color", "updated_at"])
        record_tier_activity(request.user)
    return JsonResponse({"tag": tag_payload(tag)})


def _note_relations(manuscript: Manuscript, payload: dict):
    board = None
    if payload.get("boardId"):
        try:
            board_id = uuid.UUID(str(payload["boardId"]))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError("note_board_not_found") from exc
        board = ManuscriptBoard.objects.filter(
            manuscript=manuscript,
            public_id=board_id,
        ).first()
        if board is None:
            raise ValueError("note_board_not_found")
    tag_ids = _public_ids(payload.get("tagIds", []), "note_tags_invalid")
    item_ids = _public_ids(payload.get("itemIds", []), "note_items_invalid")
    if len(tag_ids) > MAX_NOTE_TAGS:
        raise ValueError("note_tag_limit_reached")
    if len(item_ids) > MAX_NOTE_ITEMS:
        raise ValueError("note_item_limit_reached")
    tags = list(ManuscriptNoteTag.objects.filter(manuscript=manuscript, public_id__in=tag_ids))
    items = list(ManuscriptItem.objects.filter(
        manuscript=manuscript,
        public_id__in=item_ids,
        trashed_at__isnull=True,
    ))
    if len(tags) != len(tag_ids):
        raise ValueError("note_tag_not_found")
    if len(items) != len(item_ids):
        raise ValueError("note_item_not_found")
    return board, tags, items


def _validated_note_fields(manuscript: Manuscript, payload: dict):
    title = str(payload.get("title") or "").strip()
    if len(title) > NOTE_TITLE_MAX_LENGTH:
        raise ValueError("note_title_invalid")
    schema_version = payload.get("schemaVersion")
    if schema_version not in {1, ManuscriptNote.CURRENT_SCHEMA_VERSION}:
        raise ValueError("note_schema_unsupported")
    content = validate_note_content(
        payload.get("content"),
        allow_task_lists=schema_version >= ManuscriptNote.CURRENT_SCHEMA_VERSION,
    )
    color = payload.get("color", "blue")
    if not _valid_color(color, NOTE_COLORS):
        raise ValueError("note_color_invalid")
    if any(
        key in payload and not isinstance(payload[key], bool)
        for key in ("pinned", "favourite")
    ):
        raise ValueError("note_flags_invalid")
    asset_ids = note_asset_ids(content)
    if len(asset_ids) > MAX_NOTE_ASSETS:
        raise ValueError("note_asset_limit_reached")
    assets = list(ManuscriptAsset.objects.filter(
        manuscript=manuscript,
        public_id__in=asset_ids,
    ))
    if len(assets) != len(asset_ids):
        raise ValueError("note_asset_not_found")
    board, tags, items = _note_relations(manuscript, payload)
    if not title and not note_plain_text(content) and not asset_ids:
        raise ValueError("note_empty")
    return title, content, color.lower(), board, tags, items, assets


def _validated_audio_metadata(manuscript: Manuscript, payload: dict):
    allowed = {
        "title", "color", "boardId", "tagIds", "itemIds", "pinned", "favourite",
        "durationMs", "waveform",
    }
    required = {"title", "color", "boardId", "tagIds", "itemIds", "durationMs", "waveform"}
    if not required.issubset(payload) or not set(payload).issubset(allowed):
        raise ValueError("audio_note_invalid")
    title = str(payload.get("title") or "").strip()
    if len(title) > NOTE_TITLE_MAX_LENGTH:
        raise ValueError("note_title_invalid")
    color = payload.get("color", "blue")
    if not _valid_color(color, NOTE_COLORS):
        raise ValueError("note_color_invalid")
    if any(
        key in payload and not isinstance(payload[key], bool)
        for key in ("pinned", "favourite")
    ):
        raise ValueError("note_flags_invalid")
    duration_ms, waveform = validate_audio_properties(payload)
    board, tags, items = _note_relations(manuscript, payload)
    return title, color.lower(), board, tags, items, duration_ms, waveform


@require_http_methods(["POST"])
def manuscript_audio_notes(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    uploaded_file = request.FILES.get("audio")
    if uploaded_file is None:
        return JsonResponse({"error": "audio_file_required"}, status=400)
    try:
        metadata = json.loads(request.POST.get("metadata", ""))
    except (json.JSONDecodeError, TypeError):
        return JsonResponse({"error": "audio_note_invalid"}, status=400)
    if not isinstance(metadata, dict):
        return JsonResponse({"error": "audio_note_invalid"}, status=400)
    try:
        title, color, board, tags, items, duration_ms, waveform = _validated_audio_metadata(
            manuscript, metadata
        )
        content_type, codec = validate_audio_upload(uploaded_file)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    quota_error = storage_quota_response(request.user, added=uploaded_file.size)
    if quota_error is not None:
        return quota_error

    audio = None
    stored_file = None
    try:
        with transaction.atomic():
            note = ManuscriptNote.objects.create(
                manuscript=manuscript,
                board=board,
                kind=ManuscriptNote.KIND_AUDIO,
                title=title,
                content=ManuscriptNote.EMPTY_CONTENT,
                color=color,
                is_pinned=metadata.get("pinned") is True,
                is_favourite=metadata.get("favourite") is True,
            )
            audio = AudioRecording(
                note=note,
                file=uploaded_file,
                content_type=content_type,
                codec=codec,
                byte_size=uploaded_file.size,
                duration_ms=duration_ms,
                waveform=waveform,
            )
            audio.save()
            stored_file = (audio.file.storage, audio.file.name)
            note.tags.set(tags)
            ManuscriptNoteAssociation.objects.bulk_create([
                ManuscriptNoteAssociation(note=note, item=item) for item in items
            ])
            record_tier_activity(request.user)
            write_audit_event(
                request,
                "manuscript.note_created",
                actor=request.user,
                subject=f"manuscript:{manuscript.public_id}",
                payload={"kind": manuscript.kind, "noteType": ManuscriptNote.KIND_AUDIO},
            )
    except Exception:
        if stored_file is None and audio is not None and audio.file and audio.file.name:
            stored_file = (audio.file.storage, audio.file.name)
        if stored_file is not None:
            stored_file[0].delete(stored_file[1])
        raise

    note = _note_queryset(manuscript).get(id=note.id)
    return JsonResponse({"note": note_payload(note)}, status=201)


@require_http_methods(["GET", "POST"])
def manuscript_notes(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if request.method == "GET":
        notes = _note_queryset(manuscript)
        view = request.GET.get("view", "all")
        if view == "all":
            notes = notes.filter(archived_at__isnull=True, trashed_at__isnull=True)
        elif view == "favourites":
            notes = notes.filter(
                is_favourite=True,
                archived_at__isnull=True,
                trashed_at__isnull=True,
            )
        elif view == "archive":
            notes = notes.filter(archived_at__isnull=False, trashed_at__isnull=True)
        elif view == "trash":
            notes = notes.filter(trashed_at__isnull=False)
        else:
            return JsonResponse({"error": "note_view_invalid"}, status=400)
        if request.GET.get("boardId"):
            try:
                notes = notes.filter(board__public_id=_query_public_id(
                    request.GET["boardId"], "note_board_not_found"
                ))
            except ValueError as exc:
                return JsonResponse({"error": str(exc)}, status=400)
        if request.GET.get("tagId"):
            try:
                notes = notes.filter(tags__public_id=_query_public_id(
                    request.GET["tagId"], "note_tag_not_found"
                ))
            except ValueError as exc:
                return JsonResponse({"error": str(exc)}, status=400)
        if request.GET.get("itemId"):
            try:
                notes = notes.filter(associated_items__public_id=_query_public_id(
                    request.GET["itemId"], "note_item_not_found"
                ))
            except ValueError as exc:
                return JsonResponse({"error": str(exc)}, status=400)
        return JsonResponse({"items": [note_payload(note) for note in notes.distinct()]})
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        title, content, color, board, tags, items, assets = _validated_note_fields(
            manuscript, payload
        )
    except (ValueError, InvalidNote) as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    with transaction.atomic():
        note = ManuscriptNote.objects.create(
            manuscript=manuscript,
            board=board,
            kind=ManuscriptNote.KIND_TEXT,
            title=title,
            content=content,
            color=color,
            is_pinned=payload.get("pinned") is True,
            is_favourite=payload.get("favourite") is True,
        )
        note.tags.set(tags)
        note.assets.set(assets)
        ManuscriptNoteAssociation.objects.bulk_create([
            ManuscriptNoteAssociation(note=note, item=item) for item in items
        ])
    note = _note_queryset(manuscript).get(id=note.id)
    write_audit_event(
        request,
        "manuscript.note_created",
        actor=request.user,
        subject=f"manuscript:{manuscript.public_id}",
        payload={"kind": manuscript.kind, "noteType": ManuscriptNote.KIND_TEXT},
    )
    return JsonResponse({"note": note_payload(note)}, status=201)


@require_http_methods(["GET", "PATCH"])
def note_detail(request, note_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    note = _owned_note(note_id, request.user)
    if note is None:
        return JsonResponse({"error": "note_not_found"}, status=404)
    if request.method == "GET":
        note = _note_queryset(note.manuscript).get(id=note.id)
        return JsonResponse({"note": note_payload(note)})
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    expected = payload.get("expectedGeneration")
    if note.kind == ManuscriptNote.KIND_AUDIO:
        required = {"title", "color", "boardId", "tagIds", "itemIds"}
        if not required.issubset(payload) or not set(payload).issubset(
            required | {"expectedGeneration", "pinned", "favourite"}
        ):
            return JsonResponse({"error": "note_update_invalid"}, status=400)
        try:
            common_payload = {
                **{key: value for key, value in payload.items() if key != "expectedGeneration"},
                "durationMs": note.audio.duration_ms,
                "waveform": note.audio.waveform,
            }
            title, color, board, tags, items, _duration, _waveform = (
                _validated_audio_metadata(note.manuscript, common_payload)
            )
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        content = note.content
        assets = []
    else:
        required = {
            "title", "content", "schemaVersion", "color", "boardId", "tagIds", "itemIds"
        }
        if not required.issubset(payload) or not set(payload).issubset(
            required | {"expectedGeneration", "pinned", "favourite"}
        ):
            return JsonResponse({"error": "note_update_invalid"}, status=400)
        try:
            title, content, color, board, tags, items, assets = _validated_note_fields(
                note.manuscript, payload
            )
        except (ValueError, InvalidNote) as exc:
            return JsonResponse({"error": str(exc)}, status=400)
    with transaction.atomic():
        note = _owned_note(note_id, request.user, lock=True)
        if note is None:
            return JsonResponse({"error": "note_not_found"}, status=404)
        if expected != note.save_generation:
            return JsonResponse({"error": "note_update_conflict"}, status=409)
        activity_changed = (
            note.title != title
            or note.content != content
            or note.color != color
            or note.board_id != (board.id if board else None)
            or note.is_pinned != payload.get("pinned", note.is_pinned)
            or note.is_favourite != payload.get("favourite", note.is_favourite)
            or set(note.tags.values_list("id", flat=True)) != {tag.id for tag in tags}
            or set(note.assets.values_list("id", flat=True)) != {asset.id for asset in assets}
            or set(note.associated_items.values_list("id", flat=True))
            != {item.id for item in items}
        )
        note.title = title
        note.content = content
        note.color = color
        note.board = board
        note.is_pinned = payload.get("pinned", note.is_pinned)
        note.is_favourite = payload.get("favourite", note.is_favourite)
        if note.kind == ManuscriptNote.KIND_TEXT:
            note.schema_version = ManuscriptNote.CURRENT_SCHEMA_VERSION
        note.save_generation += 1
        note.save(update_fields=[
            "title", "content", "color", "board", "is_pinned", "is_favourite",
            "schema_version", "save_generation", "updated_at",
        ])
        note.tags.set(tags)
        note.assets.set(assets)
        note.manuscriptnoteassociation_set.all().delete()
        ManuscriptNoteAssociation.objects.bulk_create([
            ManuscriptNoteAssociation(note=note, item=item) for item in items
        ])
        if activity_changed:
            record_tier_activity(request.user)
    note = _note_queryset(note.manuscript).get(id=note.id)
    return JsonResponse({"note": note_payload(note)})


@require_http_methods(["GET", "HEAD"])
def note_audio_content(request, note_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    note = _owned_note(note_id, request.user)
    if note is None or note.kind != ManuscriptNote.KIND_AUDIO:
        return JsonResponse({"error": "note_not_found"}, status=404)
    audio = getattr(note, "audio", None)
    if audio is None or not audio.file:
        return JsonResponse({"error": "audio_file_not_found"}, status=404)

    return audio_content_response(request, audio, title=note.title)


@require_http_methods(["GET", "POST", "DELETE"])
def note_audio_transcription(request, note_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    note = _owned_note(note_id, request.user)
    if note is None or note.kind != ManuscriptNote.KIND_AUDIO:
        return JsonResponse({"error": "note_not_found"}, status=404)
    audio = getattr(note, "audio", None)
    if audio is None or not audio.file:
        return JsonResponse({"error": "audio_file_not_found"}, status=404)

    if request.method == "GET":
        return JsonResponse({"transcription": transcription_payload(audio)})

    try:
        if request.method == "POST":
            state = queue_audio_transcription(audio)
            write_audit_event(
                request,
                "manuscript.audio_transcription_requested",
                actor=request.user,
                subject=f"note:{note.public_id}",
                payload={"generation": state.generation},
            )
            return JsonResponse(
                {"transcription": transcription_payload(state.audio)},
                status=202,
            )

        deleted = delete_audio_transcription(audio)
    except TranscriptionRequestError as exc:
        return JsonResponse({"error": exc.code}, status=exc.status)

    if deleted:
        write_audit_event(
            request,
            "manuscript.audio_transcription_deleted",
            actor=request.user,
            subject=f"note:{note.public_id}",
            payload={},
        )
    audio.refresh_from_db()
    return JsonResponse({"transcription": transcription_payload(audio)})


@require_http_methods(["POST", "DELETE"])
def note_lifecycle(request, note_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    payload = _read_json(request) if request.method == "POST" else {}
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    with transaction.atomic():
        note = _owned_note(note_id, request.user, lock=True)
        if note is None:
            return JsonResponse({"error": "note_not_found"}, status=404)
        if request.method == "DELETE":
            if note.trashed_at is None:
                return JsonResponse({"error": "note_not_trashed"}, status=400)
            manuscript_id = note.manuscript_id
            note_type = note.kind
            note.delete()
            write_audit_event(
                request,
                "manuscript.note_permanently_deleted",
                actor=request.user,
                subject=f"manuscript:{manuscript_id}",
                payload={"noteType": note_type},
            )
            return JsonResponse({"deleted": True})
        if payload.get("expectedGeneration") != note.save_generation:
            return JsonResponse({"error": "note_update_conflict"}, status=409)
        action = payload.get("action")
        now = timezone.now()
        if action == "archive":
            note.archived_at = now
        elif action == "unarchive":
            note.archived_at = None
        elif action == "trash":
            note.trashed_at = now
        elif action == "restore":
            note.trashed_at = None
        else:
            return JsonResponse({"error": "note_action_invalid"}, status=400)
        note.save_generation += 1
        note.save(update_fields=["archived_at", "trashed_at", "save_generation", "updated_at"])
        record_tier_activity(request.user)
    note = _note_queryset(note.manuscript).get(id=note.id)
    return JsonResponse({"note": note_payload(note)})


@require_http_methods(["POST"])
def bulk_note_lifecycle(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    payload = _read_json(request)
    action = (payload or {}).get("action")
    candidates = (payload or {}).get("notes")
    if action not in {"restore", "unarchive"} or not isinstance(candidates, list):
        return JsonResponse({"error": "note_bulk_action_invalid"}, status=400)
    if not candidates or len(candidates) > MAX_BULK_NOTES:
        return JsonResponse({"error": "note_bulk_limit_invalid"}, status=400)
    try:
        expected = {
            uuid.UUID(str(candidate["id"])): candidate["expectedGeneration"]
            for candidate in candidates
            if isinstance(candidate, dict)
            and set(candidate) == {"id", "expectedGeneration"}
            and isinstance(candidate["expectedGeneration"], int)
            and not isinstance(candidate["expectedGeneration"], bool)
        }
    except (ValueError, TypeError, AttributeError):
        return JsonResponse({"error": "note_bulk_action_invalid"}, status=400)
    if len(expected) != len(candidates):
        return JsonResponse({"error": "note_bulk_action_invalid"}, status=400)
    with transaction.atomic():
        notes = list(
            ManuscriptNote.objects.select_for_update()
            .filter(manuscript=manuscript, public_id__in=expected)
            .select_related("manuscript__workspace")
        )
        if len(notes) != len(expected):
            return JsonResponse({"error": "note_not_found"}, status=404)
        if any(expected[note.public_id] != note.save_generation for note in notes):
            return JsonResponse({"error": "note_update_conflict"}, status=409)
        now = timezone.now()
        for note in notes:
            if action == "restore":
                note.trashed_at = None
            else:
                note.archived_at = None
            note.save_generation += 1
            note.updated_at = now
        ManuscriptNote.objects.bulk_update(
            notes,
            ["trashed_at", "archived_at", "save_generation", "updated_at"],
        )
    write_audit_event(
        request,
        f"manuscript.note_bulk_{action}",
        actor=request.user,
        subject=f"manuscript:{manuscript.public_id}",
        payload={"count": len(notes)},
    )
    return JsonResponse({"updated": len(notes)})


@require_http_methods(["DELETE"])
def empty_note_trash(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    notes = ManuscriptNote.objects.filter(manuscript=manuscript, trashed_at__isnull=False)
    note_count = notes.count()
    audio_count = notes.filter(kind=ManuscriptNote.KIND_AUDIO).count()
    notes.delete()
    if note_count:
        write_audit_event(
            request,
            "manuscript.note_trash_emptied",
            actor=request.user,
            subject=f"manuscript:{manuscript.public_id}",
            payload={"count": note_count, "audioCount": audio_count},
        )
    return JsonResponse({"deleted": note_count})
