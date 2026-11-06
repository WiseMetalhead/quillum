from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import posixpath
import tempfile
import unicodedata
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import timedelta
from pathlib import PurePosixPath

from django.core.files import File
from django.db import connection, transaction
from django.db.models import F
from django.http import FileResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods

from apps.audit.service import write_audit_event
from apps.manuscripts.download_names import content_disposition, safe_download_name
from apps.manuscripts.exports import ExportError, build_account_document
from apps.manuscripts.glossary_exports import (
    GlossaryExportError,
    build_account_glossary_document,
)
from apps.manuscripts.models import (
    Document,
    Glossary,
    GlossaryArticle,
    GlossaryAsset,
    IdeaItem,
    Manuscript,
    ManuscriptAsset,
    ManuscriptItem,
    ManuscriptNote,
    ManuscriptTask,
    Series,
    SeriesMembership,
)
from apps.notifications.models import Notification
from apps.notifications.service import create_notification, publish_notification_change

from .models import AccountExport, User, UserMediaAsset

logger = logging.getLogger(__name__)

ACCOUNT_EXPORT_TTL = timedelta(days=7)
ACCOUNT_EXPORT_SPOOL_BYTES = 8 * 1024 * 1024
ACCOUNT_EXPORT_CONTENT_TYPE = "application/zip"


class AccountExportError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass
class AccountExportBuild:
    file: object
    file_name: str
    byte_size: int


class ArchiveNames:
    def __init__(self) -> None:
        self._used: dict[str, set[str]] = defaultdict(set)

    def segment(
        self,
        parent: str,
        title: str,
        *,
        order: int | None = None,
        fallback: str,
        identity: str,
    ) -> str:
        value = safe_download_name(title, fallback=fallback)
        prefix = f"{order:03d} - " if order is not None else ""
        candidate = f"{prefix}{value}"
        key = unicodedata.normalize("NFC", candidate).casefold()
        if key in self._used[parent]:
            base = candidate
            suffix = safe_download_name(identity, fallback="duplicate")[:12]
            candidate = f"{base} - {suffix}"
            key = unicodedata.normalize("NFC", candidate).casefold()
            counter = 2
            while key in self._used[parent]:
                candidate = f"{base} - {suffix}-{counter}"
                key = unicodedata.normalize("NFC", candidate).casefold()
                counter += 1
        self._used[parent].add(key)
        return candidate


def _extension(content_type: str, name: str = "") -> str:
    known = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "audio/webm": "webm",
        "audio/ogg": "ogg",
        "audio/mp4": "m4a",
    }
    if content_type in known:
        return known[content_type]
    suffix = PurePosixPath(name).suffix.lower().lstrip(".")
    return suffix if suffix and suffix.isalnum() else "bin"


def _directory(archive: zipfile.ZipFile, path: str) -> None:
    archive.writestr(f"{path.rstrip('/')}/", b"")


def _write_stream(
    archive: zipfile.ZipFile,
    path: str,
    source,
    *,
    expected_hash: str = "",
) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    try:
        with source.open("rb") as input_file, archive.open(
            path,
            "w",
            force_zip64=True,
        ) as output_file:
            while chunk := input_file.read(1024 * 1024):
                output_file.write(chunk)
                digest.update(chunk)
                size += len(chunk)
    except (FileNotFoundError, OSError, ValueError) as exc:
        raise AccountExportError("account_export_source_missing") from exc
    checksum = digest.hexdigest()
    if expected_hash and checksum != expected_hash:
        raise AccountExportError("account_export_source_corrupt")
    return size, checksum


def _json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _byte_metadata(data: bytes) -> tuple[int, str]:
    return len(data), hashlib.sha256(data).hexdigest()


def _relative(target: str, source_file: str) -> str:
    return posixpath.relpath(target, posixpath.dirname(source_file))


def _markdown_escape(value: str) -> str:
    escaped = value.replace("\\", "\\\\")
    for character in "`*{}_[]<>":
        escaped = escaped.replace(character, f"\\{character}")
    return escaped


def _inline_markdown(nodes: list[dict]) -> str:
    result: list[str] = []
    for node in nodes:
        if node.get("type") == "hardBreak":
            result.append("  \n")
            continue
        if node.get("type") != "text":
            continue
        text = _markdown_escape(str(node.get("text", "")))
        mark_types = {mark.get("type") for mark in node.get("marks", [])}
        if "strike" in mark_types:
            text = f"~~{text}~~"
        if "italic" in mark_types:
            text = f"*{text}*"
        if "bold" in mark_types:
            text = f"**{text}**"
        result.append(text)
    return "".join(result)


def _note_markdown_block(node: dict, asset_paths: dict[str, str], output_path: str) -> str:
    node_type = node.get("type")
    if node_type == "paragraph":
        return _inline_markdown(node.get("content", []))
    if node_type in {"bulletList", "taskList"}:
        lines: list[str] = []
        for item in node.get("content", []):
            checked = item.get("attrs", {}).get("checked")
            marker = f"- [{'x' if checked else ' '}]" if node_type == "taskList" else "-"
            children = item.get("content", [])
            first = _note_markdown_block(children[0], asset_paths, output_path) if children else ""
            lines.append(f"{marker} {first}")
            for child in children[1:]:
                rendered = _note_markdown_block(child, asset_paths, output_path)
                lines.extend(f"  {line}" for line in rendered.splitlines())
        return "\n".join(lines)
    if node_type == "illustration":
        attrs = node.get("attrs", {})
        target = asset_paths.get(str(attrs.get("assetId", "")))
        if not target:
            raise AccountExportError("account_export_source_missing")
        alt = _markdown_escape(str(attrs.get("alt", "")))
        caption = _markdown_escape(str(attrs.get("caption", "")))
        value = f"![{alt}]({_relative(target, output_path)})"
        return f"{value}\n\n*{caption}*" if caption else value
    return ""


