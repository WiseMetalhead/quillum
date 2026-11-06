import json
from fractions import Fraction
from io import BytesIO

import av
import numpy as np
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from PIL import Image

from apps.accounts.models import UserMediaAsset
from apps.adminpanel.models import TierQuotaOverride
from apps.notifications.models import Notification

from .audio_recordings import _compressed_waveform, _waveform_level
from .models import (
    AudioRecording,
    AudioTranscriptionState,
    IdeaItem,
    Manuscript,
    ManuscriptAsset,
    ManuscriptNote,
    Series,
    SeriesMembership,
    Workspace,
)
from .transcription import TranscriptionResult, _complete_transcription


def test_audio_waveform_preserves_dynamics_and_uses_rms_downsampling():
    silence = np.zeros((1, 4), dtype=np.int16)
    quiet = np.array([[0, 655, -655, 0]], dtype=np.int16)
    loud = np.array([[6_553, -6_553, 5_243, -5_243]], dtype=np.int16)

    assert _waveform_level(silence) == 0
    assert 0 < _waveform_level(quiet) < _waveform_level(loud) < 255
    assert _compressed_waveform([0, 10] * 256) == [7] * 256


def image_upload(name="idea.png", color="#c06a36"):
    output = BytesIO()
    Image.new("RGB", (80, 120), color).save(output, format="PNG")
    return SimpleUploadedFile(name, output.getvalue(), content_type="image/png")


def audio_upload(content_type="audio/webm", body=None):
    if body is None:
        body = {
            "audio/webm": b"\x1aE\xdf\xa3webm-A_OPUS-audio",
            "audio/ogg": b"OggS-OpusHead-audio",
            "audio/mp4": b"\x00\x00\x00\x18ftypM4A-mp4a-audio",
        }[content_type]
    extension = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a"}[
        content_type
    ]
    return SimpleUploadedFile(f"idea.{extension}", body, content_type=content_type)


def imported_m4a_upload(name="Imported thought.m4a"):
    output = BytesIO()
    with av.open(output, "w", format="ipod") as container:
        stream = container.add_stream("aac", rate=8_000)
        stream.layout = "mono"
        samples = np.zeros((1, 8_000), dtype=np.int16)
        samples[0, 100:400] = 8_000
        for offset in range(0, 8_000, 1_024):
            frame = av.AudioFrame.from_ndarray(
                samples[:, offset : offset + 1_024],
                format="s16",
                layout="mono",
            )
            frame.sample_rate = 8_000
            frame.pts = offset
            frame.time_base = Fraction(1, 8_000)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return SimpleUploadedFile(name, output.getvalue(), content_type="audio/x-m4a")


def create_audio_idea(client, *, title="Voice thought", content_type="audio/webm", body=None):
    return client.post(
        "/api/ideas/audio/",
        {
            "audio": audio_upload(content_type, body),
            "metadata": json.dumps(
                {"title": title, "durationMs": 2400, "waveform": [12, 90, 220, 64]}
            ),
        },
    )


@pytest.mark.django_db
def test_image_idea_is_private_deduplicated_and_cursor_listed(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="owner", password="password")
    stranger = django_user_model.objects.create_user(username="stranger", password="password")
    client.force_login(owner)

    first = client.post("/api/ideas/images/", {"image": image_upload()})
    duplicate = client.post("/api/ideas/images/", {"image": image_upload()})
    listed = client.get("/api/ideas/?kind=image")

    assert first.status_code == 201
    assert first.json()["created"] is True
    assert duplicate.status_code == 200
    assert duplicate.json()["created"] is False
    assert IdeaItem.objects.filter(owner=owner).count() == 1
    assert UserMediaAsset.objects.filter(owner=owner).count() == 1
    assert listed.status_code == 200
    assert listed.json()["counts"] == {"all": 1, "image": 1, "text": 0, "audio": 0}
    assert listed.json()["items"][0]["id"] == first.json()["item"]["id"]
    assert listed.json()["items"][0]["image"]["previewUrl"].endswith("/medium/")

    titled = client.patch(
        f"/api/ideas/{first.json()['item']['id']}/",
        data=json.dumps({"title": "  Character mood  ", "expectedGeneration": 0}),
        content_type="application/json",
    )
    conflict = client.patch(
        f"/api/ideas/{first.json()['item']['id']}/",
        data=json.dumps({"title": "Other", "expectedGeneration": 0}),
        content_type="application/json",
    )
    assert titled.status_code == 200
    assert titled.json()["item"]["title"] == "Character mood"
    assert titled.json()["item"]["saveGeneration"] == 1
    assert conflict.status_code == 409
    assert UserMediaAsset.objects.get(owner=owner).content_hash

    client.force_login(stranger)
    idea_id = first.json()["item"]["id"]
    assert client.get(f"/api/ideas/{idea_id}/").status_code == 404
    assert client.delete(f"/api/ideas/{idea_id}/").status_code == 404


