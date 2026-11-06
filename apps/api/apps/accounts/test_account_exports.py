import hashlib
import json
import posixpath
import zipfile
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

import pytest
from django.core import mail
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from PIL import Image

from apps.accounts.account_exports import (
    ACCOUNT_EXPORT_CONTENT_TYPE,
    AccountExportBuild,
    _notify_ready_account_export,
    build_account_export,
    cleanup_expired_account_exports,
    materialize_account_export,
)
from apps.accounts.models import AccountExport, UserMediaAsset
from apps.accounts.services import delete_account_data
from apps.accounts.tiers import storage_usage_bytes
from apps.accounts.views import RECENT_AUTH_SESSION_KEY
from apps.audit.models import AuditEvent
from apps.manuscripts.models import (
    Document,
    Glossary,
    GlossaryArticle,
    GlossaryCategory,
    IdeaItem,
    Manuscript,
    ManuscriptAsset,
    ManuscriptBoard,
    ManuscriptItem,
    ManuscriptNote,
    ManuscriptNoteAudio,
    ManuscriptNoteTag,
    ManuscriptNoteTranscription,
    ManuscriptTask,
    Series,
    SeriesMembership,
    Workspace,
)
from apps.notifications.email import send_notification_email
from apps.notifications.models import Notification


def mark_recent_auth(client) -> None:
    session = client.session
    session[RECENT_AUTH_SESSION_KEY] = timezone.now().isoformat()
    session.save()


def text_document(value: str, *, asset_id: str = "") -> dict:
    content = [{"type": "paragraph", "content": [{"type": "text", "text": value}]}]
    if asset_id:
        content.append(
            {
                "type": "illustration",
                "attrs": {
                    "assetId": asset_id,
                    "alt": "Original illustration",
                    "caption": "Caption",
                    "alignment": "center",
                    "displayWidth": 80,
                },
            }
        )
    return {"type": "doc", "content": content}


def png_bytes(color: str = "#245b47") -> bytes:
    output = BytesIO()
    Image.new("RGB", (12, 12), color=color).save(output, format="PNG")
    return output.getvalue()


def create_media(user, data: bytes, *, name: str) -> UserMediaAsset:
    def upload(suffix: str) -> SimpleUploadedFile:
        return SimpleUploadedFile(f"{name}-{suffix}.png", data, content_type="image/png")

    return UserMediaAsset.objects.create(
        owner=user,
        content_hash=hashlib.sha256(data).hexdigest(),
        original=upload("original"),
        thumbnail_small=upload("small"),
        thumbnail_medium=upload("medium"),
        editor_medium=upload("editor-medium"),
        editor_large=upload("editor-large"),
        content_type="image/png",
        width=12,
        height=12,
        byte_size=len(data),
    )


def create_job(
    user,
    *,
    manuscript_format: str = "markdown",
    glossary_format: str = "markdown",
) -> AccountExport:
    return AccountExport.objects.create(
        owner=user,
        manuscript_format=manuscript_format,
        glossary_format=glossary_format,
    )


def archive_bytes(build: AccountExportBuild) -> bytes:
    try:
        return build.file.read()
    finally:
        build.file.close()


