import json

import pytest
from django.utils import timezone

from apps.accounts.views import RECENT_AUTH_SESSION_KEY
from apps.audit.models import AuditEvent

from .models import ServicePage, ServicePageRevision


def mark_recent_auth(client) -> None:
    session = client.session
    session[RECENT_AUTH_SESSION_KEY] = timezone.now().isoformat()
    session.save()


@pytest.mark.django_db
def test_migration_creates_disabled_service_pages():
    pages = list(ServicePage.objects.order_by("slug").values_list("slug", "is_published"))

    assert pages == [("contact", False), ("privacy", False), ("terms", False)]


@pytest.mark.django_db
def test_public_api_exposes_only_published_pages(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )
    page = ServicePage.objects.get(slug="privacy")
    revision = ServicePageRevision.objects.create(
        page=page,
        version=1,
        markdown="# Privacy",
        published_by=admin,
    )
    page.active_revision = revision
    page.is_published = True
    page.save(update_fields=["active_revision", "is_published"])

    listing = client.get("/api/service-pages/")
    detail = client.get("/api/service-pages/privacy/")
    hidden = client.get("/api/service-pages/terms/")

    assert listing.status_code == 200
    assert listing.json()["pages"] == [
        {
            "slug": "privacy",
            "path": "/privacy",
            "version": 1,
            "publishedAt": revision.published_at.isoformat(),
        }
    ]
    assert detail.status_code == 200
    assert detail.json()["markdown"] == "# Privacy"
    assert hidden.status_code == 404
    assert hidden.json()["error"] == "service_page_not_published"
    assert listing["Cache-Control"] == "no-store"
    assert detail["Cache-Control"] == "no-store"
    assert hidden["Cache-Control"] == "no-store"


@pytest.mark.django_db
def test_published_page_is_identical_for_authenticated_user(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    page = ServicePage.objects.get(slug="contact")
    revision = ServicePageRevision.objects.create(page=page, version=1, markdown="Contact us")
    page.active_revision = revision
    page.is_published = True
    page.save(update_fields=["active_revision", "is_published"])

    anonymous_payload = client.get("/api/service-pages/contact/").json()
    client.force_login(user)
    authenticated_payload = client.get("/api/service-pages/contact/").json()

    assert authenticated_payload == anonymous_payload


@pytest.mark.django_db
def test_admin_service_pages_require_superuser(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="service-pages-user",
        email="service-pages-user@example.test",
        password="correct-password",
    )

    anonymous = client.get("/api/admin/service-pages/")
    client.force_login(user)
    forbidden = client.get("/api/admin/service-pages/")

    assert anonymous.status_code == 401
    assert anonymous.json()["error"] == "authentication_required"
    assert forbidden.status_code == 403
    assert forbidden.json()["error"] == "superuser_required"


@pytest.mark.django_db
def test_draft_save_does_not_change_public_revision(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )
    page = ServicePage.objects.get(slug="terms")
    revision = ServicePageRevision.objects.create(page=page, version=1, markdown="Published")
    page.active_revision = revision
    page.is_published = True
    page.save(update_fields=["active_revision", "is_published"])
    client.force_login(admin)

    response = client.patch(
        "/api/admin/service-pages/terms/draft/",
        data=json.dumps({"markdown": "Draft replacement"}),
        content_type="application/json",
    )
    page.refresh_from_db()

    assert response.status_code == 200
    assert page.draft_markdown == "Draft replacement"
    assert page.active_revision_id == revision.id
    assert page.active_revision.markdown == "Published"
    assert page.is_published is True


@pytest.mark.django_db
def test_publish_requires_recent_authentication(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)

    response = client.post(
        "/api/admin/service-pages/privacy/publish/",
        data=json.dumps({"markdown": "Privacy"}),
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "recent_authentication_required"
    assert ServicePageRevision.objects.count() == 0


@pytest.mark.django_db
def test_publish_versions_and_unpublish_preserves_history(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    first = client.post(
        "/api/admin/service-pages/privacy/publish/",
        data=json.dumps({"markdown": "Version one"}),
        content_type="application/json",
    )
    second = client.post(
        "/api/admin/service-pages/privacy/publish/",
        data=json.dumps({"markdown": "Version two"}),
        content_type="application/json",
    )
    unpublished = client.post("/api/admin/service-pages/privacy/unpublish/")
    hidden = client.get("/api/service-pages/privacy/")
    republished = client.post(
        "/api/admin/service-pages/privacy/publish/",
        data=json.dumps({"markdown": "Version three"}),
        content_type="application/json",
    )
    client.post("/api/admin/service-pages/privacy/unpublish/")
    reused = client.post(
        "/api/admin/service-pages/privacy/publish/",
        data=json.dumps({"markdown": "Version three"}),
        content_type="application/json",
    )

    assert first.json()["page"]["version"] == 1
    assert second.json()["page"]["version"] == 2
    assert unpublished.status_code == 200
    assert unpublished.json()["page"]["published"] is False
    assert unpublished.json()["page"]["version"] == 2
    assert hidden.status_code == 404
    assert republished.json()["page"]["version"] == 3
    assert reused.json()["page"]["version"] == 3
    assert list(
        ServicePageRevision.objects.filter(page_id="privacy")
        .order_by("version")
        .values_list("markdown", flat=True)
    ) == ["Version one", "Version two", "Version three"]


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("markdown", "error"),
    [
        ("   ", "service_page_markdown_required"),
        ("x" * (1024 * 1024 + 1), "service_page_markdown_too_large"),
    ],
)
def test_publish_validates_markdown(client, django_user_model, markdown, error):
    admin = django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)

    response = client.post(
        "/api/admin/service-pages/contact/publish/",
        data=json.dumps({"markdown": markdown}),
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == error


@pytest.mark.django_db
def test_service_page_audit_payload_never_contains_markdown(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password="correct-password",
    )
    client.force_login(admin)
    mark_recent_auth(client)
    secret_text = "private draft marker"

    client.patch(
        "/api/admin/service-pages/contact/draft/",
        data=json.dumps({"markdown": secret_text}),
        content_type="application/json",
    )
    client.post(
        "/api/admin/service-pages/contact/publish/",
        data=json.dumps({"markdown": secret_text}),
        content_type="application/json",
    )
    client.post("/api/admin/service-pages/contact/unpublish/")

    events = AuditEvent.objects.filter(event__startswith="admin.service_page_")
    assert events.count() == 3
    assert all(secret_text not in json.dumps(event.payload) for event in events)
