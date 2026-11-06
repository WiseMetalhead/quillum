from __future__ import annotations

import json
from uuid import UUID

from django.db import transaction
from django.db.models import F, Prefetch
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods

from apps.accounts.media import media_variant_bytes, media_variant_metadata
from apps.accounts.tiers import quota_violation
from apps.audit.service import write_audit_event
from config.media_responses import private_media_response

from .media_cache import cover_cache_version
from .metadata import (
    InvalidManuscriptMetadata,
    normalize_manuscript_genres,
    normalize_manuscript_language,
)
from .models import Manuscript, Series, SeriesMembership
from .quotas import (
    quota_response,
)
from .services import (
    InvalidStructure,
    create_book,
    create_imported_book,
    create_series,
    delete_series,
    update_manuscript_metadata,
    update_series_metadata,
)
from .text_import import InvalidTextImport, parse_import_plan
from .views import (
    SYNOPSIS_MAX_LENGTH,
    TITLE_MAX_LENGTH,
    _cover_media_from_request,
    manuscript_payload,
)


def _series_for_owner(series_id: int, user) -> Series | None:
    memberships = (
        SeriesMembership.objects.select_related("manuscript__workspace")
        .prefetch_related("manuscript__documents")
        .order_by(F("position").asc(nulls_last=True), "created_at")
    )
    return (
        Series.objects.filter(id=series_id, workspace__owner=user)
        .select_related("workspace", "cover_media__owner")
        .prefetch_related(Prefetch("memberships", queryset=memberships))
        .first()
    )


def _effective_updated_at(series: Series, memberships: list[SeriesMembership]):
    book_updates = [membership.manuscript.updated_at for membership in memberships]
    return max([series.updated_at, *book_updates])


def series_payload(series: Series) -> dict:
    memberships = list(series.memberships.all())
    has_cover = bool(series.cover_media_id)
    return {
        "id": str(series.public_id),
        "kind": "series",
        "title": series.title,
        "synopsis": series.synopsis,
        "bookCount": len(memberships),
        "coverThumbnailSmallUrl": (
            f"/api/manuscripts/series/{series.public_id}/cover/small/" if has_cover else ""
        ),
        "coverThumbnailMediumUrl": (
            f"/api/manuscripts/series/{series.public_id}/cover/medium/" if has_cover else ""
        ),
        "coverVersion": cover_cache_version(series),
        "coverWidth": series.cover_width,
        "coverHeight": series.cover_height,
        "createdAt": series.created_at.isoformat(),
        "updatedAt": _effective_updated_at(series, memberships).isoformat(),
    }


def series_book_payload(membership: SeriesMembership) -> dict:
    return {
        **manuscript_payload(membership.manuscript),
        "seriesPosition": membership.position,
    }


def _validate_metadata(request, prefix: str):
    title = request.POST.get("title", "").strip()
    synopsis = request.POST.get("synopsis", "").strip()
    if not title:
        return None, JsonResponse({"error": f"{prefix}_title_required"}, status=400)
    if len(title) > TITLE_MAX_LENGTH:
        return None, JsonResponse({"error": f"{prefix}_title_too_long"}, status=400)
    if len(synopsis) > SYNOPSIS_MAX_LENGTH:
        return None, JsonResponse({"error": f"{prefix}_synopsis_too_long"}, status=400)
    if prefix == "book":
        try:
            language = normalize_manuscript_language(request.POST.get("language"))
            genres = normalize_manuscript_genres(request.POST.get("genres"))
        except InvalidManuscriptMetadata as exc:
            return None, JsonResponse({"error": exc.code}, status=400)
        return (title, synopsis, language, genres), None
    return (title, synopsis), None


def _position(value: object) -> tuple[int | None, bool]:
    normalized = str(value or "").strip()
    if not normalized:
        return None, True
    try:
        position = int(normalized)
    except (TypeError, ValueError):
        return None, False
    return (position, True) if position >= 1 else (None, False)


def _json_payload(request) -> dict | None:
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