@pytest.mark.django_db
def test_account_export_api_requires_recent_auth_defaults_and_reuses_active_job(
    client,
    django_user_model,
    django_capture_on_commit_callbacks,
):
    user = django_user_model.objects.create_user(
        username="account-export-api",
        password="correct-password",
    )
    anonymous = client.get("/api/auth/account/export/")
    assert anonymous.status_code == 401
    client.force_login(user)

    blocked = client.post("/api/auth/account/export/", {}, content_type="application/json")
    assert blocked.status_code == 403
    assert blocked.json()["error"] == "recent_authentication_required"

    mark_recent_auth(client)
    with patch("apps.accounts.account_exports._dispatch_account_export") as dispatch:
        with django_capture_on_commit_callbacks(execute=True):
            created = client.post(
                "/api/auth/account/export/",
                {},
                content_type="application/json",
            )
        current = client.post(
            "/api/auth/account/export/",
            {"manuscriptFormat": "docx", "glossaryFormat": "html"},
            content_type="application/json",
        )

    assert created.status_code == 201
    assert created.json()["export"]["manuscriptFormat"] == "markdown"
    assert created.json()["export"]["glossaryFormat"] == "markdown"
    assert current.status_code == 200
    assert current.json()["export"]["id"] == created.json()["export"]["id"]
    dispatch.assert_called_once()
    assert AuditEvent.objects.filter(event="auth.account_export_requested").count() == 1

    invalid = client.post(
        "/api/auth/account/export/",
        {"manuscriptFormat": "pdf", "glossaryFormat": "markdown"},
        content_type="application/json",
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "account_export_manuscript_format_invalid"

    invalid_glossary = client.post(
        "/api/auth/account/export/",
        {"manuscriptFormat": "markdown", "glossaryFormat": "pdf"},
        content_type="application/json",
    )
    assert invalid_glossary.status_code == 400
    assert invalid_glossary.json()["error"] == "account_export_glossary_format_invalid"

    invalid_shape = client.post(
        "/api/auth/account/export/",
        "[]",
        content_type="application/json",
    )
    assert invalid_shape.status_code == 400
    assert invalid_shape.json()["error"] == "invalid_json"


@pytest.mark.django_db
def test_account_export_replacement_removes_old_artifact_and_notification_after_commit(
    client,
    django_user_model,
    django_capture_on_commit_callbacks,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username="replace-export")
    client.force_login(user)
    mark_recent_auth(client)
    old = create_job(user)
    old.status = AccountExport.STATUS_READY
    old.expires_at = timezone.now() + timedelta(days=1)
    old.artifact.save("old.zip", ContentFile(b"old archive"), save=True)
    old_path = Path(old.artifact.path)
    Notification.objects.create(
        recipient=user,
        category=Notification.CATEGORY_SERVICE,
        kind="service.account_export_ready",
        payload={},
        deduplication_hash="a" * 64,
        expires_at=old.expires_at,
    )

    with patch("apps.accounts.account_exports._dispatch_account_export"):
        with django_capture_on_commit_callbacks(execute=True):
            response = client.post(
                "/api/auth/account/export/",
                {"manuscriptFormat": "odt", "glossaryFormat": "html"},
                content_type="application/json",
            )

    assert response.status_code == 201
    assert response.json()["export"]["id"] != str(old.public_id)
    assert not old_path.exists()
    assert not Notification.objects.filter(
        recipient=user,
        kind="service.account_export_ready",
    ).exists()


@pytest.mark.django_db
def test_account_export_download_is_owner_only_private_and_audited(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="export-owner")
    other = django_user_model.objects.create_user(username="export-other")
    export = create_job(owner)
    export.status = AccountExport.STATUS_READY
    export.file_name = "Архив Quillum.zip"
    export.content_type = ACCOUNT_EXPORT_CONTENT_TYPE
    export.completed_at = timezone.now()
    export.expires_at = export.completed_at + timedelta(days=7)
    export.artifact.save("ready.zip", ContentFile(b"private archive"), save=True)

    client.force_login(other)
    assert client.get("/api/auth/account/export/").json()["export"] is None
    denied = client.get(f"/api/auth/account/export/{export.public_id}/download/")
    assert denied.status_code == 404

    client.force_login(owner)
    response = client.get(f"/api/auth/account/export/{export.public_id}/download/")
    assert response.status_code == 200
    assert b"".join(response.streaming_content) == b"private archive"
    assert response["Cache-Control"] == "private, no-store"
    assert response["X-Content-Type-Options"] == "nosniff"
    assert "filename*=UTF-8''" in response["Content-Disposition"]
    assert AuditEvent.objects.filter(event="auth.account_export_downloaded").exists()

    status_payload = client.get("/api/auth/account/export/").json()["export"]
    assert status_payload["downloadUrl"].startswith("/api/auth/account/export/")
    assert "account-exports/" not in status_payload["downloadUrl"]


@pytest.mark.django_db
def test_account_export_archive_does_not_follow_cross_owner_membership(
    django_user_model,
):
    owner = django_user_model.objects.create_user(username="archive-owner")
    other = django_user_model.objects.create_user(username="archive-cross-owner")
    series = Series.objects.create(
        workspace=Workspace.objects.create(owner=owner),
        title="Owner series",
    )
    foreign_book = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=other),
        kind=Manuscript.KIND_BOOK,
        title="Foreign private book",
    )
    SeriesMembership.objects.create(series=series, manuscript=foreign_book, position=1)

    data = archive_bytes(build_account_export(create_job(owner)))

    with zipfile.ZipFile(BytesIO(data)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    assert manifest["manuscripts"] == []


@pytest.mark.django_db
def test_materialize_account_export_keeps_ready_state_when_notification_fails(
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username="export-notification-failure")
    export = create_job(user)

    with patch(
        "apps.accounts.account_exports.create_notification",
        side_effect=RuntimeError("mail pipeline unavailable"),
    ):
        materialize_account_export(export.id)

    export.refresh_from_db()
    assert export.status == AccountExport.STATUS_READY
    assert export.started_at is not None
    assert export.completed_at is not None
    assert export.expires_at == export.completed_at + timedelta(days=7)
    assert export.artifact.storage.exists(export.artifact.name)


@pytest.mark.django_db
def test_materialize_account_export_creates_expiring_panel_notification(
    client,
    django_user_model,
    django_capture_on_commit_callbacks,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username="export-ready-notification")
    export = create_job(user)

    with patch("apps.notifications.service.publish_notification_change") as publish, patch(
        "apps.notifications.tasks.deliver_notification_email.delay"
    ) as deliver_email:
        with django_capture_on_commit_callbacks(execute=True):
            materialize_account_export(export.id)

    export.refresh_from_db()
    notification = Notification.objects.get(
        recipient=user,
        kind="service.account_export_ready",
    )
    assert notification.expires_at == export.expires_at
    assert notification.payload["downloadPath"].endswith(
        f"/{export.public_id}/download/"
    )
    publish.assert_called_once_with(user.id)
    deliver_email.assert_called_once_with(notification.id)
    client.force_login(user)
    assert client.get("/api/notifications/").json()["items"][0]["kind"] == (
        "service.account_export_ready"
    )
    Notification.objects.filter(id=notification.id).update(expires_at=timezone.now())
    assert client.get("/api/notifications/").json()["items"] == []
    assert client.get("/api/notifications/summary/").json()["unreadCount"] == 0


@pytest.mark.django_db
def test_account_export_remains_ready_when_email_enqueue_fails(
    django_user_model,
    django_capture_on_commit_callbacks,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username="export-email-queue-failure")
    export = create_job(user)

    with patch(
        "apps.notifications.tasks.deliver_notification_email.delay",
        side_effect=RuntimeError("email queue unavailable"),
    ):
        with django_capture_on_commit_callbacks(execute=True):
            materialize_account_export(export.id)

    export.refresh_from_db()
    assert export.status == AccountExport.STATUS_READY
    assert Notification.objects.filter(
        recipient=user,
        kind="service.account_export_ready",
    ).exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("language", "subject", "action_label"),
    [
        ("en", "Your Quillum account export is ready", "Open account export"),
        ("ru", "Экспорт аккаунта Quillum готов", "Открыть экспорт аккаунта"),
    ],
)
def test_account_export_ready_email_is_localized_and_multipart(
    django_user_model,
    language,
    subject,
    action_label,
):
    user = django_user_model.objects.create_user(
        username=f"export-email-{language}",
        email=f"export-email-{language}@example.test",
        language=language,
    )
    notification = Notification.objects.create(
        recipient=user,
        category=Notification.CATEGORY_SERVICE,
        kind="service.account_export_ready",
        payload={
            "fileName": "quillum-account-export.zip",
            "actionPath": "/settings?tab=account",
        },
        deduplication_hash=language * 32,
        expires_at=timezone.now() + timedelta(days=7),
    )

    assert send_notification_email(notification) == 1
    assert mail.outbox[-1].subject == subject
    assert "quillum-account-export.zip" in mail.outbox[-1].body
    assert len(mail.outbox[-1].alternatives) == 1
    html_body, mime_type = mail.outbox[-1].alternatives[0]
    assert mime_type == "text/html"
    assert action_label in html_body


