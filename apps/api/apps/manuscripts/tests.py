import json
import zipfile
from datetime import timedelta
from io import BytesIO
from pathlib import Path

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from docx import Document as DocxDocument
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.shared import Inches
from lxml import etree
from odfdo import Cell as OdfCell
from odfdo import Document as OdfDocument
from odfdo import Header as OdfHeader
from odfdo import Paragraph as OdfParagraph
from odfdo import Row as OdfRow
from odfdo import Span as OdfSpan
from odfdo import Table as OdfTable
from PIL import Image

from apps.accounts.models import UserMediaAsset
from apps.audit.models import AuditEvent

from . import exports as manuscript_exports
from . import office_import
from .assets import InvalidAsset, process_asset
from .covers import InvalidCover, process_cover
from .exports import build_export, cleanup_expired_exports, materialize_export
from .models import (
    AnnotationReply,
    Document,
    DocumentAnnotation,
    DocumentVersion,
    EditorPreference,
    Glossary,
    GlossaryArticle,
    GlossaryCategory,
    Manuscript,
    ManuscriptAsset,
    ManuscriptExport,
    ManuscriptItem,
    ManuscriptNote,
    ManuscriptPlanStatus,
    ManuscriptTask,
    ManuscriptWritingDay,
    Series,
    SeriesMembership,
    Workspace,
)
from .office_import import InvalidOfficeImport, office_source_to_document
from .versioning import materialize_due_draft


def cover_upload(*, with_exif: bool = False) -> SimpleUploadedFile:
    output = BytesIO()
    image = Image.new("RGB", (1200, 1800), "#345995")
    exif = Image.Exif()
    if with_exif:
        exif[0x010F] = "Private camera data"
    image.save(output, format="JPEG", quality=90, exif=exif)
    return SimpleUploadedFile("cover.jpg", output.getvalue(), content_type="image/jpeg")


def text_upload(name: str, content: str, *, encoding: str = "utf-8") -> SimpleUploadedFile:
    return SimpleUploadedFile(
        name,
        content.encode(encoding),
        content_type="text/markdown" if name.endswith(".md") else "text/plain",
    )


def docx_upload(name: str = "document.docx") -> SimpleUploadedFile:
    document = DocxDocument()
    document.add_heading("Opening", level=2)
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.add_run("Bold").bold = True
    paragraph.add_run(" and ")
    marked = paragraph.add_run("italic strike")
    marked.italic = True
    marked.font.strike = True
    inserted = paragraph.add_run(" inserted")
    insertion = OxmlElement("w:ins")
    inserted._r.addprevious(insertion)
    insertion.append(inserted._r)
    deleted = paragraph.add_run(" deleted")
    deletion = OxmlElement("w:del")
    deleted._r.addprevious(deletion)
    deletion.append(deleted._r)
    image = BytesIO()
    Image.new("RGB", (16, 16), "#345995").save(image, format="PNG")
    paragraph.add_run().add_picture(BytesIO(image.getvalue()), width=Inches(0.2))
    paragraph.add_run(" after image")
    document.add_paragraph("***")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Left"
    table.cell(0, 1).text = "Right"
    document.sections[0].header.paragraphs[0].text = "Ignored header"
    output = BytesIO()
    document.save(output)
    return SimpleUploadedFile(
        name,
        output.getvalue(),
        content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )


def odt_upload(name: str = "document.odt") -> SimpleUploadedFile:
    document = OdfDocument("text")
    document.body.clear()
    document.insert_style(
        '<style:style style:name="Centered" style:family="paragraph">'
        '<style:paragraph-properties fo:text-align="center"/>'
        "</style:style>"
    )
    document.insert_style(
        '<style:style style:name="Strong" style:family="text">'
        '<style:text-properties fo:font-weight="bold"/>'
        "</style:style>"
    )
    document.body.append(OdfHeader(3, "Finale"))
    paragraph = OdfParagraph(style="Centered")
    paragraph.append(OdfSpan("Bold", style="Strong"))
    paragraph.append(" text\nnext line")
    document.body.append(paragraph)
    table = OdfTable("ImportTable")
    row = OdfRow()
    row.append(OdfCell(text="First"))
    row.append(OdfCell(text="Second"))
    table.append(row)
    document.body.append(table)
    output = BytesIO()
    document.save(output)
    return SimpleUploadedFile(
        name,
        output.getvalue(),
        content_type="application/vnd.oasis.opendocument.text",
    )


def disallowed_image_upload() -> SimpleUploadedFile:
    output = BytesIO()
    Image.new("RGB", (16, 16), "#345995").save(output, format="BMP")
    return SimpleUploadedFile("image.png", output.getvalue(), content_type="image/png")


def test_cover_rejects_disallowed_image_format():
    with pytest.raises(InvalidCover, match="cover_invalid_image"):
        process_cover(disallowed_image_upload())


def test_asset_rejects_disallowed_image_format():
    with pytest.raises(InvalidAsset, match="asset_invalid_image"):
        process_asset(disallowed_image_upload())


def export_doc(text: str, *, leading_scene_break: bool = False) -> dict:
    content = []
    if leading_scene_break:
        content.append({"type": "sceneBreak"})
    content.append({"type": "paragraph", "content": [{"type": "text", "text": text}]})
    return {"type": "doc", "content": content}


def create_export_manuscript(user, *, kind: str, title: str = "Exported"):
    workspace = Workspace.objects.create(owner=user)
    return Manuscript.objects.create(
        workspace=workspace,
        kind=kind,
        title=title,
        synopsis="Private synopsis",
        language="ru",
        genres=["fantasy"],
    )


def create_export_document(
    manuscript: Manuscript,
    *,
    title: str,
    content: dict,
    parent: ManuscriptItem | None = None,
    position: int = 1,
) -> Document:
    item = ManuscriptItem.objects.create(
        manuscript=manuscript,
        parent=parent,
        kind=ManuscriptItem.KIND_DOCUMENT,
        title=title,
        position=ManuscriptItem.POSITION_STEP * position,
    )
    return Document.objects.create(manuscript=manuscript, item=item, content=content)


def create_search_glossary_article(
    *,
    glossary: Glossary,
    title: str,
    synopsis: str = "",
    content_text: str = "",
) -> GlossaryArticle:
    category = GlossaryCategory.objects.create(
        glossary=glossary,
        name=f"Category {title}",
    )
    return GlossaryArticle.objects.create(
        glossary=glossary,
        category=category,
        title=title,
        synopsis=synopsis,
        content=export_doc(content_text),
    )


def create_export_job(
    manuscript: Manuscript,
    *,
    selected_documents: list[Document],
    export_format: str = ManuscriptExport.FORMAT_MARKDOWN,
    epub_version: int | None = None,
    include_title_page: bool = True,
    include_author_info_page: bool = True,
    include_illustrations: bool = True,
) -> ManuscriptExport:
    return ManuscriptExport.objects.create(
        owner=manuscript.workspace.owner,
        manuscript=manuscript,
        export_format=export_format,
        epub_version=epub_version,
        options={
            "format": (
                f"epub{epub_version}"
                if export_format == ManuscriptExport.FORMAT_EPUB
                else export_format
            ),
            "includeTitlePage": include_title_page,
            "includeAuthorInfoPage": include_author_info_page,
            "includeIllustrations": include_illustrations,
            "language": "",
        },
        selected_item_ids=[str(document.item.public_id) for document in selected_documents],
        expires_at=timezone.now() + timedelta(minutes=30),
    )


@pytest.mark.django_db
def test_workspace_useful_links_store_plaintext_profile_links(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="workspace-links",
        email="workspace-links@example.test",
        password="development-password",
    )
    client.force_login(user)

    response = client.patch(
        "/api/manuscripts/dashboard/useful-links/",
        {
            "links": [
                {"title": "Dictionary", "url": "example.test/dictionary"},
                {"title": "Market", "url": "https://market.example.test"},
            ],
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["links"] == [
        {"title": "Dictionary", "url": "https://example.test/dictionary"},
        {"title": "Market", "url": "https://market.example.test"},
    ]

    user.refresh_from_db()
    assert user.workspace_useful_links[0]["title"] == "Dictionary"
    get_response = client.get("/api/manuscripts/dashboard/useful-links/")
    assert get_response.status_code == 200
    assert get_response.json()["links"][0]["title"] == "Dictionary"


@pytest.mark.django_db
def test_workspace_search_returns_active_metadata_only(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="workspace-search",
        password="development-password",
    )
    client.force_login(user)
    workspace = Workspace.objects.create(owner=user)
    manuscript = Manuscript.objects.create(
        workspace=workspace,
        kind=Manuscript.KIND_BOOK,
        title="Drawer Book",
        drawer_at=timezone.now(),
    )
    active_document = create_export_document(
        manuscript,
        title="Needle Document",
        content=export_doc("body without the query"),
    )
    trashed_document = create_export_document(
        manuscript,
        title="Needle Trashed Document",
        content=export_doc("body"),
        position=2,
    )
    trashed_document.item.trashed_at = timezone.now()
    trashed_document.item.save(update_fields=["trashed_at"])
    ManuscriptItem.objects.create(
        manuscript=manuscript,
        kind=ManuscriptItem.KIND_FOLDER,
        title="Needle Folder",
        position=ManuscriptItem.POSITION_STEP * 3,
    )
    create_export_document(
        manuscript,
        title="Body-only Document",
        content=export_doc("Needle"),
        position=4,
    )
    one_shot = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=user),
        kind=Manuscript.KIND_ONESHOT,
        title="Needle One-Shot",
    )
    one_shot_document = Document.objects.create(
        manuscript=one_shot,
        content=export_doc("body"),
    )
    active_note = ManuscriptNote.objects.create(
        manuscript=manuscript,
        title="Needle Note",
        content=export_doc("body"),
    )
    ManuscriptNote.objects.create(
        manuscript=manuscript,
        title="Body-only Note",
        content=export_doc("Needle"),
    )
    ManuscriptNote.objects.create(
        manuscript=manuscript,
        title="Needle Archived Note",
        content=export_doc("body"),
        archived_at=timezone.now(),
    )
    ManuscriptNote.objects.create(
        manuscript=manuscript,
        title="Needle Trashed Note",
        content=export_doc("body"),
        trashed_at=timezone.now(),
    )
    glossary = Glossary.objects.create(manuscript=manuscript)
    title_article = create_search_glossary_article(
        glossary=glossary,
        title="Needle Article",
    )
    synopsis_article = create_search_glossary_article(
        glossary=glossary,
        title="Article by synopsis",
        synopsis="The Needle appears here",
    )
    create_search_glossary_article(
        glossary=glossary,
        title="Body-only Article",
        content_text="Needle",
    )
    synopsis_manuscript = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=user),
        kind=Manuscript.KIND_BOOK,
        title="Synopsis-only Manuscript",
        synopsis="The Needle appears in this manuscript synopsis",
    )

    other_user = django_user_model.objects.create_user(username="search-other")
    other_workspace = Workspace.objects.create(owner=other_user)
    other_manuscript = Manuscript.objects.create(
        workspace=other_workspace,
        kind=Manuscript.KIND_ONESHOT,
        title="Needle Other User",
    )
    Document.objects.create(manuscript=other_manuscript, content=export_doc("body"))

    response = client.get("/api/manuscripts/dashboard/search/?q=Needle")

    assert response.status_code == 200
    results = response.json()["results"]
    content_results = [result for result in results if result["kind"] != "manuscript"]
    assert {result["id"] for result in content_results} == {
        str(active_document.public_id),
        str(one_shot_document.public_id),
        str(active_note.public_id),
        str(title_article.public_id),
        str(synopsis_article.public_id),
    }
    manuscript_results = [result for result in results if result["kind"] == "manuscript"]
    assert {result["id"] for result in manuscript_results} == {
        str(manuscript.public_id),
        str(one_shot.public_id),
        str(synopsis_manuscript.public_id),
    }
    assert next(
        result for result in manuscript_results
        if result["id"] == str(synopsis_manuscript.public_id)
    )["synopsis"] == "The Needle appears in this manuscript synopsis"
    document_result = next(
        result for result in results if result["id"] == str(active_document.public_id)
    )
    assert document_result["itemId"] == str(active_document.item.public_id)
    assert document_result["contextTitle"] == "Drawer Book"
    one_shot_result = next(result for result in results if result["id"] == str(
        one_shot_document.public_id
    ))
    assert one_shot_result["itemId"] is None


@pytest.mark.django_db
def test_workspace_search_ranks_and_limits_each_kind(client, django_user_model):
    user = django_user_model.objects.create_user(username="workspace-search-ranking")
    client.force_login(user)
    workspace = Workspace.objects.create(owner=user)
    manuscript = Manuscript.objects.create(
        workspace=workspace,
        kind=Manuscript.KIND_BOOK,
        title="Ranking Book",
    )
    for title in (
        "A Needle suffix",
        "Needle prefix four",
        "Needle prefix three",
        "Needle prefix two",
        "Needle prefix one",
        "Needle",
        "Another Needle suffix",
    ):
        ManuscriptNote.objects.create(
            manuscript=manuscript,
            title=title,
            content=export_doc("body"),
        )

    response = client.get("/api/manuscripts/dashboard/search/?q=needle")

    assert response.status_code == 200
    notes = [result for result in response.json()["results"] if result["kind"] == "note"]
    assert len(notes) == 5
    assert notes[0]["title"] == "Needle"
    assert all(note["title"].startswith("Needle") for note in notes)


