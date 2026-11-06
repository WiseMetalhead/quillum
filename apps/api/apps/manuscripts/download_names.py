from __future__ import annotations

import re
from pathlib import PurePosixPath
from urllib.parse import quote


def safe_download_name(value: str, *, fallback: str) -> str:
    cleaned = re.sub(r'[\\/\x00-\x1f\x7f<>:"|?*]+', "_", value).strip(" ._")
    return cleaned[:80] or fallback


def content_disposition(file_name: str, *, fallback: str) -> str:
    safe_name = PurePosixPath(safe_download_name(file_name, fallback=fallback)).name
    suffix = PurePosixPath(safe_name).suffix
    stem = safe_name[: -len(suffix)] if suffix else safe_name
    ascii_stem = stem.encode("ascii", "ignore").decode("ascii")
    ascii_stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", ascii_stem).strip(" ._")
    if not ascii_stem or ascii_stem.startswith("."):
        ascii_stem = fallback
    ascii_suffix = re.sub(r"[^A-Za-z0-9.]", "", suffix)
    ascii_name = f"{ascii_stem}{ascii_suffix}"
    ascii_name = ascii_name.replace("\\", "\\\\").replace('"', r'\"')
    encoded_name = quote(safe_name)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"
