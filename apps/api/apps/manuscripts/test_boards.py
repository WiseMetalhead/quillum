import json
from io import BytesIO

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from PIL import Image

from apps.accounts.models import UserMediaAsset
from apps.adminpanel.models import TierQuotaOverride
from apps.adminpanel.runtime_settings import invalidate_runtime_setting
from apps.notifications.models import Notification

from .models import (
    Manuscript,
    ManuscriptAsset,
    ManuscriptBoard,
    ManuscriptItem,
    ManuscriptNote,
    ManuscriptNoteAudio,
    ManuscriptNoteTag,
    ManuscriptNoteTranscription,
)
from .transcription import (
    TranscriptionFailure,
    TranscriptionResult,
    _complete_transcription,
    process_next_audio_transcription,
    queue_audio_transcription,
)

EMPTY = {"type": "doc", "content": [{"type": "paragraph"}]}


@pytest.fixture
def transcription_enabled(monkeypatch):
    monkeypatch.setenv("QUILLUM_AUDIO_TRANSCRIPTION_ENABLED", "true")
    invalidate_runtime_setting("audio_transcription_enabled")
    yield
    invalidate_runtime_setting("audio_transcription_enabled")


def image_upload(name="note.png"):
    output = BytesIO()
    Image.new("RGB", (64, 64), "#245b47").save(output, format="PNG")
    return SimpleUploadedFile(name, output.getvalue(), content_type="image/png")


def create_oneshot(client, title="Book"):
    return client.post("/api/manuscripts/oneshots/", {"title": title}).json()["manuscript"]


def note_payload(**overrides):
    payload = {
        "title": "Private idea",
        "content": {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Secret body"}]}
            ],
        },
        "schemaVersion": 1,
        "color": "blue",
        "boardId": None,
        "tagIds": [],
        "itemIds": [],
        "pinned": False,
        "favourite": False,
    }
    payload.update(overrides)
    return payload


def audio_metadata(**overrides):
    payload = {
        "title": "Recorded idea",
        "color": "blue",
        "boardId": None,
        "tagIds": [],
        "itemIds": [],
        "pinned": False,
        "favourite": False,
        "durationMs": 12_345,
        "waveform": [0, 64, 255, 128],
    }
    payload.update(overrides)
    return payload


def audio_upload(content_type="audio/webm", body=None):
    if body is None:
        body = {
            "audio/webm": b"\x1aE\xdf\xa3webm-A_OPUS-audio",
            "audio/ogg": b"OggS-OpusHead-audio",
            "audio/mp4": b"\x00\x00\x00\x18ftypM4A-mp4a-audio",
        }[content_type]
    extension = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a"}[content_type]
    return SimpleUploadedFile(f"note.{extension}", body, content_type=content_type)


def create_audio_note(
    client,
    manuscript_id,
    *,
    content_type="audio/webm",
    body=None,
    **metadata,
):
    return client.post(
        f"/api/manuscripts/{manuscript_id}/audio-notes/",
        {
            "audio": audio_upload(content_type, body),
            "metadata": json.dumps(audio_metadata(**metadata)),
        },
    )


@pytest.mark.django_db
def test_note_board_tag_and_content_are_plaintext(client, django_user_model):
    user = django_user_model.objects.create_user(username="writer", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    board = client.post(
        f"/api/manuscripts/{manuscript['id']}/boards/",
        data=json.dumps({"name": "Characters"}),
        content_type="application/json",
    ).json()["board"]
    tag = client.post(
        f"/api/manuscripts/{manuscript['id']}/note-tags/",
        data=json.dumps({"name": "Protagonist", "color": "green"}),
        content_type="application/json",
    ).json()["tag"]
    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/notes/",
        data=json.dumps(note_payload(boardId=board["id"], tagIds=[tag["id"]])),
        content_type="application/json",
    )

    assert created.status_code == 201
    stored_note = ManuscriptNote.objects.values().get()
    stored_board = ManuscriptBoard.objects.values().get()
    stored_tag = ManuscriptNoteTag.objects.values().get()
    assert stored_note["title"] == "Private idea"
    assert stored_note["content"]["content"][0]["content"][0]["text"] == "Secret body"
    assert stored_board["name"] == "Characters"
    assert stored_tag["name"] == "Protagonist"
    assert created.json()["note"]["preview"] == "Secret body"