def _note_markdown(note: ManuscriptNote, asset_paths: dict[str, str], output_path: str) -> bytes:
    parts = [f"# {_markdown_escape(note.title)}"] if note.title.strip() else []
    parts.extend(
        _note_markdown_block(block, asset_paths, output_path)
        for block in note.content.get("content", [])
    )
    return ("\n\n".join(part for part in parts if part).rstrip() + "\n").encode("utf-8")


def _item_tree_paths(
    archive: zipfile.ZipFile,
    names: ArchiveNames,
    manuscript_root: str,
    items: list[ManuscriptItem],
    documents: dict[int, Document],
    export_format: str,
    manuscript: Manuscript,
    asset_paths: dict[str, str],
    manifest_items: list[dict],
) -> dict[int, str]:
    by_id = {item.id: item for item in items}
    children: dict[int | None, list[ManuscriptItem]] = defaultdict(list)
    for item in items:
        children[item.parent_id].append(item)
    for siblings in children.values():
        siblings.sort(key=lambda value: (value.position, value.created_at, value.id))
    item_paths: dict[int, str] = {}

    def visit(item: ManuscriptItem, parent_path: str, order: int, trashed: bool) -> None:
        identity = str(item.public_id)
        segment = names.segment(
            parent_path,
            item.title,
            order=order,
            fallback="item",
            identity=identity,
        )
        if item.kind == ManuscriptItem.KIND_FOLDER:
            path = f"{parent_path}/{segment}"
            _directory(archive, path)
        else:
            extension = {"markdown": "md", "docx": "docx", "odt": "odt"}[export_format]
            path = f"{parent_path}/{segment}.{extension}"
        item_paths[item.id] = path
        document = documents.get(item.id)
        manifest_item = {
            "id": identity,
            "documentId": str(document.public_id) if document is not None else None,
            "parentId": (
                str(by_id[item.parent_id].public_id) if item.parent_id is not None else None
            ),
            "previousParentId": (
                str(item.previous_parent.public_id) if item.previous_parent_id else None
            ),
            "previousPosition": item.previous_position,
            "trashBatchId": str(item.trash_batch_id) if item.trash_batch_id else None,
            "kind": item.kind,
            "title": item.title,
            "path": path,
            "position": item.position,
            "trashedAt": item.trashed_at.isoformat() if item.trashed_at else None,
            "contentType": None,
            "byteSize": None,
            "sha256": None,
        }
        manifest_items.append(manifest_item)
        if document is not None:
            build = build_account_document(
                manuscript,
                document,
                export_format,
                asset_path_for_id=lambda asset_id: _relative(asset_paths[asset_id], path),
            )
            archive.writestr(path, build.data, compress_type=zipfile.ZIP_DEFLATED)
            byte_size, checksum = _byte_metadata(build.data)
            manifest_item.update(
                contentType=build.content_type,
                byteSize=byte_size,
                sha256=checksum,
            )
        for child_order, child in enumerate(children.get(item.id, []), start=1):
            if bool(child.trashed_at) == trashed:
                visit(child, path, child_order, trashed)

    active_root = f"{manuscript_root}/manuscript"
    trash_root = f"{manuscript_root}/_trash/manuscript"
    _directory(archive, active_root)
    active_roots = [
        item
        for item in items
        if item.trashed_at is None
        and (item.parent_id is None or by_id[item.parent_id].trashed_at is not None)
    ]
    for order, item in enumerate(active_roots, start=1):
        visit(item, active_root, order, False)
    trashed_roots = [
        item
        for item in items
        if item.trashed_at is not None
        and (item.parent_id is None or by_id[item.parent_id].trashed_at is None)
    ]
    if trashed_roots:
        _directory(archive, trash_root)
        for order, item in enumerate(trashed_roots, start=1):
            visit(item, trash_root, order, True)
    return item_paths