@pytest.mark.django_db
def test_workspace_search_uses_active_series_glossary_once(client, django_user_model):
    user = django_user_model.objects.create_user(username="workspace-series-search")
    client.force_login(user)
    series = Series.objects.create(
        workspace=Workspace.objects.create(owner=user),
        title="Needle Series",
    )
    second_book = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=user),
        kind=Manuscript.KIND_BOOK,
        title="Second Book",
    )
    first_book = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=user),
        kind=Manuscript.KIND_BOOK,
        title="First Book",
    )
    SeriesMembership.objects.create(series=series, manuscript=second_book, position=2)
    SeriesMembership.objects.create(series=series, manuscript=first_book, position=1)
    series_article = create_search_glossary_article(
        glossary=Glossary.objects.create(series=series),
        title="Needle Shared Article",
    )
    create_search_glossary_article(
        glossary=Glossary.objects.create(manuscript=first_book),
        title="Needle Hidden Article",
    )
    empty_series = Series.objects.create(
        workspace=Workspace.objects.create(owner=user),
        title="Empty Series",
    )
    create_search_glossary_article(
        glossary=Glossary.objects.create(series=empty_series),
        title="Needle Inaccessible Article",
    )

    response = client.get("/api/manuscripts/dashboard/search/?q=Needle")

    assert response.status_code == 200
    articles = [
        result for result in response.json()["results"]
        if result["kind"] == "glossaryArticle"
    ]
    assert articles == [
        {
            "kind": "glossaryArticle",
            "id": str(series_article.public_id),
            "title": "Needle Shared Article",
            "manuscriptId": str(first_book.public_id),
            "contextTitle": "Needle Series",
            "updatedAt": series_article.updated_at.isoformat(),
            "synopsis": "",
        }
    ]


@pytest.mark.django_db
def test_workspace_search_validates_query_length(client, django_user_model):
    user = django_user_model.objects.create_user(username="workspace-search-query")
    client.force_login(user)

    assert client.get("/api/manuscripts/dashboard/search/?q=a").status_code == 400
    assert client.get(
        f"/api/manuscripts/dashboard/search/?q={'a' * 121}"
    ).status_code == 400


@pytest.mark.django_db
def test_workspace_stats_aggregate_existing_manuscript_metrics(client, django_user_model):
    today = timezone.localdate()
    user = django_user_model.objects.create_user(
        username="workspace-stats",
        email="workspace-stats@example.test",
        password="development-password",
    )
    workspace = Workspace.objects.create(owner=user)
    in_progress = Manuscript.objects.create(
        workspace=workspace,
        kind=Manuscript.KIND_ONESHOT,
        title="Current",
        first_edited_at=timezone.now(),
    )
    in_progress.planner_settings = {
        "deadline": (today + timedelta(days=11)).isoformat(),
        "dailyWordGoal": 0,
        "manuscriptWordGoal": 0,
    }
    in_progress.save(update_fields=["planner_settings"])
    in_progress_item = ManuscriptItem.objects.create(
        manuscript=in_progress,
        kind=ManuscriptItem.KIND_DOCUMENT,
        title="Current",
        position=ManuscriptItem.POSITION_STEP,
    )
    Document.objects.create(
        manuscript=in_progress,
        item=in_progress_item,
        content=export_doc("one two three"),
    )

    complete = Manuscript.objects.create(
        workspace=workspace,
        kind=Manuscript.KIND_ONESHOT,
        title="Done",
    )
    complete.planner_settings = {
        "deadline": (today + timedelta(days=6)).isoformat(),
        "dailyWordGoal": 0,
        "manuscriptWordGoal": 0,
    }
    complete.save(update_fields=["planner_settings"])
    complete_status = ManuscriptPlanStatus(
        manuscript=complete,
        color="green",
        position=ManuscriptItem.POSITION_STEP,
        counts_as_complete=True,
    )
    complete_status.name = "Complete"
    complete_status.save()
    complete_item = ManuscriptItem.objects.create(
        manuscript=complete,
        kind=ManuscriptItem.KIND_DOCUMENT,
        title="Done",
        position=ManuscriptItem.POSITION_STEP,
    )
    metadata = complete_item.planner_metadata
    metadata["statusId"] = str(complete_status.public_id)
    complete_item.planner_metadata = metadata
    complete_item.save(update_fields=["planner_metadata"])
    Document.objects.create(
        manuscript=complete,
        item=complete_item,
        content=export_doc("four five"),
    )
    ManuscriptWritingDay.objects.create(
        manuscript=in_progress,
        date=today,
        words_written=7,
    )
    ManuscriptWritingDay.objects.create(
        manuscript=complete,
        date=today - timedelta(days=1),
        words_written=3,
    )
    ManuscriptWritingDay.objects.create(
        manuscript=complete,
        date=today - timedelta(days=6),
        words_written=5,
    )
    client.force_login(user)

    response = client.get("/api/manuscripts/dashboard/stats/?timezone=UTC")

    assert response.status_code == 200
    stats = response.json()["stats"]
    assert stats["manuscriptsInProgress"] == 1
    assert stats["totalWords"] == 5
    assert stats["wordsWrittenThisWeek"] == 15
    assert stats["wordsWrittenToday"] == 7
    assert stats["wordsWrittenYesterday"] == 3
    assert stats["wordsWrittenTodayDelta"] == 4
    assert stats["nearestDeadline"]["title"] == "Done"
    assert stats["nearestDeadline"]["deadline"] == (today + timedelta(days=6)).isoformat()


@pytest.mark.django_db
def test_workspace_today_delta_never_reports_negative_progress(client, django_user_model):
    today = timezone.localdate()
    user = django_user_model.objects.create_user(
        username="workspace-nonnegative-delta",
        password="development-password",
    )
    workspace = Workspace.objects.create(owner=user)
    manuscript = Manuscript.objects.create(
        workspace=workspace,
        kind=Manuscript.KIND_ONESHOT,
        title="Current",
    )
    ManuscriptWritingDay.objects.create(
        manuscript=manuscript,
        date=today - timedelta(days=1),
        words_written=100,
    )
    client.force_login(user)

    response = client.get("/api/manuscripts/dashboard/stats/?timezone=UTC")

    assert response.status_code == 200
    assert response.json()["stats"]["wordsWrittenTodayDelta"] == 0


@pytest.mark.django_db
def test_create_oneshot_stores_plaintext_metadata_and_empty_document(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/manuscripts/oneshots/",
        {
            "title": "A Secret Title",
            "synopsis": "A private synopsis",
            "language": "ru",
            "genres": json.dumps(["fantasy", "adventure"]),
        },
    )

    assert response.status_code == 201
    manuscript = Manuscript.objects.select_related("workspace").get()
    document = Document.objects.select_related("manuscript__workspace").get()
    stored_manuscript = Manuscript.objects.values().get()
    stored_document = Document.objects.values().get()
    assert stored_manuscript["title"] == "A Secret Title"
    assert stored_manuscript["synopsis"] == "A private synopsis"
    assert stored_manuscript["genres"] == ["fantasy", "adventure"]
    assert stored_document["content"] == Document.EMPTY_DOCUMENT
    assert manuscript.title == "A Secret Title"
    assert manuscript.synopsis == "A private synopsis"
    assert manuscript.language == "ru"
    assert manuscript.genres == ["fantasy", "adventure"]
    assert response.json()["manuscript"]["language"] == "ru"
    assert response.json()["manuscript"]["genres"] == ["fantasy", "adventure"]
    assert document.title == manuscript.title
    assert document.content == Document.EMPTY_DOCUMENT
    assert document.schema_version == Document.CURRENT_SCHEMA_VERSION


@pytest.mark.django_db
def test_oneshot_creation_respects_tier_quota(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="oneshot-quota",
        email="oneshot-quota@example.test",
        password="correct-password",
    )
    client.force_login(user)

    responses = [
        client.post("/api/manuscripts/oneshots/", {"title": f"Story {index}"}) for index in range(6)
    ]

    assert [response.status_code for response in responses[:5]] == [201] * 5
    assert responses[5].status_code == 409
    payload = responses[5].json()
    assert {key: payload[key] for key in ("error", "quotaKey", "used", "limit", "tier")} == {
        "error": "quota_limit_reached",
        "quotaKey": "oneshots",
        "used": 5,
        "limit": 5,
        "tier": "novice",
    }
    assert payload["support"]["username"] == user.username
    assert payload["support"]["userId"] == user.id
    assert payload["support"]["ipAddress"] == "127.0.0.1"
    assert payload["support"]["occurredAt"]


@pytest.mark.django_db
def test_create_oneshot_imports_single_text_document(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="oneshot-import-writer",
        email="oneshot-import-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manifest = {
        "version": 1,
        "nodes": [
            {
                "id": "document-1",
                "parentId": None,
                "kind": "document",
                "title": "Ignored source title",
                "order": 0,
                "fileKey": "importFile_0",
                "sourcePath": "story.txt",
            }
        ],
    }

    response = client.post(
        "/api/manuscripts/oneshots/",
        {
            "title": "Imported story",
            "synopsis": "",
            "importManifest": json.dumps(manifest),
            "importFile_0": text_upload(
                "story.txt",
                "First paragraph.\nStill first.\n\nSecond paragraph.",
            ),
        },
    )

    assert response.status_code == 201
    manuscript = Manuscript.objects.get(public_id=response.json()["manuscript"]["id"])
    document = manuscript.documents.get()
    assert document.item.title == "Imported story"
    assert document.content["content"][0] == {
        "type": "paragraph",
        "content": [
            {"type": "text", "text": "First paragraph."},
            {"type": "hardBreak"},
            {"type": "text", "text": "Still first."},
        ],
    }
    assert document.content["content"][1]["content"][0]["text"] == "Second paragraph."


@pytest.mark.django_db
def test_create_book_imports_folder_tree_and_supported_markdown(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="book-import-writer",
        email="book-import-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manifest = {
        "version": 1,
        "nodes": [
            {
                "id": "chapter",
                "parentId": None,
                "kind": "folder",
                "title": "Chapter 1",
                "order": 0,
            },
            {
                "id": "scene",
                "parentId": "chapter",
                "kind": "document",
                "title": "Scene 1",
                "order": 0,
                "fileKey": "importFile_0",
                "sourcePath": "Chapter 1/Scene 1.md",
            },
            {
                "id": "appendix",
                "parentId": None,
                "kind": "document",
                "title": "Appendix",
                "order": 1,
                "fileKey": "importFile_1",
                "sourcePath": "Appendix.txt",
            },
        ],
    }

    response = client.post(
        "/api/manuscripts/books/",
        {
            "title": "Imported book",
            "synopsis": "",
            "importManifest": json.dumps(manifest),
            "importFile_0": text_upload(
                "scene.md",
                "---\ntags: [private]\n---\n"
                "# Heading\n\n"
                "**Bold** [link](https://example.test)\n\n"
                "***\n\n"
                "![cover](cover.png)",
            ),
            "importFile_1": text_upload(
                "appendix.txt",
                "Приложение",
                encoding="cp1251",
            ),
        },
    )

    assert response.status_code == 201
    manuscript = Manuscript.objects.get(public_id=response.json()["manuscript"]["id"])
    items = list(manuscript.items.order_by("id"))
    assert [(item.kind, item.title) for item in items] == [
        ("folder", "Chapter 1"),
        ("document", "Scene 1"),
        ("document", "Appendix"),
    ]
    assert all(item.planner_metadata["role"] == "untyped" for item in items)
    scene = manuscript.documents.get(item_id=items[1].id)
    assert scene.content["content"][0] == {
        "type": "heading",
        "attrs": {"level": 1},
        "content": [{"type": "text", "text": "Heading"}],
    }
    assert scene.content["content"][1]["content"] == [
        {"type": "text", "text": "Bold", "marks": [{"type": "bold"}]},
        {"type": "text", "text": " link"},
    ]
    assert scene.content["content"][2] == {"type": "sceneBreak"}
    appendix = manuscript.documents.exclude(id=scene.id).get()
    assert appendix.content["content"][0]["content"][0]["text"] == "Приложение"


