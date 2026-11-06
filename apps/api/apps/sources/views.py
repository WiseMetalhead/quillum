from __future__ import annotations

import base64
import json
from datetime import UTC, datetime

from django.db import transaction
from django.db.models import Q
from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_http_methods

from apps.manuscripts.models import Manuscript

from .contest_recommendations import (
    contest_manuscript_payload,
    contest_manuscript_recommendations,
    contest_max_works,
)
from .models import (
    ContestDetail,
    ContestItem,
    ContestParticipation,
    ContestSourceSubscription,
    ContestStatus,
    NewsItem,
    NewsSourceSubscription,
    SourceSyncState,
)
from .registry import (
    CONTEST_SOURCE_BY_KEY,
    CONTEST_SOURCES,
    NEWS_SOURCE_BY_KEY,
    NEWS_SOURCES,
)

PAGE_SIZE = 20


def _authentication_error(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    return None


def _read_json(request):
    try:
        data = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _enabled_news_source_keys(user) -> set[str]:
    return set(
        NewsSourceSubscription.objects.filter(user=user, enabled=True).values_list(
            "source_key", flat=True
        )
    ) & set(NEWS_SOURCE_BY_KEY)


def has_enabled_news_sources(user) -> bool:
    return NewsSourceSubscription.objects.filter(
        user=user,
        enabled=True,
        source_key__in=NEWS_SOURCE_BY_KEY,
    ).exists()


def _enabled_contest_source_keys(user) -> set[str]:
    return set(
        ContestSourceSubscription.objects.filter(user=user, enabled=True).values_list(
            "source_key", flat=True
        )
    ) & set(CONTEST_SOURCE_BY_KEY)


def has_enabled_contest_sources(user) -> bool:
    return ContestSourceSubscription.objects.filter(
        user=user,
        enabled=True,
        source_key__in=CONTEST_SOURCE_BY_KEY,
    ).exists()


def _source_payload(source, enabled_keys: set[str], state_by_key: dict[str, SourceSyncState]):
    state = state_by_key.get(source.key)
    return {
        "key": source.key,
        "name": source.name,
        "websiteUrl": source.website_url,
        "enabled": source.key in enabled_keys,
        "lastSuccessfulSyncAt": (
            state.last_succeeded_at.isoformat() if state and state.last_succeeded_at else None
        ),
    }


@require_http_methods(["GET", "PATCH"])
def news_sources(request):
    if error := _authentication_error(request):
        return error

    if request.method == "GET":
        enabled_keys = _enabled_news_source_keys(request.user)
    else:
        data = _read_json(request)
        if data is None:
            return JsonResponse({"error": "invalid_json"}, status=400)
        selected = data.get("enabledSourceKeys")
        if not isinstance(selected, list) or any(not isinstance(key, str) for key in selected):
            return JsonResponse({"error": "news_sources_invalid"}, status=400)
        enabled_keys = set(selected)
        if len(enabled_keys) != len(selected) or not enabled_keys.issubset(NEWS_SOURCE_BY_KEY):
            return JsonResponse({"error": "news_sources_invalid"}, status=400)

        previously_enabled = _enabled_news_source_keys(request.user)
        with transaction.atomic():
            for source in NEWS_SOURCES:
                NewsSourceSubscription.objects.update_or_create(
                    user=request.user,
                    source_key=source.key,
                    defaults={"enabled": source.key in enabled_keys},
                )
            unsynced_keys = set(
                SourceSyncState.objects.filter(
                    source_key__in=enabled_keys,
                    last_succeeded_at__isnull=True,
                ).values_list("source_key", flat=True)
            )
            missing_state_keys = enabled_keys - set(
                SourceSyncState.objects.filter(source_key__in=enabled_keys).values_list(
                    "source_key", flat=True
                )
            )
            for source_key in (enabled_keys - previously_enabled) & (
                unsynced_keys | missing_state_keys
            ):
                from .tasks import sync_news_source

                transaction.on_commit(
                    lambda source_key=source_key: sync_news_source.delay(source_key)
                )

    states = SourceSyncState.objects.filter(source_key__in=NEWS_SOURCE_BY_KEY)
    state_by_key = {state.source_key: state for state in states}
    return JsonResponse(
        {
            "items": [
                _source_payload(source, enabled_keys, state_by_key) for source in NEWS_SOURCES
            ],
            "newsEnabled": bool(enabled_keys),
        }
    )


@require_http_methods(["GET", "PATCH"])
def contest_sources(request):
    if error := _authentication_error(request):
        return error

    if request.method == "GET":
        enabled_keys = _enabled_contest_source_keys(request.user)
    else:
        data = _read_json(request)
        if data is None:
            return JsonResponse({"error": "invalid_json"}, status=400)
        selected = data.get("enabledSourceKeys")
        if not isinstance(selected, list) or any(not isinstance(key, str) for key in selected):
            return JsonResponse({"error": "contest_sources_invalid"}, status=400)
        enabled_keys = set(selected)
        if len(enabled_keys) != len(selected) or not enabled_keys.issubset(CONTEST_SOURCE_BY_KEY):
            return JsonResponse({"error": "contest_sources_invalid"}, status=400)

        previously_enabled = _enabled_contest_source_keys(request.user)
        with transaction.atomic():
            for source in CONTEST_SOURCES:
                ContestSourceSubscription.objects.update_or_create(
                    user=request.user,
                    source_key=source.key,
                    defaults={"enabled": source.key in enabled_keys},
                )
            unsynced_keys = set(
                SourceSyncState.objects.filter(
                    source_key__in=enabled_keys,
                    last_succeeded_at__isnull=True,
                ).values_list("source_key", flat=True)
            )
            missing_state_keys = enabled_keys - set(
                SourceSyncState.objects.filter(source_key__in=enabled_keys).values_list(
                    "source_key", flat=True
                )
            )
            for source_key in (enabled_keys - previously_enabled) & (
                unsynced_keys | missing_state_keys
            ):
                from .tasks import sync_contest_source

                transaction.on_commit(
                    lambda source_key=source_key: sync_contest_source.delay(source_key)
                )

    states = SourceSyncState.objects.filter(source_key__in=CONTEST_SOURCE_BY_KEY)
    state_by_key = {state.source_key: state for state in states}
    return JsonResponse(
        {
            "items": [
                _source_payload(source, enabled_keys, state_by_key) for source in CONTEST_SOURCES
            ],
            "contestsEnabled": bool(enabled_keys),
        }
    )


def _encode_cursor(item: NewsItem) -> str:
    raw = f"{item.published_at.isoformat()}|{item.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(value: str) -> tuple[datetime, int] | None:
    try:
        padded = value + "=" * (-len(value) % 4)
        raw_date, raw_id = base64.urlsafe_b64decode(padded).decode().split("|", 1)
        parsed = datetime.fromisoformat(raw_date)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed, int(raw_id)
    except (ValueError, TypeError, UnicodeError):
        return None


def _news_item_payload(item: NewsItem) -> dict:
    source = NEWS_SOURCE_BY_KEY[item.source_key]
    return {
        "id": str(item.public_id),
        "source": {"key": source.key, "name": source.name},
        "title": item.title,
        "authorName": item.author_name,
        "summary": item.summary,
        "publishedAt": item.published_at.isoformat(),
        "sourceUrl": item.canonical_url,
    }


@require_GET
def news(request):
    if error := _authentication_error(request):
        return error
    enabled_keys = _enabled_news_source_keys(request.user)
    selected_source = request.GET.get("source", "").strip()
    if selected_source and selected_source not in NEWS_SOURCE_BY_KEY:
        return JsonResponse({"error": "news_source_invalid"}, status=400)
    if selected_source:
        enabled_keys &= {selected_source}

    queryset = NewsItem.objects.filter(source_key__in=enabled_keys)
    cursor_value = request.GET.get("cursor", "").strip()
    if cursor_value:
        cursor = _decode_cursor(cursor_value)
        if cursor is None:
            return JsonResponse({"error": "news_cursor_invalid"}, status=400)
        published_at, item_id = cursor
        queryset = queryset.filter(
            Q(published_at__lt=published_at) | Q(published_at=published_at, id__lt=item_id)
        )
    page = list(queryset[: PAGE_SIZE + 1])
    has_more = len(page) > PAGE_SIZE
    page = page[:PAGE_SIZE]
    return JsonResponse(
        {
            "items": [_news_item_payload(item) for item in page],
            "nextCursor": _encode_cursor(page[-1]) if has_more and page else None,
        }
    )


def _encode_contest_cursor(item: ContestItem) -> str:
    raw = f"{item.first_seen_at.isoformat()}|{item.source_position}|{item.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_contest_cursor(value: str) -> tuple[datetime, int, int] | None:
    try:
        padded = value + "=" * (-len(value) % 4)
        raw_date, raw_position, raw_id = base64.urlsafe_b64decode(padded).decode().split("|", 2)
        parsed = datetime.fromisoformat(raw_date)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed, int(raw_position), int(raw_id)
    except (ValueError, TypeError, UnicodeError):
        return None


def _contest_item_payload(item: ContestItem) -> dict:
    source = CONTEST_SOURCE_BY_KEY[item.source_key]
    try:
        detail = item.detail
    except ContestDetail.DoesNotExist:
        detail = None
    detail_state = "pending"
    if detail and detail.last_succeeded_at:
        detail_state = "ready"
    elif detail and detail.consecutive_failures:
        detail_state = "unavailable"
    return {
        "id": str(item.public_id),
        "source": {"key": source.key, "name": source.name},
        "title": item.title,
        "description": item.description,
        "status": item.status,
        "descriptionUrl": item.canonical_url,
        "discussionUrl": item.discussion_url or None,
        "terminalAction": (
            {"kind": item.action_kind, "url": item.action_url}
            if item.action_kind and item.action_url
            else None
        ),
        "detailState": detail_state,
    }


@require_GET
def contests(request):
    if error := _authentication_error(request):
        return error
    enabled_keys = _enabled_contest_source_keys(request.user)
    selected_source = request.GET.get("source", "").strip()
    if selected_source and selected_source not in CONTEST_SOURCE_BY_KEY:
        return JsonResponse({"error": "contest_source_invalid"}, status=400)
    if selected_source:
        enabled_keys &= {selected_source}

    queryset = ContestItem.objects.filter(source_key__in=enabled_keys).select_related("detail")
    selected_status = request.GET.get("status", "").strip()
    if selected_status and selected_status not in ContestStatus.values:
        return JsonResponse({"error": "contest_status_invalid"}, status=400)
    if selected_status:
        queryset = queryset.filter(status=selected_status)

    cursor_value = request.GET.get("cursor", "").strip()
    if cursor_value:
        cursor = _decode_contest_cursor(cursor_value)
        if cursor is None:
            return JsonResponse({"error": "contest_cursor_invalid"}, status=400)
        first_seen_at, source_position, item_id = cursor
        queryset = queryset.filter(
            Q(first_seen_at__lt=first_seen_at)
            | Q(first_seen_at=first_seen_at, source_position__gt=source_position)
            | Q(
                first_seen_at=first_seen_at,
                source_position=source_position,
                id__gt=item_id,
            )
        )
    page = list(queryset[: PAGE_SIZE + 1])
    has_more = len(page) > PAGE_SIZE
    page = page[:PAGE_SIZE]
    return JsonResponse(
        {
            "items": [_contest_item_payload(item) for item in page],
            "nextCursor": _encode_contest_cursor(page[-1]) if has_more and page else None,
        }
    )


@require_GET
def contest_detail(request, contest_public_id):
    if error := _authentication_error(request):
        return error
    enabled_keys = _enabled_contest_source_keys(request.user)
    try:
        contest = ContestItem.objects.select_related("detail").get(
            public_id=contest_public_id,
            source_key__in=enabled_keys,
        )
    except ContestItem.DoesNotExist:
        return JsonResponse({"error": "contest_not_found"}, status=404)

    try:
        detail = contest.detail
    except ContestDetail.DoesNotExist:
        detail = None
    if detail is None or detail.last_succeeded_at is None:
        return JsonResponse(
            {
                "id": str(contest.public_id),
                "state": "unavailable" if detail and detail.consecutive_failures else "pending",
                "phases": [],
                "conditionFacts": [],
                "conditionsSections": [],
                "recommendedManuscripts": [],
            }
        )

    recommendations = contest_manuscript_recommendations(contest, request.user)
    return JsonResponse(
        {
            "id": str(contest.public_id),
            "state": "ready",
            "isStale": detail.consecutive_failures > 0,
            "lastSuccessfulSyncAt": detail.last_succeeded_at.isoformat(),
            "phases": [
                {
                    "key": phase.key,
                    "kind": phase.kind,
                    "label": phase.label,
                    "rawText": phase.raw_text,
                    "startsOn": phase.starts_on.isoformat() if phase.starts_on else None,
                    "endsOn": phase.ends_on.isoformat() if phase.ends_on else None,
                    "deadlineAt": phase.deadline_at.isoformat() if phase.deadline_at else None,
                    "precision": phase.precision,
                    "sourceSection": phase.source_section,
                }
                for phase in detail.phases.all()
            ],
            "conditionFacts": detail.condition_facts,
            "conditionsSections": detail.conditions_sections,
            "recommendedManuscripts": [
                contest_manuscript_payload(item) for item in recommendations
            ],
        }
    )


def _contest_participation_payload(contest, user, participating):
    recommendations = contest_manuscript_recommendations(contest, user)
    return {
        "participating": participating,
        "recommendedManuscripts": [
            contest_manuscript_payload(item) for item in recommendations
        ],
    }


@require_http_methods(["PUT", "PATCH", "DELETE"])
def contest_participation(request, contest_public_id, manuscript_public_id):
    if error := _authentication_error(request):
        return error
    enabled_keys = _enabled_contest_source_keys(request.user)
    with transaction.atomic():
        try:
            contest = (
                ContestItem.objects.select_for_update()
                .get(public_id=contest_public_id, source_key__in=enabled_keys)
            )
        except ContestItem.DoesNotExist:
            return JsonResponse({"error": "contest_not_found"}, status=404)
        try:
            manuscript = Manuscript.objects.get(
                public_id=manuscript_public_id,
                workspace__owner=request.user,
            )
        except Manuscript.DoesNotExist:
            return JsonResponse({"error": "manuscript_not_found"}, status=404)

        participation = ContestParticipation.objects.filter(
            contest=contest,
            manuscript=manuscript,
        )
        if request.method == "DELETE":
            participation.delete()
            return JsonResponse(_contest_participation_payload(contest, request.user, False))
        if request.method == "PATCH":
            data = _read_json(request)
            if (
                data is None
                or set(data) != {"trackDeadlines"}
                or not isinstance(data["trackDeadlines"], bool)
            ):
                return JsonResponse({"error": "contest_tracking_invalid"}, status=400)
            updated = participation.update(track_deadlines=data["trackDeadlines"])
            if not updated:
                return JsonResponse({"error": "contest_participation_not_found"}, status=404)
            return JsonResponse(_contest_participation_payload(contest, request.user, True))
        if participation.exists():
            return JsonResponse(_contest_participation_payload(contest, request.user, True))
        if contest.status != ContestStatus.ACCEPTING:
            return JsonResponse({"error": "contest_not_accepting"}, status=409)
        if manuscript.drawer_at is not None:
            return JsonResponse({"error": "contest_manuscript_in_drawer"}, status=409)
        maximum = contest_max_works(contest)
        if maximum is not None and ContestParticipation.objects.filter(
            contest=contest,
            manuscript__workspace__owner=request.user,
        ).count() >= maximum:
            return JsonResponse({"error": "contest_participation_limit_reached"}, status=409)
        ContestParticipation.objects.create(contest=contest, manuscript=manuscript)
    return JsonResponse(_contest_participation_payload(contest, request.user, True))