@pytest.mark.django_db
def test_idea_image_is_deletable_from_storage_and_removes_idea_and_media(
    client,
    django_capture_on_commit_callbacks,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="writer", password="password")
    client.force_login(owner)
    created = client.post("/api/ideas/images/", {"image": image_upload()}).json()["item"]
    media = UserMediaAsset.objects.get(owner=owner)
    stored_name = media.original.name

    storage = client.get("/api/auth/storage/?group=ideas&page=1&pageSize=18")
    stored_item = storage.json()["items"][0]

    assert storage.status_code == 200
    assert stored_item["id"] == f"media:{media.public_id}"
    assert stored_item["deletable"] is True
    assert stored_item["usages"] == [
        {
            "kind": "idea",
            "label": "",
            "detail": "idea",
            "url": f"/ideas?item={created['id']}",
        }
    ]

    with django_capture_on_commit_callbacks(execute=True):
        deleted = client.delete(f"/api/auth/storage/media:{media.public_id}/")

    assert deleted.status_code == 200
    assert not IdeaItem.objects.exists()
    assert not UserMediaAsset.objects.exists()
    assert not media.original.storage.exists(stored_name)


@pytest.mark.django_db
def test_deleting_image_idea_removes_unreferenced_media(
    client,
    django_capture_on_commit_callbacks,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="writer", password="password")
    client.force_login(owner)
    created = client.post("/api/ideas/images/", {"image": image_upload()}).json()["item"]
    media = UserMediaAsset.objects.get(owner=owner)
    stored_name = media.original.name

    with django_capture_on_commit_callbacks(execute=True):
        deleted = client.delete(f"/api/ideas/{created['id']}/")

    assert deleted.status_code == 200
    assert not IdeaItem.objects.exists()
    assert not UserMediaAsset.objects.exists()
    assert not media.original.storage.exists(stored_name)


@pytest.mark.django_db
def test_deleting_image_idea_retains_media_reused_by_board_note(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="writer", password="password")
    client.force_login(owner)
    created = client.post("/api/ideas/images/", {"image": image_upload()}).json()["item"]
    media = UserMediaAsset.objects.get(owner=owner)
    stored_name = media.original.name
    manuscript = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=owner),
        kind=Manuscript.KIND_ONESHOT,
        title="Story",
    )
    asset = ManuscriptAsset.objects.create(
        manuscript=manuscript,
        media=media,
        content_type=media.content_type,
        width=media.width,
        height=media.height,
        byte_size=media.byte_size,
    )
    note = ManuscriptNote.objects.create(
        manuscript=manuscript,
        title="Reference",
        content=ManuscriptNote.EMPTY_CONTENT,
    )
    note.assets.add(asset)

    storage = client.get("/api/auth/storage/?group=ideas&page=1&pageSize=18")

    assert storage.status_code == 200
    assert storage.json()["items"][0]["deletable"] is False
    assert client.delete(f"/api/auth/storage/media:{media.public_id}/").status_code == 409
    assert IdeaItem.objects.filter(public_id=created["id"]).exists()
    assert UserMediaAsset.objects.filter(id=media.id).exists()

    deleted = client.delete(f"/api/ideas/{created['id']}/")

    assert deleted.status_code == 200
    assert not IdeaItem.objects.exists()
    assert UserMediaAsset.objects.filter(id=media.id).exists()
    assert media.original.storage.exists(stored_name)