@pytest.mark.django_db
def test_note_checklist_uses_schema_v2_and_is_visible_in_preview(client, django_user_model):
    user = django_user_model.objects.create_user(username="checklist-writer", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    checklist = {
        "type": "doc",
        "content": [
            {
                "type": "taskList",
                "content": [
                    {
                        "type": "taskItem",
                        "attrs": {"checked": False},
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": "Draft opening"}],
                            }
                        ],
                    },
                    {
                        "type": "taskItem",
                        "attrs": {"checked": True},
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [{"type": "text", "text": "Choose a title"}],
                            }
                        ],
                    },
                ],
            }
        ],
    }
    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/notes/",
        data=json.dumps(note_payload(content=checklist, schemaVersion=2)),
        content_type="application/json",
    )
    legacy = client.post(
        f"/api/manuscripts/{manuscript['id']}/notes/",
        data=json.dumps(note_payload(content=checklist, schemaVersion=1)),
        content_type="application/json",
    )

    assert created.status_code == 201
    assert created.json()["note"]["schemaVersion"] == 2
    assert created.json()["note"]["preview"] == "Draft opening\nChoose a title"
    assert legacy.status_code == 400
    assert legacy.json()["error"] == "note_block_unsupported"


@pytest.mark.django_db
def test_shared_note_image_can_be_deleted_from_storage_after_note_delete(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="preserved-note-image",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    uploaded = client.post(
        f"/api/manuscripts/{manuscript['id']}/assets/",
        {"image": image_upload()},
    )
    asset = uploaded.json()["asset"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "illustration",
                "attrs": {
                    "assetId": asset["id"],
                    "alt": "",
                    "caption": "",
                    "alignment": "center",
                },
            }
        ],
    }
    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/notes/",
        data=json.dumps(note_payload(content=content)),
        content_type="application/json",
    ).json()["note"]
    trashed = client.post(
        f"/api/manuscripts/notes/{created['id']}/lifecycle/",
        data=json.dumps({"action": "trash", "expectedGeneration": created["saveGeneration"]}),
        content_type="application/json",
    )
    deleted = client.delete(f"/api/manuscripts/notes/{created['id']}/lifecycle/")
    media = UserMediaAsset.objects.get(owner=user)
    storage = client.get("/api/auth/storage/?group=all&page=1&pageSize=18")
    stored_item = next(
        item for item in storage.json()["items"] if item["id"] == f"media:{media.public_id}"
    )

    assert uploaded.status_code == 201
    assert trashed.status_code == 200
    assert deleted.status_code == 200
    assert stored_item["usages"] == []
    assert stored_item["deletable"] is True

    removed = client.delete(f"/api/auth/storage/media:{media.public_id}/")

    assert removed.status_code == 200
    assert not UserMediaAsset.objects.filter(id=media.id).exists()
    assert not ManuscriptAsset.objects.filter(public_id=asset["id"]).exists()


@pytest.mark.django_db
def test_note_update_uses_generation_and_validates_item_ownership(client, django_user_model):
    user = django_user_model.objects.create_user(username="writer", password="password")
    client.force_login(user)
    first = create_oneshot(client, "First")
    second = create_oneshot(client, "Second")
    second_item = ManuscriptItem.objects.get(manuscript__public_id=second["id"])
    rejected = client.post(
        f"/api/manuscripts/{first['id']}/notes/",
        data=json.dumps(note_payload(itemIds=[str(second_item.public_id)])),
        content_type="application/json",
    )
    created = client.post(
        f"/api/manuscripts/{first['id']}/notes/",
        data=json.dumps(note_payload()),
        content_type="application/json",
    ).json()["note"]
    changed_payload = note_payload(
        title="Changed",
        expectedGeneration=created["saveGeneration"],
    )
    changed = client.patch(
        f"/api/manuscripts/notes/{created['id']}/",
        data=json.dumps(changed_payload),
        content_type="application/json",
    )
    conflict = client.patch(
        f"/api/manuscripts/notes/{created['id']}/",
        data=json.dumps(changed_payload),
        content_type="application/json",
    )

    assert rejected.status_code == 400
    assert rejected.json()["error"] == "note_item_not_found"
    assert changed.status_code == 200
    assert changed.json()["note"]["saveGeneration"] == 1
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "note_update_conflict"