def _export_glossary(
    archive: zipfile.ZipFile,
    names: ArchiveNames,
    glossary: Glossary,
    root: str,
    export_format: str,
    media_paths: dict[int, str],
    media_usage: dict[int, list[dict]],
    manifest: dict,
) -> None:
    categories = list(glossary.categories.all().order_by("position", "created_at", "id"))
    articles = list(
        GlossaryArticle.objects.filter(glossary=glossary)
        .select_related("category")
        .prefetch_related("assets__media")
        .order_by("category__position", "-updated_at", "id")
    )
    category_paths: dict[int, str] = {}
    article_paths: dict[str, str] = {}
    extension = "md" if export_format == "markdown" else "html"
    scope_id = str(
        glossary.series.public_id if glossary.series_id else glossary.manuscript.public_id
    )
    for order, category in enumerate(categories, start=1):
        segment = names.segment(
            root,
            category.name or category.system_key,
            order=order,
            fallback="category",
            identity=str(category.public_id),
        )
        category_paths[category.id] = f"{root}/{segment}"
        _directory(archive, category_paths[category.id])
        manifest["glossaryCategories"].append(
            {
                "id": str(category.public_id),
                "scope": glossary.scope_type,
                "scopeId": scope_id,
                "name": category.name,
                "systemKey": category.system_key,
                "description": category.description,
                "icon": category.icon,
                "position": category.position,
                "sourceOrder": order,
                "hidden": category.is_hidden,
                "path": category_paths[category.id],
                "createdAt": category.created_at.isoformat(),
                "updatedAt": category.updated_at.isoformat(),
            }
        )
    article_order: dict[int, int] = defaultdict(int)
    for article in articles:
        article_order[article.category_id] += 1
        parent = category_paths[article.category_id]
        segment = names.segment(
            parent,
            article.title,
            order=article_order[article.category_id],
            fallback="article",
            identity=str(article.public_id),
        )
        article_paths[str(article.public_id)] = f"{parent}/{segment}.{extension}"
    for article in articles:
        output_path = article_paths[str(article.public_id)]
        assets = list(article.assets.all())
        illustration_paths: dict[str, str] = {}
        cover_path = None
        for asset in assets:
            source_path = media_paths.get(asset.media_id)
            if source_path is None:
                raise AccountExportError("account_export_source_missing")
            media_usage[asset.media_id].append(
                {
                    "kind": f"glossary_{asset.kind}",
                    "articleId": str(article.public_id),
                    "articlePath": output_path,
                }
            )
            relative_path = _relative(source_path, output_path)
            if asset.kind == GlossaryAsset.KIND_ILLUSTRATION:
                illustration_paths[str(asset.public_id)] = relative_path
            elif asset.kind == GlossaryAsset.KIND_COVER:
                cover_path = relative_path
        try:
            rendered = build_account_glossary_document(
                article,
                export_format,
                asset_paths=illustration_paths,
                cover_path=cover_path,
                article_paths=article_paths,
                current_path=output_path,
            )
        except GlossaryExportError as exc:
            raise AccountExportError(exc.code) from exc
        archive.writestr(output_path, rendered, compress_type=zipfile.ZIP_DEFLATED)
        byte_size, checksum = _byte_metadata(rendered)
        manifest["glossaryArticles"].append(
            {
                "id": str(article.public_id),
                "title": article.title,
                "categoryId": str(article.category.public_id),
                "categoryHidden": article.category.is_hidden,
                "path": output_path,
                "scope": glossary.scope_type,
                "scopeId": scope_id,
                "position": article_order[article.category_id],
                "sourceOrder": article_order[article.category_id],
                "favourite": article.is_favourite,
                "createdAt": article.created_at.isoformat(),
                "updatedAt": article.updated_at.isoformat(),
                "contentType": (
                    "text/markdown; charset=utf-8"
                    if export_format == "markdown"
                    else "text/html; charset=utf-8"
                ),
                "byteSize": byte_size,
                "sha256": checksum,
            }
        )