@pytest.mark.django_db
def test_ideas_list_uses_stable_twenty_four_item_cursor_pages(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(username="writer", password="password")
    client.force_login(owner)
    for index in range(25):
        media = UserMediaAsset.objects.create(
            owner=owner,
            content_hash=f"{index:064x}",
            original=f"media/original/{index}.png",
            thumbnail_small=f"media/thumbnail-small/{index}.webp",
            thumbnail_medium=f"media/thumbnail-medium/{index}.webp",
            editor_medium=f"media/editor-medium/{index}.webp",
            editor_large=f"media/editor-large/{index}.webp",
            content_type="image/png",
            width=80,
            height=120,
            byte_size=1,
        )
        IdeaItem.objects.create(owner=owner, kind=IdeaItem.KIND_IMAGE, image_media=media)

    first = client.get("/api/ideas/?kind=all").json()
    second = client.get(
        "/api/ideas/",
        {"kind": "all", "cursor": first["nextCursor"]},
    ).json()

    assert len(first["items"]) == 24
    assert first["nextCursor"]
    assert len(second["items"]) == 1
    assert second["nextCursor"] is None
    first_ids = {item["id"] for item in first["items"]}
    second_ids = {item["id"] for item in second["items"]}
    assert not first_ids & second_ids


@pytest.mark.django_db
def test_invalid_filter_and_image_are_rejected_without_rows(client, django_user_model):
    owner = django_user_model.objects.create_user(username="writer", password="password")
    client.force_login(owner)

    invalid_filter = client.get("/api/ideas/?kind=unknown")
    invalid_image = client.post(
        "/api/ideas/images/",
        {"image": SimpleUploadedFile("idea.png", b"not-an-image", content_type="image/png")},
    )

    assert invalid_filter.status_code == 400
    assert invalid_filter.json()["error"] == "idea_filter_invalid"
    assert invalid_image.status_code == 400
    assert not IdeaItem.objects.exists()
    assert not UserMediaAsset.objects.exists()


@pytest.mark.django_db
def test_text_idea_empty_create_optional_title_and_generation_conflict(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(username="text-writer", password="password")
    stranger = django_user_model.objects.create_user(username="text-stranger", password="password")
    client.force_login(owner)

    empty = client.post(
        "/api/ideas/text/",
        data=json.dumps({"title": "  ", "text": " \r\n "}),
        content_type="application/json",
    )
    created = client.post(
        "/api/ideas/text/",
        data=json.dumps({"title": "", "text": "First\r\nsecond"}),
        content_type="application/json",
    )

    assert empty.status_code == 400
    assert empty.json()["error"] == "idea_empty"
    assert created.status_code == 201
    item = created.json()["item"]
    assert item["title"] == ""
    assert item["text"] == "First\nsecond"
    listed = client.get("/api/ideas/?kind=text").json()
    assert listed["counts"] == {"all": 1, "image": 0, "text": 1, "audio": 0}
    assert "text" not in listed["items"][0]

    saved = client.patch(
        f"/api/ideas/{item['id']}/",
        data=json.dumps(
            {"title": "  Focus  ", "text": "Changed", "expectedGeneration": 0}
        ),
        content_type="application/json",
    )
    conflict = client.patch(
        f"/api/ideas/{item['id']}/",
        data=json.dumps(
            {"title": "Local", "text": "Retry", "expectedGeneration": 0}
        ),
        content_type="application/json",
    )
    retried = client.patch(
        f"/api/ideas/{item['id']}/",
        data=json.dumps(
            {"title": "Local", "text": "Retry", "expectedGeneration": 1}
        ),
        content_type="application/json",
    )

    assert saved.status_code == 200
    assert saved.json()["item"]["title"] == "Focus"
    assert saved.json()["item"]["saveGeneration"] == 1
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "idea_update_conflict"
    assert conflict.json()["saveGeneration"] == 1
    assert retried.status_code == 200
    assert retried.json()["item"]["saveGeneration"] == 2

    client.force_login(stranger)
    assert client.get(f"/api/ideas/{item['id']}/").status_code == 404
    assert client.patch(
        f"/api/ideas/{item['id']}/",
        data=json.dumps(
            {"title": "No", "text": "Access", "expectedGeneration": 2}
        ),
        content_type="application/json",
    ).status_code == 404


@pytest.mark.django_db
def test_text_targets_include_drawer_and_series_books_and_attach_is_idempotent(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(username="attach-writer", password="password")
    stranger = django_user_model.objects.create_user(username="other-writer", password="password")
    client.force_login(owner)
    one_shot = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=owner),
        kind=Manuscript.KIND_ONESHOT,
        title="Standalone",
    )
    drawer_book = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=owner),
        kind=Manuscript.KIND_BOOK,
        title="Drawer book",
        drawer_at=one_shot.created_at,
    )
    series_workspace = Workspace.objects.create(owner=owner)
    series = Series.objects.create(
        workspace=series_workspace,
        title="Saga",
        drawer_at=one_shot.created_at,
    )
    series_book = Manuscript.objects.create(
        workspace=series_workspace,
        kind=Manuscript.KIND_BOOK,
        title="Series book",
    )
    SeriesMembership.objects.create(series=series, manuscript=series_book, position=2)
    outsider = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=stranger),
        kind=Manuscript.KIND_ONESHOT,
        title="Someone else's story",
    )
    created = client.post(
        "/api/ideas/text/",
        data=json.dumps(
            {
                "title": "  Scene thought  ",
                "text": "First\r\nsecond\r\n\r\nThird\r\n\r\n\r\nFifth",
            }
        ),
        content_type="application/json",
    ).json()["item"]

    targets = client.get("/api/ideas/targets/")

    assert targets.status_code == 200
    targets_by_id = {item["id"]: item for item in targets.json()["items"]}
    assert set(targets_by_id) == {
        str(one_shot.public_id),
        str(drawer_book.public_id),
        str(series_book.public_id),
    }
    assert str(outsider.public_id) not in targets_by_id
    assert targets_by_id[str(one_shot.public_id)]["inDrawer"] is False
    assert targets_by_id[str(drawer_book.public_id)]["inDrawer"] is True
    assert targets_by_id[str(series_book.public_id)]["inDrawer"] is True
    assert targets_by_id[str(series_book.public_id)]["series"] == {
        "id": str(series.public_id),
        "title": "Saga",
        "position": 2,
    }

    attach_payload = json.dumps({"manuscriptId": str(series_book.public_id)})
    attached = client.post(
        f"/api/ideas/{created['id']}/attach/",
        data=attach_payload,
        content_type="application/json",
    )
    repeated = client.post(
        f"/api/ideas/{created['id']}/attach/",
        data=attach_payload,
        content_type="application/json",
    )
    repeated_elsewhere = client.post(
        f"/api/ideas/{created['id']}/attach/",
        data=json.dumps({"manuscriptId": str(one_shot.public_id)}),
        content_type="application/json",
    )

    assert attached.status_code == 201
    assert repeated.status_code == 200
    assert repeated.json()["alreadyAttached"] is True
    assert repeated.json()["note"] == attached.json()["note"]
    assert repeated_elsewhere.status_code == 409
    assert repeated_elsewhere.json()["error"] == "idea_already_attached"
    assert not IdeaItem.objects.filter(public_id=created["id"]).exists()
    note = ManuscriptNote.objects.get(public_id=attached.json()["note"]["id"])
    assert note.manuscript == series_book
    assert str(note.source_idea_id) == created["id"]
    assert note.kind == ManuscriptNote.KIND_TEXT
    assert note.title == "Scene thought"
    assert note.color == "blue"
    assert note.board_id is None
    assert not note.tags.exists()
    assert not note.associated_items.exists()
    assert not note.assets.exists()
    assert note.content == {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "First"},
                    {"type": "hardBreak"},
                    {"type": "text", "text": "second"},
                ],
            },
            {"type": "paragraph", "content": [{"type": "text", "text": "Third"}]},
            {"type": "paragraph"},
            {"type": "paragraph", "content": [{"type": "text", "text": "Fifth"}]},
        ],
    }


