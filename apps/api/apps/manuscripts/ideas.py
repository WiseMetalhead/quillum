from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import datetime
from pathlib import Path

from django.db import transaction
from django.db.models import Count, Q
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from apps.accounts.media import (
    create_or_get_user_media,
    process_user_media,
    processed_user_media_size,
)
from apps.accounts.models import UserMediaAsset
from apps.accounts.storage import delete_user_media_if_unreferenced
from apps.accounts.tier_progression import record_tier_activity
from apps.accounts.tiers import image_upload_limit
from apps.audit.service import write_audit_event

from .assets import InvalidAsset
from .audio_recordings import (
    audio_content_response,
    validate_audio_properties,
    validate_audio_upload,
    validate_imported_m4a,
)
from .models import AudioRecording, IdeaItem, Manuscript, ManuscriptNote
from .note_schema import (
    NOTE_TITLE_MAX_LENGTH,
    InvalidNote,
    plain_text_to_note_content,
    validate_note_content,
)
from .quotas import image_size_response, storage_quota_response
from .transcription import (
    TranscriptionRequestError,
    delete_audio_transcription,
    queue_audio_transcription,
    transcription_payload,
)

IDEA_PAGE_SIZE = 24
IDEA_KINDS = {
    "all",
    IdeaItem.KIND_IMAGE,
    IdeaItem.KIND_TEXT,
    IdeaItem.KIND_AUDIO,
}


def _read_json(request) -> dict | None:
    try:
        payload = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _validated_text_fields(payload: dict, *, updating: bool) -> tuple[str, str, int | None]:
    required = {"title", "text"}
    allowed = required | ({"expectedGeneration"} if updating else set())
    if not required.issubset(payload) or set(payload) != allowed:
        raise ValueError("idea_text_invalid")
    if not isinstance(payload["title"], str) or not isinstance(payload["text"], str):
        raise ValueError("idea_text_invalid")
    title = payload["title"].replace("\r\n", "\n").replace("\r", "\n").strip()
    text = payload["text"].replace("\r\n", "\n").replace("\r", "\n")
    if len(title) > NOTE_TITLE_MAX_LENGTH:
        raise ValueError("idea_title_invalid")
    try:
        validate_note_content(plain_text_to_note_content(text), allow_task_lists=True)
    except InvalidNote as exc:
        if str(exc) == "note_too_large":
            raise ValueError("idea_text_too_large") from exc
        raise ValueError("idea_text_invalid") from exc
    expected = payload.get("expectedGeneration")
    if updating and (
        not isinstance(expected, int)
        or isinstance(expected, bool)
        or expected < 0
    ):
        raise ValueError("idea_generation_invalid")
    return title, text, expected


def _validated_title_update(payload: dict) -> tuple[str, int]:
    if set(payload) != {"title", "expectedGeneration"}:
        raise ValueError("idea_update_invalid")
    title = payload.get("title")
    expected = payload.get("expectedGeneration")
    if not isinstance(title, str):
        raise ValueError("idea_update_invalid")
    title = title.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(title) > NOTE_TITLE_MAX_LENGTH:
        raise ValueError("idea_title_invalid")
    if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
        raise ValueError("idea_generation_invalid")
    return title, expected