def _export_manuscript(
    archive: zipfile.ZipFile,
    names: ArchiveNames,
    manuscript: Manuscript,
    root: str,
    manuscript_format: str,
    glossary_format: str,
    media_paths: dict[int, str],
    media_usage: dict[int, list[dict]],
    manifest: dict,
    *,
    private_glossary: bool,
    source_order: int,
    series: Series | None = None,
    series_position: int | None = None,
) -> None:
    _directory(archive, root)
    assets = list(
        ManuscriptAsset.objects.filter(manuscript=manuscript).select_related("media")
    )
    asset_paths: dict[str, str] = {}
    for asset in assets:
        source_path = media_paths.get(asset.media_id)
        if source_path is None:
            raise AccountExportError("account_export_source_missing")
        asset_paths[str(asset.public_id)] = source_path
        media_usage[asset.media_id].append(
            {
                "kind": "manuscript_asset",
                "manuscriptId": str(manuscript.public_id),
                "assetId": str(asset.public_id),
            }
        )
    if manuscript.cover_media_id:
        if manuscript.cover_media_id not in media_paths:
            raise AccountExportError("account_export_source_missing")
        media_usage[manuscript.cover_media_id].append(
            {"kind": "manuscript_cover", "manuscriptId": str(manuscript.public_id)}
        )
    items = list(
        manuscript.items.all()
        .select_related("parent", "previous_parent")
        .order_by("position", "created_at", "id")
    )
    all_documents = list(manuscript.documents.all().select_related("item"))
    documents = {
        document.item_id: document
        for document in all_documents
        if document.item_id
    }
    manifest_items: list[dict] = []
    try:
        item_paths = _item_tree_paths(
            archive,
            names,
            root,
            items,
            documents,
            manuscript_format,
            manuscript,
            asset_paths,
            manifest_items,
        )
    except (ExportError, KeyError, OSError) as exc:
        code = exc.code if isinstance(exc, ExportError) else "account_export_source_missing"
        raise AccountExportError(code) from exc

    active_root = f"{root}/manuscript"
    document_extension = {"markdown": "md", "docx": "docx", "odt": "odt"}[
        manuscript_format
    ]
    for order, document in enumerate(
        (value for value in all_documents if value.item_id is None),
        start=1,
    ):
        segment = names.segment(
            active_root,
            document.title,
            order=order,
            fallback="document",
            identity=str(document.public_id),
        )
        output_path = f"{active_root}/{segment}.{document_extension}"
        try:
            build = build_account_document(
                manuscript,
                document,
                manuscript_format,
                asset_path_for_id=lambda asset_id, output_path=output_path: _relative(
                    asset_paths[asset_id],
                    output_path,
                ),
            )
        except (ExportError, KeyError, OSError) as exc:
            code = exc.code if isinstance(exc, ExportError) else "account_export_source_missing"
            raise AccountExportError(code) from exc
        archive.writestr(output_path, build.data, compress_type=zipfile.ZIP_DEFLATED)
        byte_size, checksum = _byte_metadata(build.data)
        manifest_items.append(
            {
                "id": str(document.public_id),
                "documentId": str(document.public_id),
                "kind": "document",
                "title": document.title,
                "path": output_path,
                "position": order,
                "trashedAt": None,
                "contentType": build.content_type,
                "byteSize": byte_size,
                "sha256": checksum,
            }
        )

    tasks = []
    task_queryset = (
        ManuscriptTask.objects.filter(manuscript=manuscript)
        .select_related("associated_item")
        .order_by("-is_pinned", "-created_at", "id")
    )
    for task_order, task in enumerate(task_queryset, start=1):
        content = task.content
        tasks.append(
            {
                "id": str(task.public_id),
                "title": content.get("title", ""),
                "description": content.get("description", ""),
                "deadline": content.get("deadline"),
                "priority": task.priority,
                "state": "completed" if task.completed_at is not None else "open",
                "sourceOrder": task_order,
                "associatedItemId": (
                    str(task.associated_item.public_id) if task.associated_item_id else None
                ),
                "associatedItemPath": item_paths.get(task.associated_item_id),
                "pinned": task.is_pinned,
                "completed": task.completed_at is not None,
                "completedAt": task.completed_at.isoformat() if task.completed_at else None,
                "createdAt": task.created_at.isoformat(),
                "updatedAt": task.updated_at.isoformat(),
            }
        )
    tasks_path = f"{root}/tasks.json"
    tasks_data = _json_bytes({"schemaVersion": 1, "tasks": tasks})
    archive.writestr(tasks_path, tasks_data)
    task_byte_size, task_checksum = _byte_metadata(tasks_data)
    manifest["taskCollections"].append(
        {
            "manuscriptId": str(manuscript.public_id),
            "path": tasks_path,
            "contentType": "application/json",
            "byteSize": task_byte_size,
            "sha256": task_checksum,
        }
    )

    boards = list(manuscript.boards.all().order_by("position", "created_at", "id"))
    board_paths: dict[tuple[str, int | None], str] = {}
    note_roots = (
        f"{root}/notes/text",
        f"{root}/notes/audio",
        f"{root}/notes/_archive/text",
        f"{root}/notes/_archive/audio",
        f"{root}/notes/_trash/text",
        f"{root}/notes/_trash/audio",
    )
    for note_root in note_roots:
        _directory(archive, note_root)
    for board_order, board in enumerate(boards, start=1):
        board_manifest = {
            "id": str(board.public_id),
            "manuscriptId": str(manuscript.public_id),
            "name": board.name,
            "position": board.position,
            "sourceOrder": board_order,
            "activePaths": [],
            "createdAt": board.created_at.isoformat(),
            "updatedAt": board.updated_at.isoformat(),
        }
        manifest["noteBoards"].append(board_manifest)
        for note_root in note_roots[:2]:
            board_segment = names.segment(
                note_root,
                board.name,
                fallback="board",
                identity=str(board.public_id),
            )
            board_path = f"{note_root}/{board_segment}"
            board_paths[(note_root, board.id)] = board_path
            board_manifest["activePaths"].append(board_path)
            _directory(archive, board_path)
    for tag_order, tag in enumerate(
        manuscript.note_tags.all().order_by("created_at", "id"),
        start=1,
    ):
        manifest["noteTags"].append(
            {
                "id": str(tag.public_id),
                "manuscriptId": str(manuscript.public_id),
                "name": tag.name,
                "color": tag.color,
                "sourceOrder": tag_order,
                "createdAt": tag.created_at.isoformat(),
                "updatedAt": tag.updated_at.isoformat(),
            }
        )
    notes = list(
        manuscript.notes.all()
        .select_related("board", "audio", "audio__transcription")
        .prefetch_related("tags", "associated_items", "assets__media")
        .order_by("-is_pinned", "-updated_at", "id")
    )
    for note_order, note in enumerate(notes, start=1):
        state = "_trash" if note.trashed_at else "_archive" if note.archived_at else ""
        kind = "audio" if note.kind == ManuscriptNote.KIND_AUDIO else "text"
        note_root = f"{root}/notes/{state + '/' if state else ''}{kind}"
        board_name = note.board.name if note.board_id else "_unfiled"
        board_identity = str(note.board.public_id) if note.board_id else "unfiled"
        board_key = (note_root, note.board_id)
        parent = board_paths.get(board_key)
        if parent is None:
            board_segment = names.segment(
                note_root,
                board_name,
                fallback="unfiled",
                identity=board_identity,
            )
            parent = f"{note_root}/{board_segment}"
            board_paths[board_key] = parent
            _directory(archive, parent)
        title = note.title or ("audio-note" if kind == "audio" else "note")
        segment = names.segment(
            parent,
            title,
            order=note_order,
            fallback=kind,
            identity=str(note.public_id),
        )
        note_assets = list(note.assets.all())
        note_asset_paths = {}
        for asset in note_assets:
            source_path = media_paths.get(asset.media_id)
            if source_path is None:
                raise AccountExportError("account_export_source_missing")
            note_asset_paths[str(asset.public_id)] = source_path
            media_usage[asset.media_id].append(
                {
                    "kind": "note_illustration",
                    "manuscriptId": str(manuscript.public_id),
                    "noteId": str(note.public_id),
                }
            )
        if kind == "text":
            output_path = f"{parent}/{segment}.md"
            note_data = _note_markdown(note, note_asset_paths, output_path)
            archive.writestr(
                output_path,
                note_data,
                compress_type=zipfile.ZIP_DEFLATED,
            )
            byte_size, checksum = _byte_metadata(note_data)
            content_type = "text/markdown; charset=utf-8"
        else:
            audio = getattr(note, "audio", None)
            if audio is None or not audio.file:
                raise AccountExportError("account_export_source_missing")
            output_path = f"{parent}/{segment}.{_extension(audio.content_type, audio.file.name)}"
            byte_size, checksum = _write_stream(archive, output_path, audio.file)
            content_type = audio.content_type
        transcription_manifest = None
        if kind == "audio":
            transcription = getattr(audio, "transcription", None)
            if transcription is not None and transcription.text:
                transcription_path = f"{parent}/{segment}.transcript.txt"
                transcription_data = transcription.text.encode("utf-8")
                archive.writestr(
                    transcription_path,
                    transcription_data,
                    compress_type=zipfile.ZIP_DEFLATED,
                )
                transcription_size, transcription_checksum = _byte_metadata(
                    transcription_data
                )
                transcription_manifest = {
                    "path": transcription_path,
                    "language": transcription.language or None,
                    "status": transcription.status,
                    "textUpdatedAt": (
                        transcription.text_updated_at.isoformat()
                        if transcription.text_updated_at
                        else None
                    ),
                    "byteSize": transcription_size,
                    "sha256": transcription_checksum,
                }
        note_manifest = {
            "id": str(note.public_id),
            "manuscriptId": str(manuscript.public_id),
            "kind": note.kind,
            "title": note.title,
            "path": output_path,
            "state": (
                "trash" if note.trashed_at else "archive" if note.archived_at else "active"
            ),
            "sourceOrder": note_order,
            "boardId": str(note.board.public_id) if note.board_id else None,
            "boardName": board_name,
            "pinned": note.is_pinned,
            "favourite": note.is_favourite,
            "color": note.color,
            "tagIds": [str(tag.public_id) for tag in note.tags.all()],
            "associatedItemIds": [
                str(item.public_id) for item in note.associated_items.all()
            ],
            "associatedItemPaths": [
                item_paths.get(item.id) for item in note.associated_items.all()
            ],
            "archivedAt": note.archived_at.isoformat() if note.archived_at else None,
            "trashedAt": note.trashed_at.isoformat() if note.trashed_at else None,
            "createdAt": note.created_at.isoformat(),
            "updatedAt": note.updated_at.isoformat(),
            "contentType": content_type,
            "byteSize": byte_size,
            "sha256": checksum,
        }
        if transcription_manifest is not None:
            note_manifest["transcription"] = transcription_manifest
        manifest["notes"].append(note_manifest)

    glossary = Glossary.objects.filter(manuscript=manuscript).first()
    if glossary is not None:
        glossary_root = f"{root}/_inactive/glossary" if private_glossary else f"{root}/glossary"
        _export_glossary(
            archive,
            names,
            glossary,
            glossary_root,
            glossary_format,
            media_paths,
            media_usage,
            manifest,
        )
    manifest["manuscripts"].append(
        {
            "id": str(manuscript.public_id),
            "title": manuscript.title,
            "kind": manuscript.kind,
            "path": root,
            "drawerAt": manuscript.drawer_at.isoformat() if manuscript.drawer_at else None,
            "sourceOrder": source_order,
            "seriesId": str(series.public_id) if series is not None else None,
            "seriesPosition": series_position,
            "items": manifest_items,
            "tasksPath": tasks_path,
        }
    )


