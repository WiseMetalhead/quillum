from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

from .document_schema import InvalidDocument, validate_document_content
from .office_import import InvalidOfficeImport, office_source_to_document

MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024
MAX_IMPORT_TOTAL_BYTES = 25 * 1024 * 1024
MAX_IMPORT_FILES = 100
MAX_IMPORT_FOLDERS = 30
MAX_IMPORT_NODES = MAX_IMPORT_FILES + MAX_IMPORT_FOLDERS
MAX_FOLDER_DEPTH = 3
MAX_TITLE_LENGTH = 240
SUPPORTED_EXTENSIONS = {".docx", ".md", ".odt", ".txt"}


class InvalidTextImport(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ImportedNode:
    node_id: str
    parent_id: str | None
    kind: str
    title: str
    order: int
    content: dict | None = None


@dataclass(frozen=True)
class ImportPlan:
    nodes: tuple[ImportedNode, ...]


def decode_text_source(data: bytes) -> str:
    if b"\x00" in data:
        raise InvalidTextImport("import_file_binary")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1251")


def _text_node(text: str, marks: set[str]) -> dict | None:
    if not text:
        return None
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = [{"type": mark} for mark in sorted(marks)]
    return node


def _inline_nodes(value: str, *, markdown: bool) -> list[dict]:
    if not markdown:
        return [{"type": "text", "text": value}] if value else []
    value = re.sub(r"!\[[^\]]*]\([^)]*\)", "", value)
    value = re.sub(r"!\[[^\]]*]\[[^\]]*]", "", value)
    value = re.sub(r"\[([^\]]+)]\([^)]*\)", r"\1", value)
    value = re.sub(r"\[([^\]]+)]\[[^\]]*]", r"\1", value)
    value = re.sub(r"`([^`]+)`", r"\1", value)
    value = re.sub(r"<[^>]+>", "", value)
    tokens = re.split(r"(\*\*|__|~~|\*|_)", value)
    marks: set[str] = set()
    nodes: list[dict] = []
    mark_for_token = {
        "**": "bold",
        "__": "bold",
        "*": "italic",
        "_": "italic",
        "~~": "strike",
    }
    for token in tokens:
        mark = mark_for_token.get(token)
        if mark is not None:
            if mark in marks:
                marks.remove(mark)
            else:
                marks.add(mark)
            continue
        node = _text_node(token, marks)
        if node is not None:
            nodes.append(node)
    return nodes


def _paragraph(lines: list[str], *, markdown: bool, heading: int | None = None) -> dict:
    content: list[dict] = []
    for index, line in enumerate(lines):
        if index:
            content.append({"type": "hardBreak"})
        content.extend(_inline_nodes(line, markdown=markdown))
    block: dict = {"type": "heading", "attrs": {"level": heading}} if heading else {
        "type": "paragraph"
    }
    if content:
        block["content"] = content
    return block


def source_to_basic_content(
    source: str,
    extension: str,
    *,
    max_heading_level: int,
    separator_type: str,
) -> dict:
    markdown = extension == ".md"
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if markdown and lines and lines[0].strip() == "---":
        closing = next(
            (index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---"),
            None,
        )
        if closing is not None:
            lines = lines[closing + 1 :]

    blocks: list[dict] = []
    pending: list[str] = []
    in_fence = False

    def flush() -> None:
        if pending:
            block = _paragraph(pending.copy(), markdown=markdown and not in_fence)
            if not markdown or block.get("content"):
                blocks.append(block)
            pending.clear()

    for raw_line in lines:
        line = raw_line
        if markdown and line.strip().startswith("```"):
            flush()
            in_fence = not in_fence
            continue
        if not line.strip():
            flush()
            continue
        if markdown and not in_fence and line.strip() == "***":
            flush()
            blocks.append({"type": separator_type})
            continue
        heading_match = re.match(r"^(#{1,6})\s+(.+)$", line) if markdown and not in_fence else None
        if heading_match:
            flush()
            level = len(heading_match.group(1))
            title = heading_match.group(2)
            block = _paragraph(
                [title],
                markdown=True,
                heading=level if level <= max_heading_level else None,
            )
            if block.get("content"):
                blocks.append(block)
            continue
        if markdown and not in_fence:
            if re.match(r"^\s{0,3}\[[^\]]+]:\s+\S+", line):
                continue
            line = re.sub(r"^\s{0,3}(?:[-+*]|\d+[.)])\s+", "", line)
            line = re.sub(r"^\s{0,3}>\s?", "", line)
        pending.append(line)
    flush()
    return {"type": "doc", "content": blocks or [{"type": "paragraph"}]}


def source_to_document(source: str, extension: str) -> dict:
    content = source_to_basic_content(
        source,
        extension,
        max_heading_level=3,
        separator_type="sceneBreak",
    )
    try:
        return validate_document_content(content)
    except InvalidDocument as exc:
        raise InvalidTextImport(str(exc)) from exc


def parse_import_plan(raw_manifest: str, uploaded_files, *, kind: str) -> ImportPlan:
    try:
        manifest = json.loads(raw_manifest)
    except (json.JSONDecodeError, TypeError) as exc:
        raise InvalidTextImport("import_manifest_invalid") from exc
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise InvalidTextImport("import_manifest_invalid")
    raw_nodes = manifest.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes or len(raw_nodes) > MAX_IMPORT_NODES:
        raise InvalidTextImport("import_node_limit_invalid")

    by_id: dict[str, ImportedNode] = {}
    file_keys: set[str] = set()
    total_bytes = 0
    document_count = sum(
        1
        for raw_node in raw_nodes
        if isinstance(raw_node, dict) and raw_node.get("kind") == "document"
    )
    if document_count < 1 or document_count > MAX_IMPORT_FILES:
        raise InvalidTextImport("import_file_count_invalid")
    folder_count = sum(
        1
        for raw_node in raw_nodes
        if isinstance(raw_node, dict) and raw_node.get("kind") == "folder"
    )
    if folder_count > MAX_IMPORT_FOLDERS:
        raise InvalidTextImport("import_folder_count_invalid")
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict):
            raise InvalidTextImport("import_node_invalid")
        node_id = str(raw_node.get("id") or "")
        parent_id = raw_node.get("parentId")
        parent_id = str(parent_id) if parent_id is not None else None
        node_kind = raw_node.get("kind")
        title = str(raw_node.get("title") or "").strip()
        order = raw_node.get("order")
        if (
            not node_id
            or len(node_id) > 100
            or node_id in by_id
            or node_kind not in {"folder", "document"}
            or not title
            or len(title) > MAX_TITLE_LENGTH
            or isinstance(order, bool)
            or not isinstance(order, int)
            or order < 0
        ):
            raise InvalidTextImport("import_node_invalid")
        content = None
        if node_kind == "document":
            file_key = str(raw_node.get("fileKey") or "")
            source_path = str(raw_node.get("sourcePath") or "")
            if not file_key or file_key in file_keys or file_key not in uploaded_files:
                raise InvalidTextImport("import_file_missing")
            extension = PurePosixPath(source_path).suffix.lower()
            if extension not in SUPPORTED_EXTENSIONS:
                raise InvalidTextImport("import_file_type_unsupported")
            uploaded = uploaded_files[file_key]
            if uploaded.size > MAX_IMPORT_FILE_BYTES:
                raise InvalidTextImport("import_file_too_large")
            total_bytes += uploaded.size
            if total_bytes > MAX_IMPORT_TOTAL_BYTES:
                raise InvalidTextImport("import_total_too_large")
            file_keys.add(file_key)
            source_bytes = uploaded.read()
            if extension in {".docx", ".odt"}:
                try:
                    content = office_source_to_document(source_bytes, extension)
                except InvalidOfficeImport as exc:
                    raise InvalidTextImport(exc.code) from exc
            else:
                content = source_to_document(decode_text_source(source_bytes), extension)
        by_id[node_id] = ImportedNode(
            node_id=node_id,
            parent_id=parent_id,
            kind=node_kind,
            title=title,
            order=order,
            content=content,
        )

    documents = [node for node in by_id.values() if node.kind == "document"]
    if kind == "oneshot" and (
        len(by_id) != 1 or len(documents) != 1 or documents[0].parent_id is not None
    ):
        raise InvalidTextImport("import_oneshot_structure_invalid")

    depths: dict[str, int] = {}

    def depth(node: ImportedNode, trail: set[str]) -> int:
        if node.node_id in depths:
            return depths[node.node_id]
        if node.node_id in trail:
            raise InvalidTextImport("import_structure_cycle")
        if node.parent_id is None:
            value = 0
        else:
            parent = by_id.get(node.parent_id)
            if parent is None or parent.kind != "folder":
                raise InvalidTextImport("import_parent_invalid")
            value = depth(parent, trail | {node.node_id}) + 1
        depths[node.node_id] = value
        return value

    for node in by_id.values():
        node_depth = depth(node, set())
        folder_depth = node_depth + (1 if node.kind == "folder" else 0)
        if folder_depth > MAX_FOLDER_DEPTH:
            raise InvalidTextImport("import_max_depth_exceeded")
    return ImportPlan(nodes=tuple(sorted(by_id.values(), key=lambda node: node.order)))
