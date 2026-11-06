from __future__ import annotations

import json
from datetime import timedelta
from urllib.parse import urlparse

from django.core.exceptions import ValidationError
from django.core.validators import URLValidator
from django.db.models import F, Q, Sum
from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_http_methods

from .media_cache import cover_cache_version
from .models import (
    Document,
    GlossaryArticle,
    Manuscript,
    ManuscriptNote,
    ManuscriptWritingDay,
    SeriesMembership,
)
from .planner import local_date
from .versioning import document_statistics

MAX_DASHBOARD_MEMO_LENGTH = 5_000
MAX_WORKSPACE_USEFUL_LINKS = 12
MAX_WORKSPACE_USEFUL_LINK_TITLE_LENGTH = 80
MAX_WORKSPACE_USEFUL_LINK_URL_LENGTH = 500
MIN_WORKSPACE_SEARCH_QUERY_LENGTH = 2
MAX_WORKSPACE_SEARCH_QUERY_LENGTH = 120
MAX_WORKSPACE_SEARCH_RESULTS_PER_KIND = 5
DASHBOARD_WIDGET_IDS = (
    "recentSessions",
    "statusProgress",
    "writingActivity",
    "dailyGoals",
    "memo",
)
url_validator = URLValidator(schemes=["http", "https"])


def normalize_dashboard_settings(value: object) -> dict:
    if not isinstance(value, dict):
        return {"widgetOrder": list(DASHBOARD_WIDGET_IDS), "hiddenWidgets": []}
    known = set(DASHBOARD_WIDGET_IDS)
    raw_order = value.get("widgetOrder", [])
    raw_hidden = value.get("hiddenWidgets", [])
    order = []
    if isinstance(raw_order, list):
        for item in raw_order:
            if item in known and item not in order:
                order.append(item)
    order.extend(item for item in DASHBOARD_WIDGET_IDS if item not in order)
    hidden = []
    if isinstance(raw_hidden, list):
        for item in raw_hidden:
            if item in known and item not in hidden:
                hidden.append(item)
    return {"widgetOrder": order, "hiddenWidgets": hidden}


def _manuscript_for_owner(manuscript_id: int, user):
    return (
        Manuscript.objects.filter(id=manuscript_id, workspace__owner=user)
        .select_related("workspace")
        .first()
    )


def _read_json(request):
    try:
        value = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _normalize_url(value: object) -> str:
    url = str(value or "").strip()
    if not url:
        return ""
    parsed = urlparse(url)
    if not parsed.scheme:
        url = f"https://{url}"
    return url


def _workspace_useful_links(user) -> list[dict]:
    value = user.workspace_useful_links
    if not isinstance(value, list):
        return []
    links = []
    for item in value:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        url = str(item.get("url", "")).strip()
        if not title or not url:
            continue
        links.append({"title": title, "url": url})
    return links[:MAX_WORKSPACE_USEFUL_LINKS]


def _workspace_links_response(user):
    return JsonResponse({"links": _workspace_useful_links(user)})


def _recent_document_payload(document: Document) -> dict:
    word_count, character_count = document_statistics(document.content)
    return {
        "id": str(document.public_id),
        "itemId": str(document.item.public_id) if document.item_id else None,
        "title": document.item.title if document.item_id else document.manuscript.title,
        "wordCount": word_count,
        "characterCount": character_count,
        "updatedAt": document.updated_at.isoformat(),
    }


def _active_document_filter():
    return Q(item__isnull=True) | Q(item__trashed_at__isnull=True)


def _workspace_search_rank(title: str, query: str, secondary: str = "") -> int:
    normalized_title = title.casefold()
    normalized_query = query.casefold()
    if normalized_title == normalized_query:
        return 0
    if normalized_title.startswith(normalized_query):
        return 1
    if normalized_query in normalized_title:
        return 2
    if normalized_query in secondary.casefold():
        return 3
    return 4


def _workspace_search_sort_key(result: dict, query: str):
    return (
        _workspace_search_rank(
            result["title"],
            query,
            result.get("synopsis", ""),
        ),
        -result["_updatedAt"].timestamp(),
        result["title"].casefold(),
    )