def _encode_cursor(item: IdeaItem) -> str:
    raw = f"{item.updated_at.isoformat()}|{item.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(value: str) -> tuple[datetime, int] | None:
    try:
        padded = value + "=" * (-len(value) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        timestamp, item_id = raw.rsplit("|", 1)
        parsed = datetime.fromisoformat(timestamp)
        if parsed.tzinfo is None:
            return None
        return parsed, int(item_id)
    except (ValueError, UnicodeDecodeError, binascii.Error, OverflowError):
        return None


def _idea_payload(item: IdeaItem, *, detail: bool = False) -> dict:
    image = None
    if item.image_media_id:
        media = item.image_media
        image = {
            "mediaId": str(media.public_id),
            "previewUrl": f"/api/auth/storage/media/{media.public_id}/medium/",
            "displayUrl": f"/api/auth/storage/media/{media.public_id}/editor-large/",
            "width": media.width,
            "height": media.height,
        }
    recording = getattr(item, "audio", None)
    audio = (
        {
            "contentType": recording.content_type,
            "codec": recording.codec,
            "byteSize": recording.byte_size,
            "durationMs": recording.duration_ms,
            "waveform": recording.waveform,
            "playbackUrl": f"/api/ideas/{item.public_id}/audio/",
            "downloadUrl": f"/api/ideas/{item.public_id}/audio/?download=1",
            "transcriptionUrl": f"/api/ideas/{item.public_id}/transcription/",
        }
        if recording is not None
        else None
    )
    payload = {
        "id": str(item.public_id),
        "kind": item.kind,
        "title": item.title,
        "preview": item.text[:500],
        "image": image,
        "audio": audio,
        "saveGeneration": item.save_generation,
        "createdAt": item.created_at.isoformat(),
        "updatedAt": item.updated_at.isoformat(),
    }
    if detail:
        payload["text"] = item.text
    return payload


def _counts(user) -> dict[str, int]:
    grouped = {
        row["kind"]: row["count"]
        for row in IdeaItem.objects.filter(owner=user)
        .values("kind")
        .annotate(count=Count("id"))
    }
    return {
        "all": sum(grouped.values()),
        "image": grouped.get(IdeaItem.KIND_IMAGE, 0),
        "text": grouped.get(IdeaItem.KIND_TEXT, 0),
        "audio": grouped.get(IdeaItem.KIND_AUDIO, 0),
    }


@require_http_methods(["GET"])
def ideas(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    kind = request.GET.get("kind", "all")
    if kind not in IDEA_KINDS:
        return JsonResponse({"error": "idea_filter_invalid"}, status=400)
    items = IdeaItem.objects.filter(owner=request.user).select_related("image_media", "audio")
    if kind != "all":
        items = items.filter(kind=kind)
    cursor_value = request.GET.get("cursor", "").strip()
    if cursor_value:
        cursor = _decode_cursor(cursor_value)
        if cursor is None:
            return JsonResponse({"error": "idea_cursor_invalid"}, status=400)
        updated_at, item_id = cursor
        items = items.filter(
            Q(updated_at__lt=updated_at)
            | Q(updated_at=updated_at, id__lt=item_id)
        )
    page = list(items.order_by("-updated_at", "-id")[: IDEA_PAGE_SIZE + 1])
    has_more = len(page) > IDEA_PAGE_SIZE
    page = page[:IDEA_PAGE_SIZE]
    return JsonResponse(
        {
            "items": [_idea_payload(item) for item in page],
            "counts": _counts(request.user),
            "nextCursor": _encode_cursor(page[-1]) if has_more and page else None,
        }
    )


@require_http_methods(["POST"])
def idea_images(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    uploads = request.FILES.getlist("image")
    if len(uploads) != 1:
        return JsonResponse({"error": "idea_image_required"}, status=400)
    uploaded = uploads[0]
    limit = image_upload_limit(request.user)
    if uploaded.size > limit:
        return image_size_response(request.user, used=uploaded.size, limit=limit)
    try:
        processed = process_user_media(uploaded, max_bytes=limit)
    except InvalidAsset as exc:
        return JsonResponse({"error": exc.code}, status=400)
    existing_media = UserMediaAsset.objects.filter(
        owner=request.user,
        content_hash=processed.content_hash,
    ).first()
    quota_error = storage_quota_response(
        request.user,
        added=0 if existing_media else processed_user_media_size(processed),
    )
    if quota_error is not None:
        return quota_error

    media = existing_media
    media_created = False
    if media is None:
        media, media_created = create_or_get_user_media(user=request.user, processed=processed)
    try:
        with transaction.atomic():
            item, created = IdeaItem.objects.get_or_create(
                owner=request.user,
                image_media=media,
                defaults={"kind": IdeaItem.KIND_IMAGE},
            )
            if created:
                record_tier_activity(request.user)
    except Exception:
        if media_created:
            delete_user_media_if_unreferenced(request.user, media.id)
        raise
    if created:
        write_audit_event(
            request,
            "idea.image_created",
            actor=request.user,
            subject=f"idea:{item.public_id}",
            payload={"kind": IdeaItem.KIND_IMAGE},
        )
    item = IdeaItem.objects.select_related("image_media").get(id=item.id)
    return JsonResponse(
        {"item": _idea_payload(item, detail=True), "created": created},
        status=201 if created else 200,
    )


@require_http_methods(["POST"])
def idea_text(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        title, text, _expected = _validated_text_fields(payload, updating=False)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    if not title and not text.strip():
        return JsonResponse({"error": "idea_empty"}, status=400)
    with transaction.atomic():
        item = IdeaItem.objects.create(
            owner=request.user,
            kind=IdeaItem.KIND_TEXT,
            title=title,
            text=text,
        )
        record_tier_activity(request.user)
    write_audit_event(
        request,
        "idea.text_created",
        actor=request.user,
        subject=f"idea:{item.public_id}",
        payload={"kind": IdeaItem.KIND_TEXT},
    )
    return JsonResponse({"item": _idea_payload(item, detail=True)}, status=201)


@require_http_methods(["POST"])
def idea_audio(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    uploaded_file = request.FILES.get("audio")
    if uploaded_file is None:
        return JsonResponse({"error": "audio_file_required"}, status=400)
    try:
        metadata = json.loads(request.POST.get("metadata", ""))
    except (json.JSONDecodeError, TypeError):
        return JsonResponse({"error": "audio_note_invalid"}, status=400)
    if not isinstance(metadata, dict) or set(metadata) != {"title", "durationMs", "waveform"}:
        return JsonResponse({"error": "audio_note_invalid"}, status=400)
    if not isinstance(metadata["title"], str):
        return JsonResponse({"error": "audio_note_invalid"}, status=400)
    title = metadata["title"].replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(title) > NOTE_TITLE_MAX_LENGTH:
        return JsonResponse({"error": "idea_title_invalid"}, status=400)
    try:
        duration_ms, waveform = validate_audio_properties(metadata)
        content_type, codec = validate_audio_upload(uploaded_file)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    quota_error = storage_quota_response(request.user, added=uploaded_file.size)
    if quota_error is not None:
        return quota_error

    return _create_audio_idea(
        request,
        uploaded_file=uploaded_file,
        title=title,
        content_type=content_type,
        codec=codec,
        duration_ms=duration_ms,
        waveform=waveform,
        source="recorder",
    )


@require_http_methods(["POST"])
def idea_audio_import(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    uploaded_file = request.FILES.get("audio")
    if uploaded_file is None:
        return JsonResponse({"error": "audio_file_required"}, status=400)
    quota_error = storage_quota_response(request.user, added=uploaded_file.size)
    if quota_error is not None:
        return quota_error
    original_name = str(uploaded_file.name)
    try:
        content_type, codec, duration_ms, waveform = validate_imported_m4a(uploaded_file)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    title = Path(original_name).stem.replace("\r\n", "\n").replace("\r", "\n").strip()
    title = title[:NOTE_TITLE_MAX_LENGTH]
    return _create_audio_idea(
        request,
        uploaded_file=uploaded_file,
        title=title,
        content_type=content_type,
        codec=codec,
        duration_ms=duration_ms,
        waveform=waveform,
        source="import",
    )


def _create_audio_idea(
    request,
    *,
    uploaded_file,
    title: str,
    content_type: str,
    codec: str,
    duration_ms: int,
    waveform: list[int],
    source: str,
):
    recording = None
    stored_file = None
    try:
        with transaction.atomic():
            item = IdeaItem.objects.create(
                owner=request.user,
                kind=IdeaItem.KIND_AUDIO,
                title=title,
            )
            recording = AudioRecording(
                idea=item,
                file=uploaded_file,
                content_type=content_type,
                codec=codec,
                byte_size=uploaded_file.size,
                duration_ms=duration_ms,
                waveform=waveform,
            )
            recording.save()
            stored_file = (recording.file.storage, recording.file.name)
            record_tier_activity(request.user)
    except Exception:
        if stored_file is None and recording is not None and recording.file and recording.file.name:
            stored_file = (recording.file.storage, recording.file.name)
        if stored_file is not None:
            stored_file[0].delete(stored_file[1])
        raise
    write_audit_event(
        request,
        "idea.audio_created",
        actor=request.user,
        subject=f"idea:{item.public_id}",
        payload={"kind": IdeaItem.KIND_AUDIO, "source": source},
    )
    item = IdeaItem.objects.select_related("audio").get(id=item.id)
    return JsonResponse({"item": _idea_payload(item, detail=True)}, status=201)


@require_http_methods(["GET"])
def idea_targets(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscripts = (
        Manuscript.objects.filter(workspace__owner=request.user)
        .select_related("series_membership__series")
        .order_by("title", "id")
    )
    items = []
    for manuscript in manuscripts:
        membership = getattr(manuscript, "series_membership", None)
        series = membership.series if membership is not None else None
        items.append(
            {
                "id": str(manuscript.public_id),
                "title": manuscript.title,
                "kind": manuscript.kind,
                "inDrawer": bool(
                    manuscript.drawer_at
                    or (series is not None and series.drawer_at)
                ),
                "series": (
                    {
                        "id": str(series.public_id),
                        "title": series.title,
                        "position": membership.position,
                    }
                    if series is not None
                    else None
                ),
            }
        )
    items.sort(
        key=lambda item: (
            item["inDrawer"],
            (item["series"] or {}).get("title", "").casefold(),
            item["title"].casefold(),
            item["id"],
        )
    )
    return JsonResponse({"items": items})


def _attached_payload(note: ManuscriptNote, *, already_attached: bool) -> dict:
    return {
        "note": {
            "id": str(note.public_id),
            "manuscriptId": str(note.manuscript.public_id),
        },
        "alreadyAttached": already_attached,
    }


@require_http_methods(["POST"])
def idea_attach(request, idea_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    if set(payload) != {"manuscriptId"}:
        return JsonResponse({"error": "idea_target_invalid"}, status=400)
    try:
        manuscript_id = uuid.UUID(str(payload["manuscriptId"]))
    except (ValueError, TypeError, AttributeError):
        return JsonResponse({"error": "idea_target_invalid"}, status=400)

    with transaction.atomic():
        existing = (
            ManuscriptNote.objects.select_for_update()
            .select_related("manuscript")
            .filter(
                source_idea_id=idea_id,
                manuscript__workspace__owner=request.user,
            )
            .first()
        )
        if existing is not None:
            if existing.manuscript.public_id != manuscript_id:
                return JsonResponse(
                    {
                        "error": "idea_already_attached",
                        **_attached_payload(existing, already_attached=True),
                    },
                    status=409,
                )
            return JsonResponse(_attached_payload(existing, already_attached=True))

        manuscript = (
            Manuscript.objects.filter(
                public_id=manuscript_id,
                workspace__owner=request.user,
            )
            .first()
        )
        if manuscript is None:
            return JsonResponse({"error": "idea_target_not_found"}, status=404)
        item = (
            IdeaItem.objects.select_for_update()
            .filter(owner=request.user, public_id=idea_id)
            .first()
        )
        if item is None:
            existing = (
                ManuscriptNote.objects.select_related("manuscript")
                .filter(
                    source_idea_id=idea_id,
                    manuscript__workspace__owner=request.user,
                )
                .first()
            )
            if existing is not None:
                if existing.manuscript.public_id != manuscript_id:
                    return JsonResponse(
                        {
                            "error": "idea_already_attached",
                            **_attached_payload(existing, already_attached=True),
                        },
                        status=409,
                    )
                return JsonResponse(_attached_payload(existing, already_attached=True))
            return JsonResponse({"error": "idea_not_found"}, status=404)
        if item.kind not in {IdeaItem.KIND_TEXT, IdeaItem.KIND_AUDIO}:
            return JsonResponse({"error": "idea_attach_unsupported"}, status=400)
        if item.kind == IdeaItem.KIND_TEXT:
            if not item.title and not item.text.strip():
                return JsonResponse({"error": "idea_empty"}, status=400)
            content = plain_text_to_note_content(item.text)
            try:
                validate_note_content(content, allow_task_lists=True)
            except InvalidNote as exc:
                return JsonResponse({"error": str(exc)}, status=400)
            note_kind = ManuscriptNote.KIND_TEXT
        else:
            recording = (
                AudioRecording.objects.select_for_update()
                .filter(idea=item)
                .first()
            )
            if recording is None or not recording.file:
                return JsonResponse({"error": "audio_file_not_found"}, status=404)
            content = ManuscriptNote.EMPTY_CONTENT
            note_kind = ManuscriptNote.KIND_AUDIO
        note = ManuscriptNote.objects.create(
            manuscript=manuscript,
            source_idea_id=item.public_id,
            kind=note_kind,
            title=item.title.strip(),
            content=content,
            schema_version=ManuscriptNote.CURRENT_SCHEMA_VERSION,
            color="blue",
        )
        if item.kind == IdeaItem.KIND_AUDIO:
            recording.note = note
            recording.idea = None
            recording.save(update_fields=["note", "idea", "updated_at"])
        item.delete()
        record_tier_activity(request.user)

    write_audit_event(
        request,
        "idea.attached",
        actor=request.user,
        subject=f"idea:{idea_id}",
        payload={
            "kind": item.kind,
            "manuscriptId": str(manuscript.public_id),
            "noteId": str(note.public_id),
        },
    )
    return JsonResponse(_attached_payload(note, already_attached=False), status=201)


@require_http_methods(["GET", "PATCH", "DELETE"])
def idea_detail(request, idea_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    item = (
        IdeaItem.objects.filter(owner=request.user, public_id=idea_id)
        .select_related("image_media", "audio")
        .first()
    )
    if item is None:
        return JsonResponse({"error": "idea_not_found"}, status=404)
    if request.method == "GET":
        return JsonResponse({"item": _idea_payload(item, detail=True)})

    if request.method == "PATCH":
        payload = _read_json(request)
        if payload is None:
            return JsonResponse({"error": "invalid_json"}, status=400)
        if item.kind == IdeaItem.KIND_TEXT:
            try:
                title, text, expected = _validated_text_fields(payload, updating=True)
            except ValueError as exc:
                return JsonResponse({"error": str(exc)}, status=400)
        elif item.kind in {IdeaItem.KIND_IMAGE, IdeaItem.KIND_AUDIO}:
            try:
                title, expected = _validated_title_update(payload)
            except ValueError as exc:
                return JsonResponse({"error": str(exc)}, status=400)
            text = item.text
        else:
            return JsonResponse({"error": "idea_update_invalid"}, status=400)
        with transaction.atomic():
            locked = (
                IdeaItem.objects.select_for_update()
                .filter(owner=request.user, public_id=idea_id, kind=item.kind)
                .first()
            )
            if locked is None:
                return JsonResponse({"error": "idea_not_found"}, status=404)
            if expected != locked.save_generation:
                return JsonResponse(
                    {
                        "error": "idea_update_conflict",
                        "saveGeneration": locked.save_generation,
                    },
                    status=409,
                )
            changed = locked.title != title or locked.text != text
            if changed:
                locked.title = title
                locked.text = text
                locked.save_generation += 1
                locked.save(update_fields=["title", "text", "save_generation", "updated_at"])
                record_tier_activity(request.user)
        if changed:
            write_audit_event(
                request,
                "idea.updated",
                actor=request.user,
                subject=f"idea:{idea_id}",
                payload={"kind": item.kind},
            )
        locked = IdeaItem.objects.select_related("image_media", "audio").get(id=locked.id)
        return JsonResponse({"item": _idea_payload(locked, detail=True)})

    media_id = item.image_media_id
    with transaction.atomic():
        locked = (
            IdeaItem.objects.select_for_update()
            .filter(owner=request.user, public_id=idea_id)
            .first()
        )
        if locked is None:
            return JsonResponse({"error": "idea_not_found"}, status=404)
        locked.delete()
        record_tier_activity(request.user)
    if media_id is not None:
        delete_user_media_if_unreferenced(request.user, media_id)
    write_audit_event(
        request,
        "idea.deleted",
        actor=request.user,
        subject=f"idea:{idea_id}",
        payload={"kind": item.kind},
    )
    return JsonResponse({})


def _owned_audio_idea(idea_id, user):
    return (
        IdeaItem.objects.filter(
            owner=user,
            public_id=idea_id,
            kind=IdeaItem.KIND_AUDIO,
        )
        .select_related("audio")
        .first()
    )


@require_http_methods(["GET", "HEAD"])
def idea_audio_content(request, idea_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    item = _owned_audio_idea(idea_id, request.user)
    if item is None:
        return JsonResponse({"error": "idea_not_found"}, status=404)
    recording = getattr(item, "audio", None)
    if recording is None or not recording.file:
        return JsonResponse({"error": "audio_file_not_found"}, status=404)
    return audio_content_response(request, recording, title=item.title)


@require_http_methods(["GET", "POST", "DELETE"])
def idea_audio_transcription(request, idea_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    item = _owned_audio_idea(idea_id, request.user)
    if item is None:
        return JsonResponse({"error": "idea_not_found"}, status=404)
    recording = getattr(item, "audio", None)
    if recording is None or not recording.file:
        return JsonResponse({"error": "audio_file_not_found"}, status=404)
    if request.method == "GET":
        return JsonResponse({"transcription": transcription_payload(recording)})
    try:
        if request.method == "POST":
            state = queue_audio_transcription(recording)
            write_audit_event(
                request,
                "idea.audio_transcription_requested",
                actor=request.user,
                subject=f"idea:{item.public_id}",
                payload={"generation": state.generation},
            )
            return JsonResponse(
                {"transcription": transcription_payload(state.audio)},
                status=202,
            )
        deleted = delete_audio_transcription(recording)
    except TranscriptionRequestError as exc:
        return JsonResponse({"error": exc.code}, status=exc.status)
    if deleted:
        write_audit_event(
            request,
            "idea.audio_transcription_deleted",
            actor=request.user,
            subject=f"idea:{item.public_id}",
            payload={},
        )
    recording.refresh_from_db()
    return JsonResponse({"transcription": transcription_payload(recording)})
