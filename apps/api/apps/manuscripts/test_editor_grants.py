from datetime import timedelta
from io import BytesIO
from unittest.mock import patch

import pytest
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from PIL import Image

from apps.accounts.models import EditorConnection, EditorInvitation
from apps.audit.models import AuditEvent
from apps.notifications.email import send_notification_email
from apps.notifications.models import Notification

from .models import Manuscript, ManuscriptEditorGrant, Series, SeriesMembership, Workspace
from .services import create_book, create_oneshot, delete_series


def create_writer(django_user_model, username):
    return django_user_model.objects.create_user(
        username=username,
        email=f"{username}@example.test",
        password="correct-password",
    )


def create_editor(django_user_model, username):
    return django_user_model.objects.create_user(
        username=username,
        email=f"{username}@example.test",
        password="correct-password",
        author_workspace_enabled_at=None,
        editor_workspace_enabled_at=timezone.now(),
    )


def connect(writer, editor):
    now = timezone.now()
    invitation = EditorInvitation.objects.create(
        author=writer,
        expires_at=now + timedelta(hours=48),
        accepted_at=now,
        accepted_by=editor,
    )
    return EditorConnection.objects.create(
        author=writer,
        editor=editor,
        invitation=invitation,
    )


def image_upload(name="cover.png"):
    content = BytesIO()
    Image.new("RGB", (48, 72), (46, 70, 96)).save(content, format="PNG")
    return SimpleUploadedFile(name, content.getvalue(), content_type="image/png")


@pytest.mark.django_db
def test_grant_lifecycle_notifies_editor_in_panel_and_email_queue(
    client,
    django_user_model,
    django_capture_on_commit_callbacks,
):
    writer = create_writer(django_user_model, "notification-writer")
    writer.display_name = "Named Author"
    writer.save(update_fields=["display_name"])
    editor = create_editor(django_user_model, "notification-editor")
    connection = connect(writer, editor)
    manuscript = create_oneshot(
        user=writer,
        title="Shared notification story",
        synopsis="",
        cover=None,
    )
    endpoint = f"/api/manuscripts/{manuscript.public_id}/editor-grants/"
    client.force_login(writer)

    with patch("apps.notifications.tasks.deliver_notification_email.delay") as deliver_email:
        with django_capture_on_commit_callbacks(execute=True):
            granted = client.post(
                endpoint,
                {"connectionId": connection.id},
                content_type="application/json",
            )
    assert granted.status_code == 201
    grant_id = granted.json()["grants"][0]["id"]
    grant_notification = Notification.objects.get(
        recipient=editor,
        kind="service.editor_manuscript_access_granted",
    )
    assert grant_notification.payload == {
        "manuscriptId": str(manuscript.public_id),
        "manuscriptTitle": manuscript.title,
        "authorName": writer.display_name,
        "actionPath": f"/manuscripts/{manuscript.public_id}/editor?workspace=editor",
    }
    assert grant_notification.email_requested_at is not None
    deliver_email.assert_called_once_with(grant_notification.id)

    with patch("apps.notifications.tasks.deliver_notification_email.delay") as deliver_email:
        with django_capture_on_commit_callbacks(execute=True):
            revoked = client.delete(f"{endpoint}{grant_id}/")
    assert revoked.status_code == 200
    revoke_notification = Notification.objects.get(
        recipient=editor,
        kind="service.editor_manuscript_access_revoked",
    )
    assert revoke_notification.payload["actionPath"] == "/manuscripts?workspace=editor"
    assert revoke_notification.email_requested_at is not None
    deliver_email.assert_called_once_with(revoke_notification.id)


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("language", "kind", "subject", "action_label"),
    [
        (
            "en",
            "service.editor_manuscript_access_granted",
            "A manuscript is available in Quillum",
            "Open manuscript",
        ),
        (
            "ru",
            "service.editor_manuscript_access_revoked",
            "Доступ к рукописи изменён в Quillum",
            "Открыть доступные рукописи",
        ),
    ],
)
def test_editor_access_email_is_localized_and_multipart(
    django_user_model,
    language,
    kind,
    subject,
    action_label,
):
    editor = create_editor(django_user_model, f"editor-email-{language}")
    editor.language = language
    editor.save(update_fields=["language"])
    notification = Notification.objects.create(
        recipient=editor,
        category=Notification.CATEGORY_SERVICE,
        kind=kind,
        payload={
            "authorName": "Author Name",
            "manuscriptTitle": "Shared story",
            "actionPath": (
                "/manuscripts/00000000-0000-0000-0000-000000000001/editor"
                if kind.endswith("granted")
                else "/manuscripts"
            ),
        },
        deduplication_hash=f"editor-access-{language}".ljust(64, "0"),
        expires_at=timezone.now() + timedelta(days=90),
    )

    assert send_notification_email(notification) == 1
    assert mail.outbox[-1].subject == subject
    assert "Author Name" in mail.outbox[-1].body
    assert "Shared story" in mail.outbox[-1].body
    assert len(mail.outbox[-1].alternatives) == 1
    html_body, mime_type = mail.outbox[-1].alternatives[0]
    assert mime_type == "text/html"
    assert action_label in html_body


