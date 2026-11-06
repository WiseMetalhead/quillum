from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from uuid import uuid4

from django.core.files.base import ContentFile
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_COVER_BYTES = 25 * 1024 * 1024
MAX_COVER_PIXELS = 60_000_000
ALLOWED_COVER_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
FORMAT_CONTENT_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
ALLOWED_COVER_FORMATS = tuple(FORMAT_CONTENT_TYPES)
FORMAT_EXTENSIONS = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}
THUMBNAIL_SIZES = {"small": 256, "medium": 512}


class InvalidCover(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ProcessedCover:
    original: ContentFile
    content_type: str
    width: int
    height: int
    thumbnails: dict[str, ContentFile]


def _save_original(image: Image.Image, image_format: str) -> ContentFile:
    output = BytesIO()
    if image_format == "JPEG":
        if image.mode != "RGB":
            background = Image.new("RGB", image.size, "white")
            if image.mode == "RGBA":
                background.paste(image, mask=image.getchannel("A"))
            else:
                background.paste(image.convert("RGB"))
            image = background
        image.save(output, format="JPEG", quality=95, subsampling=0, optimize=True)
    elif image_format == "PNG":
        image.save(output, format="PNG", optimize=True)
    else:
        image.save(output, format="WEBP", lossless=True, method=6)
    extension = FORMAT_EXTENSIONS[image_format]
    return ContentFile(output.getvalue(), name=f"{uuid4().hex}.{extension}")


def _thumbnail(image: Image.Image, max_dimension: int) -> ContentFile:
    thumbnail = image.copy()
    thumbnail.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
    if thumbnail.mode not in {"RGB", "RGBA"}:
        thumbnail = thumbnail.convert("RGBA" if "A" in thumbnail.getbands() else "RGB")
    output = BytesIO()
    thumbnail.save(output, format="WEBP", quality=84, method=6)
    return ContentFile(output.getvalue(), name=f"{uuid4().hex}.webp")


def process_cover(uploaded_file, *, max_bytes: int = MAX_COVER_BYTES) -> ProcessedCover:
    if uploaded_file.size > max_bytes:
        raise InvalidCover("cover_too_large")
    if uploaded_file.content_type not in ALLOWED_COVER_CONTENT_TYPES:
        raise InvalidCover("cover_type_unsupported")
    try:
        image = Image.open(uploaded_file, formats=ALLOWED_COVER_FORMATS)
        if image.width * image.height > MAX_COVER_PIXELS:
            raise InvalidCover("cover_dimensions_too_large")
        image.verify()
        uploaded_file.seek(0)
        image = Image.open(uploaded_file, formats=ALLOWED_COVER_FORMATS)
        image_format = image.format
        if image_format not in FORMAT_CONTENT_TYPES:
            raise InvalidCover("cover_type_unsupported")
        if getattr(image, "is_animated", False):
            raise InvalidCover("cover_animated_unsupported")
        image = ImageOps.exif_transpose(image)
        image.load()
        width, height = image.size
        original = _save_original(image, image_format)
        thumbnails = {
            name: _thumbnail(image, max_dimension)
            for name, max_dimension in THUMBNAIL_SIZES.items()
        }
    except InvalidCover:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise InvalidCover("cover_invalid_image") from exc
    return ProcessedCover(
        original=original,
        content_type=FORMAT_CONTENT_TYPES[image_format],
        width=width,
        height=height,
        thumbnails=thumbnails,
    )