def _workspace_document_search_results(user, query: str) -> list[dict]:
    documents = (
        Document.objects.filter(
            _active_document_filter(),
            manuscript__workspace__owner=user,
        )
        .filter(
            Q(
                manuscript__kind=Manuscript.KIND_ONESHOT,
                manuscript__title__icontains=query,
            )
            | Q(
                manuscript__kind=Manuscript.KIND_BOOK,
                item__kind="document",
                item__title__icontains=query,
            )
        )
        .select_related("item", "manuscript__workspace")
    )
    results = []
    for document in documents:
        is_book = document.manuscript.kind == Manuscript.KIND_BOOK
        title = document.item.title if is_book and document.item_id else document.manuscript.title
        results.append(
            {
                "kind": "document",
                "id": str(document.public_id),
                "title": title,
                "manuscriptId": str(document.manuscript.public_id),
                "contextTitle": document.manuscript.title,
                "updatedAt": document.updated_at.isoformat(),
                "itemId": str(document.item.public_id) if is_book and document.item_id else None,
                "_updatedAt": document.updated_at,
            }
        )
    results.sort(key=lambda result: _workspace_search_sort_key(result, query))
    return results[:MAX_WORKSPACE_SEARCH_RESULTS_PER_KIND]


def _workspace_note_search_results(user, query: str) -> list[dict]:
    notes = (
        ManuscriptNote.objects.filter(
            manuscript__workspace__owner=user,
            archived_at__isnull=True,
            trashed_at__isnull=True,
            title__icontains=query,
        )
        .select_related("manuscript__workspace")
    )
    results = [
        {
            "kind": "note",
            "id": str(note.public_id),
            "title": note.title,
            "manuscriptId": str(note.manuscript.public_id),
            "contextTitle": note.manuscript.title,
            "updatedAt": note.updated_at.isoformat(),
            "_updatedAt": note.updated_at,
        }
        for note in notes
    ]
    results.sort(key=lambda result: _workspace_search_sort_key(result, query))
    return results[:MAX_WORKSPACE_SEARCH_RESULTS_PER_KIND]


def _workspace_article_search_results(user, query: str) -> list[dict]:
    articles = list(
        GlossaryArticle.objects.filter(
            Q(title__icontains=query) | Q(synopsis__icontains=query),
        )
        .filter(
            Q(
                glossary__manuscript__workspace__owner=user,
                glossary__manuscript__series_membership__isnull=True,
            )
            | Q(
                glossary__series__workspace__owner=user,
                glossary__series__memberships__isnull=False,
            )
        )
        .select_related(
            "glossary__manuscript__workspace",
            "glossary__series__workspace",
        )
        .distinct()
    )
    series_ids = {article.glossary.series_id for article in articles if article.glossary.series_id}
    series_targets = {}
    if series_ids:
        memberships = (
            SeriesMembership.objects.filter(
                series_id__in=series_ids,
                manuscript__workspace__owner=user,
            )
            .select_related("manuscript__workspace")
            .order_by(
                "series_id",
                F("position").asc(nulls_last=True),
                "created_at",
                "id",
            )
        )
        for membership in memberships:
            series_targets.setdefault(membership.series_id, membership.manuscript)

    results = []
    for article in articles:
        glossary = article.glossary
        if glossary.series_id:
            target_manuscript = series_targets.get(glossary.series_id)
            if target_manuscript is None:
                continue
            context_title = glossary.series.title
        else:
            target_manuscript = glossary.manuscript
            context_title = target_manuscript.title
        results.append(
            {
                "kind": "glossaryArticle",
                "id": str(article.public_id),
                "title": article.title,
                "manuscriptId": str(target_manuscript.public_id),
                "contextTitle": context_title,
                "updatedAt": article.updated_at.isoformat(),
                "synopsis": article.synopsis,
                "_updatedAt": article.updated_at,
            }
        )
    results.sort(key=lambda result: _workspace_search_sort_key(result, query))
    return results[:MAX_WORKSPACE_SEARCH_RESULTS_PER_KIND]


def _workspace_manuscript_search_results(
    user,
    query: str,
    related_manuscript_ids: set[str],
) -> list[dict]:
    manuscripts = Manuscript.objects.filter(workspace__owner=user).filter(
        Q(title__icontains=query)
        | Q(synopsis__icontains=query)
        | Q(public_id__in=related_manuscript_ids)
    )
    results = [
        {
            "kind": "manuscript",
            "id": str(manuscript.public_id),
            "title": manuscript.title,
            "manuscriptId": str(manuscript.public_id),
            "contextTitle": manuscript.title,
            "updatedAt": manuscript.updated_at.isoformat(),
            "synopsis": manuscript.synopsis,
            "_updatedAt": manuscript.updated_at,
        }
        for manuscript in manuscripts
    ]
    results.sort(key=lambda result: _workspace_search_sort_key(result, query))
    return results[:MAX_WORKSPACE_SEARCH_RESULTS_PER_KIND]


def _workspace_manuscripts(user):
    return (
        Manuscript.objects.filter(workspace__owner=user)
        .select_related("workspace")
        .prefetch_related("documents", "plan_statuses")
        .order_by("id")
    )