@pytest.mark.django_db
def test_audio_idea_is_private_range_playable_and_visible_in_storage(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="audio-idea-owner")
    stranger = django_user_model.objects.create_user(username="audio-idea-stranger")
    client.force_login(owner)

    created = create_audio_idea(client)

    assert created.status_code == 201
    item = created.json()["item"]
    assert item["kind"] == "audio"
    assert item["audio"]["codec"] == "opus"
    assert item["audio"]["transcriptionUrl"].endswith("/transcription/")
    assert client.get("/api/ideas/?kind=audio").json()["counts"] == {
        "all": 1,
        "image": 0,
        "text": 0,
        "audio": 1,
    }

    playback = client.get(
        f"/api/ideas/{item['id']}/audio/",
        HTTP_RANGE="bytes=0-7",
    )
    assert playback.status_code == 206
    assert playback["Accept-Ranges"] == "bytes"
    assert b"".join(playback.streaming_content) == b"\x1aE\xdf\xa3webm"

    stored = client.get("/api/auth/storage/?group=ideas&page=1&pageSize=18").json()[
        "items"
    ][0]
    assert stored["id"] == f"audio-idea:{item['id']}"
    assert stored["deletable"] is True
    assert stored["deleteReason"] == ""
    assert stored["audio"]["playbackUrl"] == item["audio"]["playbackUrl"]
    assert stored["audio"]["transcriptionUrl"] == item["audio"]["transcriptionUrl"]
    assert stored["usages"][0]["url"] == f"/ideas?item={item['id']}"

    client.force_login(stranger)
    assert client.get(f"/api/ideas/{item['id']}/audio/").status_code == 404
    assert client.get(f"/api/ideas/{item['id']}/transcription/").status_code == 404