def build_account_export(export: AccountExport) -> AccountExportBuild:
    if connection.in_atomic_block:
        snapshot_export = AccountExport.objects.select_related("owner").get(
            id=export.id,
            public_id=export.public_id,
        )
        return _build_account_export(snapshot_export)
    with transaction.atomic():
        if connection.vendor == "postgresql":
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        snapshot_export = AccountExport.objects.select_related("owner").get(
            id=export.id,
            public_id=export.public_id,
        )
        return _build_account_export(snapshot_export)


def _build_account_export(export: AccountExport) -> AccountExportBuild:
    user = export.owner
    snapshot_at = timezone.now()
    names = ArchiveNames()
    media = list(UserMediaAsset.objects.filter(owner=user).order_by("created_at", "id"))
    media_paths = {
        item.id: (
            f"_originals/images/{item.public_id}."
            f"{_extension(item.content_type, item.original.name)}"
        )
        for item in media
    }
    media_usage: dict[int, list[dict]] = defaultdict(list)
    manifest = {
        "schemaVersion": 3,
        "generatedAt": snapshot_at.isoformat(),
        "formats": {
            "manuscripts": export.manuscript_format,
            "glossary": export.glossary_format,
        },
        "series": [],
        "manuscripts": [],
        "glossaryCategories": [],
        "glossaryArticles": [],
        "noteBoards": [],
        "noteTags": [],
        "notes": [],
        "taskCollections": [],
        "ideas": [],
        "originals": [],
    }
    output = tempfile.SpooledTemporaryFile(max_size=ACCOUNT_EXPORT_SPOOL_BYTES, mode="w+b")
    try:
        with zipfile.ZipFile(output, "w", allowZip64=True) as archive:
            archive.writestr(
                "README.en.txt",
                "Quillum account content export. See manifest.json for stable IDs, "
                "paths, Ideas, file checksums, and audio-note transcript metadata.\n",
            )
            archive.writestr(
                "README.ru.txt",
                "Экспорт содержимого аккаунта Quillum. Стабильные идентификаторы, "
                "пути, Идеи, контрольные суммы и данные расшифровок находятся в manifest.json.\n",
            )
            series_items = list(
                Series.objects.filter(workspace__owner=user)
                .select_related("workspace")
                .order_by("-updated_at", "id")
            )
            series_paths: dict[int, str] = {}
            for order, series in enumerate(series_items, start=1):
                base = "_drawer/series" if series.drawer_at else "series"
                segment = names.segment(
                    base,
                    series.title,
                    order=order,
                    fallback="series",
                    identity=str(series.public_id),
                )
                series_path = f"{base}/{segment}"
                series_paths[series.id] = series_path
                _directory(archive, series_path)
                manifest["series"].append(
                    {
                        "id": str(series.public_id),
                        "title": series.title,
                        "path": series_path,
                        "sourceOrder": order,
                        "drawerAt": (
                            series.drawer_at.isoformat() if series.drawer_at else None
                        ),
                    }
                )
                if series.cover_media_id:
                    if series.cover_media_id not in media_paths:
                        raise AccountExportError("account_export_source_missing")
                    media_usage[series.cover_media_id].append(
                        {"kind": "series_cover", "seriesId": str(series.public_id)}
                    )
                glossary = Glossary.objects.filter(series=series).first()
                if glossary is not None:
                    _export_glossary(
                        archive,
                        names,
                        glossary,
                        f"{series_path}/glossary",
                        export.glossary_format,
                        media_paths,
                        media_usage,
                        manifest,
                    )

            memberships = list(
                SeriesMembership.objects.filter(
                    series__workspace__owner=user,
                    manuscript__workspace__owner=user,
                )
                .select_related("series", "manuscript__workspace")
                .order_by("series_id", F("position").asc(nulls_last=True), "created_at", "id")
            )
            member_ids = {membership.manuscript_id for membership in memberships}
            series_order: dict[int, int] = defaultdict(int)
            for membership in memberships:
                series_order[membership.series_id] += 1
                parent = series_paths[membership.series_id]
                manuscript = membership.manuscript
                segment = names.segment(
                    parent,
                    manuscript.title,
                    order=series_order[membership.series_id],
                    fallback="book",
                    identity=str(manuscript.public_id),
                )
                _export_manuscript(
                    archive,
                    names,
                    manuscript,
                    f"{parent}/{segment}",
                    export.manuscript_format,
                    export.glossary_format,
                    media_paths,
                    media_usage,
                    manifest,
                    private_glossary=True,
                    source_order=series_order[membership.series_id],
                    series=membership.series,
                    series_position=membership.position,
                )

            standalone = list(
                Manuscript.objects.filter(workspace__owner=user)
                .exclude(id__in=member_ids)
                .select_related("workspace")
                .order_by("-updated_at", "id")
            )
            for order, manuscript in enumerate(standalone, start=1):
                base = "_drawer/manuscripts" if manuscript.drawer_at else "manuscripts"
                segment = names.segment(
                    base,
                    manuscript.title,
                    order=order,
                    fallback="manuscript",
                    identity=str(manuscript.public_id),
                )
                _export_manuscript(
                    archive,
                    names,
                    manuscript,
                    f"{base}/{segment}",
                    export.manuscript_format,
                    export.glossary_format,
                    media_paths,
                    media_usage,
                    manifest,
                    private_glossary=False,
                    source_order=order,
                )

            idea_items = list(
                IdeaItem.objects.filter(owner=user)
                .select_related("image_media", "audio", "audio__transcription")
                .order_by("created_at", "id")
            )
            text_idea_order = 0
            audio_idea_order = 0
            for idea in idea_items:
                idea_manifest = {
                    "id": str(idea.public_id),
                    "kind": idea.kind,
                    "createdAt": idea.created_at.isoformat(),
                    "updatedAt": idea.updated_at.isoformat(),
                }
                if idea.kind == IdeaItem.KIND_IMAGE:
                    if idea.image_media_id not in media_paths:
                        raise AccountExportError("account_export_source_missing")
                    idea_manifest["title"] = idea.title
                    idea_manifest["originalPath"] = media_paths[idea.image_media_id]
                    media_usage[idea.image_media_id].append(
                        {"kind": "idea_image", "ideaId": str(idea.public_id)}
                    )
                elif idea.kind == IdeaItem.KIND_TEXT:
                    text_idea_order += 1
                    text_root = "ideas/text"
                    _directory(archive, text_root)
                    segment = names.segment(
                        text_root,
                        idea.title,
                        order=text_idea_order,
                        fallback="idea",
                        identity=str(idea.public_id),
                    )
                    text_path = f"{text_root}/{segment}.txt"
                    text_data = idea.text.encode("utf-8")
                    archive.writestr(text_path, text_data, compress_type=zipfile.ZIP_DEFLATED)
                    text_size, text_checksum = _byte_metadata(text_data)
                    idea_manifest.update(
                        title=idea.title,
                        path=text_path,
                        contentType="text/plain; charset=utf-8",
                        byteSize=text_size,
                        sha256=text_checksum,
                    )
                elif idea.kind == IdeaItem.KIND_AUDIO:
                    audio_idea_order += 1
                    recording = getattr(idea, "audio", None)
                    if recording is None or not recording.file:
                        raise AccountExportError("account_export_source_missing")
                    audio_root = "ideas/audio"
                    _directory(archive, audio_root)
                    segment = names.segment(
                        audio_root,
                        idea.title,
                        order=audio_idea_order,
                        fallback="audio-idea",
                        identity=str(idea.public_id),
                    )
                    audio_path = (
                        f"{audio_root}/{segment}."
                        f"{_extension(recording.content_type, recording.file.name)}"
                    )
                    audio_size, audio_checksum = _write_stream(
                        archive,
                        audio_path,
                        recording.file,
                    )
                    idea_manifest.update(
                        title=idea.title,
                        path=audio_path,
                        contentType=recording.content_type,
                        codec=recording.codec,
                        durationMs=recording.duration_ms,
                        byteSize=audio_size,
                        sha256=audio_checksum,
                    )
                    transcription = getattr(recording, "transcription", None)
                    if transcription is not None and transcription.text:
                        transcription_path = f"{audio_root}/{segment}.transcript.txt"
                        transcription_data = transcription.text.encode("utf-8")
                        archive.writestr(
                            transcription_path,
                            transcription_data,
                            compress_type=zipfile.ZIP_DEFLATED,
                        )
                        transcription_size, transcription_checksum = _byte_metadata(
                            transcription_data
                        )
                        idea_manifest["transcription"] = {
                            "path": transcription_path,
                            "language": transcription.language or None,
                            "status": transcription.status,
                            "textUpdatedAt": (
                                transcription.text_updated_at.isoformat()
                                if transcription.text_updated_at
                                else None
                            ),
                            "byteSize": transcription_size,
                            "sha256": transcription_checksum,
                        }
                manifest["ideas"].append(idea_manifest)

            _directory(archive, "_originals/images")
            for item in media:
                size, checksum = _write_stream(
                    archive,
                    media_paths[item.id],
                    item.original,
                    expected_hash=item.content_hash,
                )
                manifest["originals"].append(
                    {
                        "id": str(item.public_id),
                        "path": media_paths[item.id],
                        "contentType": item.content_type,
                        "byteSize": size,
                        "sha256": checksum,
                        "usages": media_usage[item.id],
                    }
                )
            if user.avatar:
                avatar_content_type = (
                    mimetypes.guess_type(user.avatar.name)[0] or "application/octet-stream"
                )
                avatar_path = (
                    f"_originals/account/avatar."
                    f"{_extension(avatar_content_type, user.avatar.name)}"
                )
                size, checksum = _write_stream(archive, avatar_path, user.avatar)
                manifest["originals"].append(
                    {
                        "id": "account-avatar",
                        "path": avatar_path,
                        "contentType": avatar_content_type,
                        "byteSize": size,
                        "sha256": checksum,
                        "usages": [{"kind": "account_avatar"}],
                    }
                )
            archive.writestr("manifest.json", _json_bytes(manifest))
        output.seek(0, 2)
        byte_size = output.tell()
        output.seek(0)
    except Exception:
        output.close()
        raise
    date = snapshot_at.date().isoformat()
    return AccountExportBuild(output, f"quillum-account-export-{date}.zip", byte_size)