@pytest.mark.django_db
def test_create_oneshot_imports_docx_content_without_embedded_media(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="docx-import-writer",
        email="docx-import-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manifest = {
        "version": 1,
        "nodes": [
            {
                "id": "document-1",
                "parentId": None,
                "kind": "document",
                "title": "Source title",
                "order": 0,
                "fileKey": "importFile_0",
                "sourcePath": "story.docx",
            }
        ],
    }

    response = client.post(
        "/api/manuscripts/oneshots/",
        {
            "title": "Imported DOCX",
            "importManifest": json.dumps(manifest),
            "importFile_0": docx_upload("story.docx"),
        },
    )

    assert response.status_code == 201
    manuscript = Manuscript.objects.get(public_id=response.json()["manuscript"]["id"])
    document = manuscript.documents.get()
    assert document.item.title == "Imported DOCX"
    assert document.content == {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 2},
                "content": [{"type": "text", "text": "Opening"}],
            },
            {
                "type": "paragraph",
                "attrs": {"textAlign": "center"},
                "content": [
                    {"type": "text", "text": "Bold", "marks": [{"type": "bold"}]},
                    {"type": "text", "text": " and "},
                    {
                        "type": "text",
                        "text": "italic strike",
                        "marks": [{"type": "italic"}, {"type": "strike"}],
                    },
                    {"type": "text", "text": " inserted after image"},
                ],
            },
            {"type": "sceneBreak"},
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "Left | Right"}],
            },
        ],
    }
    assert not ManuscriptAsset.objects.filter(manuscript=manuscript).exists()
    assert not UserMediaAsset.objects.filter(owner=user).exists()


@pytest.mark.django_db
def test_create_book_imports_odt_inside_selected_folder(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="odt-import-writer",
        email="odt-import-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manifest = {
        "version": 1,
        "nodes": [
            {
                "id": "folder-1",
                "parentId": None,
                "kind": "folder",
                "title": "Part 1",
                "order": 0,
            },
            {
                "id": "document-1",
                "parentId": "folder-1",
                "kind": "document",
                "title": "Scene 1",
                "order": 0,
                "fileKey": "importFile_0",
                "sourcePath": "Part 1/Scene 1.odt",
            },
        ],
    }

    response = client.post(
        "/api/manuscripts/books/",
        {
            "title": "Imported ODT",
            "importManifest": json.dumps(manifest),
            "importFile_0": odt_upload("Scene 1.odt"),
        },
    )

    assert response.status_code == 201
    manuscript = Manuscript.objects.get(public_id=response.json()["manuscript"]["id"])
    folder = manuscript.items.get(kind=ManuscriptItem.KIND_FOLDER)
    document = manuscript.documents.get()
    assert folder.title == "Part 1"
    assert document.item.parent == folder
    assert document.item.title == "Scene 1"
    assert document.content == {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 3},
                "content": [{"type": "text", "text": "Finale"}],
            },
            {
                "type": "paragraph",
                "attrs": {"textAlign": "center"},
                "content": [
                    {"type": "text", "text": "Bold", "marks": [{"type": "bold"}]},
                    {"type": "text", "text": " text"},
                    {"type": "hardBreak"},
                    {"type": "text", "text": "next line"},
                ],
            },
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "First | Second"}],
            },
        ],
    }


def test_office_import_rejects_invalid_encrypted_and_oversized_packages(monkeypatch):
    with pytest.raises(InvalidOfficeImport, match="import_file_invalid"):
        office_source_to_document(b"not a DOCX package", ".docx")

    encrypted = BytesIO()
    with zipfile.ZipFile(encrypted, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("content.xml", "<office:document-content/>")
        archive.writestr(
            "META-INF/manifest.xml",
            '<manifest:manifest><manifest:encryption-data/></manifest:manifest>',
        )
    with pytest.raises(InvalidOfficeImport, match="import_file_encrypted"):
        office_source_to_document(encrypted.getvalue(), ".odt")

    monkeypatch.setattr(office_import, "MAX_OFFICE_EXPANDED_BYTES", 10)
    oversized = BytesIO()
    with zipfile.ZipFile(oversized, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("content.xml", b" " * 11)
    with pytest.raises(InvalidOfficeImport, match="import_file_expanded_too_large"):
        office_source_to_document(oversized.getvalue(), ".odt")


@pytest.mark.django_db
def test_invalid_office_import_does_not_create_partial_book(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="invalid-office-import-writer",
        email="invalid-office-import-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manifest = {
        "version": 1,
        "nodes": [
            {
                "id": "valid",
                "parentId": None,
                "kind": "document",
                "title": "Valid",
                "order": 0,
                "fileKey": "importFile_0",
                "sourcePath": "Valid.docx",
            },
            {
                "id": "invalid",
                "parentId": None,
                "kind": "document",
                "title": "Invalid",
                "order": 1,
                "fileKey": "importFile_1",
                "sourcePath": "Invalid.odt",
            },
        ],
    }

    response = client.post(
        "/api/manuscripts/books/",
        {
            "title": "Must not exist",
            "importManifest": json.dumps(manifest),
            "importFile_0": docx_upload("Valid.docx"),
            "importFile_1": SimpleUploadedFile(
                "Invalid.odt",
                b"not an ODT package",
                content_type="application/vnd.oasis.opendocument.text",
            ),
        },
    )

    assert response.status_code == 400
    assert response.json()["error"] == "import_file_invalid"
    assert not Manuscript.objects.filter(workspace__owner=user).exists()


@pytest.mark.django_db
def test_markdown_export_uses_book_chapters_without_scene_titles(django_user_model):
    user = django_user_model.objects.create_user(
        username="export-book-writer",
        email="export-book-writer@example.test",
        password="correct-password",
    )
    user.author_name = "V. Writer"
    user.author_email = "writer@example.test"
    user.save(update_fields=["author_name", "author_email"])
    manuscript = create_export_manuscript(user, kind=Manuscript.KIND_BOOK, title="Novel")
    first_root = create_export_document(
        manuscript,
        title="Same",
        content=export_doc("Root one"),
        position=1,
    )
    second_root = create_export_document(
        manuscript,
        title="Same",
        content=export_doc("Root two"),
        position=2,
    )
    chapter = ManuscriptItem.objects.create(
        manuscript=manuscript,
        kind=ManuscriptItem.KIND_FOLDER,
        title="Chapter A",
        position=ManuscriptItem.POSITION_STEP * 3,
    )
    scene_one = create_export_document(
        manuscript,
        parent=chapter,
        title="Scene one title",
        content=export_doc("Scene one"),
        position=1,
    )
    scene_two = create_export_document(
        manuscript,
        parent=chapter,
        title="Scene two title",
        content=export_doc("Scene two", leading_scene_break=True),
        position=2,
    )
    export = create_export_job(
        manuscript,
        selected_documents=[first_root, second_root, scene_one, scene_two],
    )

    result = build_export(export)
    markdown = result.data.decode("utf-8")

    assert result.file_name == "Novel.md"
    assert "V. Writer" in markdown
    assert markdown.count("## Same") == 2
    assert "## Chapter A" in markdown
    assert "Scene one title" not in markdown
    assert "Scene two title" not in markdown
    assert markdown.count("***") == 1


@pytest.mark.django_db
def test_oneshot_markdown_export_omits_title_and_missing_author_pages(django_user_model):
    user = django_user_model.objects.create_user(
        username="export-oneshot-writer",
        email="export-oneshot-writer@example.test",
        password="correct-password",
    )
    manuscript = create_export_manuscript(user, kind=Manuscript.KIND_ONESHOT, title="One-Shot")
    document = create_export_document(
        manuscript,
        title="One-Shot",
        content=export_doc("Body text"),
    )
    export = create_export_job(
        manuscript,
        selected_documents=[document],
        include_title_page=False,
        include_author_info_page=True,
        include_illustrations=False,
    )

    result = build_export(export)

    assert result.data.decode("utf-8") == "Body text\n"


@pytest.mark.django_db
def test_export_file_name_preserves_cyrillic_title(django_user_model):
    user = django_user_model.objects.create_user(
        username="export-cyrillic-writer",
        email="export-cyrillic-writer@example.test",
        password="correct-password",
    )
    manuscript = create_export_manuscript(
        user,
        kind=Manuscript.KIND_ONESHOT,
        title="Новый Эдем. Том 1",
    )
    document = create_export_document(
        manuscript,
        title="Новый Эдем. Том 1",
        content=export_doc("Body text"),
    )
    export = create_export_job(manuscript, selected_documents=[document])

    result = build_export(export)

    assert result.file_name == "Новый Эдем. Том 1.md"


@pytest.mark.django_db
@pytest.mark.parametrize("epub_version", [2, 3])
def test_epub_export_builds_readable_archive(django_user_model, epub_version):
    user = django_user_model.objects.create_user(
        username=f"export-epub-{epub_version}-writer",
        email=f"export-epub-{epub_version}-writer@example.test",
        password="correct-password",
    )
    user.author_name = "V. Writer"
    user.author_email = "writer@example.test"
    user.save(update_fields=["author_name", "author_email"])
    manuscript = create_export_manuscript(user, kind=Manuscript.KIND_BOOK, title="EPUB Novel")
    document = create_export_document(
        manuscript,
        title="Chapter 1",
        content=export_doc("Chapter body"),
    )
    export = create_export_job(
        manuscript,
        selected_documents=[document],
        export_format=ManuscriptExport.FORMAT_EPUB,
        epub_version=epub_version,
    )

    result = build_export(export)

    assert result.file_name == "EPUB Novel.epub"
    assert result.content_type == "application/epub+zip"
    with zipfile.ZipFile(BytesIO(result.data)) as archive:
        names = set(archive.namelist())
        assert "mimetype" in names
        chapter_name = next(name for name in names if name.endswith("chapter-1.xhtml"))
        chapter = archive.read(chapter_name).decode("utf-8")
        assert "Chapter 1" in chapter
        assert "Chapter body" in chapter
        assert any(name.endswith("nav.xhtml") for name in names)
        assert any(name.endswith("synopsis.xhtml") for name in names)
        package_name = next(name for name in names if name.endswith("content.opf"))
        package = etree.fromstring(archive.read(package_name))
        namespaces = {"opf": "http://www.idpf.org/2007/opf"}
        manifest = {
            item.get("id"): item.get("href")
            for item in package.xpath("//opf:manifest/opf:item", namespaces=namespaces)
        }
        spine = [
            manifest[item.get("idref")]
            for item in package.xpath("//opf:spine/opf:itemref", namespaces=namespaces)
        ]
        assert spine.index("title.xhtml") < spine.index("synopsis.xhtml")
        assert spine.index("synopsis.xhtml") < spine.index("author.xhtml")
        assert spine.index("author.xhtml") < spine.index("nav.xhtml")
        assert spine.index("nav.xhtml") < spine.index("chapter-1.xhtml")


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("export_format", "extension", "content_type"),
    [
        (
            ManuscriptExport.FORMAT_DOCX,
            "docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        (
            ManuscriptExport.FORMAT_ODT,
            "odt",
            "application/vnd.oasis.opendocument.text",
        ),
        (
            ManuscriptExport.FORMAT_FB2,
            "fb2",
            "application/x-fictionbook+xml",
        ),
    ],
)
def test_document_exports_include_semantic_content(
    django_user_model,
    export_format,
    extension,
    content_type,
):
    user = django_user_model.objects.create_user(
        username=f"export-{extension}-writer",
        email=f"export-{extension}-writer@example.test",
        password="correct-password",
    )
    user.author_name = "V. Writer"
    user.author_email = "writer@example.test"
    user.save(update_fields=["author_name", "author_email"])
    manuscript = create_export_manuscript(user, kind=Manuscript.KIND_BOOK, title="Novel")
    document = create_export_document(
        manuscript,
        title="Chapter 1",
        content={
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "Bold", "marks": [{"type": "bold"}]},
                        {"type": "text", "text": " body"},
                    ],
                },
                {"type": "sceneBreak"},
                {"type": "paragraph", "content": [{"type": "text", "text": "Next"}]},
            ],
        },
    )
    export = create_export_job(
        manuscript,
        selected_documents=[document],
        export_format=export_format,
    )

    result = build_export(export)

    assert result.file_name == f"Novel.{extension}"
    assert result.content_type == content_type
    if export_format == ManuscriptExport.FORMAT_FB2:
        root = etree.fromstring(result.data)
        namespaces = {"fb": "http://www.gribuser.ru/xml/fictionbook/2.0"}
        assert root.xpath("string(.//fb:book-title)", namespaces=namespaces) == "Novel"
        assert root.xpath("string(.//fb:lang)", namespaces=namespaces) == "ru"
        assert root.xpath("string(.//fb:genre)", namespaces=namespaces) == "sf_fantasy"
        assert "Bold body" in "".join(root.itertext())
        section_titles = [
            " ".join(section.xpath("./fb:title/fb:p/text()", namespaces=namespaces))
            for section in root.xpath(".//fb:body/fb:section", namespaces=namespaces)
        ]
        assert section_titles[1:] == ["Синопсис", "Информация об авторе", "Chapter 1"]
        assert (
            root.xpath(
                "string(.//fb:document-info/fb:author/fb:nickname)",
                namespaces=namespaces,
            )
            == "Quillum Exporter"
        )
        scene_break = root.xpath(".//fb:p[text()='***']", namespaces=namespaces)[0]
        assert scene_break.getprevious().tag.endswith("empty-line")
    else:
        with zipfile.ZipFile(BytesIO(result.data)) as archive:
            content_name = "word/document.xml" if extension == "docx" else "content.xml"
            content = archive.read(content_name).decode("utf-8")
            assert "Chapter 1" in content
            assert "Синопсис" in content
            assert "Информация об авторе" in content
            assert "Bold" in content
            assert "body" in content
            assert "***" in content
            if extension == "docx":
                assert 'w:before="240"' in content
            else:
                assert "<text:h" not in content
                assert 'text:style-name="QuillumHeading1Left"' in content


