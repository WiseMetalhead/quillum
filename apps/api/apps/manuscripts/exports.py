from __future__ import annotations

import base64
import html
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import timedelta
from io import BytesIO
from pathlib import PurePosixPath
from uuid import UUID

from django.core.files.base import ContentFile
from django.db import transaction
from django.http import FileResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods
from docx import Document as DocxDocument
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt
from ebooklib import epub
from lxml import etree
from odfdo import Document as OdfDocument
from odfdo import Frame, PageBreak, Paragraph, Span
from PIL import Image

from apps.accounts.media import media_variant_bytes
from apps.audit.service import write_audit_event

from .download_names import content_disposition, safe_download_name
from .metadata import (
    MANUSCRIPT_GENRE_TO_FB2,
    InvalidManuscriptMetadata,
    normalize_manuscript_language,
)
from .models import Document, Manuscript, ManuscriptAsset, ManuscriptExport, ManuscriptItem
from .views import manuscript_payload

EXPORT_TTL_MINUTES = 30
EXPORT_FORMATS = {"markdown", "epub2", "epub3", "docx", "odt", "fb2"}
TEXT_CONTENT_TYPE = "text/markdown; charset=utf-8"
ZIP_CONTENT_TYPE = "application/zip"
EPUB_CONTENT_TYPE = "application/epub+zip"
DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
ODT_CONTENT_TYPE = "application/vnd.oasis.opendocument.text"
FB2_CONTENT_TYPE = "application/x-fictionbook+xml"


class ExportError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ExportOptions:
    format_key: str
    include_title_page: bool
    include_author_info_page: bool
    include_illustrations: bool
    language_override: str = ""

    @property
    def export_format(self) -> str:
        return "epub" if self.format_key.startswith("epub") else self.format_key

    @property
    def epub_version(self) -> int | None:
        if self.format_key == "epub2":
            return 2
        if self.format_key == "epub3":
            return 3
        return None


@dataclass(frozen=True)
class ExportNode:
    item: ManuscriptItem
    document: Document | None
    parent_id: int | None
    children: tuple[ExportNode, ...]
    selected: bool


@dataclass(frozen=True)
class ExportDocument:
    document: Document
    item: ManuscriptItem
    chapter_key: str
    chapter_title: str
    is_scene: bool


@dataclass(frozen=True)
class ExportAsset:
    path: str
    content_type: str
    data: bytes


@dataclass(frozen=True)
class ExportBuild:
    file_name: str
    content_type: str
    data: bytes


def build_account_document(
    manuscript: Manuscript,
    document: Document,
    export_format: str,
    *,
    asset_path_for_id=None,
) -> ExportBuild:
    """Render one document without publication front matter for an account archive."""
    if export_format not in {"markdown", "docx", "odt"}:
        raise ExportError("account_export_manuscript_format_invalid")
    options = ExportOptions(
        format_key=export_format,
        include_title_page=False,
        include_author_info_page=False,
        include_illustrations=True,
    )
    asset_loader = None
    if export_format == "markdown" and asset_path_for_id is not None:
        def account_markdown_asset(asset_id: str) -> ExportAsset | None:
            asset = _asset_by_public_id(manuscript, asset_id)
            if asset is None:
                return None
            return ExportAsset(
                asset_path_for_id(str(asset.public_id)),
                asset.content_type,
                b"",
            )

        asset_loader = account_markdown_asset
    blocks = _semantic_document_blocks(
        document.content,
        options,
        manuscript,
        suppress_leading_scene_break=False,
        asset_loader=asset_loader,
    )
    publication = ExportPublication(
        manuscript=manuscript,
        options=options,
        author_name="",
        language=manuscript.language,
        genres=tuple(manuscript.genres),
        synopsis="",
        cover=None,
        author_info=(),
        sections=(ExportSection(title="", blocks=tuple(blocks)),),
    )
    base_name = safe_download_name(document.title, fallback="document")
    if export_format == "markdown":
        markdown, _assets = _render_markdown(publication)
        return ExportBuild(f"{base_name}.md", TEXT_CONTENT_TYPE, markdown.encode("utf-8"))
    if export_format == "docx":
        build = _build_docx(publication)
        return ExportBuild(f"{base_name}.docx", DOCX_CONTENT_TYPE, build.data)
    build = _build_odt(publication)
    return ExportBuild(f"{base_name}.odt", ODT_CONTENT_TYPE, build.data)


@dataclass(frozen=True)
class ExportInline:
    text: str = ""
    marks: tuple[str, ...] = ()
    hard_break: bool = False


@dataclass(frozen=True)
class ExportBlock:
    kind: str
    inlines: tuple[ExportInline, ...] = ()
    heading_level: int = 0
    text_align: str = "left"
    image: ExportAsset | None = None
    image_alt: str = ""
    image_caption: str = ""
    image_align: str = "center"
    image_width: int = 80


@dataclass(frozen=True)
class ExportSection:
    title: str
    blocks: tuple[ExportBlock, ...]


@dataclass(frozen=True)
class ExportPublication:
    manuscript: Manuscript
    options: ExportOptions
    author_name: str
    language: str
    genres: tuple[str, ...]
    synopsis: str
    cover: ExportAsset | None
    author_info: tuple[tuple[str, str], ...]
    sections: tuple[ExportSection, ...]


def _json_payload(request) -> dict | None:
    try:
        import json

        value = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _manuscript_for_owner(manuscript_id: int, user) -> Manuscript | None:
    return (
        Manuscript.objects.filter(id=manuscript_id, workspace__owner=user)
        .select_related("workspace", "workspace__owner")
        .prefetch_related("documents")
        .first()
    )


def _active_items(manuscript: Manuscript) -> list[ManuscriptItem]:
    return list(
        ManuscriptItem.objects.filter(manuscript=manuscript, trashed_at__isnull=True)
        .select_related("manuscript__workspace", "parent")
        .order_by("position", "created_at")
    )


def _tree(manuscript: Manuscript, selected_ids: set[str] | None = None) -> tuple[ExportNode, ...]:
    items = _active_items(manuscript)
    documents = {
        document.item_id: document
        for document in Document.objects.filter(
            manuscript=manuscript,
            item__trashed_at__isnull=True,
        ).select_related("manuscript__workspace", "item")
    }
    children: dict[int | None, list[ManuscriptItem]] = {}
    for item in items:
        children.setdefault(item.parent_id, []).append(item)

    def build(parent_id: int | None) -> tuple[ExportNode, ...]:
        nodes = []
        for item in children.get(parent_id, []):
            item_children = build(item.id)
            document = documents.get(item.id)
            item_id = str(item.public_id)
            selected = document is not None and (selected_ids is None or item_id in selected_ids)
            nodes.append(
                ExportNode(
                    item=item,
                    document=document,
                    parent_id=parent_id,
                    children=item_children,
                    selected=selected,
                )
            )
        return tuple(nodes)

    return build(None)