@pytest.mark.django_db
def test_stale_account_export_worker_cannot_publish_over_replacement(
    django_user_model,
):
    user = django_user_model.objects.create_user(username="stale-export-worker")
    old = create_job(user)
    replacement_id = None

    def replace_while_building(_export):
        nonlocal replacement_id
        AccountExport.objects.filter(id=old.id).delete()
        replacement = create_job(user, manuscript_format="docx", glossary_format="html")
        replacement_id = replacement.id
        return AccountExportBuild(BytesIO(b"stale"), "stale.zip", 5)

    with patch(
        "apps.accounts.account_exports.build_account_export",
        side_effect=replace_while_building,
    ), patch("apps.accounts.account_exports.create_notification") as notify:
        materialize_account_export(old.id)

    replacement = AccountExport.objects.get(id=replacement_id)
    assert replacement.status == AccountExport.STATUS_PENDING
    assert not replacement.artifact
    notify.assert_not_called()


@pytest.mark.django_db
def test_replaced_ready_export_cannot_publish_a_stale_notification(
    django_user_model,
):
    user = django_user_model.objects.create_user(username="stale-ready-notification")
    old = create_job(user)
    old.status = AccountExport.STATUS_READY
    old.completed_at = timezone.now()
    old.expires_at = old.completed_at + timedelta(days=7)
    old.save()
    old_id = old.id
    old_public_id = old.public_id
    old.delete()
    replacement = create_job(user, manuscript_format="docx", glossary_format="html")

    with patch("apps.accounts.account_exports.create_notification") as notify:
        _notify_ready_account_export(old_id, old_public_id)

    replacement.refresh_from_db()
    assert replacement.status == AccountExport.STATUS_PENDING
    notify.assert_not_called()


