from django.http import JsonResponse
from django.views.decorators.http import require_GET

from .models import ServicePage


def no_store(response: JsonResponse) -> JsonResponse:
    response["Cache-Control"] = "no-store"
    return response


def public_metadata(page: ServicePage) -> dict:
    revision = page.active_revision
    return {
        "slug": page.slug,
        "path": f"/{page.slug}",
        "version": revision.version,
        "publishedAt": revision.published_at.isoformat(),
    }


@require_GET
def service_pages(request):
    pages_by_slug = {
        page.slug: page
        for page in ServicePage.objects.filter(
            is_published=True,
            active_revision__isnull=False,
        ).select_related("active_revision")
    }
    pages = [pages_by_slug[slug] for slug in ServicePage.SLUGS if slug in pages_by_slug]
    return no_store(JsonResponse({"pages": [public_metadata(page) for page in pages]}))


@require_GET
def service_page_detail(request, slug: str):
    try:
        page = ServicePage.objects.select_related("active_revision").get(slug=slug)
    except ServicePage.DoesNotExist:
        return no_store(JsonResponse({"error": "service_page_not_found"}, status=404))
    if not page.is_published or page.active_revision is None:
        return no_store(JsonResponse({"error": "service_page_not_published"}, status=404))
    revision = page.active_revision
    return no_store(
        JsonResponse(
            {
                **public_metadata(page),
                "markdown": revision.markdown,
            }
        )
    )