@pytest.mark.django_db
def test_document_exports_embed_cover_and_illustration(django_user_model, monkeypatch):
    user = django_user_model.objects.create_user(
        username="export-images-writer",
        email="export-images-writer@example.test",
        password="correct-password",
    )
    manuscript = create_export_manuscript(user, kind=Manuscript.KIND_BOOK, title="Illustrated")
    image_output = BytesIO()
    Image.new("RGB", (120, 80), "#345995").save(image_output, format="PNG")
    asset = manuscript_exports.ExportAsset(
        path="images/illustration.png",
        content_type="image/png",
        data=image_output.getvalue(),
    )
    monkeypatch.setattr(manuscript_exports, "_cover_export_asset", lambda _manuscript: asset)
    monkeypatch.setattr(
        manuscript_exports,
        "_illustration_export_asset",
        lambda _manuscript, _asset_id: asset,
    )
    document = create_export_document(
        manuscript,
        title="Chapter 1",
        content={
            "type": "doc",
            "content": [
                {
                    "type": "illustration",
                    "attrs": {
                        "assetId": "00000000-0000-0000-0000-000000000001",
                        "alt": "Map",
                        "caption": "World map",
                        "alignment": "center",
                        "displayWidth": 65,
                    },
                }
            ],
        },
    )

    results = {
        export_format: build_export(
            create_export_job(
                manuscript,
                selected_documents=[document],
                export_format=export_format,
            )
        )
        for export_format in (
            ManuscriptExport.FORMAT_DOCX,
            ManuscriptExport.FORMAT_ODT,
            ManuscriptExport.FORMAT_FB2,
        )
    }

    with zipfile.ZipFile(BytesIO(results[ManuscriptExport.FORMAT_DOCX].data)) as archive:
        assert any(name.startswith("word/media/") for name in archive.namelist())
    with zipfile.ZipFile(BytesIO(results[ManuscriptExport.FORMAT_ODT].data)) as archive:
        assert any(name.startswith("Pictures/") for name in archive.namelist())
    fb2 = etree.fromstring(results[ManuscriptExport.FORMAT_FB2].data)
    namespaces = {"fb": "http://www.gribuser.ru/xml/fictionbook/2.0"}
    assert len(fb2.xpath(".//fb:coverpage/fb:image", namespaces=namespaces)) == 1
    assert len(fb2.xpath("./fb:binary", namespaces=namespaces)) == 2


@pytest.mark.django_db
def test_materialized_export_is_plaintext_and_expires(
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="export-encrypted-writer",
        email="export-encrypted-writer@example.test",
        password="correct-password",
    )
    manuscript = create_export_manuscript(user, kind=Manuscript.KIND_ONESHOT, title="Secret")
    document = create_export_document(
        manuscript,
        title="Secret",
        content=export_doc("Private body"),
    )
    export = create_export_job(manuscript, selected_documents=[document])

    materialize_export(export.id)
    export.refresh_from_db()
    artifact_name = export.artifact.name
    with export.artifact.open("rb") as artifact:
        stored_artifact = artifact.read()

    assert export.status == ManuscriptExport.STATUS_READY
    assert b"Private body" in stored_artifact

    export.expires_at = timezone.now() - timedelta(minutes=1)
    export.save(update_fields=["expires_at", "updated_at"])

    assert cleanup_expired_exports() == 1
    export.refresh_from_db()
    assert export.status == ManuscriptExport.STATUS_EXPIRED
    assert export.artifact.name == ""
    assert not export.artifact.storage.exists(artifact_name)


@pytest.mark.django_db
def test_invalid_book_import_does_not_create_partial_manuscript(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="invalid-import-writer",
        email="invalid-import-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manifest = {
        "version": 1,
        "nodes": [
            {
                "id": "missing",
                "parentId": None,
                "kind": "document",
                "title": "Missing",
                "order": 0,
                "fileKey": "importFile_0",
                "sourcePath": "missing.md",
            }
        ],
    }

    response = client.post(
        "/api/manuscripts/books/",
        {
            "title": "Must not exist",
            "importManifest": json.dumps(manifest),
        },
    )

    assert response.status_code == 400
    assert response.json()["error"] == "import_file_missing"
    assert not Manuscript.objects.filter(workspace__owner=user).exists()


@pytest.mark.django_db
def test_book_import_rejects_more_than_thirty_folders(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="folder-limit-import-writer",
        email="folder-limit-import-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manifest = {
        "version": 1,
        "nodes": [
            {
                "id": f"folder-{index}",
                "parentId": None,
                "kind": "folder",
                "title": f"Folder {index}",
                "order": index,
            }
            for index in range(31)
        ]
        + [
            {
                "id": "document",
                "parentId": None,
                "kind": "document",
                "title": "Document",
                "order": 31,
                "fileKey": "importFile_0",
                "sourcePath": "document.md",
            }
        ],
    }

    response = client.post(
        "/api/manuscripts/books/",
        {
            "title": "Must not exist",
            "importManifest": json.dumps(manifest),
            "importFile_0": text_upload("document.md", "Text"),
        },
    )

    assert response.status_code == 400
    assert response.json()["error"] == "import_folder_count_invalid"
    assert not Manuscript.objects.filter(workspace__owner=user).exists()


@pytest.mark.django_db
def test_new_oneshots_create_independent_workspaces(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    assert client.post("/api/manuscripts/oneshots/", {"title": "First"}).status_code == 201
    assert client.post("/api/manuscripts/oneshots/", {"title": "Second"}).status_code == 201

    workspaces = list(Workspace.objects.filter(owner=user))
    assert len(workspaces) == 2
    assert len({workspace.id for workspace in workspaces}) == 2


@pytest.mark.django_db
def test_renaming_oneshot_also_changes_document_title(django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    workspace = Workspace.objects.create(owner=user)
    manuscript = Manuscript.objects.create(
        workspace=workspace,
        kind=Manuscript.KIND_ONESHOT,
        title="Old title",
        synopsis="",
    )
    document = Document.objects.create(manuscript=manuscript, content=Document.EMPTY_DOCUMENT)

    manuscript.title = "New title"
    manuscript.save(update_fields=["title", "updated_at"])
    document.refresh_from_db()

    assert document.title == "New title"


@pytest.mark.django_db
def test_cover_is_normalized_without_exif_and_thumbnails_are_plaintext(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/manuscripts/oneshots/",
        {"title": "Covered", "cover": cover_upload(with_exif=True)},
    )

    assert response.status_code == 201
    manuscript = Manuscript.objects.select_related("workspace", "cover_media__owner").get()
    assert manuscript.cover_media is not None
    media = manuscript.cover_media
    assert media.original.name.endswith(".jpg")
    assert media.thumbnail_small.name.endswith(".webp")
    assert media.thumbnail_medium.name.endswith(".webp")
    with media.original.open("rb") as stored:
        original = stored.read()
    assert original.startswith(b"\xff\xd8")
    normalized = Image.open(BytesIO(original))
    assert not normalized.getexif()
    assert normalized.size == (1200, 1800)

    thumbnail_response = client.get(f"/api/manuscripts/{manuscript.public_id}/cover/medium/")
    assert thumbnail_response.status_code == 200
    thumbnail = Image.open(BytesIO(b"".join(thumbnail_response.streaming_content)))
    assert thumbnail.format == "WEBP"
    assert max(thumbnail.size) <= 512
    assert thumbnail_response["Cache-Control"] == "private, no-cache"
    assert thumbnail_response["ETag"]

    revalidated = client.get(
        f"/api/manuscripts/{manuscript.public_id}/cover/medium/",
        headers={"If-None-Match": thumbnail_response["ETag"]},
    )
    assert revalidated.status_code == 304

    original_response = client.get(f"/api/manuscripts/{manuscript.public_id}/cover/original/")
    assert original_response.status_code == 200
    assert original_response["Cache-Control"] == "private, no-store"
    assert "ETag" not in original_response


@pytest.mark.django_db
def test_shared_cover_remains_in_storage_after_manuscript_delete(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="preserved-cover-writer",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post(
        "/api/manuscripts/oneshots/",
        {"title": "Temporary", "cover": cover_upload()},
    )
    manuscript_id = created.json()["manuscript"]["id"]
    media = UserMediaAsset.objects.get(owner=user)
    media_path = media.original.path

    deleted = client.delete(f"/api/manuscripts/{manuscript_id}/")
    storage = client.get("/api/auth/storage/?group=all&page=1&pageSize=18")

    assert deleted.status_code == 200
    assert UserMediaAsset.objects.filter(id=media.id).exists()
    assert Path(media_path).exists()
    stored_item = next(
        item for item in storage.json()["items"] if item["id"] == f"media:{media.public_id}"
    )
    assert stored_item["usages"] == []
    assert stored_item["deletable"] is True
    assert stored_item["previewUrl"].endswith("/medium/")
    assert stored_item["displayUrl"].endswith("/editor-large/")
    assert stored_item["downloadUrl"].endswith("/original/")


@pytest.mark.django_db
def test_book_creation_accepts_plaintext_cover(client, django_user_model, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="book-cover-writer",
        email="book-cover-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/manuscripts/books/",
        {
            "title": "Covered book",
            "template": "chapters",
            "cover": cover_upload(),
        },
    )

    assert response.status_code == 201
    manuscript = Manuscript.objects.select_related("workspace", "cover_media").get(
        kind=Manuscript.KIND_BOOK
    )
    assert manuscript.cover_media.original.name.endswith(".jpg")
    assert response.json()["manuscript"]["coverThumbnailMediumUrl"].endswith("/cover/medium/")


@pytest.mark.django_db
def test_series_creation_stores_plaintext_metadata_and_cover(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="series-writer",
        email="series-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    response = client.post(
        "/api/manuscripts/series/",
        {
            "title": "Secret cycle",
            "synopsis": "Private series synopsis",
            "cover": cover_upload(),
        },
    )

    assert response.status_code == 201
    series = Series.objects.select_related("workspace", "cover_media").get()
    stored = Series.objects.values().get()
    assert stored["title"] == "Secret cycle"
    assert stored["synopsis"] == "Private series synopsis"
    assert series.title == "Secret cycle"
    assert series.synopsis == "Private series synopsis"
    assert series.cover_media.original.name.endswith(".jpg")
    assert response.json()["series"]["kind"] == "series"
    cover_response = client.get(f"/api/manuscripts/series/{series.public_id}/cover/medium/")
    assert cover_response.status_code == 200


@pytest.mark.django_db
def test_series_and_its_cover_are_owner_only(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(
        username="series-owner",
        email="series-owner@example.test",
        password="correct-password",
    )
    stranger = django_user_model.objects.create_user(
        username="series-stranger",
        email="series-stranger@example.test",
        password="correct-password",
    )
    client.force_login(owner)
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Private cycle", "cover": cover_upload()},
    ).json()["series"]["id"]

    client.force_login(stranger)

    assert client.get(f"/api/manuscripts/series/{series_id}/").status_code == 404
    assert client.delete(f"/api/manuscripts/series/{series_id}/").status_code == 404
    assert client.get(f"/api/manuscripts/series/{series_id}/cover/medium/").status_code == 404
    assert Series.objects.filter(public_id=series_id).exists()


@pytest.mark.django_db
def test_series_books_are_ordered_and_hidden_from_standalone_books(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="series-books-writer",
        email="series-books-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    series_response = client.post("/api/manuscripts/series/", {"title": "Cycle"})
    series_id = series_response.json()["series"]["id"]

    second = client.post(
        f"/api/manuscripts/series/{series_id}/books/",
        {
            "title": "Second",
            "template": "chapters",
            "seriesPosition": "2",
        },
    )
    first = client.post(
        f"/api/manuscripts/series/{series_id}/books/",
        {
            "title": "First",
            "template": "scenes",
            "seriesPosition": "1",
        },
    )

    assert second.status_code == 201
    assert first.status_code == 201
    detail = client.get(f"/api/manuscripts/series/{series_id}/")
    assert [book["title"] for book in detail.json()["books"]] == ["First", "Second"]
    assert [book["seriesPosition"] for book in detail.json()["books"]] == [1, 2]
    assert client.get("/api/manuscripts/books/").json()["items"] == []
    assert SeriesMembership.objects.count() == 2


@pytest.mark.django_db
def test_series_book_can_be_created_from_text_import(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="series-import-writer",
        email="series-import-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Imported cycle"},
    ).json()["series"]["id"]
    manifest = {
        "version": 1,
        "nodes": [
            {
                "id": "chapter",
                "parentId": None,
                "kind": "document",
                "title": "Imported chapter",
                "order": 0,
                "fileKey": "importFile_0",
                "sourcePath": "chapter.md",
            }
        ],
    }

    response = client.post(
        f"/api/manuscripts/series/{series_id}/books/",
        {
            "title": "Imported volume",
            "synopsis": "",
            "seriesPosition": "2",
            "importManifest": json.dumps(manifest),
            "importFile_0": text_upload("chapter.md", "# Opening"),
        },
    )

    assert response.status_code == 201
    book_id = response.json()["book"]["id"]
    assert SeriesMembership.objects.get(manuscript__public_id=book_id).position == 2
    assert (
        Document.objects.get(manuscript__public_id=book_id).content["content"][0]["type"]
        == "heading"
    )


@pytest.mark.django_db
def test_series_rejects_duplicate_book_positions(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="series-position-writer",
        email="series-position-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Cycle"},
    ).json()["series"]["id"]
    payload = {
        "title": "First",
        "template": "chapters",
        "seriesPosition": "1",
    }
    assert client.post(f"/api/manuscripts/series/{series_id}/books/", payload).status_code == 201

    duplicate = client.post(
        f"/api/manuscripts/series/{series_id}/books/",
        {**payload, "title": "Duplicate"},
    )

    assert duplicate.status_code == 400
    assert duplicate.json()["error"] == "series_position_duplicate"
    assert Manuscript.objects.filter(kind=Manuscript.KIND_BOOK).count() == 1


@pytest.mark.django_db
def test_series_allows_multiple_unnumbered_books_after_numbered_books(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="unnumbered-series-writer",
        email="unnumbered-series-writer@example.test",
        password="correct-password",
        tier=django_user_model.TIER_AUTHOR,
    )
    client.force_login(user)
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Cycle"},
    ).json()["series"]["id"]
    for title, position in (
        ("Collection", None),
        ("Volume two", "2"),
        ("Side stories", None),
        ("Volume one", "1"),
    ):
        payload = {"title": title, "template": "chapters"}
        if position is not None:
            payload["seriesPosition"] = position
        response = client.post(
            f"/api/manuscripts/series/{series_id}/books/",
            payload,
        )
        assert response.status_code == 201

    books = client.get(f"/api/manuscripts/series/{series_id}/").json()["books"]

    assert [book["title"] for book in books[:2]] == ["Volume one", "Volume two"]
    assert {book["title"] for book in books[2:]} == {"Collection", "Side stories"}
    assert all(book["seriesPosition"] is None for book in books[2:])


@pytest.mark.django_db
def test_standalone_book_can_be_added_to_and_removed_from_series(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="book-transfer-writer",
        email="book-transfer-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Cycle"},
    ).json()["series"]["id"]
    book_id = client.post(
        "/api/manuscripts/books/",
        data=json.dumps({"title": "Standalone", "template": "chapters"}),
        content_type="application/json",
    ).json()["manuscript"]["id"]

    added = client.put(
        f"/api/manuscripts/books/{book_id}/series-membership/",
        data=json.dumps({"seriesId": series_id, "seriesPosition": 4}),
        content_type="application/json",
    )

    assert added.status_code == 200
    assert added.json()["book"]["seriesPosition"] == 4
    assert added.json()["series"]["bookCount"] == 1
    assert client.get("/api/manuscripts/books/").json()["items"] == []
    membership = SeriesMembership.objects.select_related("series").get(
        manuscript__public_id=book_id
    )
    assert str(membership.series.public_id) == series_id

    removed = client.delete(
        f"/api/manuscripts/books/{book_id}/series-membership/",
    )

    assert removed.status_code == 200
    assert removed.json()["book"]["id"] == book_id
    assert not SeriesMembership.objects.filter(manuscript__public_id=book_id).exists()
    assert client.get("/api/manuscripts/books/").json()["items"][0]["id"] == book_id


