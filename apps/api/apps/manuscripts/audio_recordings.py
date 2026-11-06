from __future__ import annotations

import math
import re

import av
from django.http import HttpResponse, StreamingHttpResponse
from django.utils.http import content_disposition_header

from .models import AudioRecording

MAX_AUDIO_DURATION_MS = 60 * 60 * 1000
MAX_AUDIO_WAVEFORM_SAMPLES = 256
AUDIO_FORMATS = {
    "audio/webm": ("opus", "webm"),
    "audio/ogg": ("opus", "ogg"),
    "audio/mp4": ("aac", "m4a"),
}
IMPORTED_M4A_CONTENT_TYPES = {"audio/mp4", "audio/m4a", "audio/x-m4a"}
IMPORTED_AUDIO_SAMPLE_RATE = 8_000


def validate_audio_properties(payload: dict) -> tuple[int, list[int]]:
    duration_ms = payload.get("durationMs")
    if (
        not isinstance(duration_ms, int)
        or isinstance(duration_ms, bool)
        or not 1 <= duration_ms <= MAX_AUDIO_DURATION_MS
    ):
        raise ValueError("audio_duration_invalid")
    waveform = payload.get("waveform")
    if (
        not isinstance(waveform, list)
        or not 1 <= len(waveform) <= MAX_AUDIO_WAVEFORM_SAMPLES
        or any(
            not isinstance(sample, int)
            or isinstance(sample, bool)
            or not 0 <= sample <= 255
            for sample in waveform
        )
    ):
        raise ValueError("audio_waveform_invalid")
    return duration_ms, waveform


def validate_audio_upload(uploaded_file) -> tuple[str, str]:
    content_type = str(uploaded_file.content_type or "").split(";", 1)[0].strip().lower()
    audio_format = AUDIO_FORMATS.get(content_type)
    if audio_format is None:
        raise ValueError("audio_type_unsupported")
    header = uploaded_file.read(64 * 1024)
    uploaded_file.seek(0)
    valid = (
        (
            content_type == "audio/webm"
            and header.startswith(b"\x1aE\xdf\xa3")
            and (b"A_OPUS" in header or b"OpusHead" in header)
        )
        or (
            content_type == "audio/ogg"
            and header.startswith(b"OggS")
            and b"OpusHead" in header
        )
        or (
            content_type == "audio/mp4"
            and len(header) >= 8
            and header[4:8] == b"ftyp"
            and b"mp4a" in header
        )
    )
    if not valid:
        raise ValueError("audio_file_invalid")
    codec, extension = audio_format
    uploaded_file.name = f"audio-note.{extension}"
    return content_type, codec


def _waveform_level(values) -> int:
    if not values.size:
        return 0
    amplitudes = abs(values.astype("float64")) / 32768
    peak = float(amplitudes.max())
    rms = math.sqrt(float((amplitudes * amplitudes).mean()))
    strength = max(rms, peak * 0.25)
    noise_floor = 10 ** (-50 / 20)
    if strength <= noise_floor:
        return 0
    decibels = 20 * math.log10(strength)
    normalized = max(0, min(1, (decibels + 50) / 44))
    return round(normalized**0.85 * 255)


def _compressed_waveform(levels: list[int]) -> list[int]:
    if len(levels) <= MAX_AUDIO_WAVEFORM_SAMPLES:
        groups = ((level,) for level in levels)
    else:
        groups = (
            levels[
                index * len(levels) // MAX_AUDIO_WAVEFORM_SAMPLES :
                (index + 1) * len(levels) // MAX_AUDIO_WAVEFORM_SAMPLES
            ]
            for index in range(MAX_AUDIO_WAVEFORM_SAMPLES)
        )
    return [
        round(math.sqrt(sum(level * level for level in group) / len(group)))
        for group in groups
    ]