@pytest.mark.django_db
def test_board_delete_keeps_notes_and_lifecycle_preserves_archive(client, django_user_model):
    user = django_user_model.objects.create_user(username="writer", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    board = client.post(
        f"/api/manuscripts/{manuscript['id']}/boards/",
        data=json.dumps({"name": "Plot"}),
        content_type="application/json",
    ).json()["board"]
    note = client.post(
        f"/api/manuscripts/{manuscript['id']}/notes/",
        data=json.dumps(note_payload(boardId=board["id"])),
        content_type="application/json",
    ).json()["note"]
    assert client.delete(f"/api/manuscripts/boards/{board['id']}/").status_code == 200
    note = client.get(f"/api/manuscripts/notes/{note['id']}/").json()["note"]
    assert note["boardId"] is None

    archived = client.post(
        f"/api/manuscripts/notes/{note['id']}/lifecycle/",
        data=json.dumps({"action": "archive", "expectedGeneration": note["saveGeneration"]}),
        content_type="application/json",
    ).json()["note"]
    trashed = client.post(
        f"/api/manuscripts/notes/{note['id']}/lifecycle/",
        data=json.dumps({"action": "trash", "expectedGeneration": archived["saveGeneration"]}),
        content_type="application/json",
    ).json()["note"]
    restored = client.post(
        f"/api/manuscripts/notes/{note['id']}/lifecycle/",
        data=json.dumps({"action": "restore", "expectedGeneration": trashed["saveGeneration"]}),
        content_type="application/json",
    ).json()["note"]

    assert restored["archivedAt"] is not None
    assert restored["trashedAt"] is None


@pytest.mark.django_db
def test_empty_note_is_not_created_and_other_users_cannot_read_notes(client, django_user_model):
    owner = django_user_model.objects.create_user(username="owner", password="password")
    stranger = django_user_model.objects.create_user(username="stranger", password="password")
    client.force_login(owner)
    manuscript = create_oneshot(client)
    empty = client.post(
        f"/api/manuscripts/{manuscript['id']}/notes/",
        data=json.dumps(note_payload(title="", content=EMPTY)),
        content_type="application/json",
    )
    note = client.post(
        f"/api/manuscripts/{manuscript['id']}/notes/",
        data=json.dumps(note_payload()),
        content_type="application/json",
    ).json()["note"]
    client.force_login(stranger)

    assert empty.status_code == 400
    assert empty.json()["error"] == "note_empty"
    assert client.get(f"/api/manuscripts/notes/{note['id']}/").status_code == 404


@pytest.mark.django_db
def test_bulk_restore_and_empty_trash(client, django_user_model):
    user = django_user_model.objects.create_user(username="bulk-writer", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    notes = [
        client.post(
            f"/api/manuscripts/{manuscript['id']}/notes/",
            data=json.dumps(note_payload(title=f"Note {index}")),
            content_type="application/json",
        ).json()["note"]
        for index in range(2)
    ]
    trashed = [
        client.post(
            f"/api/manuscripts/notes/{note['id']}/lifecycle/",
            data=json.dumps(
                {
                    "action": "trash",
                    "expectedGeneration": note["saveGeneration"],
                }
            ),
            content_type="application/json",
        ).json()["note"]
        for note in notes
    ]

    restored = client.post(
        f"/api/manuscripts/{manuscript['id']}/notes/bulk-lifecycle/",
        data=json.dumps(
            {
                "action": "restore",
                "notes": [
                    {"id": note["id"], "expectedGeneration": note["saveGeneration"]}
                    for note in trashed
                ],
            }
        ),
        content_type="application/json",
    )
    assert restored.status_code == 200
    assert restored.json()["updated"] == 2

    current = client.get(f"/api/manuscripts/{manuscript['id']}/notes/?view=all").json()["items"]
    for note in current:
        response = client.post(
            f"/api/manuscripts/notes/{note['id']}/lifecycle/",
            data=json.dumps(
                {
                    "action": "trash",
                    "expectedGeneration": note["saveGeneration"],
                }
            ),
            content_type="application/json",
        )
        assert response.status_code == 200

    emptied = client.delete(f"/api/manuscripts/{manuscript['id']}/notes/trash/")
    assert emptied.status_code == 200
    assert emptied.json()["deleted"] == 2
    assert ManuscriptNote.objects.count() == 0


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("content_type", "codec"),
    [("audio/webm", "opus"), ("audio/ogg", "opus"), ("audio/mp4", "aac")],
)
def test_audio_note_upload_returns_audio_contract(
    client,
    django_user_model,
    content_type,
    codec,
):
    user = django_user_model.objects.create_user(username=f"audio-{codec}-{content_type[-3:]}")
    client.force_login(user)
    manuscript = create_oneshot(client)

    response = create_audio_note(client, manuscript["id"], content_type=content_type)

    assert response.status_code == 201
    note = response.json()["note"]
    assert note["kind"] == "audio"
    assert note["content"] == EMPTY
    assert note["audio"] == {
        "contentType": content_type,
        "codec": codec,
        "byteSize": len(audio_upload(content_type).read()),
        "durationMs": 12_345,
        "waveform": [0, 64, 255, 128],
        "playbackUrl": f"/api/manuscripts/notes/{note['id']}/audio/",
        "downloadUrl": f"/api/manuscripts/notes/{note['id']}/audio/?download=1",
    }
    assert ManuscriptNoteAudio.objects.filter(note__public_id=note["id"]).exists()


@pytest.mark.django_db
def test_audio_note_validates_signature_metadata_and_cannot_replace_file(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="audio-validation")
    client.force_login(user)
    manuscript = create_oneshot(client)
    invalid_file = client.post(
        f"/api/manuscripts/{manuscript['id']}/audio-notes/",
        {
            "audio": audio_upload("audio/webm", b"not-webm"),
            "metadata": json.dumps(audio_metadata()),
        },
    )
    invalid_waveform = client.post(
        f"/api/manuscripts/{manuscript['id']}/audio-notes/",
        {
            "audio": audio_upload(),
            "metadata": json.dumps(audio_metadata(waveform=[256])),
        },
    )
    created = create_audio_note(client, manuscript["id"]).json()["note"]
    metadata_update = audio_metadata(title="Renamed recording")
    metadata_update.pop("durationMs")
    metadata_update.pop("waveform")
    changed = client.patch(
        f"/api/manuscripts/notes/{created['id']}/",
        data=json.dumps({
            **metadata_update,
            "expectedGeneration": created["saveGeneration"],
        }),
        content_type="application/json",
    )
    conflict = client.patch(
        f"/api/manuscripts/notes/{created['id']}/",
        data=json.dumps({
            **metadata_update,
            "expectedGeneration": created["saveGeneration"],
        }),
        content_type="application/json",
    )
    replacement = client.patch(
        f"/api/manuscripts/notes/{created['id']}/",
        data=json.dumps({
            **metadata_update,
            "expectedGeneration": changed.json()["note"]["saveGeneration"],
            "audio": "replacement",
        }),
        content_type="application/json",
    )

    assert invalid_file.status_code == 400
    assert invalid_file.json()["error"] == "audio_file_invalid"
    assert invalid_waveform.status_code == 400
    assert invalid_waveform.json()["error"] == "audio_waveform_invalid"
    assert changed.status_code == 200
    assert changed.json()["note"]["title"] == "Renamed recording"
    assert conflict.status_code == 409
    assert replacement.status_code == 400
    assert replacement.json()["error"] == "note_update_invalid"
    assert ManuscriptNote.objects.filter(kind=ManuscriptNote.KIND_AUDIO).count() == 1


@pytest.mark.django_db
def test_audio_note_quota_rejection_leaves_no_row_or_file(client, django_user_model, tmp_path):
    user = django_user_model.objects.create_user(username="audio-quota")
    TierQuotaOverride.objects.create(tier=user.tier, key="storage_bytes", value=1)
    client.force_login(user)
    manuscript = create_oneshot(client)

    with override_settings(MEDIA_ROOT=tmp_path):
        response = create_audio_note(client, manuscript["id"])

    assert response.status_code == 409
    assert response.json()["error"] == "quota_limit_reached"
    assert not ManuscriptNote.objects.filter(kind=ManuscriptNote.KIND_AUDIO).exists()
    assert not (tmp_path / "audio-notes").exists()


@pytest.mark.django_db
def test_audio_note_stream_supports_head_range_ownership_and_storage_filter(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(username="audio-owner")
    stranger = django_user_model.objects.create_user(username="audio-stranger")
    client.force_login(owner)
    manuscript = create_oneshot(client)
    note = create_audio_note(client, manuscript["id"]).json()["note"]
    url = note["audio"]["playbackUrl"]

    head = client.head(url)
    partial = client.get(url, HTTP_RANGE="bytes=0-3")
    unsatisfiable = client.get(url, HTTP_RANGE="bytes=999-1000")
    storage = client.get("/api/auth/storage/?group=audioNotes&page=1&pageSize=18")

    assert head.status_code == 200
    assert head["Accept-Ranges"] == "bytes"
    assert head["Cache-Control"] == "private, no-store"
    assert partial.status_code == 206
    assert partial["Content-Range"].startswith("bytes 0-3/")
    assert partial["Content-Length"] == "4"
    assert b"".join(partial.streaming_content) == b"\x1aE\xdf\xa3"
    assert unsatisfiable.status_code == 416
    assert unsatisfiable["Content-Range"].startswith("bytes */")
    assert storage.status_code == 200
    assert storage.json()["items"][0]["mediaType"] == "audio_note"
    assert storage.json()["items"][0]["audio"]["noteId"] == note["id"]
    assert storage.json()["items"][0]["deletable"] is False

    client.force_login(stranger)
    assert client.get(url).status_code == 404


@pytest.mark.django_db
def test_audio_transcription_api_enforces_feature_owner_trash_and_active_state(
    client,
    django_user_model,
    monkeypatch,
    transcription_enabled,
):
    owner = django_user_model.objects.create_user(username="transcription-owner")
    stranger = django_user_model.objects.create_user(username="transcription-stranger")
    client.force_login(owner)
    manuscript = create_oneshot(client)
    note = create_audio_note(client, manuscript["id"]).json()["note"]
    url = f"/api/manuscripts/notes/{note['id']}/transcription/"
    monkeypatch.setattr(
        "apps.manuscripts.transcription.transcription_model_ready",
        lambda: True,
    )
    monkeypatch.setattr(
        "apps.manuscripts.transcription._enqueue_worker",
        lambda: None,
    )

    initial = client.get(url)
    queued = client.post(url)
    duplicate = client.post(url)
    active_delete = client.delete(url)

    assert initial.status_code == 200
    assert initial.json()["transcription"] == {
        "featureEnabled": True,
        "status": "none",
        "text": None,
        "hasText": False,
        "language": None,
        "errorCode": None,
        "requestedAt": None,
        "startedAt": None,
        "finishedAt": None,
        "textUpdatedAt": None,
    }
    assert queued.status_code == 202
    assert queued.json()["transcription"]["status"] == "queued"
    assert duplicate.status_code == 409
    assert duplicate.json()["error"] == "audio_transcription_in_progress"
    assert active_delete.status_code == 409
    assert active_delete.json()["error"] == "audio_transcription_delete_in_progress"

    client.force_login(stranger)
    assert client.get(url).status_code == 404
    client.force_login(owner)

    state = ManuscriptNoteTranscription.objects.get(audio__note__public_id=note["id"])
    state.status = ManuscriptNoteTranscription.STATUS_READY
    state.text = "Saved transcript"
    state.language = "en"
    state.finished_at = timezone.now()
    state.text_updated_at = timezone.now()
    state.save()
    deleted = client.delete(url)
    assert deleted.status_code == 200
    assert deleted.json()["transcription"]["status"] == "none"
    assert not ManuscriptNoteTranscription.objects.exists()

    trashed = client.post(
        f"/api/manuscripts/notes/{note['id']}/lifecycle/",
        data=json.dumps({"action": "trash", "expectedGeneration": note["saveGeneration"]}),
        content_type="application/json",
    )
    assert trashed.status_code == 200
    trash_request = client.post(url)
    assert trash_request.status_code == 409
    assert trash_request.json()["error"] == "audio_transcription_note_trashed"

    monkeypatch.setenv("QUILLUM_AUDIO_TRANSCRIPTION_ENABLED", "false")
    invalidate_runtime_setting("audio_transcription_enabled")
    disabled = client.post(url)
    assert disabled.status_code == 409
    assert disabled.json()["error"] == "audio_transcription_disabled"


@pytest.mark.django_db
def test_audio_transcription_worker_is_global_fifo_restart_safe_and_preserves_old_text(
    client,
    django_user_model,
    monkeypatch,
    transcription_enabled,
    django_capture_on_commit_callbacks,
):
    first_user = django_user_model.objects.create_user(username="transcription-first")
    second_user = django_user_model.objects.create_user(username="transcription-second")
    monkeypatch.setattr(
        "apps.manuscripts.transcription.transcription_model_ready",
        lambda: True,
    )
    monkeypatch.setattr(
        "apps.manuscripts.transcription._enqueue_worker",
        lambda: None,
    )
    released_models = []
    monkeypatch.setattr(
        "apps.manuscripts.transcription.unload_transcription_model",
        lambda: released_models.append(True) or True,
    )

    client.force_login(first_user)
    first_manuscript = create_oneshot(client, "First")
    first_note = create_audio_note(client, first_manuscript["id"]).json()["note"]
    client.force_login(second_user)
    second_manuscript = create_oneshot(client, "Second")
    second_note = create_audio_note(
        client,
        second_manuscript["id"],
        body=b"\x1aE\xdf\xa3second-webm-A_OPUS-audio",
    ).json()["note"]
    first_audio = ManuscriptNoteAudio.objects.get(note__public_id=first_note["id"])
    second_audio = ManuscriptNoteAudio.objects.get(note__public_id=second_note["id"])
    first_generation = first_audio.note.save_generation
    queue_audio_transcription(first_audio)
    queue_audio_transcription(second_audio)

    seen = []
    results = iter(
        [
            TranscriptionResult("First transcript", "en"),
            TranscriptionResult("Вторая расшифровка", "ru"),
        ]
    )

    def deterministic_transcription(file_handle):
        seen.append(file_handle.read())
        return next(results)

    monkeypatch.setattr(
        "apps.manuscripts.transcription.transcribe_audio_file",
        deterministic_transcription,
    )
    with django_capture_on_commit_callbacks(execute=True):
        assert process_next_audio_transcription("worker-first") is True
    assert released_models == []
    with django_capture_on_commit_callbacks(execute=True):
        assert process_next_audio_transcription("worker-second") is True
    assert released_models == [True]

    first_state = ManuscriptNoteTranscription.objects.get(audio=first_audio)
    second_state = ManuscriptNoteTranscription.objects.get(audio=second_audio)
    assert first_state.text == "First transcript"
    assert first_state.language == "en"
    assert second_state.text == "Вторая расшифровка"
    assert second_state.language == "ru"
    assert seen[0].startswith(b"\x1aE\xdf\xa3")
    assert b"second-webm" not in seen[0]
    assert b"second-webm" in seen[1]
    first_audio.note.refresh_from_db()
    assert first_audio.note.save_generation == first_generation

    ready_notification = Notification.objects.get(
        recipient=first_user,
        kind="service.audio_transcription_ready",
    )
    assert ready_notification.email_requested_at is None
    assert "text" not in ready_notification.payload
    assert ready_notification.payload["actionPath"].endswith(
        f"/boards?note={first_note['id']}&workspace=author"
    )

    queue_audio_transcription(first_audio)
    released_models.clear()
    first_state.refresh_from_db()
    assert first_state.status == ManuscriptNoteTranscription.STATUS_QUEUED
    assert first_state.text == "First transcript"
    replacement_generation = first_state.generation
    first_state.status = ManuscriptNoteTranscription.STATUS_PROCESSING
    first_state.task_id = "worker-restarted"
    first_state.started_at = timezone.now()
    first_state.save()

    def unsupported_language(_file_handle):
        raise TranscriptionFailure("unsupported_language")

    monkeypatch.setattr(
        "apps.manuscripts.transcription.transcribe_audio_file",
        unsupported_language,
    )
    with django_capture_on_commit_callbacks(execute=True):
        assert process_next_audio_transcription("worker-restarted") is True
    assert released_models == [True]
    first_state.refresh_from_db()
    assert first_state.status == ManuscriptNoteTranscription.STATUS_FAILED
    assert first_state.error_code == "unsupported_language"
    assert first_state.text == "First transcript"
    assert first_state.language == "en"
    assert _complete_transcription(
        first_state.id,
        replacement_generation - 1,
        TranscriptionResult("Stale result", "en"),
    ) is False
    first_state.refresh_from_db()
    assert first_state.text == "First transcript"

    failed_notification = Notification.objects.get(
        recipient=first_user,
        kind="service.audio_transcription_failed",
    )
    assert failed_notification.email_requested_at is None
    assert failed_notification.payload["errorCode"] == "unsupported_language"
    assert "text" not in failed_notification.payload


@pytest.mark.django_db
def test_audio_transcription_cascades_and_deleted_inference_is_discarded(
    client,
    django_user_model,
    monkeypatch,
    transcription_enabled,
):
    user = django_user_model.objects.create_user(username="transcription-cascade")
    client.force_login(user)
    manuscript = create_oneshot(client)
    note = create_audio_note(client, manuscript["id"]).json()["note"]
    audio = ManuscriptNoteAudio.objects.get(note__public_id=note["id"])
    monkeypatch.setattr(
        "apps.manuscripts.transcription.transcription_model_ready",
        lambda: True,
    )
    monkeypatch.setattr(
        "apps.manuscripts.transcription._enqueue_worker",
        lambda: None,
    )
    queue_audio_transcription(audio)
    state = ManuscriptNoteTranscription.objects.get(audio=audio)
    state.status = ManuscriptNoteTranscription.STATUS_PROCESSING
    state.task_id = "deleted-job"
    state.started_at = timezone.now()
    state.save()

    ManuscriptNote.objects.get(public_id=note["id"]).delete()

    assert not ManuscriptNoteTranscription.objects.exists()
    assert process_next_audio_transcription("deleted-job") is False
    assert not Notification.objects.filter(
        kind__in=[
            "service.audio_transcription_ready",
            "service.audio_transcription_failed",
        ]
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_audio_file_is_kept_in_trash_and_deleted_after_permanent_note_delete(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="audio-delete")
    client.force_login(user)
    manuscript = create_oneshot(client)
    note = create_audio_note(client, manuscript["id"]).json()["note"]
    audio = ManuscriptNoteAudio.objects.get(note__public_id=note["id"])
    storage = audio.file.storage
    file_name = audio.file.name

    trashed = client.post(
        f"/api/manuscripts/notes/{note['id']}/lifecycle/",
        data=json.dumps({"action": "trash", "expectedGeneration": note["saveGeneration"]}),
        content_type="application/json",
    )
    assert trashed.status_code == 200
    assert storage.exists(file_name)

    deleted = client.delete(f"/api/manuscripts/notes/{note['id']}/lifecycle/")

    assert deleted.status_code == 200
    assert not storage.exists(file_name)


@pytest.mark.django_db(transaction=True)
def test_audio_files_are_deleted_by_empty_trash_manuscript_and_account(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="audio-cascade-delete")
    client.force_login(user)
    manuscripts = [create_oneshot(client, f"Audio {index}") for index in range(3)]
    notes = [create_audio_note(client, item["id"]).json()["note"] for item in manuscripts]
    audios = [ManuscriptNoteAudio.objects.get(note__public_id=note["id"]) for note in notes]
    stored_files = [(audio.file.storage, audio.file.name) for audio in audios]

    trashed = client.post(
        f"/api/manuscripts/notes/{notes[0]['id']}/lifecycle/",
        data=json.dumps({"action": "trash", "expectedGeneration": notes[0]["saveGeneration"]}),
        content_type="application/json",
    )
    assert trashed.status_code == 200
    emptied = client.delete(f"/api/manuscripts/{manuscripts[0]['id']}/notes/trash/")
    assert emptied.status_code == 200
    assert not stored_files[0][0].exists(stored_files[0][1])

    Manuscript.objects.get(public_id=manuscripts[1]["id"]).delete()
    assert not stored_files[1][0].exists(stored_files[1][1])

    user.delete()
    assert not stored_files[2][0].exists(stored_files[2][1])