@pytest.mark.django_db
def test_adding_standalone_book_rejects_duplicate_series_position(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="book-transfer-position-writer",
        email="book-transfer-position-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Cycle"},
    ).json()["series"]["id"]
    client.post(
        f"/api/manuscripts/series/{series_id}/books/",
        {"title": "First", "template": "chapters", "seriesPosition": "1"},
    )
    book_id = client.post(
        "/api/manuscripts/books/",
        data=json.dumps({"title": "Standalone", "template": "chapters"}),
        content_type="application/json",
    ).json()["manuscript"]["id"]

    response = client.put(
        f"/api/manuscripts/books/{book_id}/series-membership/",
        data=json.dumps({"seriesId": series_id, "seriesPosition": 1}),
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "series_position_duplicate"
    assert not SeriesMembership.objects.filter(manuscript__public_id=book_id).exists()


@pytest.mark.django_db
def test_series_book_metadata_and_position_can_be_updated(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="series-edit-writer",
        email="series-edit-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Cycle"},
    ).json()["series"]["id"]
    book = client.post(
        f"/api/manuscripts/series/{series_id}/books/",
        {
            "title": "Old title",
            "template": "chapters",
            "seriesPosition": "1",
        },
    ).json()["book"]

    response = client.post(
        f"/api/manuscripts/series/{series_id}/books/{book['id']}/",
        {
            "title": "New title",
            "synopsis": "Updated synopsis",
            "seriesPosition": "3",
        },
    )

    assert response.status_code == 200
    assert response.json()["book"]["title"] == "New title"
    assert response.json()["book"]["synopsis"] == "Updated synopsis"
    assert response.json()["book"]["seriesPosition"] == 3
    assert SeriesMembership.objects.get(manuscript__public_id=book["id"]).position == 3

    unnumbered = client.post(
        f"/api/manuscripts/series/{series_id}/books/{book['id']}/",
        {
            "title": "New title",
            "synopsis": "Updated synopsis",
        },
    )

    assert unnumbered.status_code == 200
    assert unnumbered.json()["book"]["seriesPosition"] is None


@pytest.mark.django_db
def test_deleting_series_preserves_books_as_standalone(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="delete-series-writer",
        email="delete-series-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created_series = client.post("/api/manuscripts/series/", {"title": "Temporary"})
    series_id = created_series.json()["series"]["id"]
    series_workspace_id = Series.objects.get(public_id=series_id).workspace_id
    created_book = client.post(
        f"/api/manuscripts/series/{series_id}/books/",
        {
            "title": "Preserved",
            "template": "chapters",
            "seriesPosition": "1",
        },
    )
    book_id = created_book.json()["book"]["id"]

    response = client.delete(f"/api/manuscripts/series/{series_id}/")

    assert response.status_code == 200
    assert response.json()["books"][0]["id"] == book_id
    assert not Series.objects.filter(public_id=series_id).exists()
    assert not SeriesMembership.objects.filter(manuscript__public_id=book_id).exists()
    assert not Workspace.objects.filter(id=series_workspace_id).exists()
    assert Manuscript.objects.filter(public_id=book_id).exists()
    assert client.get("/api/manuscripts/books/").json()["items"][0]["id"] == book_id


@pytest.mark.django_db
def test_book_tree_aggregates_document_statistics(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="book-statistics-writer",
        email="book-statistics-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post(
        "/api/manuscripts/books/",
        data=json.dumps({"title": "Statistics", "template": "scenes"}),
        content_type="application/json",
    )
    manuscript_id = created.json()["manuscript"]["id"]
    document = Document.objects.get(manuscript__public_id=manuscript_id)
    document.content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "Three counted words"}],
            }
        ],
    }
    document.save(update_fields=["content"])

    response = client.get(f"/api/manuscripts/books/{manuscript_id}/tree/")

    assert response.status_code == 200
    items = response.json()["tree"]["items"]
    folder = next(item for item in items if item["kind"] == "folder")
    scene = next(item for item in items if item["kind"] == "document")
    assert (scene["wordCount"], scene["characterCount"]) == (3, 19)
    assert (folder["wordCount"], folder["characterCount"]) == (3, 19)


@pytest.mark.django_db
def test_book_tree_audits_creation_and_deletion_but_not_restore(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="book-tree-auditor",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post(
        "/api/manuscripts/books/",
        data=json.dumps({"title": "Audit tree", "template": "chapters"}),
        content_type="application/json",
    ).json()["manuscript"]
    AuditEvent.objects.filter(event__startswith="manuscript.book_item_").delete()

    folder = client.post(
        f"/api/manuscripts/books/{created['id']}/tree/",
        data=json.dumps(
            {
                "title": "Chapter folder",
                "kind": "folder",
                "expectedStructureGeneration": created["structureGeneration"],
            }
        ),
        content_type="application/json",
    ).json()
    document = client.post(
        f"/api/manuscripts/books/{created['id']}/tree/",
        data=json.dumps(
            {
                "title": "Scene",
                "kind": "document",
                "parentId": folder["item"]["id"],
                "expectedStructureGeneration": folder["structureGeneration"],
            }
        ),
        content_type="application/json",
    ).json()
    trashed_response = client.patch(
        f"/api/manuscripts/book-items/{document['item']['id']}/",
        data=json.dumps(
            {
                "action": "trash",
                "expectedStructureGeneration": document["structureGeneration"],
            }
        ),
        content_type="application/json",
    )
    trashed = trashed_response.json()
    restored_response = client.patch(
        f"/api/manuscripts/book-items/{document['item']['id']}/",
        data=json.dumps(
            {
                "action": "restore",
                "expectedStructureGeneration": trashed["structureGeneration"],
            }
        ),
        content_type="application/json",
    )
    restored = restored_response.json()
    trashed_again_response = client.patch(
        f"/api/manuscripts/book-items/{document['item']['id']}/",
        data=json.dumps(
            {
                "action": "trash",
                "expectedStructureGeneration": restored["structureGeneration"],
            }
        ),
        content_type="application/json",
    )
    deleted = client.delete(f"/api/manuscripts/book-items/{document['item']['id']}/")

    event_codes = list(
        AuditEvent.objects.filter(event__startswith="manuscript.book_item_")
        .order_by("created_at", "id")
        .values_list("event", flat=True)
    )
    assert trashed_response.status_code == 200
    assert restored_response.status_code == 200
    assert trashed_again_response.status_code == 200
    assert deleted.status_code == 200
    assert event_codes.count("manuscript.book_item_created") == 2
    assert event_codes.count("manuscript.book_item_trashed") == 2
    assert event_codes == [
        "manuscript.book_item_created",
        "manuscript.book_item_created",
        "manuscript.book_item_trashed",
        "manuscript.book_item_trashed",
        "manuscript.book_item_permanently_deleted",
    ]


@pytest.mark.django_db
def test_public_review_share_lifecycle_is_audited_without_token(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="review-share-auditor",
        password="correct-password",
    )
    client.force_login(user)
    manuscript = client.post(
        "/api/manuscripts/oneshots/",
        {"title": "Review share audit"},
    ).json()["manuscript"]
    AuditEvent.objects.all().delete()

    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/review-shares/",
        data=json.dumps({"accessLevel": "view", "scopeType": "oneshot"}),
        content_type="application/json",
    )
    share = created.json()["share"]
    revoked = client.delete(f"/api/manuscripts/review-shares/{share['id']}/")

    events = list(AuditEvent.objects.order_by("created_at", "id"))
    assert created.status_code == 201
    assert revoked.status_code == 200
    assert [event.event for event in events] == [
        "manuscript.review_share_created",
        "manuscript.review_share_revoked",
    ]
    assert all(share["urlToken"] not in str(event.payload) for event in events)


@pytest.mark.django_db
def test_cover_is_not_available_to_another_user(client, django_user_model, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(
        username="owner",
        email="owner@example.test",
        password="correct-password",
    )
    stranger = django_user_model.objects.create_user(
        username="stranger",
        email="stranger@example.test",
        password="correct-password",
    )
    client.force_login(owner)
    response = client.post(
        "/api/manuscripts/oneshots/",
        {"title": "Private", "cover": cover_upload()},
    )
    manuscript_id = response.json()["manuscript"]["id"]

    client.force_login(stranger)
    response = client.get(f"/api/manuscripts/{manuscript_id}/cover/medium/")

    assert response.status_code == 404


@pytest.mark.django_db
def test_owner_can_update_oneshot_metadata_and_cover(
    client,
    django_user_model,
    settings,
    tmp_path,
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="metadata-writer",
        email="metadata-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Old title"})
    manuscript_id = created.json()["manuscript"]["id"]

    updated = client.post(
        f"/api/manuscripts/{manuscript_id}/",
        {
            "title": "New title",
            "synopsis": "New synopsis",
            "cover": cover_upload(),
        },
    )

    assert updated.status_code == 200
    assert updated.json()["manuscript"]["title"] == "New title"
    assert updated.json()["manuscript"]["synopsis"] == "New synopsis"
    assert updated.json()["manuscript"]["coverThumbnailMediumUrl"]
    cover_version = updated.json()["manuscript"]["coverVersion"]
    assert cover_version
    manuscript = Manuscript.objects.select_related("workspace", "cover_media").get(
        public_id=manuscript_id
    )
    assert manuscript.documents.get().item.title == "New title"
    assert manuscript.cover_media

    retitled = client.post(
        f"/api/manuscripts/{manuscript_id}/",
        {"title": "Retitled", "synopsis": "New synopsis"},
    )

    assert retitled.status_code == 200
    assert retitled.json()["manuscript"]["coverVersion"] == cover_version

    removed = client.post(
        f"/api/manuscripts/{manuscript_id}/",
        {"title": "Retitled", "synopsis": "", "removeCover": "true"},
    )

    assert removed.status_code == 200
    manuscript.refresh_from_db()
    assert manuscript.synopsis == ""
    assert manuscript.cover_media is None
    assert removed.json()["manuscript"]["coverThumbnailMediumUrl"] == ""
    assert removed.json()["manuscript"]["coverVersion"] == ""


