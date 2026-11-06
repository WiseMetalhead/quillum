import base64
import json
import uuid

import pytest
from django.test import override_settings

from .collaboration import (
    CollaborationError,
    commit_collaboration_update,
    consume_collaboration_ticket,
    initialize_collaboration_document,
)
from .models import (
    DocumentAnnotation,
    DocumentCollaborationState,
    DocumentCollaborationUpdate,
)
from .services import create_oneshot


def create_collaborative_document(user):
    manuscript = create_oneshot(
        user=user,
        title="Collaboration test",
        synopsis="",
        cover=None,
    )
    document = manuscript.documents.get()
    state = DocumentCollaborationState.objects.create(
        document=document,
        status=DocumentCollaborationState.STATUS_ACTIVE,
        schema_version=document.schema_version,
    )
    return manuscript, document, state


@pytest.mark.django_db
@override_settings(QUILLUM_COLLABORATION_MODE="pilot")
def test_collaboration_ticket_is_one_time_and_document_payload_selects_live_mode(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(
        username="collaboration-owner",
        password="correct-password",
    )
    manuscript, document, state = create_collaborative_document(owner)
    client.force_login(owner)

    opened = client.get(f"/api/manuscripts/oneshots/{manuscript.public_id}/document/")
    assert opened.status_code == 200
    assert opened.json()["document"]["syncMode"] == "collaborative"
    assert opened.json()["document"]["collaborationEpoch"] == state.epoch

    issued = client.post(
        f"/api/manuscripts/oneshots/{manuscript.public_id}/document/collaboration-ticket/",
        data=json.dumps({"timezone": "UTC"}),
        content_type="application/json",
    )
    assert issued.status_code == 200
    payload = issued.json()["collaboration"]
    context = consume_collaboration_ticket(payload["ticket"], payload["room"])
    assert context["documentId"] == str(document.public_id)
    with pytest.raises(CollaborationError, match="collaboration_ticket_invalid"):
        consume_collaboration_ticket(payload["ticket"], payload["room"])


@pytest.mark.django_db
@override_settings(QUILLUM_COLLABORATION_MODE="pilot")
def test_legacy_put_is_rejected_for_collaborative_document(client, django_user_model):
    owner = django_user_model.objects.create_user(
        username="legacy-guard-owner",
        password="correct-password",
    )
    manuscript, document, _state = create_collaborative_document(owner)
    client.force_login(owner)

    response = client.put(
        f"/api/manuscripts/oneshots/{manuscript.public_id}/document/",
        data=json.dumps(
            {
                "content": document.content,
                "schemaVersion": document.schema_version,
                "expectedGeneration": document.save_generation,
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 409
    assert response.json()["error"] == "collaboration_required"


@pytest.mark.django_db
@override_settings(QUILLUM_COLLABORATION_MODE="pilot")
def test_durable_commit_materializes_content_and_is_idempotent(django_user_model):
    owner = django_user_model.objects.create_user(username="commit-owner")
    _manuscript, document, state = create_collaborative_document(owner)
    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "Durable live text"}],
            }
        ],
    }
    update_id = uuid.uuid4()
    payload = {
        "documentId": str(document.public_id),
        "epoch": state.epoch,
        "updateId": str(update_id),
        "update": base64.b64encode(b"update").decode("ascii"),
        "state": base64.b64encode(b"state").decode("ascii"),
        "content": content,
        "actorId": owner.id,
        "role": DocumentCollaborationUpdate.ROLE_OWNER,
        "timezone": "UTC",
    }

    first = commit_collaboration_update(payload)
    second = commit_collaboration_update(payload)
    document.refresh_from_db()
    state.refresh_from_db()

    assert first.sequence == second.sequence == 1
    assert document.content == content
    assert document.save_generation == 1
    assert bytes(state.ydoc_state) == b"state"
    assert state.latest_sequence == state.materialized_sequence == 1
    assert state.updates.filter(update_id=update_id).count() == 1


@pytest.mark.django_db
@override_settings(QUILLUM_COLLABORATION_MODE="pilot")
def test_initial_snapshot_is_pinned_before_the_first_user_update(django_user_model):
    owner = django_user_model.objects.create_user(username="initialize-owner")
    _manuscript, document, state = create_collaborative_document(owner)

    first = initialize_collaboration_document(
        {
            "documentId": str(document.public_id),
            "epoch": state.epoch,
            "state": base64.b64encode(b"first-ydoc-state").decode("ascii"),
        }
    )
    second = initialize_collaboration_document(
        {
            "documentId": str(document.public_id),
            "epoch": state.epoch,
            "state": base64.b64encode(b"different-ydoc-state").decode("ascii"),
        }
    )
    state.refresh_from_db()

    assert first == second == b"first-ydoc-state"
    assert bytes(state.ydoc_state) == b"first-ydoc-state"
    assert state.snapshot_sequence == state.latest_sequence == 0


@pytest.mark.django_db
@override_settings(QUILLUM_COLLABORATION_MODE="pilot")
def test_durable_commit_normalizes_tiptap_empty_simple_mark_attrs(django_user_model):
    owner = django_user_model.objects.create_user(username="mark-owner")
    _manuscript, document, state = create_collaborative_document(owner)
    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Formatted",
                        "marks": [{"type": "bold", "attrs": {}}],
                    }
                ],
            }
        ],
    }

    commit_collaboration_update(
        {
            "documentId": str(document.public_id),
            "epoch": state.epoch,
            "updateId": str(uuid.uuid4()),
            "update": base64.b64encode(b"update").decode("ascii"),
            "state": base64.b64encode(b"state").decode("ascii"),
            "content": content,
            "actorId": owner.id,
            "role": DocumentCollaborationUpdate.ROLE_OWNER,
            "timezone": "UTC",
        }
    )
    document.refresh_from_db()

    assert document.content["content"][0]["content"][0]["marks"] == [{"type": "bold"}]


@pytest.mark.django_db
@override_settings(QUILLUM_COLLABORATION_MODE="pilot")
def test_collaborative_annotation_delete_does_not_rewrite_materialized_document(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(
        username="annotation-owner",
        password="correct-password",
    )
    manuscript, document, _state = create_collaborative_document(owner)
    annotation = DocumentAnnotation.objects.create(
        document=document,
        author=owner,
        quote="quote",
        comment="comment",
    )
    original_generation = document.save_generation
    client.force_login(owner)

    response = client.delete(
        f"/api/manuscripts/annotations/{annotation.public_id}/",
        data=json.dumps({}),
        content_type="application/json",
    )

    assert response.status_code == 200
    document.refresh_from_db()
    assert document.save_generation == original_generation
    assert not DocumentAnnotation.objects.filter(id=annotation.id).exists()