def account_export_payload(export: AccountExport | None) -> dict | None:
    if export is None:
        return None
    expired = bool(
        export.status == AccountExport.STATUS_READY
        and export.expires_at
        and export.expires_at <= timezone.now()
    )
    status = AccountExport.STATUS_EXPIRED if expired else export.status
    return {
        "id": str(export.public_id),
        "manuscriptFormat": export.manuscript_format,
        "glossaryFormat": export.glossary_format,
        "status": status,
        "fileName": export.file_name,
        "byteSize": export.byte_size,
        "errorCode": export.error_code,
        "createdAt": export.created_at.isoformat(),
        "updatedAt": export.updated_at.isoformat(),
        "startedAt": export.started_at.isoformat() if export.started_at else None,
        "completedAt": export.completed_at.isoformat() if export.completed_at else None,
        "expiresAt": export.expires_at.isoformat() if export.expires_at else None,
        "downloadUrl": (
            f"/api/auth/account/export/{export.public_id}/download/"
            if status == AccountExport.STATUS_READY and export.artifact
            else None
        ),
    }


def _delete_stored_artifact(storage, name: str, export_id: int | None) -> bool:
    if not name:
        return True
    try:
        storage.delete(name)
    except Exception:
        logger.exception("Unable to delete account export artifact id=%s", export_id)
        return False
    return True