@pytest.mark.django_db
def test_account_export_cleanup_quota_and_account_deletion(
    client,
    django_user_model,
    django_capture_on_commit_callbacks,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username="cleanup-export")
    before = storage_usage_bytes(user)
    export = create_job(user)
    export.status = AccountExport.STATUS_READY
    export.completed_at = timezone.now() - timedelta(days=8)
    export.expires_at = timezone.now() - timedelta(days=1)
    export.artifact.save("expired.zip", ContentFile(b"not quota"), save=True)
    expired_path = Path(export.artifact.path)

    assert storage_usage_bytes(user) == before
    client.force_login(user)
    status_payload = client.get("/api/auth/account/export/").json()["export"]
    assert status_payload["status"] == AccountExport.STATUS_EXPIRED
    assert status_payload["downloadUrl"] is None
    expired_download = client.get(
        f"/api/auth/account/export/{export.public_id}/download/"
    )
    assert expired_download.status_code == 410
    assert expired_path.exists()
    assert cleanup_expired_account_exports() == 1
    export.refresh_from_db()
    assert export.status == AccountExport.STATUS_EXPIRED
    assert not export.artifact
    assert not expired_path.exists()

    export.status = AccountExport.STATUS_READY
    export.expires_at = timezone.now() + timedelta(days=7)
    export.artifact.save("delete-with-account.zip", ContentFile(b"delete me"), save=True)
    account_path = Path(export.artifact.path)
    with django_capture_on_commit_callbacks(execute=True):
        delete_account_data(user)
    assert not account_path.exists()
    assert not AccountExport.objects.filter(id=export.id).exists()


@pytest.mark.django_db
def test_account_export_missing_original_fails_explicitly(
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username="missing-export-source")
    UserMediaAsset.objects.create(
        owner=user,
        content_hash="b" * 64,
        original="media/original/missing.png",
        thumbnail_small="media/thumbnail-small/missing.webp",
        thumbnail_medium="media/thumbnail-medium/missing.webp",
        editor_medium="media/editor-medium/missing.webp",
        editor_large="media/editor-large/missing.webp",
        content_type="image/png",
        width=12,
        height=12,
        byte_size=100,
    )
    export = create_job(user)

    materialize_account_export(export.id)

    export.refresh_from_db()
    assert export.status == AccountExport.STATUS_FAILED
    assert export.error_code == "account_export_source_missing"
    assert not export.artifact


@pytest.mark.django_db
def test_account_export_changed_original_fails_checksum_validation(
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username="corrupt-export-source")
    media = create_media(user, png_bytes(), name="changed")
    UserMediaAsset.objects.filter(id=media.id).update(content_hash="b" * 64)
    export = create_job(user)

    materialize_account_export(export.id)

    export.refresh_from_db()
    assert export.status == AccountExport.STATUS_FAILED
    assert export.error_code == "account_export_source_corrupt"
    assert not export.artifact