@pytest.mark.django_db
def test_owner_can_update_book_metadata(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="book-metadata-writer",
        email="book-metadata-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post(
        "/api/manuscripts/books/",
        data=json.dumps({"title": "Old book", "template": "chapters"}),
        content_type="application/json",
    )
    manuscript_id = created.json()["manuscript"]["id"]

    response = client.post(
        f"/api/manuscripts/{manuscript_id}/",
        {"title": "New book", "synopsis": "Changed"},
    )

    assert response.status_code == 200
    assert response.json()["manuscript"]["title"] == "New book"
    assert response.json()["manuscript"]["synopsis"] == "Changed"
    assert ManuscriptItem.objects.get(manuscript__public_id=manuscript_id).title == "Chapter 1"


@pytest.mark.django_db
def test_owner_can_delete_manuscript_and_workspace(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="delete-writer",
        email="delete-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Delete me"})
    manuscript_id = created.json()["manuscript"]["id"]
    workspace_id = Manuscript.objects.get(public_id=manuscript_id).workspace_id

    response = client.delete(f"/api/manuscripts/{manuscript_id}/")

    assert response.status_code == 200
    assert not Manuscript.objects.filter(public_id=manuscript_id).exists()
    assert not Document.objects.filter(manuscript__public_id=manuscript_id).exists()
    assert not Workspace.objects.filter(id=workspace_id).exists()


@pytest.mark.django_db
def test_stranger_cannot_update_or_delete_manuscript(client, django_user_model):
    owner = django_user_model.objects.create_user(
        username="metadata-owner",
        email="metadata-owner@example.test",
        password="correct-password",
    )
    stranger = django_user_model.objects.create_user(
        username="metadata-stranger",
        email="metadata-stranger@example.test",
        password="correct-password",
    )
    client.force_login(owner)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Owner only"})
    manuscript_id = created.json()["manuscript"]["id"]
    client.force_login(stranger)

    update = client.post(
        f"/api/manuscripts/{manuscript_id}/",
        {"title": "Stolen", "synopsis": ""},
    )
    delete = client.delete(f"/api/manuscripts/{manuscript_id}/")

    assert update.status_code == 404
    assert delete.status_code == 404
    assert Manuscript.objects.filter(public_id=manuscript_id).exists()


@pytest.mark.django_db
def test_planner_settings_are_plaintext_and_owner_only(client, django_user_model):
    owner = django_user_model.objects.create_user(
        username="planner-owner",
        email="planner-owner@example.test",
        password="correct-password",
    )
    stranger = django_user_model.objects.create_user(
        username="planner-stranger",
        email="planner-stranger@example.test",
        password="correct-password",
    )
    client.force_login(owner)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Planned"})
    manuscript_id = created.json()["manuscript"]["id"]

    response = client.patch(
        f"/api/manuscripts/{manuscript_id}/planner/",
        data=json.dumps(
            {
                "deadline": "2026-12-31",
                "dailyWordGoal": 1500,
                "manuscriptWordGoal": 90000,
                "timezone": "Europe/Moscow",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["planner"]["settings"] == {
        "deadline": "2026-12-31",
        "dailyWordGoal": 1500,
        "manuscriptWordGoal": 90000,
    }
    manuscript = Manuscript.objects.select_related("workspace").get(public_id=manuscript_id)
    assert manuscript.planner_settings["deadline"] == "2026-12-31"
    assert manuscript.planner_settings["manuscriptWordGoal"] == 90000

    client.force_login(stranger)
    assert client.get(f"/api/manuscripts/{manuscript_id}/planner/").status_code == 404


@pytest.mark.django_db
def test_planner_task_lifecycle_stores_plaintext_and_enforces_owner(client, django_user_model):
    owner = django_user_model.objects.create_user(
        username="task-owner",
        email="task-owner@example.test",
        password="correct-password",
    )
    stranger = django_user_model.objects.create_user(
        username="task-stranger",
        email="task-stranger@example.test",
        password="correct-password",
    )
    client.force_login(owner)
    manuscript_id = client.post("/api/manuscripts/oneshots/", {"title": "Task manuscript"}).json()[
        "manuscript"
    ]["id"]
    planner = client.get(f"/api/manuscripts/{manuscript_id}/planner/?timezone=UTC").json()[
        "planner"
    ]
    item_id = planner["plan"]["items"][0]["id"]

    created = client.post(
        f"/api/manuscripts/{manuscript_id}/planner/tasks/",
        data=json.dumps(
            {
                "title": "Private next step",
                "description": "Private task details",
                "deadline": "2026-12-31",
                "priority": "high",
                "associatedItemId": item_id,
                "pinned": True,
            }
        ),
        content_type="application/json",
    )

    assert created.status_code == 201
    task_payload = created.json()["task"]
    assert task_payload["associatedItemId"] == item_id
    assert task_payload["completed"] is False
    stored = ManuscriptTask.objects.select_related("manuscript__workspace").get()
    assert stored.content["title"] == "Private next step"
    assert stored.content["description"] == "Private task details"
    assert stored.content["deadline"] == "2026-12-31"

    completed = client.patch(
        f"/api/manuscripts/planner-tasks/{task_payload['id']}/",
        data=json.dumps({"completed": True}),
        content_type="application/json",
    )
    assert completed.status_code == 200
    assert completed.json()["task"]["completed"] is True
    aggregate = client.get(f"/api/manuscripts/{manuscript_id}/planner/?timezone=UTC")
    assert aggregate.json()["planner"]["tasks"][0]["title"] == "Private next step"

    client.force_login(stranger)
    assert (
        client.patch(
            f"/api/manuscripts/planner-tasks/{task_payload['id']}/",
            data=json.dumps({"completed": False}),
            content_type="application/json",
        ).status_code
        == 404
    )

    client.force_login(owner)
    deleted = client.delete(f"/api/manuscripts/planner-tasks/{task_payload['id']}/")
    assert deleted.status_code == 200
    assert not ManuscriptTask.objects.exists()


@pytest.mark.django_db
def test_document_saves_track_positive_daily_words_and_current_total(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="daily-progress-writer",
        email="daily-progress-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Progress"})
    manuscript_id = created.json()["manuscript"]["id"]
    endpoint = f"/api/manuscripts/oneshots/{manuscript_id}/document/"

    first_save = client.put(
        endpoint,
        data=json.dumps(
            {
                "content": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "one two three"}],
                        }
                    ],
                },
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )
    assert first_save.status_code == 200

    second_save = client.put(
        endpoint,
        data=json.dumps(
            {
                "content": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "one two"}],
                        }
                    ],
                },
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": first_save.json()["document"]["saveGeneration"],
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )
    assert second_save.status_code == 200

    planner = client.get(f"/api/manuscripts/{manuscript_id}/planner/?timezone=UTC")

    assert planner.status_code == 200
    assert planner.json()["planner"]["statistics"]["wordsToday"] == 3
    assert planner.json()["planner"]["statistics"]["totalWords"] == 2
    assert ManuscriptWritingDay.objects.get(manuscript__public_id=manuscript_id).words_written == 3


@pytest.mark.django_db
def test_planner_total_excludes_trashed_book_documents(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="planner-book-writer",
        email="planner-book-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post(
        "/api/manuscripts/books/",
        data=json.dumps({"title": "Planner book", "template": "chapters"}),
        content_type="application/json",
    )
    manuscript_id = created.json()["manuscript"]["id"]
    document = Document.objects.select_related("manuscript__workspace").get(
        manuscript__public_id=manuscript_id
    )
    document.content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "hidden words"}],
            }
        ],
    }
    document.save(update_fields=["content"])
    ManuscriptItem.objects.filter(id=document.item_id).update(trashed_at=timezone.now())

    response = client.get(f"/api/manuscripts/{manuscript_id}/planner/?timezone=UTC")

    assert response.status_code == 200
    assert response.json()["planner"]["statistics"]["totalWords"] == 0


