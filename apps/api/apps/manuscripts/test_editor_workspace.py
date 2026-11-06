import json

import pytest
from django.utils import timezone

from .models import (
    AnnotationReply,
    Document,
    DocumentAnnotation,
    DocumentVersion,
    ManuscriptEditorGrant,
    ManuscriptItem,
    ManuscriptWritingDay,
)
from .services import create_book, create_oneshot
from .test_editor_grants import connect, create_editor, create_writer, image_upload


def grant_access(writer, editor, manuscript):
    return ManuscriptEditorGrant.objects.create(
        manuscript=manuscript,
        editor_connection=connect(writer, editor),
    )


@pytest.mark.django_db
def test_editor_workspace_search_is_grant_scoped_and_metadata_only(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "search-writer")
    writer.display_name = "Search Author"
    writer.save(update_fields=["display_name"])
    other_writer = create_writer(django_user_model, "search-other-writer")
    editor = create_editor(django_user_model, "search-editor")
    connection = connect(writer, editor)
    book = create_book(
        user=writer,
        title="Granted Book",
        synopsis="A visible summary",
        template="chapters",
        cover=None,
        language="en",
    )
    book_document = book.documents.select_related("item").first()
    assert book_document is not None and book_document.item is not None
    book_document.item.title = "Needle chapter"
    book_document.item.save(update_fields=["title"])
    book_document.content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "Body secret"}],
            }
        ],
    }
    book_document.save(update_fields=["content"])
    ManuscriptEditorGrant.objects.create(manuscript=book, editor_connection=connection)

    revoked = create_oneshot(
        user=other_writer,
        title="Needle revoked",
        synopsis="",
        cover=None,
    )
    revoked_grant = grant_access(other_writer, editor, revoked)
    revoked_grant.revoked_at = timezone.now()
    revoked_grant.save(update_fields=["revoked_at"])
    create_oneshot(
        user=writer,
        title="Needle private",
        synopsis="",
        cover=None,
    )

    client.force_login(editor)
    response = client.get("/api/editor/workspace/search/?q=Needle")
    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    results = response.json()["results"]
    assert {result["kind"] for result in results} == {"manuscript", "document"}
    assert {result["manuscriptId"] for result in results} == {str(book.public_id)}
    assert {result["authorName"] for result in results} == {writer.display_name}
    document_result = next(result for result in results if result["kind"] == "document")
    assert document_result["itemId"] == str(book_document.item.public_id)

    assert client.get("/api/editor/workspace/search/?q=Body%20secret").json()["results"] == []
    invalid = client.get("/api/editor/workspace/search/?q=x")
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "workspace_search_query_invalid"

    client.force_login(writer)
    denied = client.get("/api/editor/workspace/search/?q=Needle")
    assert denied.status_code == 403
    assert denied.json()["error"] == "editor_workspace_required"


@pytest.mark.django_db
def test_editor_workspace_detail_tree_and_document_save_are_grant_scoped(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "workspace-writer")
    editor = create_editor(django_user_model, "workspace-editor")
    stranger = create_editor(django_user_model, "workspace-stranger")
    book = create_book(
        user=writer,
        title="Shared book",
        synopsis="For editing",
        template="chapters",
        cover=None,
        language="en",
    )
    grant_access(writer, editor, book)
    document = book.documents.select_related("item").first()
    assert document is not None and document.item is not None
    trashed = ManuscriptItem.objects.create(
        manuscript=book,
        kind=ManuscriptItem.KIND_DOCUMENT,
        title="Removed scene",
        position=9999,
        trashed_at=document.updated_at,
        previous_position=9999,
    )
    trashed_document = Document.objects.create(
        manuscript=book,
        item=trashed,
        content=Document.EMPTY_DOCUMENT,
    )
    trashed_annotation = DocumentAnnotation.objects.create(
        document=trashed_document,
        author=writer,
        quote="Hidden",
        comment="Hidden with Trash",
    )
    trashed_draft = DocumentVersion(
        document=trashed_document,
        kind=DocumentVersion.KIND_DRAFT,
        schema_version=trashed_document.schema_version,
        source_history_generation=trashed_document.history_generation,
    )
    trashed_draft.snapshot = {"content": trashed_document.content, "annotations": []}
    trashed_draft.save()

    client.force_login(editor)
    detail = client.get(f"/api/editor/manuscripts/{book.public_id}/")
    assert detail.status_code == 200
    assert detail["Cache-Control"] == "private, no-store"
    assert detail.json()["manuscript"]["author"]["username"] == writer.username

    tree = client.get(f"/api/editor/manuscripts/{book.public_id}/tree/")
    assert tree.status_code == 200
    assert tree.json()["tree"]["trash"] == []
    assert str(trashed.public_id) not in {item["id"] for item in tree.json()["tree"]["items"]}
    assert client.get(
        f"/api/editor/manuscripts/{book.public_id}/documents/{trashed.public_id}/"
    ).status_code == 404
    assert client.patch(
        f"/api/editor/manuscripts/{book.public_id}/annotations/{trashed_annotation.public_id}/",
        {"status": "resolved", "expectedVersion": trashed_annotation.version},
        content_type="application/json",
    ).status_code == 404
    assert client.get(
        f"/api/editor/manuscripts/{book.public_id}/drafts/{trashed_draft.public_id}/"
    ).status_code == 404
    owner_tree = client.get(f"/api/manuscripts/books/{book.public_id}/tree/")
    assert owner_tree.status_code == 403
    assert owner_tree.json()["error"] == "author_workspace_required"

    endpoint = f"/api/editor/manuscripts/{book.public_id}/documents/{document.item.public_id}/"
    loaded = client.get(endpoint)
    assert loaded.status_code == 200
    assert loaded["Cache-Control"] == "private, no-store"
    saved = client.put(
        endpoint,
        {
            "content": {
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Edited"}]}],
            },
            "schemaVersion": document.schema_version,
            "expectedGeneration": document.save_generation,
        },
        content_type="application/json",
    )
    assert saved.status_code == 200
    assert saved.json()["document"]["saveGeneration"] == document.save_generation + 1
    assert not ManuscriptWritingDay.objects.filter(manuscript=book).exists()

    client.force_login(stranger)
    assert client.get(endpoint).status_code == 404


