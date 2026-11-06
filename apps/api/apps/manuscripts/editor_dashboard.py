from __future__ import annotations

from django.db.models import Q
from django.http import JsonResponse
from django.views.decorators.http import require_GET

from apps.accounts.capabilities import has_editor_workspace

from .models import Document, Manuscript

MIN_WORKSPACE_SEARCH_QUERY_LENGTH = 2
MAX_WORKSPACE_SEARCH_QUERY_LENGTH = 120
MAX_WORKSPACE_SEARCH_RESULTS_PER_KIND = 5


def _private_json(payload: dict, *, status: int = 200) -> JsonResponse:
    response = JsonResponse(payload, status=status)
    response["Cache-Control"] = "private, no-store"
    return response


def _search_sort_key(result: dict, query: str):
    normalized_title = result["title"].casefold()
    normalized_query = query.casefold()
    if normalized_title == normalized_query:
        rank = 0
    elif normalized_title.startswith(normalized_query):
        rank = 1
    elif normalized_query in normalized_title:
        rank = 2
    elif normalized_query in result.get("synopsis", "").casefold():
        rank = 3
    else:
        rank = 4
    return rank, -result["_updatedAt"].timestamp(), normalized_title


def _granted_manuscripts(user):
    return Manuscript.objects.filter(
        editor_grants__editor_connection__editor=user,
        editor_grants__editor_connection__disconnected_at__isnull=True,
        editor_grants__revoked_at__isnull=True,
    ).distinct()


def _document_results(user, query: str) -> list[dict]:
    documents = (
        Document.objects.filter(
            manuscript__in=_granted_manuscripts(user),
        )
        .filter(Q(item__isnull=True) | Q(item__trashed_at__isnull=True))
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
        .select_related("item", "manuscript__workspace__owner")
        .distinct()
    )
    results = []
    for document in documents:
        manuscript = document.manuscript
        author = manuscript.workspace.owner
        is_book = manuscript.kind == Manuscript.KIND_BOOK
        results.append(
            {
                "kind": "document",
                "id": str(document.public_id),
                "title": document.item.title if is_book and document.item_id else manuscript.title,
                "manuscriptId": str(manuscript.public_id),
                "contextTitle": manuscript.title,
                "updatedAt": document.updated_at.isoformat(),
                "itemId": str(document.item.public_id) if is_book and document.item_id else None,
                "authorName": author.display_name.strip() or author.get_username(),
                "_updatedAt": document.updated_at,
            }
        )
    results.sort(key=lambda result: _search_sort_key(result, query))
    return results[:MAX_WORKSPACE_SEARCH_RESULTS_PER_KIND]


def _manuscript_results(user, query: str, related_ids: set[str]) -> list[dict]:
    manuscripts = (
        _granted_manuscripts(user)
        .filter(
            Q(title__icontains=query)
            | Q(synopsis__icontains=query)
            | Q(public_id__in=related_ids)
        )
        .select_related("workspace__owner")
        .distinct()
    )
    results = []
    for manuscript in manuscripts:
        author = manuscript.workspace.owner
        results.append(
            {
                "kind": "manuscript",
                "id": str(manuscript.public_id),
                "title": manuscript.title,
                "manuscriptId": str(manuscript.public_id),
                "contextTitle": manuscript.title,
                "updatedAt": manuscript.updated_at.isoformat(),
                "synopsis": manuscript.synopsis,
                "authorName": author.display_name.strip() or author.get_username(),
                "_updatedAt": manuscript.updated_at,
            }
        )
    results.sort(key=lambda result: _search_sort_key(result, query))
    return results[:MAX_WORKSPACE_SEARCH_RESULTS_PER_KIND]


@require_GET
def editor_workspace_search(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if not has_editor_workspace(request.user):
        return JsonResponse({"error": "editor_workspace_required"}, status=403)
    query = request.GET.get("q", "").strip()
    if not MIN_WORKSPACE_SEARCH_QUERY_LENGTH <= len(query) <= MAX_WORKSPACE_SEARCH_QUERY_LENGTH:
        return _private_json({"error": "workspace_search_query_invalid"}, status=400)

    document_results = _document_results(request.user, query)
    manuscript_results = _manuscript_results(
        request.user,
        query,
        {result["manuscriptId"] for result in document_results},
    )
    results = [*manuscript_results, *document_results]
    for result in results:
        result.pop("_updatedAt", None)
    return _private_json({"results": results})
