from __future__ import annotations

from collections.abc import Callable
from hashlib import sha256
from io import BytesIO

from django.http import FileResponse, HttpRequest, HttpResponse, HttpResponseNotModified
from django.utils.http import parse_etags, quote_etag

PRESENTATION_MEDIA_CACHE_CONTROL = "private, no-cache"
PRIVATE_MEDIA_NO_STORE = "private, no-store"


def _etag(cache_key: str) -> str:
    return quote_etag(sha256(cache_key.encode("utf-8")).hexdigest())


def _etag_matches(request: HttpRequest, etag: str) -> bool:
    candidates = parse_etags(request.headers.get("If-None-Match", ""))
    return any(
        candidate == "*" or candidate.removeprefix("W/") == etag
        for candidate in candidates
    )


def private_media_response(
    request: HttpRequest,
    *,
    load_content: Callable[[], tuple[bytes, str]],
    cache_key: str | None = None,
) -> HttpResponse:
    etag = _etag(cache_key) if cache_key else None
    if etag and _etag_matches(request, etag):
        response = HttpResponseNotModified()
    else:
        content, content_type = load_content()
        response = FileResponse(BytesIO(content), content_type=content_type)

    response["Cache-Control"] = (
        PRESENTATION_MEDIA_CACHE_CONTROL if etag else PRIVATE_MEDIA_NO_STORE
    )
    if etag:
        response["ETag"] = etag
    response["X-Content-Type-Options"] = "nosniff"
    return response