@pytest.mark.django_db
def test_editor_comments_enforce_own_message_permissions_and_keep_discussion_history(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "comment-writer")
    editor = create_editor(django_user_model, "comment-editor")
    other_editor = create_editor(django_user_model, "comment-other-editor")
    manuscript = create_oneshot(
        user=writer,
        title="Comments",
        synopsis="",
        cover=None,
    )
    grant = grant_access(writer, editor, manuscript)
    grant_access(writer, other_editor, manuscript)
    endpoint = f"/api/editor/manuscripts/{manuscript.public_id}/document/annotations/"

    client.force_login(editor)
    created = client.post(
        endpoint,
        {"quote": "Quoted text", "comment": "Editorial note"},
        content_type="application/json",
    )
    assert created.status_code == 201
    annotation_id = created.json()["annotation"]["id"]
    reply = client.post(
        f"/api/editor/manuscripts/{manuscript.public_id}/annotations/{annotation_id}/replies/",
        {"body": "Follow-up"},
        content_type="application/json",
    )
    assert reply.status_code == 201
    second_reply = client.post(
        f"/api/editor/manuscripts/{manuscript.public_id}/annotations/{annotation_id}/replies/",
        {"body": "Temporary follow-up"},
        content_type="application/json",
    )
    assert second_reply.status_code == 201
    removed_reply = client.delete(
        f"/api/editor/manuscripts/{manuscript.public_id}/annotation-replies/"
        f"{second_reply.json()['reply']['id']}/"
    )
    assert removed_reply.status_code == 200
    annotation = DocumentAnnotation.objects.get(public_id=annotation_id)
    blocked_delete = client.delete(
        f"/api/editor/manuscripts/{manuscript.public_id}/annotations/{annotation_id}/",
        {"expectedGeneration": annotation.document.save_generation},
        content_type="application/json",
    )
    assert blocked_delete.status_code == 409
    assert blocked_delete.json()["error"] == "annotation_delete_has_replies"

    client.force_login(other_editor)
    listing = client.get(endpoint)
    item = listing.json()["items"][0]
    assert item["canEdit"] is False
    assert item["canDelete"] is False
    resolved = client.patch(
        f"/api/editor/manuscripts/{manuscript.public_id}/annotations/{annotation_id}/",
        {"status": "resolved", "expectedVersion": item["version"]},
        content_type="application/json",
    )
    assert resolved.status_code == 200

    grant.revoked_at = annotation.updated_at
    grant.save(update_fields=["revoked_at"])
    assert client.get(endpoint).status_code == 200
    client.force_login(editor)
    assert client.get(endpoint).status_code == 404
    assert DocumentAnnotation.objects.filter(id=annotation.id).exists()
    assert AnnotationReply.objects.filter(annotation=annotation).exists()