@pytest.mark.django_db
def test_account_export_archive_preserves_hierarchy_states_and_original_bytes(
    django_user_model,
    settings,
    tmp_path,
    monkeypatch,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username="archive-content")
    avatar = png_bytes("#7a4c9e")
    user.avatar.save("avatar.png", ContentFile(avatar), save=True)
    media_data = png_bytes()
    media = create_media(user, media_data, name="used")
    idea = IdeaItem.objects.create(
        owner=user,
        kind=IdeaItem.KIND_IMAGE,
        title="Visual reference",
        image_media=media,
    )
    text_idea = IdeaItem.objects.create(
        owner=user,
        kind=IdeaItem.KIND_TEXT,
        title="A sudden thought",
        text="First line\nSecond line",
    )
    audio_idea = IdeaItem.objects.create(
        owner=user,
        kind=IdeaItem.KIND_AUDIO,
        title="Loose voice thought",
    )
    audio_idea_bytes = b"idea audio bytes"
    audio_idea_recording = ManuscriptNoteAudio.objects.create(
        idea=audio_idea,
        file=SimpleUploadedFile(
            "idea-voice.ogg",
            audio_idea_bytes,
            content_type="audio/ogg",
        ),
        content_type="audio/ogg",
        codec="opus",
        byte_size=len(audio_idea_bytes),
        duration_ms=2200,
        waveform=[12, 120, 32],
    )
    audio_idea_transcript = "Loose transcript"
    audio_idea_state = ManuscriptNoteTranscription.objects.create(
        audio=audio_idea_recording,
        status=ManuscriptNoteTranscription.STATUS_READY,
        text=audio_idea_transcript,
        language="en",
        requested_at=timezone.now(),
        started_at=timezone.now(),
        finished_at=timezone.now(),
        text_updated_at=timezone.now(),
    )
    orphan_data = png_bytes("#9e5b3f")
    orphan = create_media(user, orphan_data, name="orphan")

    series_workspace = Workspace.objects.create(owner=user)
    series = Series.objects.create(workspace=series_workspace, title="Saga / One")
    drawer_series = Series.objects.create(
        workspace=Workspace.objects.create(owner=user),
        title="Archived Saga",
        drawer_at=timezone.now(),
    )
    book = Manuscript.objects.create(
        workspace=series_workspace,
        kind=Manuscript.KIND_BOOK,
        title="Book: One",
        language="en",
    )
    SeriesMembership.objects.create(series=series, manuscript=book, position=1)
    asset = ManuscriptAsset.objects.create(
        manuscript=book,
        media=media,
        content_type="image/png",
        width=12,
        height=12,
        byte_size=len(media_data),
    )
    folder = ManuscriptItem.objects.create(
        manuscript=book,
        kind=ManuscriptItem.KIND_FOLDER,
        title="Chapter 1",
        position=1024,
    )
    ManuscriptItem.objects.create(
        manuscript=book,
        kind=ManuscriptItem.KIND_FOLDER,
        title="Empty folder",
        position=2048,
    )
    scene = ManuscriptItem.objects.create(
        manuscript=book,
        parent=folder,
        kind=ManuscriptItem.KIND_DOCUMENT,
        title="Scene 1",
        position=1024,
    )
    Document.objects.create(
        manuscript=book,
        item=scene,
        content=text_document("Scene body", asset_id=str(asset.public_id)),
    )
    trash_item = ManuscriptItem.objects.create(
        manuscript=book,
        kind=ManuscriptItem.KIND_DOCUMENT,
        title="Deleted? Scene",
        position=3072,
        trashed_at=timezone.now(),
    )
    Document.objects.create(
        manuscript=book,
        item=trash_item,
        content=text_document("Trash body"),
    )
    ManuscriptTask.objects.create(
        manuscript=book,
        associated_item=scene,
        content={"title": "Finish scene", "description": "Write", "deadline": "2026-10-10"},
        priority=ManuscriptTask.PRIORITY_HIGH,
        is_pinned=True,
    )
    board = ManuscriptBoard.objects.create(manuscript=book, name="Ideas", position=1)
    active_note = ManuscriptNote.objects.create(
        manuscript=book,
        board=board,
        title="First note",
        content=text_document("Note body"),
    )
    note_tag = ManuscriptNoteTag.objects.create(
        manuscript=book,
        name="Research",
        color="blue",
    )
    active_note.tags.add(note_tag)
    active_note.assets.add(asset)
    conflicting_board = ManuscriptBoard.objects.create(
        manuscript=book,
        name="ideas",
        position=2,
    )
    empty_board = ManuscriptBoard.objects.create(
        manuscript=book,
        name="Empty board",
        position=3,
    )
    conflicting_note = ManuscriptNote.objects.create(
        manuscript=book,
        board=conflicting_board,
        title="Second note",
        content=text_document("Second board"),
    )
    ManuscriptNote.objects.create(
        manuscript=book,
        board=board,
        title="Archived note",
        content=text_document("Archived"),
        archived_at=timezone.now(),
    )
    audio_bytes = b"original audio bytes"
    audio_note = ManuscriptNote.objects.create(
        manuscript=book,
        board=board,
        kind=ManuscriptNote.KIND_AUDIO,
        title="Voice note",
        content=ManuscriptNote.EMPTY_CONTENT,
        trashed_at=timezone.now(),
    )
    audio = ManuscriptNoteAudio.objects.create(
        note=audio_note,
        file=SimpleUploadedFile("voice.webm", audio_bytes, content_type="audio/webm"),
        content_type="audio/webm",
        codec="opus",
        byte_size=len(audio_bytes),
        duration_ms=1000,
        waveform=[0.1, 0.2],
    )
    transcript_text = "Current transcript"
    ManuscriptNoteTranscription.objects.create(
        audio=audio,
        status=ManuscriptNoteTranscription.STATUS_PROCESSING,
        text=transcript_text,
        language="en",
        generation=2,
        requested_at=timezone.now(),
        started_at=timezone.now(),
        text_updated_at=timezone.now(),
    )

    private_glossary = Glossary.objects.create(manuscript=book)
    private_category = GlossaryCategory.objects.create(
        glossary=private_glossary,
        name="Private",
        is_hidden=True,
    )
    GlossaryArticle.objects.create(
        glossary=private_glossary,
        category=private_category,
        title="Secret",
        content=text_document("Private article"),
    )
    series_glossary = Glossary.objects.create(series=series)
    series_category = GlossaryCategory.objects.create(
        glossary=series_glossary,
        name="People",
        is_hidden=True,
    )
    target = GlossaryArticle.objects.create(
        glossary=series_glossary,
        category=series_category,
        title="Target",
        content=text_document("Target article"),
    )
    GlossaryArticle.objects.create(
        glossary=series_glossary,
        category=series_category,
        title="Source",
        content={
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "Target link",
                            "marks": [
                                {
                                    "type": "glossaryLink",
                                    "attrs": {"articleId": str(target.public_id)},
                                }
                            ],
                        }
                    ],
                }
            ],
        },
    )

    drawer_workspace = Workspace.objects.create(owner=user)
    one_shot = Manuscript.objects.create(
        workspace=drawer_workspace,
        kind=Manuscript.KIND_ONESHOT,
        title="Loose Story",
        drawer_at=timezone.now(),
    )
    Document.objects.create(manuscript=one_shot, content=text_document("One-shot body"))

    export = create_job(user)
    monkeypatch.setattr(zipfile, "ZIP64_LIMIT", 1)
    data = archive_bytes(build_account_export(export))

    with zipfile.ZipFile(BytesIO(data)) as archive:
        names = archive.namelist()
        assert archive.testzip() is None
        assert "README.en.txt" in names
        assert "README.ru.txt" in names
        assert "manifest.json" in names
        assert any(name.startswith("series/") and "/manuscript/" in name for name in names)
        assert any(name.startswith("_drawer/series/") for name in names)
        assert any("/_trash/manuscript/" in name for name in names)
        assert any("/manuscript/" in name and "Empty folder/" in name for name in names)
        assert any("/notes/text/" in name for name in names)
        assert any("/notes/text/Empty board/" in name for name in names)
        assert any("/notes/_archive/text/" in name for name in names)
        audio_path = next(
            name
            for name in names
            if "/notes/_trash/audio/" in name and name.endswith(".webm")
        )
        assert archive.read(audio_path) == audio_bytes
        assert any("/_inactive/glossary/" in name for name in names)
        assert any(name.startswith("series/") and "/glossary/" in name for name in names)
        assert any(
            name.startswith("_drawer/manuscripts/") and name.endswith(".md")
            for name in names
        )

        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["schemaVersion"] == 3
        assert manifest["formats"] == {"manuscripts": "markdown", "glossary": "markdown"}
        assert manifest["ideas"] == [
            {
                "id": str(idea.public_id),
                "kind": "image",
                "createdAt": idea.created_at.isoformat(),
                "updatedAt": idea.updated_at.isoformat(),
                "title": idea.title,
                "originalPath": next(
                    item["path"]
                    for item in manifest["originals"]
                    if item["id"] == str(media.public_id)
                ),
            },
            {
                "id": str(text_idea.public_id),
                "kind": "text",
                "createdAt": text_idea.created_at.isoformat(),
                "updatedAt": text_idea.updated_at.isoformat(),
                "title": text_idea.title,
                "path": next(
                    name
                    for name in names
                    if name.startswith("ideas/text/") and name.endswith(".txt")
                ),
                "contentType": "text/plain; charset=utf-8",
                "byteSize": len(text_idea.text.encode("utf-8")),
                "sha256": hashlib.sha256(text_idea.text.encode("utf-8")).hexdigest(),
            },
            {
                "id": str(audio_idea.public_id),
                "kind": "audio",
                "createdAt": audio_idea.created_at.isoformat(),
                "updatedAt": audio_idea.updated_at.isoformat(),
                "title": audio_idea.title,
                "path": next(
                    name
                    for name in names
                    if name.startswith("ideas/audio/") and name.endswith(".ogg")
                ),
                "contentType": "audio/ogg",
                "codec": "opus",
                "durationMs": 2200,
                "byteSize": len(audio_idea_bytes),
                "sha256": hashlib.sha256(audio_idea_bytes).hexdigest(),
                "transcription": {
                    "path": next(
                        name
                        for name in names
                        if name.startswith("ideas/audio/")
                        and name.endswith(".transcript.txt")
                    ),
                    "language": "en",
                    "status": "ready",
                    "textUpdatedAt": audio_idea_state.text_updated_at.isoformat(),
                    "byteSize": len(audio_idea_transcript.encode("utf-8")),
                    "sha256": hashlib.sha256(
                        audio_idea_transcript.encode("utf-8")
                    ).hexdigest(),
                },
            },
        ]
        assert archive.read(manifest["ideas"][1]["path"]).decode("utf-8") == text_idea.text
        assert archive.read(manifest["ideas"][2]["path"]) == audio_idea_bytes
        assert archive.read(
            manifest["ideas"][2]["transcription"]["path"]
        ).decode("utf-8") == audio_idea_transcript
        assert any(item["id"] == str(one_shot.public_id) for item in manifest["manuscripts"])
        assert any(item["id"] == str(board.public_id) for item in manifest["noteBoards"])
        assert any(item["id"] == str(empty_board.public_id) for item in manifest["noteBoards"])
        assert any(item["id"] == str(note_tag.public_id) for item in manifest["noteTags"])
        assert any(
            item["id"] == str(private_category.public_id)
            and item["hidden"] is True
            for item in manifest["glossaryCategories"]
        )
        original_by_id = {item["id"]: item for item in manifest["originals"]}
        assert archive.read(original_by_id[str(media.public_id)]["path"]) == media_data
        assert archive.read(original_by_id[str(orphan.public_id)]["path"]) == orphan_data
        assert original_by_id[str(orphan.public_id)]["usages"] == []
        assert original_by_id[str(media.public_id)]["sha256"] == hashlib.sha256(
            media_data
        ).hexdigest()
        assert {
            "kind": "idea_image",
            "ideaId": str(idea.public_id),
        } in original_by_id[str(media.public_id)]["usages"]
        board_note_paths = [
            item["path"]
            for item in manifest["notes"]
            if item["id"] in {str(active_note.public_id), str(conflicting_note.public_id)}
        ]
        board_directories = {str(Path(path).parent).casefold() for path in board_note_paths}
        assert len(board_directories) == 2
        assert any(
            suffix in path
            for suffix in {
                str(board.public_id)[:12],
                str(conflicting_board.public_id)[:12],
            }
            for path in board_note_paths
        )
        assert original_by_id["account-avatar"]["contentType"] == "image/png"
        assert archive.read(original_by_id["account-avatar"]["path"]) == avatar
        assert next(item for item in manifest["notes"] if item["id"] == str(audio_note.public_id))[
            "sha256"
        ] == hashlib.sha256(audio_bytes).hexdigest()
        audio_manifest = next(
            item for item in manifest["notes"] if item["id"] == str(audio_note.public_id)
        )
        transcript = audio_manifest["transcription"]
        assert transcript["status"] == "processing"
        assert transcript["language"] == "en"
        assert archive.read(transcript["path"]).decode("utf-8") == transcript_text
        assert transcript["byteSize"] == len(transcript_text.encode("utf-8"))
        assert transcript["sha256"] == hashlib.sha256(
            transcript_text.encode("utf-8")
        ).hexdigest()
        assert manifest["taskCollections"][0]["sha256"]
        task_collection = next(
            item
            for item in manifest["taskCollections"]
            if item["manuscriptId"] == str(book.public_id)
        )
        task_payload = json.loads(archive.read(task_collection["path"]))
        assert task_payload["tasks"][0]["state"] == "open"
        assert task_payload["tasks"][0]["sourceOrder"] == 1
        scene_entry = next(
            item
            for manuscript in manifest["manuscripts"]
            if manuscript["id"] == str(book.public_id)
            for item in manuscript["items"]
            if item.get("documentId")
            and item["title"] == "Scene 1"
        )
        assert scene_entry["sha256"]
        markdown = archive.read(scene_entry["path"]).decode()
        assert "_originals" in markdown
        source_path = next(
            item["path"]
            for item in manifest["glossaryArticles"]
            if item["title"] == "Source"
        )
        target_path = next(
            item["path"]
            for item in manifest["glossaryArticles"]
            if item["title"] == "Target"
        )
        relative_target = posixpath.relpath(target_path, posixpath.dirname(source_path))
        quoted_target = quote(relative_target, safe=":/?#[]@!$&'+,;=%~.-_")
        assert f"]({quoted_target})" in archive.read(source_path).decode()
        assert any(item["id"] == str(drawer_series.public_id) for item in manifest["series"])


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("manuscript_format", "glossary_format", "document_suffix", "article_suffix"),
    [
        ("markdown", "markdown", ".md", ".md"),
        ("docx", "html", ".docx", ".html"),
        ("odt", "markdown", ".odt", ".md"),
    ],
)
def test_account_export_document_and_glossary_formats(
    django_user_model,
    settings,
    tmp_path,
    manuscript_format,
    glossary_format,
    document_suffix,
    article_suffix,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(username=f"formats-{manuscript_format}")
    manuscript = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=user),
        kind=Manuscript.KIND_ONESHOT,
        title="Formatted story",
        language="en",
    )
    media_data = png_bytes()
    media = create_media(user, media_data, name=f"format-{manuscript_format}")
    asset = ManuscriptAsset.objects.create(
        manuscript=manuscript,
        media=media,
        content_type="image/png",
        width=12,
        height=12,
        byte_size=len(media_data),
    )
    Document.objects.create(
        manuscript=manuscript,
        content=text_document("Formatted body", asset_id=str(asset.public_id)),
    )
    glossary = Glossary.objects.create(manuscript=manuscript)
    category = GlossaryCategory.objects.create(glossary=glossary, name="Places")
    GlossaryArticle.objects.create(
        glossary=glossary,
        category=category,
        title="City",
        content=text_document("Article body"),
    )
    export = create_job(
        user,
        manuscript_format=manuscript_format,
        glossary_format=glossary_format,
    )
    data = archive_bytes(build_account_export(export))

    with zipfile.ZipFile(BytesIO(data)) as archive:
        document_path = next(
            name
            for name in archive.namelist()
            if "/manuscript/" in name and name.endswith(document_suffix)
        )
        article_path = next(
            name
            for name in archive.namelist()
            if "/glossary/" in name and name.endswith(article_suffix)
        )
        document_data = archive.read(document_path)
        article_data = archive.read(article_path)
        if manuscript_format == "markdown":
            assert "Formatted body" in document_data.decode()
            assert "_originals" in document_data.decode()
        else:
            with zipfile.ZipFile(BytesIO(document_data)) as office_archive:
                assert office_archive.testzip() is None
                expected_prefix = "word/media/" if manuscript_format == "docx" else "Pictures/"
                assert any(
                    name.startswith(expected_prefix)
                    for name in office_archive.namelist()
                )
        if glossary_format == "html":
            assert b"<html" in article_data
        else:
            assert article_data.decode().startswith("# City")