def _delete_artifact(export: AccountExport) -> None:
    if export.artifact:
        _delete_stored_artifact(export.artifact.storage, export.artifact.name, export.id)


def _dispatch_account_export(export_id: int) -> None:
    from .tasks import build_account_export

    try:
        build_account_export.delay(export_id)
    except Exception:
        logger.exception("Unable to enqueue account export id=%s", export_id)
        AccountExport.objects.filter(id=export_id).update(
            status=AccountExport.STATUS_FAILED,
            error_code="account_export_queue_failed",
            updated_at=timezone.now(),
        )


@require_http_methods(["GET", "POST"])
def account_export(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    current = AccountExport.objects.filter(owner=request.user).first()
    if request.method == "GET":
        return JsonResponse({"export": account_export_payload(current)})
    from .views import read_json, require_recent_auth

    if response := require_recent_auth(request):
        return response
    payload = read_json(request)
    if not isinstance(payload, dict):
        return JsonResponse({"error": "invalid_json"}, status=400)
    manuscript_format = str(
        payload.get("manuscriptFormat", AccountExport.MANUSCRIPT_FORMAT_MARKDOWN)
    )
    glossary_format = str(
        payload.get("glossaryFormat", AccountExport.GLOSSARY_FORMAT_MARKDOWN)
    )
    if manuscript_format not in dict(AccountExport.MANUSCRIPT_FORMAT_CHOICES):
        return JsonResponse({"error": "account_export_manuscript_format_invalid"}, status=400)
    if glossary_format not in dict(AccountExport.GLOSSARY_FORMAT_CHOICES):
        return JsonResponse({"error": "account_export_glossary_format_invalid"}, status=400)
    old_artifact = None
    user_id = request.user.id
    with transaction.atomic():
        User.objects.select_for_update().get(id=user_id)
        current = AccountExport.objects.select_for_update().filter(owner=request.user).first()
        if current is not None and current.status in {
            AccountExport.STATUS_PENDING,
            AccountExport.STATUS_BUILDING,
        }:
            return JsonResponse({"export": account_export_payload(current)}, status=200)
        if current is not None:
            if current.artifact:
                old_artifact = (
                    current.artifact.storage,
                    current.artifact.name,
                    current.id,
                )
            current.delete()
        Notification.objects.filter(
            recipient=request.user,
            kind="service.account_export_ready",
        ).delete()
        export = AccountExport.objects.create(
            owner=request.user,
            manuscript_format=manuscript_format,
            glossary_format=glossary_format,
        )
        transaction.on_commit(lambda export_id=export.id: _dispatch_account_export(export_id))
        if old_artifact is not None:
            transaction.on_commit(
                lambda value=old_artifact: _delete_stored_artifact(*value)
            )
        transaction.on_commit(lambda: publish_notification_change(user_id))
    export.refresh_from_db()
    write_audit_event(
        request,
        "auth.account_export_requested",
        actor=request.user,
        subject=f"user:{request.user.id}",
        payload={
            "exportId": str(export.public_id),
            "manuscriptFormat": manuscript_format,
            "glossaryFormat": glossary_format,
        },
    )
    return JsonResponse({"export": account_export_payload(export)}, status=201)


@require_GET
def account_export_download(request, export_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    export = AccountExport.objects.filter(
        public_id=export_id,
        owner=request.user,
        status=AccountExport.STATUS_READY,
    ).first()
    if export is None:
        return JsonResponse({"error": "account_export_not_found"}, status=404)
    if not export.expires_at or export.expires_at <= timezone.now() or not export.artifact:
        return JsonResponse({"error": "account_export_expired"}, status=410)
    try:
        response = FileResponse(export.artifact.open("rb"), content_type=export.content_type)
    except (FileNotFoundError, OSError, ValueError):
        return JsonResponse({"error": "account_export_source_missing"}, status=410)
    response["Content-Disposition"] = content_disposition(
        export.file_name,
        fallback="account-export",
    )
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    write_audit_event(
        request,
        "auth.account_export_downloaded",
        actor=request.user,
        subject=f"user:{request.user.id}",
        payload={
            "exportId": str(export.public_id),
            "manuscriptFormat": export.manuscript_format,
            "glossaryFormat": export.glossary_format,
        },
    )
    return response


def _notify_ready_account_export(export_id: int, public_id) -> None:
    with transaction.atomic():
        owner_id = AccountExport.objects.filter(
            id=export_id,
            public_id=public_id,
        ).values_list("owner_id", flat=True).first()
        if owner_id is None:
            return
        if not User.objects.select_for_update().filter(id=owner_id).exists():
            return
        export = (
            AccountExport.objects.select_for_update()
            .select_related("owner")
            .filter(
                id=export_id,
                public_id=public_id,
                status=AccountExport.STATUS_READY,
            )
            .first()
        )
        if export is None:
            return
        create_notification(
            recipient=export.owner,
            kind="service.account_export_ready",
            payload={
                "exportId": str(export.public_id),
                "fileName": export.file_name,
                "byteSize": export.byte_size,
                "expiresAt": export.expires_at.isoformat(),
                "downloadPath": (
                    f"/api/auth/account/export/{export.public_id}/download/"
                ),
                "actionPath": "/settings?tab=account",
            },
            deduplication_key=f"account-export-ready:{export.public_id}",
            email=True,
            expires_at=export.expires_at,
        )


def materialize_account_export(export_id: int) -> None:
    with transaction.atomic():
        export = AccountExport.objects.select_for_update().select_related("owner").filter(
            id=export_id
        ).first()
        if export is None or export.status != AccountExport.STATUS_PENDING:
            return
        export.status = AccountExport.STATUS_BUILDING
        export.error_code = ""
        export.started_at = timezone.now()
        export.save(update_fields=["status", "error_code", "started_at", "updated_at"])
    build = None
    stored_artifact = None
    ready_export = None
    try:
        export = AccountExport.objects.select_related("owner").get(id=export_id)
        build = build_account_export(export)
        with transaction.atomic():
            if not User.objects.select_for_update().filter(id=export.owner_id).exists():
                return
            locked = AccountExport.objects.select_for_update().select_related("owner").filter(
                id=export_id
            ).first()
            if locked is None or locked.status != AccountExport.STATUS_BUILDING:
                return
            locked.artifact.save(
                f"{locked.public_id}.zip",
                File(build.file, name=f"{locked.public_id}.zip"),
                save=False,
            )
            stored_artifact = (
                locked.artifact.storage,
                locked.artifact.name,
                locked.id,
            )
            completed_at = timezone.now()
            locked.file_name = build.file_name
            locked.content_type = ACCOUNT_EXPORT_CONTENT_TYPE
            locked.byte_size = build.byte_size
            locked.status = AccountExport.STATUS_READY
            locked.error_code = ""
            locked.completed_at = completed_at
            locked.expires_at = completed_at + ACCOUNT_EXPORT_TTL
            locked.save()
            ready_export = locked
            stored_artifact = None
    except AccountExportError as exc:
        AccountExport.objects.filter(id=export_id).update(
            status=AccountExport.STATUS_FAILED,
            error_code=exc.code,
            updated_at=timezone.now(),
        )
    except Exception:
        if stored_artifact is not None:
            _delete_stored_artifact(*stored_artifact)
        logger.exception("Account export build failed id=%s", export_id)
        AccountExport.objects.filter(id=export_id).update(
            status=AccountExport.STATUS_FAILED,
            error_code="account_export_build_failed",
            updated_at=timezone.now(),
        )
        raise
    else:
        if ready_export is not None:
            try:
                _notify_ready_account_export(
                    ready_export.id,
                    ready_export.public_id,
                )
            except Exception:
                logger.exception(
                    "Unable to create account export notification id=%s",
                    export_id,
                )
    finally:
        if build is not None:
            build.file.close()


def cleanup_expired_account_exports(batch_size: int = 100) -> int:
    exports = list(
        AccountExport.objects.filter(
            status=AccountExport.STATUS_READY,
            expires_at__lte=timezone.now(),
        ).order_by("expires_at")[:batch_size]
    )
    cleaned = 0
    for export in exports:
        if export.artifact and not _delete_stored_artifact(
            export.artifact.storage,
            export.artifact.name,
            export.id,
        ):
            continue
        export.artifact = ""
        export.status = AccountExport.STATUS_EXPIRED
        export.save(update_fields=["artifact", "status", "updated_at"])
        cleaned += 1
    return cleaned
