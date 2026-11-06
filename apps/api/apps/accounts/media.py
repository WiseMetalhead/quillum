from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256

from django.core.files.base import ContentFile
from django.db import IntegrityError

from apps.manuscripts.assets import InvalidAsset, process_asset
from apps.manuscripts.covers import InvalidCover, process_cover

from .models import UserMediaAsset


@dataclass(frozen=True)
class ProcessedUserMedia:
    original: ContentFile
    thumbnail_small: ContentFile
    thumbnail_medium: ContentFile
    editor_medium: ContentFile
    editor_large: ContentFile
    content_type: str
    width: int
    height: int
    content_hash: str


def process_user_media(uploaded_file, *, max_bytes: int) -> ProcessedUserMedia:
    """Normalize an image once and create every private presentation variant."""
    try:
        asset = process_asset(uploaded_file, max_bytes=max_bytes)
        uploaded_file.seek(0)
        cover = process_cover(uploaded_file, max_bytes=max_bytes)
    except InvalidCover as exc:
        raise InvalidAsset(exc.code.replace("cover_", "asset_")) from exc
    original_data = asset.original.read()
    asset.original.seek(0)
    return ProcessedUserMedia(
        original=asset.original,
        thumbnail_small=cover.thumbnails["small"],
        thumbnail_medium=cover.thumbnails["medium"],
        editor_medium=asset.variants["medium"],
        editor_large=asset.variants["large"],
        content_type=asset.content_type,
        width=asset.width,
        height=asset.height,
        content_hash=sha256(original_data).hexdigest(),
    )


def media_total_size(media: UserMediaAsset) -> int:
    total = 0
    for field_name in (
        "original",
        "thumbnail_small",
        "thumbnail_medium",
        "editor_medium",
        "editor_large",
    ):
        field = getattr(media, field_name)
        if field:
            try:
                total += int(field.size or 0)
            except (OSError, ValueError):
                pass
    return total


def processed_user_media_size(processed: ProcessedUserMedia) -> int:
    return sum(
        source.size
        for source in (
            processed.original,
            processed.thumbnail_small,
            processed.thumbnail_medium,
            processed.editor_medium,
            processed.editor_large,
        )
    )


def _save_file(field, *, source: ContentFile) -> None:
    copied = ContentFile(source.read(), name=source.name)
    field.save(copied.name, copied, save=False)


def create_or_get_user_media(*, user, processed: ProcessedUserMedia) -> tuple[UserMediaAsset, bool]:
    existing = UserMediaAsset.objects.filter(
        owner=user, content_hash=processed.content_hash
    ).first()
    if existing is not None:
        return existing, False

    media = UserMediaAsset(
        owner=user,
        content_hash=processed.content_hash,
        content_type=processed.content_type,
        width=processed.width,
        height=processed.height,
        byte_size=processed.original.size,
    )
    stored_files: list[tuple[object, str]] = []
    try:
        for field_name, source in (
            ("original", processed.original),
            ("thumbnail_small", processed.thumbnail_small),
            ("thumbnail_medium", processed.thumbnail_medium),
            ("editor_medium", processed.editor_medium),
            ("editor_large", processed.editor_large),
        ):
            field = getattr(media, field_name)
            _save_file(field, source=source)
            stored_files.append((field.storage, field.name))
        media.save()
        return media, True
    except IntegrityError:
        for storage, name in stored_files:
            storage.delete(name)
        return UserMediaAsset.objects.get(owner=user, content_hash=processed.content_hash), False
    except Exception:
        for storage, name in stored_files:
            storage.delete(name)
        raise


def _media_variant(media: UserMediaAsset, variant: str):
    return {
        "original": (media.original, media.content_type, "original"),
        "small": (media.thumbnail_small, "image/webp", "small"),
        "medium": (media.thumbnail_medium, "image/webp", "medium"),
        "editor-medium": (media.editor_medium, "image/webp", "editor-medium"),
        "editor-large": (media.editor_large, "image/webp", "editor-large"),
        "large": (media.editor_large, "image/webp", "editor-large"),
    }.get(variant)


def media_variant_metadata(media: UserMediaAsset, variant: str) -> tuple[str, str] | None:
    selected = _media_variant(media, variant)
    if selected is None:
        return None
    stored_file, content_type, variant_name = selected
    if not stored_file:
        return None
    return content_type, variant_name


def media_variant_bytes(media: UserMediaAsset, variant: str) -> tuple[bytes, str] | None:
    selected = _media_variant(media, variant)
    if selected is None:
        return None
    stored_file, content_type, _variant_name = selected
    if not stored_file:
        return None
    with stored_file.open("rb") as stored_stream:
        data = stored_stream.read()
    return data, content_type


def media_variant_file(media: UserMediaAsset, variant: str) -> ContentFile | None:
    value = media_variant_bytes(media, variant)
    if value is None:
        return None
    data, content_type = value
    extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(
        content_type, "bin"
    )
    return ContentFile(data, name=f"{media.public_id}.{extension}")
