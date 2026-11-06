import json

from django.db import transaction
from django.db.models import Max
from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from apps.accounts.views import require_recent_auth
from apps.audit.service import write_audit_event

from .models import ServicePage, ServicePageRevision

MAX_MARKDOWN_BYTES = 1024 * 1024


def require_superuser(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if not request.user.is_superuser:
        return JsonResponse({"error": "superuser_required"}, status=403)
    return None


def read_json(request):
    try:
        return json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def markdown_from_payload(payload, *, required: bool = False):
    if not isinstance(payload, dict) or not isinstance(payload.get("markdown"), str):
        return None, JsonResponse({"error": "service_page_payload_invalid"}, status=400)
    markdown = payload["markdown"]
    if len(markdown.encode("utf-8")) > MAX_MARKDOWN_BYTES:
        return None, JsonResponse({"error": "service_page_markdown_too_large"}, status=400)
    if required and not markdown.strip():
        return None, JsonResponse({"error": "service_page_markdown_required"}, status=400)
    return markdown, None


def admin_page_payload(page: ServicePage) -> dict:
    revision = page.active_revision
    return {
        "slug": page.slug,
        "draftMarkdown": page.draft_markdown,
        "published": page.is_published and revision is not None,
        "version": revision.version if revision else None,
        "publishedAt": revision.published_at.isoformat() if revision else None,
        "draftUpdatedAt": page.updated_at.isoformat(),
        "hasUnpublishedChanges": revision is None or page.draft_markdown != revision.markdown,
    }


@require_GET
def admin_service_pages(request):
    if response := require_superuser(request):
        return response
    pages = ServicePage.objects.select_related("active_revision").order_by("slug")
    return JsonResponse({"pages": [admin_page_payload(page) for page in pages]})


@require_http_methods(["PATCH"])
def save_service_page_draft(request, slug: str):
    if response := require_superuser(request):
        return response
    try:
        page = ServicePage.objects.select_related("active_revision").get(slug=slug)
    except ServicePage.DoesNotExist:
        return JsonResponse({"error": "service_page_not_found"}, status=404)
    markdown, error = markdown_from_payload(read_json(request))
    if error is not None:
        return error
    page.draft_markdown = markdown
    page.updated_by = request.user
    page.save(update_fields=["draft_markdown", "updated_by", "updated_at"])
    write_audit_event(
        request,
        "admin.service_page_draft_saved",
        actor=request.user,
        subject=page.slug,
        payload={
            "slug": page.slug,
            "version": page.active_revision.version if page.active_revision else None,
        },
    )
    return JsonResponse({"page": admin_page_payload(page)})


@require_POST
def publish_service_page(request, slug: str):
    if response := require_superuser(request):
        return response
    if response := require_recent_auth(request):
        return response
    markdown, error = markdown_from_payload(read_json(request), required=True)
    if error is not None:
        return error
    with transaction.atomic():
        try:
            page = ServicePage.objects.select_for_update().get(slug=slug)
        except ServicePage.DoesNotExist:
            return JsonResponse({"error": "service_page_not_found"}, status=404)
        active_revision = page.active_revision
        if active_revision is not None and active_revision.markdown == markdown:
            revision = active_revision
        else:
            latest_version = page.revisions.aggregate(value=Max("version"))["value"] or 0
            revision = ServicePageRevision.objects.create(
                page=page,
                version=latest_version + 1,
                markdown=markdown,
                published_by=request.user,
            )
        page.draft_markdown = markdown
        page.is_published = True
        page.active_revision = revision
        page.updated_by = request.user
        page.save(
            update_fields=[
                "draft_markdown",
                "is_published",
                "active_revision",
                "updated_by",
                "updated_at",
            ]
        )
        write_audit_event(
            request,
            "admin.service_page_published",
            actor=request.user,
            subject=page.slug,
            payload={"slug": page.slug, "version": revision.version},
        )
    return JsonResponse({"page": admin_page_payload(page)})


@require_POST
def unpublish_service_page(request, slug: str):
    if response := require_superuser(request):
        return response
    if response := require_recent_auth(request):
        return response
    markdown = None
    if request.content_type == "application/json":
        payload = read_json(request)
        if payload is None:
            return JsonResponse({"error": "service_page_payload_invalid"}, status=400)
        if isinstance(payload, dict) and "markdown" in payload:
            markdown, error = markdown_from_payload(payload)
            if error is not None:
                return error
    with transaction.atomic():
        try:
            page = ServicePage.objects.select_for_update().get(slug=slug)
        except ServicePage.DoesNotExist:
            return JsonResponse({"error": "service_page_not_found"}, status=404)
        page.is_published = False
        if markdown is not None:
            page.draft_markdown = markdown
        page.updated_by = request.user
        page.save(
            update_fields=["draft_markdown", "is_published", "updated_by", "updated_at"]
        )
        write_audit_event(
            request,
            "admin.service_page_unpublished",
            actor=request.user,
            subject=page.slug,
            payload={
                "slug": page.slug,
                "version": page.active_revision.version if page.active_revision else None,
            },
        )
    return JsonResponse({"page": admin_page_payload(page)})
