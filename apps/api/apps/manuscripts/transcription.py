from __future__ import annotations

import ctypes
import gc
import hashlib
import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import BinaryIO

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.adminpanel.runtime_settings import runtime_setting
from apps.notifications.service import create_notification

from .models import AudioRecording, AudioTranscriptionState

logger = logging.getLogger(__name__)

TRANSCRIPTION_ENGINE = "faster-whisper"
TRANSCRIPTION_MODEL = "small"
TRANSCRIPTION_MODEL_REPOSITORY = "Systran/faster-whisper-small"
TRANSCRIPTION_MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
TRANSCRIPTION_MODEL_SHA256 = (
    "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"
)
TRANSCRIPTION_MODEL_SIZE = 483_546_902
TRANSCRIPTION_LANGUAGES = ("en", "ru")
ACTIVE_STATUSES = {
    AudioTranscriptionState.STATUS_QUEUED,
    AudioTranscriptionState.STATUS_PROCESSING,
}

_model = None


class TranscriptionRequestError(Exception):
    def __init__(self, code: str, *, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


class TranscriptionFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str


def transcription_feature_enabled() -> bool:
    return bool(runtime_setting("audio_transcription_enabled"))


def transcription_model_path() -> Path:
    return Path(settings.QUILLUM_TRANSCRIPTION_MODEL_PATH)


def transcription_model_ready() -> bool:
    model_path = transcription_model_path()
    model_file = model_path / "model.bin"
    try:
        stat = model_file.stat()
        if stat.st_size != TRANSCRIPTION_MODEL_SIZE:
            return False
        checksum = _model_checksum(str(model_file), stat.st_size, stat.st_mtime_ns)
    except OSError:
        return False
    return bool(
        checksum == TRANSCRIPTION_MODEL_SHA256
        and (model_path / "config.json").is_file()
        and (model_path / "tokenizer.json").is_file()
    )


@lru_cache(maxsize=4)
def _model_checksum(path: str, _size: int, _modified_ns: int) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def transcription_model_status_payload() -> dict:
    return {
        "engine": TRANSCRIPTION_ENGINE,
        "model": TRANSCRIPTION_MODEL,
        "languages": list(TRANSCRIPTION_LANGUAGES),
        "ready": transcription_model_ready(),
    }


def _iso(value):
    return value.isoformat() if value is not None else None


def transcription_payload(recording: AudioRecording) -> dict:
    state = getattr(recording, "transcription", None)
    return {
        "featureEnabled": transcription_feature_enabled(),
        "status": state.status if state is not None else "none",
        "text": state.text if state is not None and state.text else None,
        "hasText": bool(state is not None and state.text),
        "language": state.language if state is not None and state.language else None,
        "errorCode": state.error_code if state is not None and state.error_code else None,
        "requestedAt": _iso(state.requested_at) if state is not None else None,
        "startedAt": _iso(state.started_at) if state is not None else None,
        "finishedAt": _iso(state.finished_at) if state is not None else None,
        "textUpdatedAt": _iso(state.text_updated_at) if state is not None else None,
    }


def _enqueue_worker() -> None:
    from .tasks import process_audio_transcription_queue

    try:
        process_audio_transcription_queue.delay()
    except Exception:
        logger.exception("Unable to enqueue the audio transcription worker")


def queue_audio_transcription(recording: AudioRecording) -> AudioTranscriptionState:
    if not transcription_feature_enabled():
        raise TranscriptionRequestError("audio_transcription_disabled")
    if recording.note_id and recording.note.trashed_at is not None:
        raise TranscriptionRequestError("audio_transcription_note_trashed")
    if not transcription_model_ready():
        raise TranscriptionRequestError(
            "audio_transcription_model_unavailable",
            status=503,
        )

    with transaction.atomic():
        locked_recording = (
            AudioRecording.objects.select_for_update(of=("self",))
            .select_related("note", "idea")
            .get(pk=recording.pk)
        )
        if locked_recording.note_id and locked_recording.note.trashed_at is not None:
            raise TranscriptionRequestError("audio_transcription_note_trashed")
        state = (
            AudioTranscriptionState.objects.select_for_update()
            .filter(audio=locked_recording)
            .first()
        )
        if state is not None and state.status in ACTIVE_STATUSES:
            raise TranscriptionRequestError("audio_transcription_in_progress")

        now = timezone.now()
        if state is None:
            state = AudioTranscriptionState.objects.create(
                audio=locked_recording,
                status=AudioTranscriptionState.STATUS_QUEUED,
                requested_at=now,
            )
        else:
            state.status = AudioTranscriptionState.STATUS_QUEUED
            state.generation += 1
            state.task_id = ""
            state.error_code = ""
            state.requested_at = now
            state.started_at = None
            state.finished_at = None
            state.save(
                update_fields=[
                    "status",
                    "generation",
                    "task_id",
                    "error_code",
                    "requested_at",
                    "started_at",
                    "finished_at",
                    "updated_at",
                ]
            )
        transaction.on_commit(_enqueue_worker)
        return state


def delete_audio_transcription(recording: AudioRecording) -> bool:
    with transaction.atomic():
        locked_recording = AudioRecording.objects.select_for_update().get(pk=recording.pk)
        state = (
            AudioTranscriptionState.objects.select_for_update()
            .filter(audio=locked_recording)
            .first()
        )
        if state is None:
            return False
        if state.status in ACTIVE_STATUSES:
            raise TranscriptionRequestError("audio_transcription_delete_in_progress")
        state.delete()
        return True


def queued_transcriptions_exist() -> bool:
    return AudioTranscriptionState.objects.filter(
        status=AudioTranscriptionState.STATUS_QUEUED
    ).exists()


def _claim_next_transcription(task_id: str) -> tuple[int, int] | None:
    with transaction.atomic():
        resumed = (
            AudioTranscriptionState.objects.select_for_update()
            .filter(
                status=AudioTranscriptionState.STATUS_PROCESSING,
                task_id=task_id,
            )
            .first()
        )
        if resumed is not None:
            return resumed.pk, resumed.generation

        if AudioTranscriptionState.objects.filter(
            status=AudioTranscriptionState.STATUS_PROCESSING
        ).exists():
            return None

        state = (
            AudioTranscriptionState.objects.select_for_update()
            .filter(status=AudioTranscriptionState.STATUS_QUEUED)
            .order_by("requested_at", "id")
            .first()
        )
        if state is None:
            return None
        state.status = AudioTranscriptionState.STATUS_PROCESSING
        state.task_id = task_id
        state.started_at = timezone.now()
        state.finished_at = None
        state.error_code = ""
        state.save(
            update_fields=[
                "status",
                "task_id",
                "started_at",
                "finished_at",
                "error_code",
                "updated_at",
            ]
        )
        return state.pk, state.generation


def _whisper_model():
    global _model
    if _model is not None:
        return _model
    if not transcription_model_ready():
        raise TranscriptionFailure("model_unavailable")

    from faster_whisper import WhisperModel

    _model = WhisperModel(
        str(transcription_model_path()),
        device="cpu",
        compute_type="int8",
        local_files_only=True,
    )
    return _model


def unload_transcription_model() -> bool:
    global _model
    model = _model
    if model is None:
        return False
    _model = None
    del model
    gc.collect()
    heap_trimmed = _trim_process_heap()
    logger.info(
        "Released the idle audio transcription model heap_trimmed=%s",
        heap_trimmed,
    )
    return True


def _trim_process_heap() -> bool:
    try:
        malloc_trim = ctypes.CDLL(None).malloc_trim
    except (AttributeError, OSError):
        return False
    malloc_trim.argtypes = [ctypes.c_size_t]
    malloc_trim.restype = ctypes.c_int
    return bool(malloc_trim(0))


def release_transcription_model_if_idle() -> bool:
    try:
        if queued_transcriptions_exist():
            return False
    except Exception:
        logger.exception("Unable to determine whether the transcription model is idle")
        return False
    return unload_transcription_model()


def transcribe_audio_file(file_handle: BinaryIO) -> TranscriptionResult:
    segments, info = _whisper_model().transcribe(
        file_handle,
        task="transcribe",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
    )
    language = str(info.language or "").lower()
    if language not in TRANSCRIPTION_LANGUAGES:
        raise TranscriptionFailure("unsupported_language")
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    if not text:
        raise TranscriptionFailure("no_speech")
    return TranscriptionResult(text=text, language=language)


def _completion_notification(state, *, success: bool, error_code: str = "") -> None:
    recording = state.audio
    if recording.idea_id:
        owner = recording.idea.owner
        title = recording.idea.title
        action_path = f"/ideas?item={recording.idea.public_id}&workspace=author"
    else:
        note = recording.note
        owner = note.manuscript.workspace.owner
        title = note.title
        action_path = (
            f"/manuscripts/{note.manuscript.public_id}/boards"
            f"?note={note.public_id}&workspace=author"
        )
    kind = (
        "service.audio_transcription_ready"
        if success
        else "service.audio_transcription_failed"
    )
    payload = {
        "noteTitle": title,
        "actionPath": action_path,
    }
    if error_code:
        payload["errorCode"] = error_code
    create_notification(
        recipient=owner,
        kind=kind,
        payload=payload,
        deduplication_key=(
            f"audio-transcription:{state.pk}:{state.generation}:"
            f"{'ready' if success else 'failed'}"
        ),
        email=False,
    )


def _complete_transcription(
    state_id: int,
    generation: int,
    result: TranscriptionResult,
) -> bool:
    with transaction.atomic():
        recording_id = (
            AudioTranscriptionState.objects.filter(pk=state_id)
            .values_list("audio_id", flat=True)
            .first()
        )
        if recording_id is None:
            return False
        recording = (
            AudioRecording.objects.select_for_update(of=("self",))
            .select_related("idea__owner", "note__manuscript__workspace__owner")
            .filter(pk=recording_id)
            .first()
        )
        if recording is None:
            return False
        state = (
            AudioTranscriptionState.objects.select_for_update()
            .filter(
                pk=state_id,
                audio=recording,
                generation=generation,
                status=AudioTranscriptionState.STATUS_PROCESSING,
            )
            .first()
        )
        if state is None:
            return False
        state.audio = recording
        now = timezone.now()
        state.status = AudioTranscriptionState.STATUS_READY
        state.text = result.text
        state.language = result.language
        state.error_code = ""
        state.finished_at = now
        state.text_updated_at = now
        state.save(
            update_fields=[
                "status",
                "text",
                "language",
                "error_code",
                "finished_at",
                "text_updated_at",
                "updated_at",
            ]
        )
        _completion_notification(state, success=True)
        return True


def _fail_transcription(state_id: int, generation: int, error_code: str) -> bool:
    with transaction.atomic():
        recording_id = (
            AudioTranscriptionState.objects.filter(pk=state_id)
            .values_list("audio_id", flat=True)
            .first()
        )
        if recording_id is None:
            return False
        recording = (
            AudioRecording.objects.select_for_update(of=("self",))
            .select_related("idea__owner", "note__manuscript__workspace__owner")
            .filter(pk=recording_id)
            .first()
        )
        if recording is None:
            return False
        state = (
            AudioTranscriptionState.objects.select_for_update()
            .filter(
                pk=state_id,
                audio=recording,
                generation=generation,
                status=AudioTranscriptionState.STATUS_PROCESSING,
            )
            .first()
        )
        if state is None:
            return False
        state.audio = recording
        state.status = AudioTranscriptionState.STATUS_FAILED
        state.error_code = error_code
        state.finished_at = timezone.now()
        state.save(
            update_fields=[
                "status",
                "error_code",
                "finished_at",
                "updated_at",
            ]
        )
        _completion_notification(
            state,
            success=False,
            error_code=error_code,
        )
        return True


def process_next_audio_transcription(task_id: str) -> bool:
    try:
        claimed = _claim_next_transcription(task_id)
        if claimed is None:
            return False
        state_id, generation = claimed
        try:
            state = AudioTranscriptionState.objects.select_related("audio").get(pk=state_id)
            with state.audio.file.open("rb") as file_handle:
                result = transcribe_audio_file(file_handle)
        except AudioTranscriptionState.DoesNotExist:
            return False
        except TranscriptionFailure as exc:
            _fail_transcription(state_id, generation, exc.code)
        except Exception:
            logger.exception(
                "Audio transcription failed state_id=%s generation=%s",
                state_id,
                generation,
            )
            _fail_transcription(state_id, generation, "transcription_failed")
        else:
            _complete_transcription(state_id, generation, result)
    finally:
        release_transcription_model_if_idle()
    return True