def _focused_workspace_manuscripts(user):
    return (
        _workspace_manuscripts(user)
        .filter(
            drawer_at__isnull=True,
        )
        .filter(
            Q(series_membership__isnull=True) | Q(series_membership__series__drawer_at__isnull=True)
        )
    )


def _manuscript_total_words(manuscripts) -> int:
    manuscript_ids = [manuscript.id for manuscript in manuscripts]
    if not manuscript_ids:
        return 0
    documents = Document.objects.filter(
        _active_document_filter(), manuscript_id__in=manuscript_ids
    ).select_related("item", "manuscript__workspace")
    return sum(document_statistics(document.content)[0] for document in documents)


def _writing_days(manuscripts, *, today):
    manuscript_ids = [manuscript.id for manuscript in manuscripts]
    if not manuscript_ids:
        return {}
    start_date = today - timedelta(days=6)
    rows = (
        ManuscriptWritingDay.objects.filter(
            manuscript_id__in=manuscript_ids,
            date__gte=start_date,
            date__lte=today,
        )
        .values("date")
        .annotate(words=Sum("words_written"))
    )
    return {row["date"]: row["words"] or 0 for row in rows}


def _nearest_manuscript_deadline(manuscripts, *, today):
    nearest = None
    for manuscript in manuscripts:
        deadline = manuscript.planner_settings.get("deadline")
        if not deadline:
            continue
        try:
            deadline_date = local_date_from_iso(deadline)
        except ValueError:
            continue
        if deadline_date < today:
            continue
        if nearest is None or deadline_date < nearest["deadlineDate"]:
            nearest = {
                "manuscriptId": str(manuscript.public_id),
                "title": manuscript.title,
                "deadlineDate": deadline_date,
                "daysRemaining": (deadline_date - today).days,
            }
    if nearest is None:
        return None
    return {
        **nearest,
        "deadline": nearest["deadlineDate"].isoformat(),
        "deadlineDate": nearest["deadlineDate"].isoformat(),
    }


def local_date_from_iso(value: str):
    from django.utils.dateparse import parse_date

    parsed = parse_date(value)
    if parsed is None:
        raise ValueError("date_invalid")
    return parsed