@pytest.mark.django_db
def test_planner_creates_semantic_book_structure(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="planner-structure-writer",
        email="planner-structure-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post(
        "/api/manuscripts/books/",
        data=json.dumps({"title": "Structured", "template": "chapters"}),
        content_type="application/json",
    )
    manuscript_id = created.json()["manuscript"]["id"]
    loaded = client.get(f"/api/manuscripts/{manuscript_id}/planner/?timezone=UTC").json()["planner"]

    chapter = client.post(
        f"/api/manuscripts/{manuscript_id}/planner/items/",
        data=json.dumps(
            {
                "title": "Chapter with scenes",
                "role": "chapter",
                "chapterMode": "scenes",
                "parentId": None,
                "expectedStructureGeneration": loaded["plan"]["structureGeneration"],
                "expectedPlannerGeneration": loaded["plan"]["plannerGeneration"],
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )

    assert chapter.status_code == 201
    chapter_planner = chapter.json()["planner"]
    chapter_item = next(
        item for item in chapter_planner["plan"]["items"] if item["title"] == "Chapter with scenes"
    )
    assert chapter_item["kind"] == "folder"
    assert chapter_item["role"] == "chapter"

    scene = client.post(
        f"/api/manuscripts/{manuscript_id}/planner/items/",
        data=json.dumps(
            {
                "title": "Opening scene",
                "role": "scene",
                "chapterMode": None,
                "parentId": chapter_item["id"],
                "expectedStructureGeneration": chapter_planner["plan"]["structureGeneration"],
                "expectedPlannerGeneration": chapter_planner["plan"]["plannerGeneration"],
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )

    assert scene.status_code == 201
    scene_item = next(
        item
        for item in scene.json()["planner"]["plan"]["items"]
        if item["title"] == "Opening scene"
    )
    assert scene_item["kind"] == "document"
    assert scene_item["role"] == "scene"
    assert scene_item["parentId"] == chapter_item["id"]

    scene_planner = scene.json()["planner"]
    act = client.post(
        f"/api/manuscripts/{manuscript_id}/planner/items/",
        data=json.dumps(
            {
                "title": "Act One",
                "role": "act",
                "chapterMode": None,
                "parentId": None,
                "expectedStructureGeneration": scene_planner["plan"]["structureGeneration"],
                "expectedPlannerGeneration": scene_planner["plan"]["plannerGeneration"],
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )
    assert act.status_code == 201
    act_planner = act.json()["planner"]
    act_item = next(item for item in act_planner["plan"]["items"] if item["role"] == "act")

    moved = client.patch(
        f"/api/manuscripts/book-items/{chapter_item['id']}/",
        data=json.dumps(
            {
                "action": "move",
                "parentId": act_item["id"],
                "beforeId": None,
                "expectedStructureGeneration": act_planner["plan"]["structureGeneration"],
            }
        ),
        content_type="application/json",
    )

    assert moved.status_code == 200
    moved_plan = client.get(f"/api/manuscripts/{manuscript_id}/planner/?timezone=UTC").json()[
        "planner"
    ]["plan"]
    moved_chapter = next(item for item in moved_plan["items"] if item["id"] == chapter_item["id"])
    moved_scene = next(item for item in moved_plan["items"] if item["id"] == scene_item["id"])
    assert moved_chapter["parentId"] == act_item["id"]
    assert moved_scene["parentId"] == moved_chapter["id"]


@pytest.mark.django_db
def test_planner_item_settings_are_plaintext_and_track_completion(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="planner-item-writer",
        email="planner-item-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Old One-Shot"})
    manuscript_id = created.json()["manuscript"]["id"]
    planner = client.get(f"/api/manuscripts/{manuscript_id}/planner/?timezone=UTC").json()[
        "planner"
    ]
    item = planner["plan"]["items"][0]
    complete = next(status for status in planner["plan"]["statuses"] if status["countsAsComplete"])

    response = client.patch(
        f"/api/manuscripts/planner-items/{item['id']}/",
        data=json.dumps(
            {
                "title": "New One-Shot",
                "synopsis": "Private item synopsis",
                "deadline": "2026-12-31",
                "wordGoal": 12000,
                "statusId": complete["id"],
                "role": "chapter",
                "expectedStructureGeneration": planner["plan"]["structureGeneration"],
                "expectedPlannerGeneration": planner["plan"]["plannerGeneration"],
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    updated = response.json()["planner"]
    updated_item = updated["plan"]["items"][0]
    assert updated["manuscriptTitle"] == "New One-Shot"
    assert updated_item["completedDate"] == updated["statistics"]["today"]
    assert updated_item["wordGoal"] == 12000
    stored_item = ManuscriptItem.objects.select_related("manuscript__workspace").get(
        public_id=item["id"]
    )
    assert stored_item.planner_metadata["synopsis"] == "Private item synopsis"
    assert Manuscript.objects.select_related("workspace").get(public_id=manuscript_id).title == (
        "New One-Shot"
    )


@pytest.mark.django_db
def test_planner_status_catalog_can_be_reordered_and_cleared(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="planner-status-writer",
        email="planner-status-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Statuses"})
    manuscript_id = created.json()["manuscript"]["id"]
    planner = client.get(f"/api/manuscripts/{manuscript_id}/planner/?timezone=UTC").json()[
        "planner"
    ]
    reversed_statuses = [
        {
            "id": status["id"],
            "name": status["name"],
            "color": status["color"],
            "countsAsComplete": status["countsAsComplete"],
        }
        for status in reversed(planner["plan"]["statuses"])
    ]
    reversed_statuses[0]["color"] = "#1a2b3c"

    reordered = client.patch(
        f"/api/manuscripts/{manuscript_id}/planner/statuses/",
        data=json.dumps(
            {
                "statuses": reversed_statuses,
                "expectedPlannerGeneration": planner["plan"]["plannerGeneration"],
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )

    assert reordered.status_code == 200
    reordered_planner = reordered.json()["planner"]
    assert [status["name"] for status in reordered_planner["plan"]["statuses"]] == [
        status["name"] for status in reversed_statuses
    ]
    assert reordered_planner["plan"]["statuses"][0]["color"] == "#1a2b3c"

    cleared = client.patch(
        f"/api/manuscripts/{manuscript_id}/planner/statuses/",
        data=json.dumps(
            {
                "statuses": [],
                "expectedPlannerGeneration": reordered_planner["plan"]["plannerGeneration"],
                "timezone": "UTC",
            }
        ),
        content_type="application/json",
    )

    assert cleared.status_code == 200
    assert cleared.json()["planner"]["plan"]["statuses"] == []
    assert not ManuscriptPlanStatus.objects.filter(manuscript__public_id=manuscript_id).exists()


@pytest.mark.django_db
def test_oneshot_detail_is_available_only_to_owner(client, django_user_model):
    owner = django_user_model.objects.create_user(
        username="owner-detail",
        email="owner-detail@example.test",
        password="correct-password",
    )
    stranger = django_user_model.objects.create_user(
        username="stranger-detail",
        email="stranger-detail@example.test",
        password="correct-password",
    )
    client.force_login(owner)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Owner only"})
    manuscript_id = created.json()["manuscript"]["id"]

    response = client.get(f"/api/manuscripts/oneshots/{manuscript_id}/")
    assert response.status_code == 200
    assert response.json()["manuscript"]["title"] == "Owner only"

    client.force_login(stranger)
    response = client.get(f"/api/manuscripts/oneshots/{manuscript_id}/")
    assert response.status_code == 404


@pytest.mark.django_db
def test_document_save_updates_one_plaintext_row(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="document-writer",
        email="document-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Editable"})
    manuscript_id = created.json()["manuscript"]["id"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Encrypted prose", "marks": [{"type": "bold"}]}
                ],
            }
        ],
    }

    response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["document"]["saveGeneration"] == 1
    assert Document.objects.count() == 1
    document = Document.objects.get()
    stored = Document.objects.values().get()
    assert document.content == content
    assert document.save_generation == 1
    assert stored["content"] == content


@pytest.mark.django_db
def test_stale_save_generation_does_not_overwrite_document(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="conflict-writer",
        email="conflict-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Conflict"})
    manuscript_id = created.json()["manuscript"]["id"]
    first_content = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "First"}]}],
    }
    stale_content = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Stale"}]}],
    }
    first_response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": first_content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    stale_response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": stale_content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    assert first_response.status_code == 200
    assert stale_response.status_code == 409
    assert stale_response.json()["error"] == "document_save_conflict"
    document = Document.objects.get()
    assert document.content == first_content
    assert document.save_generation == 1


@pytest.mark.django_db
def test_manuscript_status_moves_to_in_progress_after_first_document_edit(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="status-writer",
        email="status-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Status"})
    manuscript_id = created.json()["manuscript"]["id"]

    assert created.json()["manuscript"]["status"] == "new"

    content = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Started"}]}],
    }
    response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    detail = client.get(f"/api/manuscripts/{manuscript_id}/")

    assert response.status_code == 200
    assert detail.json()["manuscript"]["status"] == "in_progress"
    assert Manuscript.objects.get(public_id=manuscript_id).first_edited_at is not None


@pytest.mark.django_db
def test_manuscript_status_complete_when_all_documents_use_completion_status(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="complete-status-writer",
        email="complete-status-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Complete Status"})
    manuscript_id = created.json()["manuscript"]["id"]
    manuscript = Manuscript.objects.select_related("workspace").get(public_id=manuscript_id)
    status = ManuscriptPlanStatus(
        manuscript=manuscript,
        color="green",
        position=1024,
        counts_as_complete=True,
    )
    status.name = "Complete"
    status.save()
    item = ManuscriptItem.objects.select_related("manuscript__workspace").get(
        manuscript=manuscript,
        kind=ManuscriptItem.KIND_DOCUMENT,
    )
    metadata = item.planner_metadata
    metadata["statusId"] = str(status.public_id)
    item.planner_metadata = metadata
    item.save(update_fields=["planner_metadata"])

    detail = client.get(f"/api/manuscripts/{manuscript_id}/")

    assert detail.json()["manuscript"]["status"] == "complete"
    assert Manuscript.objects.get(public_id=manuscript_id).first_edited_at is None


@pytest.mark.django_db
def test_document_accepts_h1_to_h3_and_rejects_h4(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="heading-writer",
        email="heading-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Headings"})
    manuscript_id = created.json()["manuscript"]["id"]
    valid_content = {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": level},
                "content": [{"type": "text", "text": f"Heading {level}"}],
            }
            for level in (1, 2, 3)
        ],
    }
    valid_response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": valid_content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    invalid_content = {
        "type": "doc",
        "content": [{"type": "heading", "attrs": {"level": 4}}],
    }
    invalid_response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": invalid_content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 1,
            }
        ),
        content_type="application/json",
    )

    assert valid_response.status_code == 200
    assert invalid_response.status_code == 400
    assert invalid_response.json()["error"] == "document_heading_unsupported"


@pytest.mark.django_db
def test_rename_oneshot_updates_plaintext_titles_without_duplicate_document(
    client, django_user_model
):
    user = django_user_model.objects.create_user(
        username="rename-writer",
        email="rename-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Old title"})
    manuscript_id = created.json()["manuscript"]["id"]

    response = client.patch(
        f"/api/manuscripts/oneshots/{manuscript_id}/",
        data=json.dumps({"title": "New title"}),
        content_type="application/json",
    )

    assert response.status_code == 200
    manuscript = (
        Manuscript.objects.select_related("workspace")
        .prefetch_related("documents__item__manuscript__workspace")
        .get(public_id=manuscript_id)
    )
    stored = Manuscript.objects.values("title").get(public_id=manuscript_id)
    stored_item = ManuscriptItem.objects.values("title").get(manuscript__public_id=manuscript_id)
    assert manuscript.title == "New title"
    assert manuscript.document.title == "New title"
    assert stored["title"] == "New title"
    assert stored_item["title"] == "New title"
    assert Document.objects.count() == 1


@pytest.mark.django_db
def test_document_accepts_alignment_and_scene_break(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="layout-writer",
        email="layout-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "Layout"})
    manuscript_id = created.json()["manuscript"]["id"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "attrs": {"textAlign": "right"},
                "content": [{"type": "text", "text": "Before"}],
            },
            {"type": "sceneBreak"},
            {
                "type": "heading",
                "attrs": {"level": 2, "textAlign": "center"},
                "content": [{"type": "text", "text": "After"}],
            },
        ],
    }

    response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    assert Document.objects.get().content == content