@pytest.mark.django_db
def test_editor_document_conflict_illustration_immutability_and_private_asset_scope(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    writer = create_writer(django_user_model, "asset-writer")
    editor = create_editor(django_user_model, "asset-editor")
    manuscript = create_oneshot(
        user=writer,
        title="Illustrated",
        synopsis="",
        cover=None,
    )
    other_manuscript = create_oneshot(
        user=writer,
        title="Other",
        synopsis="",
        cover=None,
    )

    client.force_login(writer)
    asset_response = client.post(
        f"/api/manuscripts/oneshots/{manuscript.public_id}/assets/",
        {"image": image_upload("illustration.png")},
    )
    assert asset_response.status_code == 201
    asset_id = asset_response.json()["asset"]["id"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "illustration",
                "attrs": {
                    "assetId": asset_id,
                    "alt": "Original alt",
                    "caption": "Original caption",
                    "alignment": "center",
                    "displayWidth": 65,
                },
            },
            {"type": "paragraph", "content": [{"type": "text", "text": "Original"}]},
        ],
    }
    owner_saved = client.put(
        f"/api/manuscripts/oneshots/{manuscript.public_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": manuscript.documents.get().schema_version,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    assert owner_saved.status_code == 200
    connection = connect(writer, editor)
    ManuscriptEditorGrant.objects.create(manuscript=manuscript, editor_connection=connection)
    ManuscriptEditorGrant.objects.create(manuscript=other_manuscript, editor_connection=connection)

    client.force_login(editor)
    editor_endpoint = f"/api/editor/manuscripts/{manuscript.public_id}/document/"
    loaded = client.get(editor_endpoint).json()["document"]
    asset = client.get(
        f"/api/editor/manuscripts/{manuscript.public_id}/assets/{asset_id}/medium/"
    )
    assert asset.status_code == 200
    assert asset["Cache-Control"].startswith("private")
    assert client.get(
        f"/api/editor/manuscripts/{other_manuscript.public_id}/assets/{asset_id}/medium/"
    ).status_code == 404

    changed_illustration = json.loads(json.dumps(content))
    changed_illustration["content"][0]["attrs"]["alt"] = "Changed alt"
    forbidden = client.put(
        editor_endpoint,
        data=json.dumps(
            {
                "content": changed_illustration,
                "schemaVersion": loaded["schemaVersion"],
                "expectedGeneration": loaded["saveGeneration"],
            }
        ),
        content_type="application/json",
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["error"] == "editor_illustration_mutation_forbidden"

    edited_text = json.loads(json.dumps(content))
    edited_text["content"][1]["content"][0]["text"] = "Editor text"
    saved = client.put(
        editor_endpoint,
        data=json.dumps(
            {
                "content": edited_text,
                "schemaVersion": loaded["schemaVersion"],
                "expectedGeneration": loaded["saveGeneration"],
            }
        ),
        content_type="application/json",
    )
    assert saved.status_code == 200
    conflict = client.put(
        editor_endpoint,
        data=json.dumps(
            {
                "content": edited_text,
                "schemaVersion": loaded["schemaVersion"],
                "expectedGeneration": loaded["saveGeneration"],
            }
        ),
        content_type="application/json",
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "document_save_conflict"


@pytest.mark.django_db
def test_editor_preferences_are_personal_and_owner_workspace_apis_stay_closed(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "preference-writer")
    editor = create_editor(django_user_model, "preference-editor")
    manuscript = create_oneshot(
        user=writer,
        title="Preferences",
        synopsis="",
        cover=None,
    )
    grant_access(writer, editor, manuscript)

    client.force_login(editor)
    updated = client.patch(
        "/api/editor/preferences/",
        {
            "fontSize": 20,
            "spellcheckEnabled": True,
            "spellcheckDictionary": "en-GB",
        },
        content_type="application/json",
    )
    assert updated.status_code == 200
    assert updated.json()["preferences"]["fontSize"] == 20
    assert updated.json()["preferences"]["spellcheckDictionary"] == "en-GB"
    assert client.get("/api/editor/preferences/")["Cache-Control"] == "private, no-store"

    for path in (
        f"/api/manuscripts/{manuscript.public_id}/",
        f"/api/manuscripts/oneshots/{manuscript.public_id}/document/",
        f"/api/manuscripts/{manuscript.public_id}/planner/",
        f"/api/manuscripts/{manuscript.public_id}/boards/",
    ):
        response = client.get(path)
        assert response.status_code == 403
        assert response.json()["error"] == "author_workspace_required"


@pytest.mark.django_db
def test_editor_drafts_are_read_only_and_revocation_hides_all_nested_objects(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "draft-writer")
    editor = create_editor(django_user_model, "draft-editor")
    manuscript = create_oneshot(
        user=writer,
        title="Drafts",
        synopsis="",
        cover=None,
    )
    grant = grant_access(writer, editor, manuscript)
    document = manuscript.documents.get()
    draft = DocumentVersion(
        document=document,
        kind=DocumentVersion.KIND_DRAFT,
        schema_version=document.schema_version,
        source_history_generation=document.history_generation,
    )
    draft.snapshot = {"content": document.content, "annotations": []}
    draft.save()
    revision = DocumentVersion(
        document=document,
        kind=DocumentVersion.KIND_REVISION,
        schema_version=document.schema_version,
        source_history_generation=document.history_generation,
        name="Owner revision",
    )
    revision.snapshot = {"content": document.content, "annotations": []}
    revision.save()

    client.force_login(editor)
    drafts = client.get(f"/api/editor/manuscripts/{manuscript.public_id}/document/drafts/")
    assert drafts.status_code == 200
    assert [item["id"] for item in drafts.json()["items"]] == [str(draft.public_id)]
    assert client.get(
        f"/api/editor/manuscripts/{manuscript.public_id}/drafts/{draft.public_id}/"
    ).status_code == 200
    assert client.get(
        f"/api/editor/manuscripts/{manuscript.public_id}/drafts/{revision.public_id}/"
    ).status_code == 404

    grant.revoked_at = document.updated_at
    grant.save(update_fields=["revoked_at"])
    assert client.get(
        f"/api/editor/manuscripts/{manuscript.public_id}/drafts/{draft.public_id}/"
    ).status_code == 404
    assert client.get(f"/api/editor/manuscripts/{manuscript.public_id}/").status_code == 404