def _document_count(node: ExportNode) -> int:
    return int(node.document is not None) + sum(_document_count(child) for child in node.children)


def _selected_count(node: ExportNode) -> int:
    return int(node.selected) + sum(_selected_count(child) for child in node.children)


def _export_node_payload(node: ExportNode) -> dict:
    selected_documents = _selected_count(node)
    total_documents = _document_count(node)
    metadata = node.item.planner_metadata
    return {
        "id": str(node.item.public_id),
        "kind": node.item.kind,
        "title": node.item.title,
        "statusId": metadata.get("statusId"),
        "selected": node.selected,
        "selectedDocumentCount": selected_documents,
        "documentCount": total_documents,
        "children": [_export_node_payload(child) for child in node.children],
    }


def _default_selected_ids(manuscript: Manuscript) -> list[str]:
    return [
        str(item.public_id)
        for item in _active_items(manuscript)
        if item.kind == ManuscriptItem.KIND_DOCUMENT
    ]


@require_GET
def export_plan(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    selected_ids = set(_default_selected_ids(manuscript))
    statuses = [
        {
            "id": str(status.public_id),
            "name": status.name,
            "color": status.color,
            "countsAsComplete": status.counts_as_complete,
        }
        for status in manuscript.plan_statuses.all().order_by("position", "created_at")
    ]
    root_children = _tree(manuscript, selected_ids)
    return JsonResponse(
        {
            "manuscript": manuscript_payload(manuscript),
            "defaultSelectedItemIds": sorted(selected_ids),
            "tree": [_export_node_payload(node) for node in root_children],
            "statuses": statuses,
        }
    )


def _parse_options(payload: dict) -> ExportOptions:
    format_key = str(payload.get("format") or "")
    if format_key not in EXPORT_FORMATS:
        raise ExportError("export_format_invalid")
    try:
        language_override = normalize_manuscript_language(payload.get("language"))
    except InvalidManuscriptMetadata as exc:
        raise ExportError(exc.code) from exc
    return ExportOptions(
        format_key=format_key,
        include_title_page=bool(payload.get("includeTitlePage", True)),
        include_author_info_page=bool(payload.get("includeAuthorInfoPage", True)),
        include_illustrations=bool(payload.get("includeIllustrations", True)),
        language_override=language_override,
    )


def _parse_selected_item_ids(value) -> list[str]:
    if not isinstance(value, list):
        raise ExportError("export_selection_invalid")
    result = []
    for item_id in value:
        try:
            result.append(str(UUID(str(item_id))))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ExportError("export_selection_invalid") from exc
    if not result:
        raise ExportError("export_selection_empty")
    return result


@require_http_methods(["GET", "POST"])
def manuscript_exports(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = _manuscript_for_owner(manuscript_id, request.user)
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if request.method == "GET":
        exports = ManuscriptExport.objects.filter(
            owner=request.user, manuscript=manuscript
        ).select_related("manuscript")[:10]
        return JsonResponse({"items": [export_payload(item) for item in exports]})
    payload = _json_payload(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        options = _parse_options(payload)
        selected_item_ids = _parse_selected_item_ids(payload.get("selectedItemIds"))
        validate_selection(manuscript, selected_item_ids)
        if options.format_key != "markdown" and not (
            options.language_override or manuscript.language
        ):
            raise ExportError("export_language_required")
    except ExportError as exc:
        return JsonResponse({"error": exc.code}, status=400)
    export = ManuscriptExport.objects.create(
        owner=request.user,
        manuscript=manuscript,
        export_format=options.export_format,
        epub_version=options.epub_version,
        options={
            "includeTitlePage": options.include_title_page,
            "includeAuthorInfoPage": options.include_author_info_page,
            "includeIllustrations": options.include_illustrations,
            "language": options.language_override,
        },
        selected_item_ids=selected_item_ids,
        expires_at=timezone.now() + timedelta(minutes=EXPORT_TTL_MINUTES),
    )
    from .tasks import build_manuscript_export

    build_manuscript_export.delay(export.id)
    write_audit_event(
        request,
        "manuscript.export_requested",
        actor=request.user,
        subject=f"manuscript:{manuscript.public_id}",
        payload={
            "manuscriptId": str(manuscript.public_id),
            "exportId": str(export.public_id),
            "format": options.format_key,
        },
    )
    return JsonResponse({"export": export_payload(export)}, status=201)


@require_GET
def export_detail(request, export_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    export = (
        ManuscriptExport.objects.filter(public_id=export_id, owner=request.user)
        .select_related("manuscript__workspace")
        .first()
    )
    if export is None:
        return JsonResponse({"error": "export_not_found"}, status=404)
    return JsonResponse({"export": export_payload(export)})


@require_GET
def export_download(request, export_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    export = (
        ManuscriptExport.objects.filter(
            public_id=export_id,
            owner=request.user,
            status=ManuscriptExport.STATUS_READY,
        )
        .select_related("manuscript__workspace")
        .first()
    )
    if export is None:
        return JsonResponse({"error": "export_not_found"}, status=404)
    if export.expires_at <= timezone.now() or not export.artifact:
        return JsonResponse({"error": "export_expired"}, status=410)
    with export.artifact.open("rb") as stored_stream:
        plaintext = stored_stream.read()
    response = FileResponse(BytesIO(plaintext), content_type=export.content_type)
    response["Content-Disposition"] = content_disposition(
        export.file_name,
        fallback="manuscript",
    )
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


def export_payload(export: ManuscriptExport) -> dict:
    return {
        "id": str(export.public_id),
        "manuscriptId": str(export.manuscript.public_id),
        "format": export.export_format,
        "epubVersion": export.epub_version,
        "status": export.status,
        "fileName": export.file_name,
        "byteSize": export.byte_size,
        "errorCode": export.error_code,
        "expiresAt": export.expires_at.isoformat(),
        "createdAt": export.created_at.isoformat(),
        "updatedAt": export.updated_at.isoformat(),
        "downloadUrl": (
            f"/api/manuscripts/exports/{export.public_id}/download/"
            if export.status == ManuscriptExport.STATUS_READY
            else ""
        ),
    }


def validate_selection(manuscript: Manuscript, selected_item_ids: list[str]) -> None:
    selected = set(selected_item_ids)
    available = {
        str(item.public_id)
        for item in ManuscriptItem.objects.filter(
            manuscript=manuscript,
            kind=ManuscriptItem.KIND_DOCUMENT,
            trashed_at__isnull=True,
        )
    }
    if not selected:
        raise ExportError("export_selection_empty")
    if not selected.issubset(available):
        raise ExportError("export_selection_invalid")


def build_export(export: ManuscriptExport) -> ExportBuild:
    options = ExportOptions(
        format_key=(
            f"epub{export.epub_version}"
            if export.export_format == ManuscriptExport.FORMAT_EPUB
            else export.export_format
        ),
        include_title_page=bool(export.options.get("includeTitlePage", True)),
        include_author_info_page=bool(export.options.get("includeAuthorInfoPage", True)),
        include_illustrations=bool(export.options.get("includeIllustrations", True)),
        language_override=str(export.options.get("language") or ""),
    )
    documents = _selected_documents(export.manuscript, set(export.selected_item_ids))
    if not documents:
        raise ExportError("export_selection_empty")
    publication = _build_publication(export.manuscript, documents, options)
    if export.export_format == ManuscriptExport.FORMAT_MARKDOWN:
        return _build_markdown(publication)
    if export.export_format == ManuscriptExport.FORMAT_EPUB:
        return _build_epub(publication, export.epub_version or 2)
    if export.export_format == ManuscriptExport.FORMAT_DOCX:
        return _build_docx(publication)
    if export.export_format == ManuscriptExport.FORMAT_ODT:
        return _build_odt(publication)
    return _build_fb2(publication)


def materialize_export(export_id: int) -> None:
    with transaction.atomic():
        export = (
            ManuscriptExport.objects.select_for_update()
            .select_related("manuscript__workspace", "owner")
            .get(id=export_id)
        )
        if export.status not in {
            ManuscriptExport.STATUS_PENDING,
            ManuscriptExport.STATUS_FAILED,
        }:
            return
        export.status = ManuscriptExport.STATUS_BUILDING
        export.error_code = ""
        export.save(update_fields=["status", "error_code", "updated_at"])
    try:
        export = ManuscriptExport.objects.select_related("manuscript__workspace", "owner").get(
            id=export_id
        )
        build = build_export(export)
        suffix = PurePosixPath(build.file_name).suffix or ".bin"
        export.artifact.save(
            f"{export.public_id}{suffix}",
            ContentFile(build.data),
            save=False,
        )
        export.file_name = build.file_name
        export.content_type = build.content_type
        export.byte_size = len(build.data)
        export.status = ManuscriptExport.STATUS_READY
        export.error_code = ""
        export.save(
            update_fields=[
                "artifact",
                "file_name",
                "content_type",
                "byte_size",
                "status",
                "error_code",
                "updated_at",
            ]
        )
    except ExportError as exc:
        ManuscriptExport.objects.filter(id=export_id).update(
            status=ManuscriptExport.STATUS_FAILED,
            error_code=exc.code,
            updated_at=timezone.now(),
        )
    except Exception:
        ManuscriptExport.objects.filter(id=export_id).update(
            status=ManuscriptExport.STATUS_FAILED,
            error_code="export_build_failed",
            updated_at=timezone.now(),
        )
        raise


def cleanup_expired_exports() -> int:
    now = timezone.now()
    exports = list(
        ManuscriptExport.objects.filter(expires_at__lte=now).exclude(
            status=ManuscriptExport.STATUS_EXPIRED
        )[:100]
    )
    count = 0
    for export in exports:
        artifact = export.artifact
        if artifact:
            artifact.storage.delete(artifact.name)
        export.artifact = ""
        export.status = ManuscriptExport.STATUS_EXPIRED
        export.save(update_fields=["artifact", "status", "updated_at"])
        count += 1
    return count


def _selected_documents(manuscript: Manuscript, selected_ids: set[str]) -> list[ExportDocument]:
    nodes = _tree(manuscript, selected_ids)
    result: list[ExportDocument] = []

    def visit(
        node: ExportNode,
        inherited_chapter_key: str | None,
        inherited_chapter_title: str | None,
    ) -> None:
        chapter_key = inherited_chapter_key
        chapter_title = inherited_chapter_title
        if node.item.kind == ManuscriptItem.KIND_FOLDER:
            chapter_key = str(node.item.public_id)
            chapter_title = node.item.title
        if node.document and node.selected:
            result.append(
                ExportDocument(
                    document=node.document,
                    item=node.item,
                    chapter_key=chapter_key or str(node.item.public_id),
                    chapter_title=chapter_title or node.item.title,
                    is_scene=chapter_key is not None and node.parent_id is not None,
                )
            )
        for child in node.children:
            visit(child, chapter_key, chapter_title)

    for node in nodes:
        visit(node, None, None)
    return result


def _build_publication(
    manuscript: Manuscript,
    documents: list[ExportDocument],
    options: ExportOptions,
) -> ExportPublication:
    sections: list[ExportSection] = []
    for group in _chapter_groups(documents):
        blocks: list[ExportBlock] = []
        for index, document in enumerate(group):
            suppress_leading_scene_break = False
            if index > 0 and document.is_scene:
                blocks.append(ExportBlock(kind="scene_break", text_align="center"))
                suppress_leading_scene_break = True
            blocks.extend(
                _semantic_document_blocks(
                    document.document.content,
                    options,
                    manuscript,
                    suppress_leading_scene_break=suppress_leading_scene_break,
                )
            )
        sections.append(
            ExportSection(
                title=group[0].chapter_title if manuscript.kind == Manuscript.KIND_BOOK else "",
                blocks=tuple(blocks),
            )
        )
    cover = _cover_export_asset(manuscript) if options.include_title_page else None
    return ExportPublication(
        manuscript=manuscript,
        options=options,
        author_name=manuscript.workspace.owner.author_name.strip(),
        language=options.language_override or manuscript.language or "ru",
        genres=tuple(manuscript.genres),
        synopsis=manuscript.synopsis.strip(),
        cover=cover,
        author_info=tuple(_author_info_rows(manuscript)),
        sections=tuple(sections),
    )


def _semantic_document_blocks(
    content: dict,
    options: ExportOptions,
    manuscript: Manuscript,
    *,
    suppress_leading_scene_break: bool,
    asset_loader=None,
) -> list[ExportBlock]:
    result: list[ExportBlock] = []
    for block_index, block in enumerate(content.get("content", [])):
        block_type = block.get("type")
        attrs = block.get("attrs", {})
        if block_type == "sceneBreak":
            if block_index == 0 and suppress_leading_scene_break:
                continue
            result.append(ExportBlock(kind="scene_break", text_align="center"))
        elif block_type in {"paragraph", "heading"}:
            result.append(
                ExportBlock(
                    kind=block_type,
                    inlines=_semantic_inlines(block.get("content", [])),
                    heading_level=(
                        min(max(int(attrs.get("level") or 1), 1), 3)
                        if block_type == "heading"
                        else 0
                    ),
                    text_align=attrs.get("textAlign") or "left",
                )
            )
        elif block_type == "illustration" and options.include_illustrations:
            asset = (
                asset_loader(attrs["assetId"])
                if asset_loader is not None
                else _illustration_export_asset(manuscript, attrs["assetId"])
            )
            if asset:
                result.append(
                    ExportBlock(
                        kind="illustration",
                        image=asset,
                        image_alt=attrs.get("alt") or "",
                        image_caption=attrs.get("caption") or "",
                        image_align=attrs.get("alignment") or "center",
                        image_width=int(attrs.get("displayWidth") or 80),
                    )
                )
    return result


def _semantic_inlines(nodes: list[dict]) -> tuple[ExportInline, ...]:
    result = []
    for node in nodes:
        if node.get("type") == "hardBreak":
            result.append(ExportInline(hard_break=True))
        elif node.get("type") == "text":
            marks = tuple(
                mark["type"]
                for mark in node.get("marks", [])
                if mark.get("type") in {"bold", "italic", "strike"}
            )
            result.append(ExportInline(text=node.get("text", ""), marks=marks))
    return tuple(result)


def _build_markdown(publication: ExportPublication) -> ExportBuild:
    markdown, assets = _render_markdown(publication)
    base_name = safe_download_name(publication.manuscript.title, fallback="manuscript")
    if assets:
        output = BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f"{base_name}.md", markdown)
            for asset in assets.values():
                archive.writestr(asset.path, asset.data)
        return ExportBuild(f"{base_name}.zip", ZIP_CONTENT_TYPE, output.getvalue())
    return ExportBuild(f"{base_name}.md", TEXT_CONTENT_TYPE, markdown.encode("utf-8"))


def _build_epub(publication: ExportPublication, epub_version: int) -> ExportBuild:
    manuscript = publication.manuscript
    book = epub.EpubBook()
    book.EPUB_VERSION = "3.0" if epub_version == 3 else "2.0"
    book.set_identifier(f"quillum-manuscript-{manuscript.public_id}")
    book.set_title(manuscript.title)
    if publication.author_name:
        book.add_author(publication.author_name)
    if publication.synopsis:
        book.add_metadata("DC", "description", publication.synopsis)
    book.set_language(publication.language)

    front_matter: list[epub.EpubHtml] = []
    content_pages: list[epub.EpubHtml] = []
    cover_file_name = ""
    if publication.options.include_illustrations and publication.cover:
        cover_file_name = PurePosixPath(publication.cover.path).name
        book.set_cover(cover_file_name, publication.cover.data)
    if publication.options.include_title_page:
        front_matter.append(
            _epub_page(
                "title.xhtml",
                manuscript.title,
                _title_page_html(publication, cover_file_name),
                publication.language,
            )
        )
        if publication.synopsis:
            synopsis_title = _export_label(publication.language, "synopsis")
            front_matter.append(
                _epub_page(
                    "synopsis.xhtml",
                    synopsis_title,
                    _synopsis_page_html(publication.synopsis, synopsis_title),
                    publication.language,
                )
            )
    if publication.options.include_author_info_page and publication.author_info:
        author_info_title = _export_label(publication.language, "author_info")
        front_matter.append(
            _epub_page(
                "author.xhtml",
                author_info_title,
                _author_info_page_html(publication.author_info, author_info_title),
                publication.language,
            )
        )
    for index, section in enumerate(publication.sections, start=1):
        title = section.title or manuscript.title
        html_body = _semantic_blocks_html(section)
        content_pages.append(
            _epub_page(f"chapter-{index}.xhtml", title, html_body, publication.language)
        )
    for page in (*front_matter, *content_pages):
        book.add_item(page)
    book.toc = tuple(content_pages) if manuscript.kind == Manuscript.KIND_BOOK else ()
    book.spine = [*front_matter, "nav", *content_pages]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav(title=_export_label(publication.language, "contents")))
    for asset in _publication_assets(publication):
        item = epub.EpubItem(
            uid=asset.path.replace("/", "-"),
            file_name=asset.path,
            media_type=asset.content_type,
            content=asset.data,
        )
        book.add_item(item)
    output = BytesIO()
    with tempfile.NamedTemporaryFile(suffix=".epub") as tmp:
        epub.write_epub(tmp.name, book)
        tmp.seek(0)
        output.write(tmp.read())
    return ExportBuild(
        f"{safe_download_name(manuscript.title, fallback='manuscript')}.epub",
        EPUB_CONTENT_TYPE,
        output.getvalue(),
    )


def _build_docx(publication: ExportPublication) -> ExportBuild:
    document = DocxDocument()
    core = document.core_properties
    core.title = publication.manuscript.title
    core.author = publication.author_name
    core.subject = publication.synopsis[:255]
    core.identifier = str(publication.manuscript.public_id)
    core.language = publication.language
    core.keywords = ", ".join(publication.genres)
    section = document.sections[0]
    section.top_margin = Cm(2.5)
    section.bottom_margin = Cm(2.5)
    section.left_margin = Cm(2.5)
    section.right_margin = Cm(2.5)
    normal = document.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(12)
    normal.paragraph_format.line_spacing = 1.5
    normal.paragraph_format.first_line_indent = Cm(1.25)

    if publication.options.include_title_page:
        if publication.author_name:
            paragraph = document.add_paragraph()
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            paragraph.add_run(publication.author_name)
        title = document.add_heading(publication.manuscript.title, level=0)
        title.alignment = WD_ALIGN_PARAGRAPH.CENTER
        if publication.options.include_illustrations and publication.cover:
            _docx_picture(document, publication.cover, 80, "center", max_height_cm=15.5)
        document.add_page_break()
        if publication.synopsis:
            document.add_heading(_export_label(publication.language, "synopsis"), level=1)
            document.add_paragraph(publication.synopsis)
            document.add_page_break()
    if publication.options.include_author_info_page and publication.author_info:
        document.add_heading(_export_label(publication.language, "author_info"), level=1)
        for label, value in publication.author_info:
            paragraph = document.add_paragraph()
            paragraph.add_run(f"{label}: ").bold = True
            paragraph.add_run(value)
        document.add_page_break()
    for section_index, export_section in enumerate(publication.sections):
        if export_section.title:
            if section_index:
                document.add_page_break()
            document.add_heading(export_section.title, level=1)
        for block in export_section.blocks:
            _append_docx_block(document, block, bool(export_section.title))
    output = BytesIO()
    document.save(output)
    return ExportBuild(
        f"{safe_download_name(publication.manuscript.title, fallback='manuscript')}.docx",
        DOCX_CONTENT_TYPE,
        output.getvalue(),
    )


def _append_docx_block(document, block: ExportBlock, has_chapter: bool) -> None:
    if block.kind == "heading":
        paragraph = document.add_heading(level=min(block.heading_level + int(has_chapter), 4))
    else:
        paragraph = document.add_paragraph()
    paragraph.alignment = _docx_alignment(block.text_align)
    if block.kind == "scene_break":
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.paragraph_format.first_line_indent = Cm(0)
        paragraph.paragraph_format.space_before = Pt(12)
        paragraph.add_run("***")
    elif block.kind in {"paragraph", "heading"}:
        for inline in block.inlines:
            if inline.hard_break:
                paragraph.add_run().add_break()
                continue
            run = paragraph.add_run(inline.text)
            run.bold = "bold" in inline.marks
            run.italic = "italic" in inline.marks
            run.font.strike = "strike" in inline.marks
    elif block.kind == "illustration" and block.image:
        paragraph._element.getparent().remove(paragraph._element)
        _docx_picture(document, block.image, block.image_width, block.image_align)
        if block.image_caption:
            caption = document.add_paragraph(block.image_caption)
            caption.alignment = _docx_alignment(block.image_align)
            for run in caption.runs:
                run.italic = True


def _docx_picture(
    document,
    asset: ExportAsset,
    width_percent: int,
    alignment: str,
    *,
    max_height_cm: float = 20,
) -> None:
    data, _content_type, _extension, width, height = _office_image(asset)
    width_cm = 16 * width_percent / 100
    height_cm = width_cm * height / max(width, 1)
    if height_cm > max_height_cm:
        width_cm *= max_height_cm / height_cm
        height_cm = max_height_cm
    paragraph = document.add_paragraph()
    paragraph.alignment = _docx_alignment(alignment)
    paragraph.paragraph_format.first_line_indent = Cm(0)
    paragraph.add_run().add_picture(BytesIO(data), width=Cm(width_cm), height=Cm(height_cm))


def _docx_alignment(value: str):
    return {
        "center": WD_ALIGN_PARAGRAPH.CENTER,
        "right": WD_ALIGN_PARAGRAPH.RIGHT,
    }.get(value, WD_ALIGN_PARAGRAPH.LEFT)


def _build_odt(publication: ExportPublication) -> ExportBuild:
    document = OdfDocument("text")
    document.meta.set_title(publication.manuscript.title)
    document.meta.set_creator(publication.author_name)
    document.meta.set_subject(publication.synopsis)
    document.meta.set_language(publication.language)
    document.meta.set_keywords(", ".join(publication.genres))
    document.meta.set_generator("Quillum")
    document.add_page_break_style()
    _odt_insert_styles(document)
    body = document.body
    if publication.options.include_title_page:
        if publication.author_name:
            body.append(Paragraph(publication.author_name, style="QuillumCenter"))
        body.append(Paragraph(publication.manuscript.title, style="QuillumTitle"))
        if publication.options.include_illustrations and publication.cover:
            _odt_picture(
                document,
                body,
                publication.cover,
                80,
                "center",
                max_height_cm=15.5,
            )
        body.append(PageBreak())
        if publication.synopsis:
            body.append(
                Paragraph(
                    _export_label(publication.language, "synopsis"),
                    style=_odt_heading_style(1, "left"),
                )
            )
            body.append(Paragraph(publication.synopsis, style="Text_20_body"))
            body.append(PageBreak())
    if publication.options.include_author_info_page and publication.author_info:
        body.append(
            Paragraph(
                _export_label(publication.language, "author_info"),
                style=_odt_heading_style(1, "left"),
            )
        )
        for label, value in publication.author_info:
            paragraph = Paragraph(style="Text_20_body")
            paragraph.append(Span(f"{label}: ", style="QuillumBold"))
            paragraph.append(value)
            body.append(paragraph)
        body.append(PageBreak())
    for section_index, export_section in enumerate(publication.sections):
        if export_section.title:
            if section_index:
                body.append(PageBreak())
            body.append(Paragraph(export_section.title, style=_odt_heading_style(1, "left")))
        for block in export_section.blocks:
            _append_odt_block(document, body, block, bool(export_section.title))
    output = BytesIO()
    document.save(output)
    return ExportBuild(
        f"{safe_download_name(publication.manuscript.title, fallback='manuscript')}.odt",
        ODT_CONTENT_TYPE,
        output.getvalue(),
    )


def _odt_insert_styles(document: OdfDocument) -> None:
    document.insert_style(
        '<style:style style:name="QuillumTitle" style:family="paragraph" '
        'style:parent-style-name="Title"><style:paragraph-properties fo:text-align="center"/>'
        '<style:text-properties fo:font-size="22pt" fo:font-weight="bold"/></style:style>'
    )
    document.insert_style(
        '<style:style style:name="QuillumSceneBreak" style:family="paragraph" '
        'style:parent-style-name="Text_20_body"><style:paragraph-properties '
        'fo:text-align="center" fo:margin-top="0.35cm"/></style:style>'
    )
    alignments = (
        ("QuillumLeft", "left"),
        ("QuillumCenter", "center"),
        ("QuillumRight", "right"),
    )
    for name, align in alignments:
        document.insert_style(
            f'<style:style style:name="{name}" style:family="paragraph" '
            f'style:parent-style-name="Text_20_body"><style:paragraph-properties '
            f'fo:text-align="{align}"/></style:style>'
        )
    for level in range(1, 5):
        font_size = {1: 18, 2: 16, 3: 14, 4: 13}[level]
        for suffix, align in (("Left", "left"), ("Center", "center"), ("Right", "right")):
            document.insert_style(
                f'<style:style style:name="QuillumHeading{level}{suffix}" '
                'style:family="paragraph" style:parent-style-name="Text_20_body">'
                f'<style:paragraph-properties fo:text-align="{align}" '
                'fo:margin-top="0.42cm" fo:margin-bottom="0.2cm" '
                'fo:keep-with-next="always"/>'
                f'<style:text-properties fo:font-size="{font_size}pt" '
                'fo:font-weight="bold"/></style:style>'
            )
    combinations = {
        "QuillumBold": (True, False, False),
        "QuillumItalic": (False, True, False),
        "QuillumStrike": (False, False, True),
        "QuillumBoldItalic": (True, True, False),
        "QuillumBoldStrike": (True, False, True),
        "QuillumItalicStrike": (False, True, True),
        "QuillumBoldItalicStrike": (True, True, True),
    }
    for name, (bold, italic, strike) in combinations.items():
        properties = []
        if bold:
            properties.append('fo:font-weight="bold"')
        if italic:
            properties.append('fo:font-style="italic"')
        if strike:
            properties.append('style:text-line-through-style="solid"')
        document.insert_style(
            f'<style:style style:name="{name}" style:family="text">'
            f"<style:text-properties {' '.join(properties)}/></style:style>"
        )


def _append_odt_block(document: OdfDocument, body, block: ExportBlock, has_chapter: bool) -> None:
    if block.kind == "illustration" and block.image:
        _odt_picture(document, body, block.image, block.image_width, block.image_align)
        if block.image_caption:
            body.append(Paragraph(block.image_caption, style=_odt_alignment(block.image_align)))
        return
    if block.kind == "heading":
        level = min(block.heading_level + int(has_chapter), 4)
        paragraph = Paragraph(style=_odt_heading_style(level, block.text_align))
    else:
        paragraph = Paragraph(style=_odt_alignment(block.text_align))
    if block.kind == "scene_break":
        paragraph.style = "QuillumSceneBreak"
        paragraph.append("***")
    else:
        for inline in block.inlines:
            if inline.hard_break:
                paragraph.append("\n")
                continue
            style = _odt_inline_style(inline.marks)
            paragraph.append(Span(inline.text, style=style) if style else inline.text)
    body.append(paragraph)


def _odt_picture(
    document: OdfDocument,
    body,
    asset: ExportAsset,
    width_percent: int,
    alignment: str,
    *,
    max_height_cm: float = 22,
) -> None:
    data, _content_type, extension, width, height = _office_image(asset)
    with tempfile.NamedTemporaryFile(suffix=f".{extension}") as image_file:
        image_file.write(data)
        image_file.flush()
        url = document.add_file(image_file.name)
    width_cm = 16 * width_percent / 100
    height_cm = width_cm * height / max(width, 1)
    if height_cm > max_height_cm:
        width_cm *= max_height_cm / height_cm
        height_cm = max_height_cm
    paragraph = Paragraph(style=_odt_alignment(alignment))
    paragraph.append(
        Frame.image_frame(
            url,
            size=(f"{width_cm:.2f}cm", f"{height_cm:.2f}cm"),
            anchor_type="as-char",
        )
    )
    body.append(paragraph)


def _odt_alignment(value: str) -> str:
    return {"center": "QuillumCenter", "right": "QuillumRight"}.get(value, "QuillumLeft")


def _odt_heading_style(level: int, alignment: str) -> str:
    suffix = {"center": "Center", "right": "Right"}.get(alignment, "Left")
    return f"QuillumHeading{level}{suffix}"


def _odt_inline_style(marks: tuple[str, ...]) -> str | None:
    selected = frozenset(marks)
    return {
        frozenset({"bold"}): "QuillumBold",
        frozenset({"italic"}): "QuillumItalic",
        frozenset({"strike"}): "QuillumStrike",
        frozenset({"bold", "italic"}): "QuillumBoldItalic",
        frozenset({"bold", "strike"}): "QuillumBoldStrike",
        frozenset({"italic", "strike"}): "QuillumItalicStrike",
        frozenset({"bold", "italic", "strike"}): "QuillumBoldItalicStrike",
    }.get(selected)


def _build_fb2(publication: ExportPublication) -> ExportBuild:
    fb = "http://www.gribuser.ru/xml/fictionbook/2.0"
    xlink = "http://www.w3.org/1999/xlink"
    root = etree.Element(f"{{{fb}}}FictionBook", nsmap={None: fb, "xlink": xlink})
    description = etree.SubElement(root, f"{{{fb}}}description")
    title_info = etree.SubElement(description, f"{{{fb}}}title-info")
    genres = publication.genres or ("other",)
    for genre in genres:
        etree.SubElement(title_info, f"{{{fb}}}genre").text = MANUSCRIPT_GENRE_TO_FB2[genre]
    author = etree.SubElement(title_info, f"{{{fb}}}author")
    etree.SubElement(author, f"{{{fb}}}nickname").text = publication.author_name or _export_label(
        publication.language, "unknown_author"
    )
    etree.SubElement(title_info, f"{{{fb}}}book-title").text = publication.manuscript.title
    if publication.synopsis:
        annotation = etree.SubElement(title_info, f"{{{fb}}}annotation")
        etree.SubElement(annotation, f"{{{fb}}}p").text = publication.synopsis
    binaries: dict[str, tuple[str, bytes]] = {}
    if publication.options.include_illustrations and publication.cover:
        cover_data, cover_type, _extension, _width, _height = _office_image(publication.cover)
        coverpage = etree.SubElement(title_info, f"{{{fb}}}coverpage")
        cover_image = etree.SubElement(coverpage, f"{{{fb}}}image")
        cover_image.set(f"{{{xlink}}}href", "#cover")
        binaries["cover"] = (cover_type, cover_data)
    etree.SubElement(title_info, f"{{{fb}}}lang").text = publication.language
    document_info = etree.SubElement(description, f"{{{fb}}}document-info")
    document_author = etree.SubElement(document_info, f"{{{fb}}}author")
    etree.SubElement(document_author, f"{{{fb}}}nickname").text = "Quillum Exporter"
    etree.SubElement(document_info, f"{{{fb}}}program-used").text = "Quillum"
    date_value = publication.manuscript.updated_at.date().isoformat()
    date = etree.SubElement(document_info, f"{{{fb}}}date", value=date_value)
    date.text = date_value
    etree.SubElement(document_info, f"{{{fb}}}id").text = str(publication.manuscript.public_id)
    etree.SubElement(document_info, f"{{{fb}}}version").text = "1.0"
    body = etree.SubElement(root, f"{{{fb}}}body")
    if publication.options.include_title_page:
        title_section = etree.SubElement(body, f"{{{fb}}}section")
        title = etree.SubElement(title_section, f"{{{fb}}}title")
        if publication.author_name:
            etree.SubElement(title, f"{{{fb}}}p").text = publication.author_name
        etree.SubElement(title, f"{{{fb}}}p").text = publication.manuscript.title
        if publication.options.include_illustrations and publication.cover:
            image_paragraph = etree.SubElement(title_section, f"{{{fb}}}p")
            image = etree.SubElement(image_paragraph, f"{{{fb}}}image")
            image.set(f"{{{xlink}}}href", "#cover")
        else:
            etree.SubElement(title_section, f"{{{fb}}}empty-line")
        if publication.synopsis:
            synopsis_section = etree.SubElement(body, f"{{{fb}}}section")
            synopsis_title = etree.SubElement(synopsis_section, f"{{{fb}}}title")
            etree.SubElement(synopsis_title, f"{{{fb}}}p").text = _export_label(
                publication.language, "synopsis"
            )
            etree.SubElement(synopsis_section, f"{{{fb}}}p").text = publication.synopsis
    if publication.options.include_author_info_page and publication.author_info:
        section = etree.SubElement(body, f"{{{fb}}}section")
        title = etree.SubElement(section, f"{{{fb}}}title")
        etree.SubElement(title, f"{{{fb}}}p").text = _export_label(
            publication.language, "author_info"
        )
        for label, value in publication.author_info:
            etree.SubElement(section, f"{{{fb}}}p").text = f"{label}: {value}"
    for export_section in publication.sections:
        section = etree.SubElement(body, f"{{{fb}}}section")
        if export_section.title:
            title = etree.SubElement(section, f"{{{fb}}}title")
            etree.SubElement(title, f"{{{fb}}}p").text = export_section.title
        for block in export_section.blocks:
            _append_fb2_block(section, block, fb, xlink, binaries)
        if not export_section.blocks:
            etree.SubElement(section, f"{{{fb}}}empty-line")
    for image_id, (content_type, data) in binaries.items():
        binary = etree.SubElement(
            root,
            f"{{{fb}}}binary",
            id=image_id,
            **{"content-type": content_type},
        )
        binary.text = base64.b64encode(data).decode("ascii")
    output = etree.tostring(root, xml_declaration=True, encoding="utf-8", pretty_print=True)
    return ExportBuild(
        f"{safe_download_name(publication.manuscript.title, fallback='manuscript')}.fb2",
        FB2_CONTENT_TYPE,
        output,
    )


def _append_fb2_block(section, block: ExportBlock, fb: str, xlink: str, binaries) -> None:
    if block.kind == "illustration" and block.image:
        data, content_type, _extension, _width, _height = _office_image(block.image)
        image_id = f"img-{PurePosixPath(block.image.path).stem}"
        paragraph = etree.SubElement(section, f"{{{fb}}}p")
        image = etree.SubElement(paragraph, f"{{{fb}}}image")
        image.set(f"{{{xlink}}}href", f"#{image_id}")
        if block.image_alt:
            image.set("alt", block.image_alt)
        binaries[image_id] = (content_type, data)
        if block.image_caption:
            etree.SubElement(section, f"{{{fb}}}subtitle").text = block.image_caption
        return
    tag = "subtitle" if block.kind == "heading" else "p"
    if block.kind == "scene_break" and len(section):
        etree.SubElement(section, f"{{{fb}}}empty-line")
    element = etree.SubElement(section, f"{{{fb}}}{tag}")
    if block.kind == "scene_break":
        element.text = "***"
        return
    _append_fb2_inlines(element, block.inlines, fb)


def _append_fb2_inlines(parent, inlines: tuple[ExportInline, ...], fb: str) -> None:
    cursor = parent
    for inline in inlines:
        if inline.hard_break:
            _append_xml_text(cursor, "\n")
            continue
        node = None
        for mark in inline.marks:
            tag = {"bold": "strong", "italic": "emphasis", "strike": "strikethrough"}[mark]
            child = etree.Element(f"{{{fb}}}{tag}")
            if node is None:
                node = child
            else:
                cursor.append(child)
            cursor = child
        if node is None:
            _append_xml_text(parent, inline.text)
        else:
            cursor.text = inline.text
            parent.append(node)
        cursor = parent


def _append_xml_text(element, value: str) -> None:
    if len(element):
        element[-1].tail = (element[-1].tail or "") + value
    else:
        element.text = (element.text or "") + value


def _office_image(asset: ExportAsset) -> tuple[bytes, str, str, int, int]:
    with Image.open(BytesIO(asset.data)) as image:
        width, height = image.size
        if asset.content_type in {"image/jpeg", "image/png"}:
            extension = "jpg" if asset.content_type == "image/jpeg" else "png"
            return asset.data, asset.content_type, extension, width, height
        converted = image.convert("RGBA" if image.mode in {"RGBA", "LA"} else "RGB")
        output = BytesIO()
        converted.save(output, format="PNG", optimize=True)
        return output.getvalue(), "image/png", "png", width, height


def _render_markdown(publication: ExportPublication) -> tuple[str, dict[str, ExportAsset]]:
    manuscript = publication.manuscript
    options = publication.options
    assets: dict[str, ExportAsset] = {}
    parts: list[str] = []
    if options.include_title_page:
        title_lines = []
        if publication.author_name:
            title_lines.append(publication.author_name)
            title_lines.append("")
        title_lines.append(f"# {manuscript.title}")
        if publication.cover and options.include_illustrations:
            asset = publication.cover
            if asset:
                assets[asset.path] = asset
                title_lines.append("")
                title_lines.append(f"![Cover]({asset.path})")
        parts.append("\n".join(title_lines))
        if publication.synopsis:
            parts.append(
                "\n".join(
                    [
                        f"# {_export_label(publication.language, 'synopsis')}",
                        "",
                        publication.synopsis,
                    ]
                )
            )
    if options.include_author_info_page:
        rows = publication.author_info
        if rows:
            parts.append(
                "\n".join(
                    [
                        f"# {_export_label(publication.language, 'author_info')}",
                        "",
                        *[f"- **{label}:** {value}" for label, value in rows],
                    ]
                )
            )
    for section in publication.sections:
        if section.title:
            parts.append(f"## {section.title}")
        body = _semantic_blocks_markdown(section.blocks, assets)
        if body:
            parts.append(body)
    return "\n\n".join(part.strip() for part in parts if part.strip()) + "\n", assets


def _semantic_blocks_markdown(
    blocks: tuple[ExportBlock, ...],
    assets: dict[str, ExportAsset],
) -> str:
    lines: list[str] = []
    for block in blocks:
        if block.kind == "scene_break":
            lines.append("***")
        elif block.kind == "heading":
            text = _semantic_inline_markdown(block.inlines)
            if text:
                lines.append(f"{'#' * block.heading_level} {text}")
        elif block.kind == "paragraph":
            text = _semantic_inline_markdown(block.inlines)
            if text:
                lines.append(text)
        elif block.kind == "illustration" and block.image:
            assets[block.image.path] = block.image
            lines.append(f"![{_markdown_escape(block.image_alt)}]({block.image.path})")
            if block.image_caption:
                lines.append(f"*{_markdown_escape(block.image_caption)}*")
    return "\n\n".join(lines)


def _semantic_inline_markdown(inlines: tuple[ExportInline, ...]) -> str:
    parts = []
    for inline in inlines:
        if inline.hard_break:
            parts.append("  \n")
            continue
        text = _markdown_escape(inline.text)
        for mark in inline.marks:
            if mark == "bold":
                text = f"**{text}**"
            elif mark == "italic":
                text = f"*{text}*"
            elif mark == "strike":
                text = f"~~{text}~~"
        parts.append(text)
    return "".join(parts).strip()


def _chapter_groups(documents: list[ExportDocument]) -> list[list[ExportDocument]]:
    groups: list[list[ExportDocument]] = []
    for document in documents:
        if not groups or groups[-1][0].chapter_key != document.chapter_key:
            groups.append([document])
        else:
            groups[-1].append(document)
    return groups


def _semantic_blocks_html(section: ExportSection) -> str:
    parts = []
    if section.title:
        parts.append(f"<h1>{html.escape(section.title)}</h1>")
    for block in section.blocks:
        if block.kind == "scene_break":
            parts.append(
                '<p class="scene-break" style="margin-top: 1.5em; text-align: center;">***</p>'
            )
        elif block.kind == "heading":
            level = block.heading_level
            parts.append(f"<h{level}>{_semantic_inline_html(block.inlines)}</h{level}>")
        elif block.kind == "paragraph":
            parts.append(f"<p>{_semantic_inline_html(block.inlines) or '&#160;'}</p>")
        elif block.kind == "illustration" and block.image:
            alt = html.escape(block.image_alt)
            parts.append(f'<figure><img src="{html.escape(block.image.path)}" alt="{alt}" />')
            if block.image_caption:
                parts.append(f"<figcaption>{html.escape(block.image_caption)}</figcaption>")
            parts.append("</figure>")
    return "\n".join(parts)


def _semantic_inline_html(inlines: tuple[ExportInline, ...]) -> str:
    parts = []
    for inline in inlines:
        if inline.hard_break:
            parts.append("<br />")
            continue
        text = html.escape(inline.text)
        for mark in inline.marks:
            if mark == "bold":
                text = f"<strong>{text}</strong>"
            elif mark == "italic":
                text = f"<em>{text}</em>"
            elif mark == "strike":
                text = f"<s>{text}</s>"
        parts.append(text)
    return "".join(parts)


def _publication_assets(publication: ExportPublication) -> list[ExportAsset]:
    assets: dict[str, ExportAsset] = {}
    for section in publication.sections:
        for block in section.blocks:
            if block.image:
                assets[block.image.path] = block.image
    return list(assets.values())


def _epub_page(file_name: str, title: str, body: str, language: str) -> epub.EpubHtml:
    page = epub.EpubHtml(title=title, file_name=file_name, lang=language)
    page.set_content(
        f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{html.escape(title)}</title></head>
<body>{body}</body>
</html>""".encode()
    )
    return page


def _title_page_html(publication: ExportPublication, cover_file_name: str) -> str:
    parts = ['<section class="title-page">']
    if publication.author_name:
        parts.append(f"<p>{html.escape(publication.author_name)}</p>")
    parts.append(f"<h1>{html.escape(publication.manuscript.title)}</h1>")
    if cover_file_name:
        parts.append(f'<figure><img src="{html.escape(cover_file_name)}" alt="" /></figure>')
    parts.append("</section>")
    return "\n".join(parts)


def _author_info_rows(manuscript: Manuscript) -> list[tuple[str, str]]:
    owner = manuscript.workspace.owner
    rows = [
        ("Email", owner.author_email.strip()),
        ("Website", owner.author_website.strip()),
        ("Author.Today", owner.author_today_profile.strip()),
        ("Литрес Авторы", owner.author_litres_profile.strip()),
        ("Проза.ру", owner.author_proza_profile.strip()),
        ('Журнал "Самиздат"', owner.author_samizdat_profile.strip()),
        ("Целлюлоза", owner.author_cellulosa_profile.strip()),
        ("Wattpad", owner.author_wattpad_profile.strip()),
    ]
    return [(label, value) for label, value in rows if value]


def _synopsis_page_html(synopsis: str, title: str) -> str:
    content = html.escape(synopsis).replace("\n", "<br />")
    return f"<section><h1>{html.escape(title)}</h1><p>{content}</p></section>"


def _author_info_page_html(author_info: tuple[tuple[str, str], ...], title: str) -> str:
    rows = "".join(
        f"<dt>{html.escape(label)}</dt><dd>{html.escape(value)}</dd>"
        for label, value in author_info
    )
    return f"<section><h1>{html.escape(title)}</h1><dl>{rows}</dl></section>"


def _export_label(language: str, key: str) -> str:
    labels = {
        "en": {
            "author_info": "Author information",
            "contents": "Table of contents",
            "synopsis": "Synopsis",
            "unknown_author": "Unknown author",
        },
        "ru": {
            "author_info": "Информация об авторе",
            "contents": "Оглавление",
            "synopsis": "Синопсис",
            "unknown_author": "Неизвестный автор",
        },
    }
    return labels.get(language, labels["en"])[key]


def _asset_by_public_id(manuscript: Manuscript, asset_id: str) -> ManuscriptAsset | None:
    return (
        ManuscriptAsset.objects.filter(public_id=asset_id, manuscript=manuscript)
        .select_related("manuscript__workspace", "media")
        .first()
    )


def _illustration_export_asset(manuscript: Manuscript, asset_id: str) -> ExportAsset | None:
    asset = _asset_by_public_id(manuscript, asset_id)
    if asset is None:
        return None
    value = media_variant_bytes(asset.media, "original")
    if value is None:
        return None
    data, content_type = value
    return ExportAsset(_asset_path(asset), content_type, data)


def _cover_asset(manuscript: Manuscript) -> bytes | None:
    if not manuscript.cover_media_id:
        return None
    value = media_variant_bytes(manuscript.cover_media, "original")
    return value[0] if value is not None else None


def _cover_export_asset(manuscript: Manuscript) -> ExportAsset | None:
    data = _cover_asset(manuscript)
    if data is None:
        return None
    extension = _extension_for_content_type(manuscript.cover_content_type)
    return ExportAsset(f"assets/cover.{extension}", manuscript.cover_content_type, data)


def _asset_path(asset: ManuscriptAsset) -> str:
    extension = _extension_for_content_type(asset.content_type)
    return f"assets/{asset.public_id}.{extension}"


def _extension_for_content_type(content_type: str) -> str:
    return {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
    }.get(content_type, "bin")


def _markdown_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _export_context(export: ManuscriptExport) -> str:
    return f"manuscripts.export.{export.public_id}.artifact"