@pytest.mark.django_db
def test_document_rejects_unsupported_alignment(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="justify-writer",
        email="justify-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    created = client.post("/api/manuscripts/oneshots/", {"title": "No justify"})
    manuscript_id = created.json()["manuscript"]["id"]
    content = {
        "type": "doc",
        "content": [{"type": "paragraph", "attrs": {"textAlign": "justify"}}],
    }

    response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "document_alignment_unsupported"


@pytest.mark.django_db
def test_editor_preferences_are_created_only_after_change(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="preference-writer",
        email="preference-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    default_response = client.get("/api/manuscripts/editor-preferences/")
    assert default_response.status_code == 200
    assert default_response.json()["preferences"] == {
        "fontSize": 16,
        "smartQuotes": False,
        "quoteStyle": "guillemets",
        "autoCapitalize": False,
        "autoReplace": False,
        "spellcheckEnabled": False,
        "spellcheckDictionary": "ru",
    }
    assert EditorPreference.objects.count() == 0

    update_response = client.patch(
        "/api/manuscripts/editor-preferences/",
        data=json.dumps(
            {
                "fontSize": 20,
                "smartQuotes": True,
                "quoteStyle": "curly",
                "autoCapitalize": True,
                "autoReplace": True,
                "spellcheckEnabled": True,
                "spellcheckDictionary": "en-GB",
            }
        ),
        content_type="application/json",
    )

    assert update_response.status_code == 200
    preferences = EditorPreference.objects.get(user=user)
    assert preferences.font_size == 20
    assert preferences.smart_quotes is True
    assert preferences.quote_style == "curly"
    assert preferences.auto_capitalize is True
    assert preferences.auto_replace is True
    assert preferences.spellcheck_enabled is True
    assert preferences.spellcheck_dictionary == "en-GB"


@pytest.mark.django_db
def test_editor_preferences_reject_unsupported_values(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="invalid-preference-writer",
        email="invalid-preference-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    font_response = client.patch(
        "/api/manuscripts/editor-preferences/",
        data=json.dumps({"fontSize": 100}),
        content_type="application/json",
    )
    quote_response = client.patch(
        "/api/manuscripts/editor-preferences/",
        data=json.dumps({"quoteStyle": "unsupported"}),
        content_type="application/json",
    )
    spellcheck_response = client.patch(
        "/api/manuscripts/editor-preferences/",
        data=json.dumps({"spellcheckEnabled": "yes"}),
        content_type="application/json",
    )
    dictionary_response = client.patch(
        "/api/manuscripts/editor-preferences/",
        data=json.dumps({"spellcheckDictionary": "unsupported"}),
        content_type="application/json",
    )

    assert font_response.status_code == 400
    assert quote_response.status_code == 400
    assert spellcheck_response.status_code == 400
    assert dictionary_response.status_code == 400
    assert dictionary_response.json()["error"] == "editor_spellcheck_dictionary_invalid"
    assert EditorPreference.objects.count() == 0


@pytest.mark.django_db
def test_illustration_is_normalized_plaintext_and_served_only_to_owner(
    client, django_user_model, settings, tmp_path
):
    settings.MEDIA_ROOT = tmp_path
    owner = django_user_model.objects.create_user(
        username="asset-owner", email="asset-owner@example.test", password="correct-password"
    )
    stranger = django_user_model.objects.create_user(
        username="asset-stranger", email="asset-stranger@example.test", password="correct-password"
    )
    client.force_login(owner)
    manuscript_id = client.post("/api/manuscripts/oneshots/", {"title": "Illustrated"}).json()[
        "manuscript"
    ]["id"]

    response = client.post(
        f"/api/manuscripts/oneshots/{manuscript_id}/assets/",
        {"image": cover_upload(with_exif=True), "alt": "Secret alt", "caption": "Secret caption"},
    )

    assert response.status_code == 201
    asset = ManuscriptAsset.objects.select_related("manuscript__workspace", "media__owner").get()
    stored = ManuscriptAsset.objects.values().get()
    assert stored["alt_text"] == "Secret alt"
    assert stored["caption"] == "Secret caption"
    assert asset.alt_text == "Secret alt"
    assert asset.caption == "Secret caption"
    assert asset.media is not None
    with asset.media.original.open("rb") as stored_file:
        original = stored_file.read()
    assert original.startswith(b"\xff\xd8")
    assert not Image.open(BytesIO(original)).getexif()
    image_response = client.get(response.json()["asset"]["largeUrl"])
    assert image_response.status_code == 200
    assert Image.open(BytesIO(b"".join(image_response.streaming_content))).format == "WEBP"

    client.force_login(stranger)
    assert client.get(response.json()["asset"]["largeUrl"]).status_code == 404


@pytest.mark.django_db
def test_document_accepts_only_illustrations_owned_by_same_manuscript(
    client, django_user_model, settings, tmp_path
):
    settings.MEDIA_ROOT = tmp_path
    user = django_user_model.objects.create_user(
        username="asset-document-writer",
        email="asset-document-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    first_id = client.post("/api/manuscripts/oneshots/", {"title": "First"}).json()["manuscript"][
        "id"
    ]
    second_id = client.post("/api/manuscripts/oneshots/", {"title": "Second"}).json()["manuscript"][
        "id"
    ]
    asset_id = client.post(
        f"/api/manuscripts/oneshots/{first_id}/assets/", {"image": cover_upload()}
    ).json()["asset"]["id"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "illustration",
                "attrs": {
                    "assetId": asset_id,
                    "alt": "Alt",
                    "caption": "Caption",
                    "alignment": "center",
                    "displayWidth": 65,
                },
            }
        ],
    }

    accepted = client.put(
        f"/api/manuscripts/oneshots/{first_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    rejected = client.put(
        f"/api/manuscripts/oneshots/{second_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    invalid_width_content = json.loads(json.dumps(content))
    invalid_width_content["content"][0]["attrs"]["displayWidth"] = 101
    invalid_width = client.put(
        f"/api/manuscripts/oneshots/{first_id}/document/",
        data=json.dumps(
            {
                "content": invalid_width_content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": accepted.json()["document"]["saveGeneration"],
            }
        ),
        content_type="application/json",
    )

    assert accepted.status_code == 200
    assert rejected.status_code == 400
    assert rejected.json()["error"] == "document_asset_not_found"
    assert invalid_width.status_code == 400
    assert invalid_width.json()["error"] == "document_illustration_width_invalid"


@pytest.mark.django_db
def test_annotation_and_reply_are_plaintext(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="commenter",
        email="commenter@example.test",
        password="correct-password",
        display_name="Commenter Name",
    )
    client.force_login(user)
    manuscript_id = client.post("/api/manuscripts/oneshots/", {"title": "Commented"}).json()[
        "manuscript"
    ]["id"]

    created = client.post(
        f"/api/manuscripts/oneshots/{manuscript_id}/annotations/",
        data=json.dumps({"quote": "Private quote", "comment": "Private comment"}),
        content_type="application/json",
    )
    annotation_id = created.json()["annotation"]["id"]
    reply_response = client.post(
        f"/api/manuscripts/annotations/{annotation_id}/replies/",
        data=json.dumps({"body": "Private reply"}),
        content_type="application/json",
    )

    assert created.status_code == 201
    assert reply_response.status_code == 201
    annotation = DocumentAnnotation.objects.select_related("document__manuscript__workspace").get()
    reply = AnnotationReply.objects.select_related(
        "annotation__document__manuscript__workspace"
    ).get()
    stored_annotation = DocumentAnnotation.objects.values().get()
    stored_reply = AnnotationReply.objects.values().get()
    assert annotation.quote == "Private quote"
    assert annotation.comment == "Private comment"
    assert reply.body == "Private reply"
    assert stored_annotation["quote"] == "Private quote"
    assert stored_annotation["comment"] == "Private comment"
    assert stored_reply["body"] == "Private reply"
    assert created.json()["annotation"]["author"]["displayName"] == "Commenter Name"


@pytest.mark.django_db
def test_document_annotation_mark_must_belong_to_same_document(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="anchor-writer",
        email="anchor-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    first_id = client.post("/api/manuscripts/oneshots/", {"title": "First annotations"}).json()[
        "manuscript"
    ]["id"]
    second_id = client.post("/api/manuscripts/oneshots/", {"title": "Second annotations"}).json()[
        "manuscript"
    ]["id"]
    annotation_id = client.post(
        f"/api/manuscripts/oneshots/{first_id}/annotations/",
        data=json.dumps({"quote": "Quote", "comment": "Comment"}),
        content_type="application/json",
    ).json()["annotation"]["id"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Annotated text",
                        "marks": [
                            {
                                "type": "annotationAnchor",
                                "attrs": {"annotationId": annotation_id},
                            }
                        ],
                    }
                ],
            }
        ],
    }

    accepted = client.put(
        f"/api/manuscripts/oneshots/{first_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    rejected = client.put(
        f"/api/manuscripts/oneshots/{second_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    assert accepted.status_code == 200
    assert rejected.status_code == 400
    assert rejected.json()["error"] == "document_annotation_not_found"


@pytest.mark.django_db
def test_deleting_annotation_removes_anchor_from_document(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="delete-comment-writer",
        email="delete-comment-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manuscript_id = client.post("/api/manuscripts/oneshots/", {"title": "Delete comment"}).json()[
        "manuscript"
    ]["id"]
    annotation_id = client.post(
        f"/api/manuscripts/oneshots/{manuscript_id}/annotations/",
        data=json.dumps({"quote": "Quote", "comment": "Comment"}),
        content_type="application/json",
    ).json()["annotation"]["id"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Keep the prose",
                        "marks": [
                            {
                                "type": "annotationAnchor",
                                "attrs": {"annotationId": annotation_id},
                            }
                        ],
                    }
                ],
            }
        ],
    }
    saved = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    deleted = client.delete(
        f"/api/manuscripts/annotations/{annotation_id}/",
        data=json.dumps({"expectedGeneration": saved.json()["document"]["saveGeneration"]}),
        content_type="application/json",
    )

    assert deleted.status_code == 200
    assert DocumentAnnotation.objects.count() == 0
    document = Document.objects.get()
    assert document.content["content"][0]["content"][0] == {
        "type": "text",
        "text": "Keep the prose",
    }
    assert document.save_generation == 2


@pytest.mark.django_db
def test_annotation_edit_resolve_and_reply_lifecycle(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="comment-lifecycle",
        email="comment-lifecycle@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manuscript_id = client.post(
        "/api/manuscripts/oneshots/", {"title": "Comment lifecycle"}
    ).json()["manuscript"]["id"]
    annotation = client.post(
        f"/api/manuscripts/oneshots/{manuscript_id}/annotations/",
        data=json.dumps({"quote": "Quote", "comment": "Original"}),
        content_type="application/json",
    ).json()["annotation"]

    edited = client.patch(
        f"/api/manuscripts/annotations/{annotation['id']}/",
        data=json.dumps({"comment": "Edited", "expectedVersion": annotation["version"]}),
        content_type="application/json",
    )
    resolved = client.patch(
        f"/api/manuscripts/annotations/{annotation['id']}/",
        data=json.dumps(
            {
                "status": "resolved",
                "expectedVersion": edited.json()["annotation"]["version"],
            }
        ),
        content_type="application/json",
    )
    reply = client.post(
        f"/api/manuscripts/annotations/{annotation['id']}/replies/",
        data=json.dumps({"body": "First reply"}),
        content_type="application/json",
    ).json()["reply"]
    reply_edited = client.patch(
        f"/api/manuscripts/annotation-replies/{reply['id']}/",
        data=json.dumps({"body": "Edited reply", "expectedVersion": reply["version"]}),
        content_type="application/json",
    )
    reply_deleted = client.delete(f"/api/manuscripts/annotation-replies/{reply['id']}/")

    assert edited.status_code == 200
    assert edited.json()["annotation"]["comment"] == "Edited"
    assert resolved.status_code == 200
    assert resolved.json()["annotation"]["status"] == "resolved"
    assert resolved.json()["annotation"]["resolvedBy"]["id"] == user.id
    assert reply_edited.status_code == 200
    assert reply_edited.json()["reply"]["body"] == "Edited reply"
    assert reply_deleted.status_code == 200
    assert AnnotationReply.objects.count() == 0
    assert set(
        AuditEvent.objects.filter(event__startswith="manuscript.annotation").values_list(
            "event", flat=True
        )
    ) == {
        "manuscript.annotation_created",
        "manuscript.annotation_updated",
        "manuscript.annotation_reply_created",
        "manuscript.annotation_reply_updated",
        "manuscript.annotation_reply_deleted",
    }
    assert all(
        "Edited" not in str(event.payload) and "First reply" not in str(event.payload)
        for event in AuditEvent.objects.filter(event__startswith="manuscript.annotation")
    )


@pytest.mark.django_db
def test_document_change_schedules_draft_after_three_minutes(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="draft-writer",
        email="draft-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manuscript_id = client.post("/api/manuscripts/oneshots/", {"title": "Draft timing"}).json()[
        "manuscript"
    ]["id"]
    before = timezone.now()
    content = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Saved prose"}]}],
    }

    response = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    document = Document.objects.get(manuscript__public_id=manuscript_id)
    assert document.history_generation == 1
    assert before + timedelta(seconds=180) <= document.draft_due_at
    assert document.draft_due_at <= timezone.now() + timedelta(seconds=180)


@pytest.mark.django_db
def test_due_drafts_are_gzipped_plaintext_and_rotate_at_tier_limit(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="draft-rotation",
        email="draft-rotation@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manuscript_id = client.post("/api/manuscripts/oneshots/", {"title": "Draft rotation"}).json()[
        "manuscript"
    ]["id"]
    document = Document.objects.select_related("manuscript__workspace").get(
        manuscript__public_id=manuscript_id
    )

    for index in range(11):
        document.content = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": f"Secret draft {index}"}],
                }
            ],
        }
        document.history_generation += 1
        document.draft_due_at = timezone.now() - timedelta(seconds=1)
        document.save(update_fields=["content", "history_generation", "draft_due_at"])
        materialize_due_draft(document.id)
        document.refresh_from_db()

    versions = DocumentVersion.objects.filter(document=document, kind=DocumentVersion.KIND_DRAFT)
    assert versions.count() == 10
    oldest_content = versions.order_by("created_at").first().snapshot["content"]
    assert oldest_content["content"][0]["content"][0]["text"] == "Secret draft 1"
    stored = DocumentVersion.objects.values("snapshot_data").latest("created_at")
    assert b"Secret draft 10" not in stored["snapshot_data"]


@pytest.mark.django_db
def test_revision_limit_and_plaintext_metadata(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="revision-limit",
        email="revision-limit@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manuscript_id = client.post("/api/manuscripts/oneshots/", {"title": "Revision limit"}).json()[
        "manuscript"
    ]["id"]

    responses = [
        client.post(
            f"/api/manuscripts/oneshots/{manuscript_id}/versions/",
            data=json.dumps(
                {
                    "name": f"Private revision {index}",
                    "description": f"Private description {index}",
                    "expectedGeneration": 0,
                }
            ),
            content_type="application/json",
        )
        for index in range(4)
    ]

    assert [response.status_code for response in responses[:3]] == [201] * 3
    assert responses[3].status_code == 409
    assert responses[3].json()["error"] == "revision_limit_reached"
    assert DocumentVersion.objects.filter(kind=DocumentVersion.KIND_REVISION).count() == 3
    stored = DocumentVersion.objects.values("name", "description").first()
    assert stored["name"].startswith("Private revision")
    assert stored["description"].startswith("Private description")


@pytest.mark.django_db
def test_restore_replaces_content_and_annotations_without_scheduling_draft(
    client, django_user_model
):
    user = django_user_model.objects.create_user(
        username="restore-writer",
        email="restore-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)
    manuscript_id = client.post(
        "/api/manuscripts/oneshots/", {"title": "Restore aggregate"}
    ).json()["manuscript"]["id"]
    annotation = client.post(
        f"/api/manuscripts/oneshots/{manuscript_id}/annotations/",
        data=json.dumps({"quote": "Original", "comment": "Keep this comment"}),
        content_type="application/json",
    ).json()["annotation"]
    original = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Original",
                        "marks": [
                            {
                                "type": "annotationAnchor",
                                "attrs": {"annotationId": annotation["id"]},
                            }
                        ],
                    }
                ],
            }
        ],
    }
    saved = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": original,
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    ).json()["document"]
    revision = client.post(
        f"/api/manuscripts/oneshots/{manuscript_id}/versions/",
        data=json.dumps(
            {
                "name": "Original state",
                "description": "",
                "expectedGeneration": saved["saveGeneration"],
            }
        ),
        content_type="application/json",
    ).json()["version"]
    changed = client.put(
        f"/api/manuscripts/oneshots/{manuscript_id}/document/",
        data=json.dumps(
            {
                "content": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "Changed"}],
                        }
                    ],
                },
                "schemaVersion": Document.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": saved["saveGeneration"],
            }
        ),
        content_type="application/json",
    ).json()["document"]

    restored = client.post(
        f"/api/manuscripts/versions/{revision['id']}/restore/",
        data=json.dumps({"expectedGeneration": changed["saveGeneration"]}),
        content_type="application/json",
    )

    assert restored.status_code == 200
    document = Document.objects.get(manuscript__public_id=manuscript_id)
    assert document.content == original
    assert document.draft_due_at is None
    assert document.last_drafted_history_generation == document.history_generation
    assert restored.json()["annotations"][0]["comment"] == "Keep this comment"
    assert DocumentVersion.objects.filter(kind=DocumentVersion.KIND_DRAFT).count() == 0
