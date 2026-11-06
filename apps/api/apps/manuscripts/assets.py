from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from uuid import uuid4

from django.core.files.base import ContentFile
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_ASSET_BYTES = 25 * 1024 * 1024
MAX_ASSET_PIXELS = 60_000_000
ALLOWED_ASSET_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
FORMAT_CONTENT_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
ALLOWED_ASSET_FORMATS = tuple(FORMAT_CONTENT_TYPES)
FORMAT_EXTENSIONS = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}
EDITOR_SIZES = {"medium": 1280, "large": 2400}


class InvalidAsset(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ProcessedAsset:
    original: ContentFile
    variants: dict[str, ContentFile]
    content_type: str
    width: int
    height: int


def _normalized_original(image: Image.Image, image_format: str) -> ContentFile:
    output = BytesIO()
    if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    if image_format == "JPEG":
        if image.mode == "RGBA":
            background = Image.new("RGB", image.size, "white")
            background.paste(image, mask=image.getchannel("A"))
            image = background
        image.save(output, format="JPEG", quality=95, subsampling=0, optimize=True)
    elif image_format == "PNG":
        image.save(output, format="PNG", optimize=True)
    else:
        image.save(output, format="WEBP", lossless=True, method=6)
    return ContentFile(output.getvalue(), name=f"{uuid4().hex}.{FORMAT_EXTENSIONS[image_format]}")


def _webp_variant(image: Image.Image, max_dimension: int) -> ContentFile:
    variant = image.copy()
    variant.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
    if variant.mode not in {"RGB", "RGBA"}:
        variant = variant.convert("RGBA" if "A" in variant.getbands() else "RGB")
    output = BytesIO()
    variant.save(output, format="WEBP", quality=84, method=6)
    return ContentFile(output.getvalue(), name=f"{uuid4().hex}.webp")


def process_asset(uploaded_file, *, max_bytes: int = MAX_ASSET_BYTES) -> ProcessedAsset:
    if uploaded_file.size > max_bytes:
        raise InvalidAsset("asset_too_large")
    if uploaded_file.content_type not in ALLOWED_ASSET_CONTENT_TYPES:
        raise InvalidAsset("asset_type_unsupported")
    try:
        image = Image.open(uploaded_file, formats=ALLOWED_ASSET_FORMATS)
        if image.width * image.height > MAX_ASSET_PIXELS:
            raise InvalidAsset("asset_dimensions_too_large")
        image.verify()
        uploaded_file.seek(0)
        image = Image.open(uploaded_file, formats=ALLOWED_ASSET_FORMATS)
        image_format = image.format
        if image_format not in FORMAT_CONTENT_TYPES:
            raise InvalidAsset("asset_type_unsupported")
        if getattr(image, "is_animated", False):
            raise InvalidAsset("asset_animated_unsupported")
        image = ImageOps.exif_transpose(image)
        image.load()
        width, height = image.size
        original = _normalized_original(image, image_format)
        variants = {
            name: _webp_variant(image, dimension)
            for name, dimension in EDITOR_SIZES.items()
        }
    except InvalidAsset:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise InvalidAsset("asset_invalid_image") from exc
    return ProcessedAsset(
        original=original,
        variants=variants,
        content_type=FORMAT_CONTENT_TYPES[image_format],
        width=width,
        height=height,
    )