@require_http_methods(["GET", "POST"])
def series_collection(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    if request.method == "GET":
        memberships = (
            SeriesMembership.objects.select_related("manuscript__workspace")
            .prefetch_related("manuscript__documents")
            .order_by(F("position").asc(nulls_last=True), "created_at")
        )
        items = (
            Series.objects.filter(workspace__owner=request.user, drawer_at__isnull=True)
            .select_related("workspace")
            .prefetch_related(Prefetch("memberships", queryset=memberships))
            .order_by("-updated_at")
        )
        return JsonResponse({"items": [series_payload(item) for item in items]})

    metadata, error = _validate_metadata(request, "series")
    if error is not None:
        return error
    cover, error = _cover_media_from_request(request)
    if error is not None:
        return error
    violation = quota_violation(request.user, "series")
    if violation is not None:
        return quota_response(violation)
    title, synopsis = metadata
    series = create_series(
        user=request.user,
        title=title,
        synopsis=synopsis,
        cover=cover,
    )
    write_audit_event(
        request,
        "manuscript.series_created",
        actor=request.user,
        subject=f"series:{series.public_id}",
        payload={},
    )
    series = _series_for_owner(series.id, request.user)
    return JsonResponse({"series": series_payload(series)}, status=201)


@require_http_methods(["GET", "POST", "DELETE"])
def series_detail(request, series_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    series = _series_for_owner(series_id, request.user)
    if series is None:
        return JsonResponse({"error": "series_not_found"}, status=404)

    if request.method == "DELETE":
        detached_books = [
            manuscript_payload(membership.manuscript) for membership in series.memberships.all()
        ]
        with transaction.atomic():
            delete_series(series)
            write_audit_event(
                request,
                "manuscript.series_deleted",
                actor=request.user,
                subject=f"series:{series_id}",
                payload={"detachedBookCount": len(detached_books)},
            )
        return JsonResponse({"books": detached_books})

    if request.method == "POST":
        metadata, error = _validate_metadata(request, "series")
        if error is not None:
            return error
        remove_cover = request.POST.get("removeCover") == "true"
        if (
            request.FILES.get("cover") is not None or request.POST.get("coverMediaId")
        ) and remove_cover:
            return JsonResponse({"error": "series_cover_update_invalid"}, status=400)
        cover, error = _cover_media_from_request(request, replacing_media=series.cover_media)
        if error is not None:
            return error
        title, synopsis = metadata
        update_series_metadata(
            series=series,
            title=title,
            synopsis=synopsis,
            cover=cover,
            remove_cover=remove_cover,
        )
        write_audit_event(
            request,
            "manuscript.series_updated",
            actor=request.user,
            subject=f"series:{series.public_id}",
            payload={"coverChanged": bool(cover or remove_cover)},
        )
        series = _series_for_owner(series.id, request.user)

    return JsonResponse(
        {
            "series": series_payload(series),
            "books": [series_book_payload(membership) for membership in series.memberships.all()],
        }
    )


@require_http_methods(["POST"])
def series_books(request, series_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    series = _series_for_owner(series_id, request.user)
    if series is None:
        return JsonResponse({"error": "series_not_found"}, status=404)
    metadata, error = _validate_metadata(request, "book")
    if error is not None:
        return error
    position, position_valid = _position(request.POST.get("seriesPosition"))
    if not position_valid:
        return JsonResponse({"error": "series_position_invalid"}, status=400)
    template = request.POST.get("template")
    raw_import_manifest = request.POST.get("importManifest")
    cover, error = _cover_media_from_request(request)
    if error is not None:
        return error
    violation = quota_violation(request.user, "books")
    if violation is not None:
        return quota_response(violation)
    title, synopsis, language, genres = metadata
    import_plan = None
    if raw_import_manifest:
        try:
            import_plan = parse_import_plan(
                raw_import_manifest,
                request.FILES,
                kind="book",
            )
        except InvalidTextImport as exc:
            return JsonResponse({"error": exc.code}, status=400)

    with transaction.atomic():
        locked_series = Series.objects.select_for_update().get(id=series.id)
        if (
            position is not None
            and SeriesMembership.objects.filter(series=locked_series, position=position).exists()
        ):
            return JsonResponse({"error": "series_position_duplicate"}, status=400)
        try:
            if import_plan is not None:
                manuscript = create_imported_book(
                    user=request.user,
                    title=title,
                    synopsis=synopsis,
                    cover=cover,
                    import_plan=import_plan,
                    language=language,
                    genres=genres,
                    series=locked_series,
                    series_position=position,
                )
            else:
                manuscript = create_book(
                    user=request.user,
                    title=title,
                    synopsis=synopsis,
                    template=template,
                    cover=cover,
                    language=request.user.language,
                    manuscript_language=language,
                    genres=genres,
                    series=locked_series,
                    series_position=position,
                )
        except InvalidStructure as exc:
            return JsonResponse({"error": exc.code}, status=400)
        Series.objects.filter(id=locked_series.id).update(updated_at=timezone.now())

    membership = (
        SeriesMembership.objects.select_related("manuscript__workspace")
        .prefetch_related("manuscript__documents")
        .get(manuscript=manuscript)
    )
    write_audit_event(
        request,
        "manuscript.series_book_created",
        actor=request.user,
        subject=f"manuscript:{manuscript.public_id}",
        payload={
            "seriesId": str(series.public_id),
            "position": position,
            "imported": bool(raw_import_manifest),
        },
    )
    return JsonResponse({"book": series_book_payload(membership)}, status=201)


@require_http_methods(["POST"])
def series_book_detail(request, series_id: int, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    membership = (
        SeriesMembership.objects.filter(
            series_id=series_id,
            manuscript_id=manuscript_id,
            series__workspace__owner=request.user,
            manuscript__kind=Manuscript.KIND_BOOK,
        )
        .select_related("series__workspace", "manuscript__workspace")
        .prefetch_related("manuscript__documents")
        .first()
    )
    if membership is None:
        return JsonResponse({"error": "series_book_not_found"}, status=404)
    metadata, error = _validate_metadata(request, "book")
    if error is not None:
        return error
    position, position_valid = _position(request.POST.get("seriesPosition"))
    if not position_valid:
        return JsonResponse({"error": "series_position_invalid"}, status=400)
    remove_cover = request.POST.get("removeCover") == "true"
    if (
        request.FILES.get("cover") is not None or request.POST.get("coverMediaId")
    ) and remove_cover:
        return JsonResponse({"error": "manuscript_cover_update_invalid"}, status=400)
    cover, error = _cover_media_from_request(
        request, replacing_media=membership.manuscript.cover_media
    )
    if error is not None:
        return error
    title, synopsis, language, genres = metadata

    with transaction.atomic():
        Series.objects.select_for_update().get(id=series_id)
        if position is not None and (
            SeriesMembership.objects.filter(series_id=series_id, position=position)
            .exclude(id=membership.id)
            .exists()
        ):
            return JsonResponse({"error": "series_position_duplicate"}, status=400)
        membership.position = position
        membership.save(update_fields=["position", "updated_at"])
        update_manuscript_metadata(
            manuscript=membership.manuscript,
            title=title,
            synopsis=synopsis,
            cover=cover,
            remove_cover=remove_cover,
            language=language,
            genres=genres,
        )
        Series.objects.filter(id=series_id).update(updated_at=timezone.now())

    membership.manuscript.refresh_from_db()
    write_audit_event(
        request,
        "manuscript.series_book_updated",
        actor=request.user,
        subject=f"manuscript:{manuscript_id}",
        payload={"seriesId": str(membership.series.public_id), "position": position},
    )
    return JsonResponse({"book": series_book_payload(membership)})


@require_http_methods(["PUT", "DELETE"])
def book_series_membership(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    book = (
        Manuscript.objects.filter(
            id=manuscript_id,
            workspace__owner=request.user,
            kind=Manuscript.KIND_BOOK,
        )
        .select_related("workspace")
        .prefetch_related("documents")
        .first()
    )
    if book is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    if request.method == "DELETE":
        with transaction.atomic():
            locked_book = Manuscript.objects.select_for_update().get(id=book.id)
            membership = (
                SeriesMembership.objects.select_for_update()
                .select_related("series")
                .filter(
                    manuscript=locked_book,
                    series__workspace__owner=request.user,
                )
                .first()
            )
            if membership is None:
                return JsonResponse({"error": "series_membership_not_found"}, status=404)
            series_id = membership.series_id
            series_public_id = membership.series.public_id
            if membership.series.drawer_at is not None:
                locked_book.drawer_at = membership.series.drawer_at
                locked_book.save(update_fields=["drawer_at"])
            membership.delete()
            Series.objects.filter(id=series_id).update(updated_at=timezone.now())
        write_audit_event(
            request,
            "manuscript.series_book_removed",
            actor=request.user,
            subject=f"manuscript:{book.public_id}",
            payload={"seriesId": str(series_public_id)},
        )
        return JsonResponse({"book": manuscript_payload(book)})

    payload = _json_payload(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        series_public_id = UUID(str(payload.get("seriesId", "")))
    except (TypeError, ValueError):
        return JsonResponse({"error": "series_target_invalid"}, status=400)
    position, position_valid = _position(payload.get("seriesPosition"))
    if not position_valid:
        return JsonResponse({"error": "series_position_invalid"}, status=400)

    with transaction.atomic():
        locked_book = Manuscript.objects.select_for_update().get(id=book.id)
        if SeriesMembership.objects.filter(manuscript=locked_book).exists():
            return JsonResponse({"error": "series_membership_exists"}, status=400)
        series = (
            Series.objects.select_for_update()
            .filter(public_id=series_public_id, workspace__owner=request.user)
            .first()
        )
        if series is None:
            return JsonResponse({"error": "series_not_found"}, status=404)
        if (
            position is not None
            and SeriesMembership.objects.filter(
                series=series,
                position=position,
            ).exists()
        ):
            return JsonResponse({"error": "series_position_duplicate"}, status=400)
        membership = SeriesMembership.objects.create(
            series=series,
            manuscript=locked_book,
            position=position,
        )
        if locked_book.drawer_at is not None:
            locked_book.drawer_at = None
            locked_book.save(update_fields=["drawer_at"])
        Series.objects.filter(id=series.id).update(updated_at=timezone.now())

    membership = (
        SeriesMembership.objects.select_related("manuscript__workspace")
        .prefetch_related("manuscript__documents")
        .get(id=membership.id)
    )
    series = _series_for_owner(series.id, request.user)
    write_audit_event(
        request,
        "manuscript.series_book_added",
        actor=request.user,
        subject=f"manuscript:{book.public_id}",
        payload={"seriesId": str(series.public_id), "position": position},
    )
    return JsonResponse(
        {
            "book": series_book_payload(membership),
            "series": series_payload(series),
        }
    )


@require_GET
def series_cover_content(request, series_id: int, variant: str):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    series = (
        Series.objects.filter(id=series_id, workspace__owner=request.user)
        .select_related("workspace", "cover_media__owner")
        .first()
    )
    if series is None:
        return JsonResponse({"error": "series_not_found"}, status=404)
    if not series.cover_media_id:
        return JsonResponse({"error": "cover_not_found"}, status=404)
    metadata = media_variant_metadata(series.cover_media, variant)
    if metadata is None:
        return JsonResponse({"error": "cover_variant_not_found"}, status=404)
    return private_media_response(
        request,
        cache_key=(
            None
            if variant == "original"
            else (
                f"user-media:{series.cover_media.public_id}:"
                f"{series.cover_media.content_hash}:{metadata[1]}"
            )
        ),
        load_content=lambda: media_variant_bytes(series.cover_media, variant),
    )
