from django.db import transaction
from django.db.models import Prefetch
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods

from .models import Manuscript, Series, SeriesMembership
from .series_views import series_payload
from .views import manuscript_payload


def _drawer_manuscript_payload(manuscript: Manuscript) -> dict:
    return {
        **manuscript_payload(manuscript),
        "drawerAt": manuscript.drawer_at.isoformat(),
    }


def _drawer_series_payload(series: Series) -> dict:
    return {
        **series_payload(series),
        "drawerAt": series.drawer_at.isoformat(),
    }


@require_GET
def drawer_items(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    manuscripts = (
        Manuscript.objects.filter(
            workspace__owner=request.user,
            drawer_at__isnull=False,
            series_membership__isnull=True,
        )
        .select_related("workspace")
        .prefetch_related("documents")
    )
    memberships = (
        SeriesMembership.objects.select_related("manuscript__workspace")
        .prefetch_related("manuscript__documents")
        .order_by("created_at")
    )
    series_items = (
        Series.objects.filter(
            workspace__owner=request.user,
            drawer_at__isnull=False,
        )
        .select_related("workspace")
        .prefetch_related(Prefetch("memberships", queryset=memberships))
    )
    items = [
        *(_drawer_manuscript_payload(item) for item in manuscripts),
        *(_drawer_series_payload(item) for item in series_items),
    ]
    items.sort(key=lambda item: item["drawerAt"], reverse=True)
    return JsonResponse({"items": items})


@require_http_methods(["PUT", "DELETE"])
def drawer_manuscript(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    with transaction.atomic():
        manuscript = (
            Manuscript.objects.select_for_update()
            .filter(id=manuscript_id, workspace__owner=request.user)
            .select_related("workspace")
            .prefetch_related("documents")
            .first()
        )
        if manuscript is None:
            return JsonResponse({"error": "drawer_item_not_found"}, status=404)
        if request.method == "PUT":
            if SeriesMembership.objects.filter(manuscript=manuscript).exists():
                return JsonResponse({"error": "drawer_series_book_forbidden"}, status=400)
            if manuscript.drawer_at is None:
                manuscript.drawer_at = timezone.now()
                manuscript.save(update_fields=["drawer_at"])
        elif manuscript.drawer_at is not None:
            manuscript.drawer_at = None
            manuscript.save(update_fields=["drawer_at"])

    return JsonResponse({"item": manuscript_payload(manuscript)})


@require_http_methods(["PUT", "DELETE"])
def drawer_series(request, series_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    with transaction.atomic():
        series = (
            Series.objects.select_for_update()
            .filter(id=series_id, workspace__owner=request.user)
            .first()
        )
        if series is None:
            return JsonResponse({"error": "drawer_item_not_found"}, status=404)
        if request.method == "PUT" and series.drawer_at is None:
            series.drawer_at = timezone.now()
            series.save(update_fields=["drawer_at"])
        elif request.method == "DELETE" and series.drawer_at is not None:
            series.drawer_at = None
            series.save(update_fields=["drawer_at"])

    return JsonResponse({"ok": True})