def validate_imported_m4a(uploaded_file) -> tuple[str, str, int, list[int]]:
    content_type = str(uploaded_file.content_type or "").split(";", 1)[0].strip().lower()
    if content_type not in IMPORTED_M4A_CONTENT_TYPES or not str(
        uploaded_file.name
    ).lower().endswith(".m4a"):
        raise ValueError("audio_type_unsupported")

    sample_count = 0
    frame_levels: list[int] = []
    max_samples = MAX_AUDIO_DURATION_MS * IMPORTED_AUDIO_SAMPLE_RATE // 1000
    duration_ms = 0
    try:
        with av.open(uploaded_file, mode="r") as container:
            audio_streams = list(container.streams.audio)
            if (
                not audio_streams
                or container.streams.video
                or audio_streams[0].codec_context.name != "aac"
            ):
                raise ValueError("audio_type_unsupported")
            audio_stream = audio_streams[0]
            if audio_stream.duration is not None and audio_stream.time_base is not None:
                duration_ms = round(float(audio_stream.duration * audio_stream.time_base) * 1000)
            elif container.duration is not None:
                duration_ms = round(container.duration * 1000 / av.time_base)
            if duration_ms > MAX_AUDIO_DURATION_MS:
                raise ValueError("audio_duration_invalid")
            resampler = av.AudioResampler(
                format="s16",
                layout="mono",
                rate=IMPORTED_AUDIO_SAMPLE_RATE,
            )
            for decoded in container.decode(audio_stream):
                for frame in resampler.resample(decoded):
                    sample_count += frame.samples
                    if sample_count > max_samples + IMPORTED_AUDIO_SAMPLE_RATE:
                        raise ValueError("audio_duration_invalid")
                    values = frame.to_ndarray()
                    frame_levels.append(_waveform_level(values))
            for frame in resampler.resample(None):
                sample_count += frame.samples
                if sample_count > max_samples + IMPORTED_AUDIO_SAMPLE_RATE:
                    raise ValueError("audio_duration_invalid")
                values = frame.to_ndarray()
                frame_levels.append(_waveform_level(values))
    except (av.FFmpegError, EOFError, OSError, OverflowError) as exc:
        raise ValueError("audio_file_invalid") from exc
    except ValueError:
        raise
    finally:
        uploaded_file.seek(0)

    if sample_count <= 0 or not frame_levels:
        raise ValueError("audio_file_invalid")
    duration_ms = duration_ms or round(sample_count * 1000 / IMPORTED_AUDIO_SAMPLE_RATE)
    if not 1 <= duration_ms <= MAX_AUDIO_DURATION_MS:
        raise ValueError("audio_duration_invalid")
    uploaded_file.name = "audio-note.m4a"
    uploaded_file.content_type = "audio/mp4"
    return "audio/mp4", "aac", duration_ms, _compressed_waveform(frame_levels)


def audio_extension(recording: AudioRecording) -> str:
    return AUDIO_FORMATS.get(recording.content_type, ("", "bin"))[1]


def _audio_chunks(field, start: int, length: int, chunk_size: int = 64 * 1024):
    file_handle = field.open("rb")
    try:
        file_handle.seek(start)
        remaining = length
        while remaining > 0:
            chunk = file_handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
    finally:
        file_handle.close()


def _requested_audio_range(value: str, size: int) -> tuple[int, int] | None:
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if match is None or size <= 0:
        return None
    raw_start, raw_end = match.groups()
    if not raw_start and not raw_end:
        return None
    if raw_start:
        start = int(raw_start)
        end = int(raw_end) if raw_end else size - 1
        if start >= size or end < start:
            return None
        return start, min(end, size - 1)
    suffix = int(raw_end)
    if suffix <= 0:
        return None
    return max(0, size - suffix), size - 1


def audio_content_response(request, recording: AudioRecording, *, title: str):
    size = recording.byte_size
    range_header = request.headers.get("Range")
    byte_range = _requested_audio_range(range_header, size) if range_header else None
    if range_header and byte_range is None:
        response = HttpResponse(status=416)
        response["Content-Range"] = f"bytes */{size}"
        response["Content-Length"] = "0"
    else:
        start, end = byte_range if byte_range is not None else (0, size - 1)
        length = end - start + 1
        if request.method == "HEAD":
            response = HttpResponse(
                status=206 if byte_range is not None else 200,
                content_type=recording.content_type,
            )
        else:
            response = StreamingHttpResponse(
                _audio_chunks(recording.file, start, length),
                status=206 if byte_range is not None else 200,
                content_type=recording.content_type,
            )
        response["Content-Length"] = str(length)
        if byte_range is not None:
            response["Content-Range"] = f"bytes {start}-{end}/{size}"
        filename = f"{title.strip() or 'audio-note'}.{audio_extension(recording)}"
        response["Content-Disposition"] = content_disposition_header(
            request.GET.get("download") == "1",
            filename,
        )
    response["Accept-Ranges"] = "bytes"
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response