@pytest.mark.django_db
def test_writer_grants_multiple_editors_and_editor_list_stays_restricted(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "grant-writer")
    first_editor = create_editor(django_user_model, "grant-editor-one")
    second_editor = create_editor(django_user_model, "grant-editor-two")
    other_writer = create_writer(django_user_model, "grant-other-writer")
    first_connection = connect(writer, first_editor)
    second_connection = connect(writer, second_editor)
    cross_author_connection = connect(other_writer, first_editor)
    foreign_connection = connect(other_writer, create_editor(django_user_model, "foreign-editor"))

    client.force_login(writer)
    created = client.post(
        "/api/manuscripts/oneshots/",
        {"title": "Shared story", "cover": image_upload()},
    )
    assert created.status_code == 201
    manuscript_id = created.json()["manuscript"]["id"]
    endpoint = f"/api/manuscripts/{manuscript_id}/editor-grants/"

    initial = client.get(endpoint)
    assert initial.status_code == 200
    assert {item["connectionId"] for item in initial.json()["eligibleEditors"]} == {
        first_connection.id,
        second_connection.id,
    }

    first_grant = client.post(
        endpoint,
        {"connectionId": first_connection.id},
        content_type="application/json",
    )
    assert first_grant.status_code == 201
    assert first_grant.json()["grants"][0]["editor"]["username"] == first_editor.username
    duplicate = client.post(
        endpoint,
        {"connectionId": first_connection.id},
        content_type="application/json",
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error"] == "manuscript_editor_grant_already_exists"
    foreign = client.post(
        endpoint,
        {"connectionId": foreign_connection.id},
        content_type="application/json",
    )
    assert foreign.status_code == 404
    assert foreign.json()["error"] == "editor_connection_not_found"

    second_grant = client.post(
        endpoint,
        {"connectionId": second_connection.id},
        content_type="application/json",
    )
    assert second_grant.status_code == 201
    assert len(second_grant.json()["grants"]) == 2
    assert AuditEvent.objects.filter(event="manuscript.editor_access_granted").count() == 2

    other_manuscript = create_oneshot(
        user=other_writer,
        title="Another author's story",
        synopsis="",
        cover=None,
    )
    client.force_login(other_writer)
    cross_author_grant = client.post(
        f"/api/manuscripts/{other_manuscript.public_id}/editor-grants/",
        {"connectionId": cross_author_connection.id},
        content_type="application/json",
    )
    assert cross_author_grant.status_code == 201

    client.force_login(first_editor)
    available = client.get("/api/editor/manuscripts/")
    assert available.status_code == 200
    available_by_id = {item["id"]: item for item in available.json()["items"]}
    assert set(available_by_id) == {manuscript_id, str(other_manuscript.public_id)}
    assert available_by_id[manuscript_id]["author"] == {
        "displayName": writer.display_name,
        "username": writer.username,
        "avatarUrl": "",
    }
    assert available_by_id[str(other_manuscript.public_id)]["author"] == {
        "displayName": other_writer.display_name,
        "username": other_writer.username,
        "avatarUrl": "",
    }
    assert client.get(
        f"/api/editor/manuscripts/{manuscript_id}/cover/medium/"
    ).status_code == 200
    blocked_detail = client.get(f"/api/manuscripts/{manuscript_id}/")
    assert blocked_detail.status_code == 403
    assert blocked_detail.json()["error"] == "author_workspace_required"

    unconnected_editor = create_editor(django_user_model, "unconnected-editor")
    client.force_login(unconnected_editor)
    assert client.get("/api/editor/manuscripts/").json()["items"] == []
    hidden_cover = client.get(f"/api/editor/manuscripts/{manuscript_id}/cover/medium/")
    assert hidden_cover.status_code == 404
    assert hidden_cover.json()["error"] == "manuscript_not_found"

    client.force_login(writer)
    writer_list = client.get("/api/editor/manuscripts/")
    assert writer_list.status_code == 403
    assert writer_list.json()["error"] == "editor_workspace_required"


@pytest.mark.django_db
def test_manual_revoke_preserves_history_and_disconnect_revokes_all_active_grants(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "revoke-writer")
    editor = create_editor(django_user_model, "revoke-editor")
    connection = connect(writer, editor)
    first = create_oneshot(
        user=writer,
        title="First",
        synopsis="",
        cover=None,
    )
    second = create_book(
        user=writer,
        title="Second",
        synopsis="",
        template="chapters",
        cover=None,
        language="en",
    )
    client.force_login(writer)

    first_endpoint = f"/api/manuscripts/{first.public_id}/editor-grants/"
    initial = client.post(
        first_endpoint,
        {"connectionId": connection.id},
        content_type="application/json",
    )
    grant_id = initial.json()["grants"][0]["id"]
    revoked = client.delete(f"{first_endpoint}{grant_id}/")
    assert revoked.status_code == 200
    assert revoked.json()["grants"] == []
    assert ManuscriptEditorGrant.objects.get(public_id=grant_id).revoked_at is not None
    assert AuditEvent.objects.filter(event="manuscript.editor_access_revoked").count() == 1
    missing_grant = client.delete(f"{first_endpoint}{grant_id}/")
    assert missing_grant.status_code == 404
    assert missing_grant.json()["error"] == "manuscript_editor_grant_not_found"

    regranted = client.post(
        first_endpoint,
        {"connectionId": connection.id},
        content_type="application/json",
    )
    assert regranted.status_code == 201
    assert ManuscriptEditorGrant.objects.filter(manuscript=first).count() == 2
    second_grant = client.post(
        f"/api/manuscripts/{second.public_id}/editor-grants/",
        {"connectionId": connection.id},
        content_type="application/json",
    )
    assert second_grant.status_code == 201

    disconnected = client.delete(f"/api/editor/connections/{connection.id}/")
    assert disconnected.status_code == 200
    assert not ManuscriptEditorGrant.objects.filter(
        editor_connection=connection,
        revoked_at__isnull=True,
    ).exists()
    audit = AuditEvent.objects.get(event="editor.connection_disconnected")
    assert audit.payload["revokedManuscriptGrantCount"] == 2
    revoke_notifications = Notification.objects.filter(
        recipient=editor,
        kind="service.editor_manuscript_access_revoked",
    )
    assert revoke_notifications.count() == 3
    assert not revoke_notifications.filter(email_requested_at__isnull=True).exists()
    rejected = client.post(
        first_endpoint,
        {"connectionId": connection.id},
        content_type="application/json",
    )
    assert rejected.status_code == 404
    assert rejected.json()["error"] == "editor_connection_not_found"

    client.force_login(editor)
    assert client.get("/api/editor/manuscripts/").json()["items"] == []
    assert client.get(
        f"/api/editor/manuscripts/{first.public_id}/cover/medium/"
    ).status_code == 404


@pytest.mark.django_db
def test_available_list_ignores_drawer_and_series_organization_but_deletion_cascades(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "organization-writer")
    editor = create_editor(django_user_model, "organization-editor")
    connection = connect(writer, editor)
    drawer_story = create_oneshot(
        user=writer,
        title="Drawer story",
        synopsis="",
        cover=None,
    )
    drawer_story.drawer_at = timezone.now()
    drawer_story.save(update_fields=["drawer_at"])
    series_book = create_book(
        user=writer,
        title="Series book",
        synopsis="",
        template="chapters",
        cover=None,
        language="en",
    )
    series = Series.objects.create(
        workspace=Workspace.objects.create(owner=writer),
        title="Series",
    )
    membership = SeriesMembership.objects.create(
        series=series,
        manuscript=series_book,
        position=1,
    )

    client.force_login(writer)
    for manuscript in (drawer_story, series_book):
        response = client.post(
            f"/api/manuscripts/{manuscript.public_id}/editor-grants/",
            {"connectionId": connection.id},
            content_type="application/json",
        )
        assert response.status_code == 201

    client.force_login(editor)
    available_ids = {
        item["id"] for item in client.get("/api/editor/manuscripts/").json()["items"]
    }
    assert available_ids == {str(drawer_story.public_id), str(series_book.public_id)}

    membership.delete()
    assert ManuscriptEditorGrant.objects.filter(manuscript=series_book).exists()
    SeriesMembership.objects.create(series=series, manuscript=series_book, position=1)
    delete_series(series)
    assert Manuscript.objects.filter(id=series_book.id).exists()
    assert ManuscriptEditorGrant.objects.filter(manuscript=series_book).exists()

    drawer_story.delete()
    assert not ManuscriptEditorGrant.objects.filter(manuscript_id=drawer_story.id).exists()