@pytest.mark.django_db
def test_m4a_import_uses_file_metadata_and_builds_waveform(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="audio-import-owner")
    client.force_login(owner)

    imported = client.post(
        "/api/ideas/audio/import/",
        {"audio": imported_m4a_upload()},
    )

    assert imported.status_code == 201
    item = imported.json()["item"]
    assert item["title"] == "Imported thought"
    assert item["audio"]["contentType"] == "audio/mp4"
    assert item["audio"]["codec"] == "aac"
    assert 900 <= item["audio"]["durationMs"] <= 1_100
    assert 1 <= len(item["audio"]["waveform"]) <= 256
    assert max(item["audio"]["waveform"]) > 0
    recording = AudioRecording.objects.get(idea__public_id=item["id"])
    assert recording.file.name.endswith(".m4a")
    assert recording.byte_size > 0

    invalid = client.post(
        "/api/ideas/audio/import/",
        {"audio": SimpleUploadedFile("broken.m4a", b"not-audio", content_type="audio/x-m4a")},
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "audio_file_invalid"
    assert IdeaItem.objects.filter(owner=owner, kind=IdeaItem.KIND_AUDIO).count() == 1


@pytest.mark.django_db
def test_audio_idea_is_deletable_from_storage_and_removes_transcript_and_file(
    client,
    django_capture_on_commit_callbacks,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="audio-storage-owner")
    stranger = django_user_model.objects.create_user(username="audio-storage-stranger")
    client.force_login(owner)
    item = create_audio_idea(client).json()["item"]
    recording = AudioRecording.objects.get(idea__public_id=item["id"])
    stored_name = recording.file.name
    AudioTranscriptionState.objects.create(
        audio=recording,
        status=AudioTranscriptionState.STATUS_READY,
        text="Transcript",
        language="en",
        requested_at=timezone.now(),
        started_at=timezone.now(),
        finished_at=timezone.now(),
        text_updated_at=timezone.now(),
    )

    client.force_login(stranger)
    hidden = client.delete(f"/api/auth/storage/audio-idea:{item['id']}/")
    assert hidden.status_code == 404

    client.force_login(owner)
    with django_capture_on_commit_callbacks(execute=True):
        deleted = client.delete(f"/api/auth/storage/audio-idea:{item['id']}/")

    assert deleted.status_code == 200
    assert not IdeaItem.objects.filter(public_id=item["id"]).exists()
    assert not AudioRecording.objects.filter(id=recording.id).exists()
    assert not AudioTranscriptionState.objects.exists()
    assert not recording.file.storage.exists(stored_name)


@pytest.mark.django_db
def test_audio_idea_quota_rejection_leaves_no_row_or_file(
    client,
    django_user_model,
    tmp_path,
):
    user = django_user_model.objects.create_user(username="audio-idea-quota")
    TierQuotaOverride.objects.create(tier=user.tier, key="storage_bytes", value=1)
    client.force_login(user)

    with override_settings(MEDIA_ROOT=tmp_path):
        response = create_audio_idea(client)

    assert response.status_code == 409
    assert response.json()["error"] == "quota_limit_reached"
    assert not IdeaItem.objects.exists()
    assert not AudioRecording.objects.exists()
    assert not (tmp_path / "audio-notes").exists()


@pytest.mark.django_db
def test_audio_idea_attach_moves_recording_and_processing_notification_to_boards(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(username="audio-idea-attach")
    client.force_login(owner)
    manuscript = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=owner),
        kind=Manuscript.KIND_ONESHOT,
        title="Target story",
    )
    item = create_audio_idea(client).json()["item"]
    recording = AudioRecording.objects.get(idea__public_id=item["id"])
    stored_name = recording.file.name
    state = AudioTranscriptionState.objects.create(
        audio=recording,
        status=AudioTranscriptionState.STATUS_PROCESSING,
        requested_at=timezone.now(),
        started_at=timezone.now(),
        task_id="idea-worker",
    )

    payload = json.dumps({"manuscriptId": str(manuscript.public_id)})
    attached = client.post(
        f"/api/ideas/{item['id']}/attach/",
        data=payload,
        content_type="application/json",
    )
    repeated = client.post(
        f"/api/ideas/{item['id']}/attach/",
        data=payload,
        content_type="application/json",
    )

    assert attached.status_code == 201
    assert repeated.status_code == 200
    assert repeated.json()["alreadyAttached"] is True
    recording.refresh_from_db()
    assert recording.idea_id is None
    assert str(recording.note.public_id) == attached.json()["note"]["id"]
    assert recording.note.kind == ManuscriptNote.KIND_AUDIO
    assert recording.note.board_id is None
    assert recording.file.name == stored_name
    assert AudioTranscriptionState.objects.get(id=state.id).audio_id == recording.id
    assert not IdeaItem.objects.filter(public_id=item["id"]).exists()

    assert _complete_transcription(
        state.id,
        state.generation,
        TranscriptionResult("Moved transcript", "en"),
    ) is True
    notification = Notification.objects.get(
        recipient=owner,
        kind="service.audio_transcription_ready",
    )
    assert notification.payload["actionPath"] == (
        f"/manuscripts/{manuscript.public_id}/boards"
        f"?note={recording.note.public_id}&workspace=author"
    )


@pytest.mark.django_db
def test_deleting_processing_audio_idea_discards_late_result_and_file(
    client,
    django_capture_on_commit_callbacks,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(username="audio-idea-delete")
    client.force_login(owner)
    item = create_audio_idea(client).json()["item"]
    recording = AudioRecording.objects.get(idea__public_id=item["id"])
    stored_name = recording.file.name
    state = AudioTranscriptionState.objects.create(
        audio=recording,
        status=AudioTranscriptionState.STATUS_PROCESSING,
        requested_at=timezone.now(),
        started_at=timezone.now(),
        task_id="deleted-idea-worker",
    )

    with django_capture_on_commit_callbacks(execute=True):
        deleted = client.delete(f"/api/ideas/{item['id']}/")

    assert deleted.status_code == 200
    assert not AudioRecording.objects.exists()
    assert not AudioTranscriptionState.objects.exists()
    assert not recording.file.storage.exists(stored_name)
    assert _complete_transcription(
        state.id,
        state.generation,
        TranscriptionResult("Too late", "en"),
    ) is False
    assert not Notification.objects.filter(recipient=owner).exists()