@require_GET
def workspace_recent_work(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    latest_document = (
        Document.objects.filter(
            _active_document_filter(),
            manuscript__workspace__owner=request.user,
            manuscript__drawer_at__isnull=True,
        )
        .filter(
            Q(manuscript__series_membership__isnull=True)
            | Q(manuscript__series_membership__series__drawer_at__isnull=True)
        )
        .select_related("item", "manuscript", "manuscript__workspace")
        .order_by("-updated_at", "-id")
        .first()
    )
    if latest_document is None:
        return JsonResponse({"recentWork": None})

    manuscript = latest_document.manuscript
    documents = (
        Document.objects.filter(_active_document_filter(), manuscript=manuscript)
        .select_related("item", "manuscript", "manuscript__workspace")
        .order_by("-updated_at", "-id")[:5]
    )
    has_cover = bool(manuscript.cover_media_id)
    return JsonResponse(
        {
            "recentWork": {
                "manuscript": {
                    "id": str(manuscript.public_id),
                    "kind": manuscript.kind,
                    "title": manuscript.title,
                    "coverThumbnailMediumUrl": (
                        f"/api/manuscripts/{manuscript.public_id}/cover/medium/"
                        if has_cover
                        else ""
                    ),
                    "coverVersion": cover_cache_version(manuscript),
                    "updatedAt": manuscript.updated_at.isoformat(),
                },
                "continueDocument": _recent_document_payload(latest_document),
                "documents": [_recent_document_payload(document) for document in documents],
            }
        }
    )


@require_GET
def workspace_search(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    query = request.GET.get("q", "").strip()
    if not MIN_WORKSPACE_SEARCH_QUERY_LENGTH <= len(query) <= MAX_WORKSPACE_SEARCH_QUERY_LENGTH:
        return JsonResponse({"error": "workspace_search_query_invalid"}, status=400)

    document_results = _workspace_document_search_results(request.user, query)
    note_results = _workspace_note_search_results(request.user, query)
    article_results = _workspace_article_search_results(request.user, query)
    content_results = [*document_results, *note_results, *article_results]
    manuscript_results = _workspace_manuscript_search_results(
        request.user,
        query,
        {result["manuscriptId"] for result in content_results},
    )
    results = [*manuscript_results, *content_results]
    for result in results:
        result.pop("_updatedAt", None)
    return JsonResponse({"results": results})


@require_GET
def workspace_stats(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    try:
        today = local_date(request.GET.get("timezone", "UTC"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    from .views import manuscript_lifecycle_status

    manuscripts = list(_workspace_manuscripts(request.user))
    focused_manuscripts = list(_focused_workspace_manuscripts(request.user))
    writing_days = _writing_days(manuscripts, today=today)
    words_today = writing_days.get(today, 0)
    words_yesterday = writing_days.get(today - timedelta(days=1), 0)
    week_words = sum(writing_days.values())
    return JsonResponse(
        {
            "stats": {
                "today": today.isoformat(),
                "manuscriptsInProgress": sum(
                    1
                    for manuscript in focused_manuscripts
                    if manuscript_lifecycle_status(manuscript) == "in_progress"
                ),
                "totalWords": _manuscript_total_words(manuscripts),
                "wordsWrittenThisWeek": week_words,
                "wordsWrittenToday": words_today,
                "wordsWrittenYesterday": words_yesterday,
                "wordsWrittenTodayDelta": max(words_today - words_yesterday, 0),
                "nearestDeadline": _nearest_manuscript_deadline(
                    focused_manuscripts,
                    today=today,
                ),
            }
        }
    )


@require_http_methods(["GET", "PATCH"])
def workspace_useful_links(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    if request.method == "GET":
        return _workspace_links_response(request.user)

    payload = _read_json(request)
    raw_links = payload.get("links") if payload is not None else None
    if not isinstance(raw_links, list) or len(raw_links) > MAX_WORKSPACE_USEFUL_LINKS:
        return JsonResponse({"error": "workspace_useful_links_invalid"}, status=400)

    normalized_links = []
    for item in raw_links:
        if not isinstance(item, dict):
            return JsonResponse({"error": "workspace_useful_links_invalid"}, status=400)
        title = str(item.get("title", "")).strip()
        url = _normalize_url(item.get("url", ""))
        if (
            not title
            or len(title) > MAX_WORKSPACE_USEFUL_LINK_TITLE_LENGTH
            or not url
            or len(url) > MAX_WORKSPACE_USEFUL_LINK_URL_LENGTH
        ):
            return JsonResponse({"error": "workspace_useful_links_invalid"}, status=400)
        try:
            url_validator(url)
        except ValidationError:
            return JsonResponse({"error": "workspace_useful_links_invalid"}, status=400)
        normalized_links.append({"title": title, "url": url})

    request.user.workspace_useful_links = normalized_links
    request.user.save(update_fields=["workspace_useful_links"])
    return _workspace_links_response(request.user)


@require_GET
def recent_documents(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    documents = (
        Document.objects.filter(manuscript=manuscript)
        .select_related("item")
        .order_by("-updated_at")[:5]
    )
    items = []
    for document in documents:
        if document.item and document.item.trashed_at is not None:
            continue
        items.append(_recent_document_payload(document))
    return JsonResponse({"items": items})


@require_GET
def writing_activity(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    today = local_date(request.GET.get("timezone", "UTC"))
    start_date = today - timedelta(days=6)
    recorded = {
        item.date: item.words_written
        for item in ManuscriptWritingDay.objects.filter(
            manuscript=manuscript,
            date__gte=start_date,
            date__lte=today,
        )
    }
    days = [
        {
            "date": (start_date + timedelta(days=offset)).isoformat(),
            "words": recorded.get(start_date + timedelta(days=offset), 0),
        }
        for offset in range(7)
    ]
    return JsonResponse({"days": days})


@require_http_methods(["GET", "PATCH"])
def dashboard_memo(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    if request.method == "GET":
        return JsonResponse({"memo": manuscript.dashboard_memo})

    payload = _read_json(request)
    if payload is None or "memo" not in payload:
        return JsonResponse({"error": "dashboard_memo_invalid"}, status=400)
    memo = payload["memo"]
    if not isinstance(memo, str):
        return JsonResponse({"error": "dashboard_memo_invalid"}, status=400)
    if len(memo) > MAX_DASHBOARD_MEMO_LENGTH:
        return JsonResponse({"error": "dashboard_memo_too_long"}, status=400)

    manuscript.dashboard_memo = memo
    manuscript.save(update_fields=["dashboard_memo", "updated_at"])
    return JsonResponse({"memo": manuscript.dashboard_memo})


@require_http_methods(["GET", "PATCH"])
def dashboard_settings(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    if request.method == "GET":
        return JsonResponse(
            {"settings": normalize_dashboard_settings(manuscript.dashboard_settings)}
        )

    payload = _read_json(request)
    if payload is None or "settings" not in payload or not isinstance(payload["settings"], dict):
        return JsonResponse({"error": "dashboard_settings_invalid"}, status=400)
    settings = normalize_dashboard_settings(payload["settings"])
    manuscript.dashboard_settings = settings
    manuscript.save(update_fields=["dashboard_settings", "updated_at"])
    return JsonResponse({"settings": settings})
