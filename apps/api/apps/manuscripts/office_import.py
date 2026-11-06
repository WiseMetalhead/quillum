from __future__ import annotations

import re
import zipfile
from io import BytesIO

from docx import Document as DocxDocument
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.table import Table as DocxTable
from docx.text.paragraph import Paragraph as DocxParagraph
from docx.text.run import Run as DocxRun
from odfdo import Document as OdfDocument

from .document_schema import InvalidDocument, validate_document_content

MAX_OFFICE_ARCHIVE_ENTRIES = 2_048
MAX_OFFICE_EXPANDED_BYTES = 32 * 1024 * 1024
OLE_COMPOUND_MAGIC = bytes.fromhex("d0cf11e0a1b11ae1")


class InvalidOfficeImport(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class _InlineBuilder:
    def __init__(self) -> None:
        self.nodes: list[dict] = []

    def text(self, value: str, marks: set[str] | frozenset[str] = frozenset()) -> None:
        value = value.replace("\r\n", "\n").replace("\r", "\n")
        for index, part in enumerate(value.split("\n")):
            if index:
                self.hard_break()
            if not part:
                continue
            mark_nodes = [{"type": mark} for mark in sorted(marks)]
            if self.nodes and self.nodes[-1].get("type") == "text":
                previous_marks = self.nodes[-1].get("marks", [])
                if previous_marks == mark_nodes:
                    self.nodes[-1]["text"] += part
                    continue
            node: dict = {"type": "text", "text": part}
            if mark_nodes:
                node["marks"] = mark_nodes
            self.nodes.append(node)

    def hard_break(self) -> None:
        self.nodes.append({"type": "hardBreak"})

    def extend(self, nodes: list[dict]) -> None:
        for node in nodes:
            if node["type"] == "hardBreak":
                self.hard_break()
            else:
                marks = frozenset(mark["type"] for mark in node.get("marks", []))
                self.text(node["text"], marks)


def _validated_archive(data: bytes, extension: str) -> None:
    if data.startswith(OLE_COMPOUND_MAGIC):
        raise InvalidOfficeImport("import_file_encrypted")
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_OFFICE_ARCHIVE_ENTRIES:
                raise InvalidOfficeImport("import_file_expanded_too_large")
            if len({entry.filename for entry in entries}) != len(entries):
                raise InvalidOfficeImport("import_file_invalid")
            if any(entry.flag_bits & 0x1 for entry in entries):
                raise InvalidOfficeImport("import_file_encrypted")
            expanded_bytes = sum(entry.file_size for entry in entries)
            if expanded_bytes > MAX_OFFICE_EXPANDED_BYTES:
                raise InvalidOfficeImport("import_file_expanded_too_large")
            names = {entry.filename for entry in entries}
            required = (
                {"[Content_Types].xml", "word/document.xml"}
                if extension == ".docx"
                else {"content.xml"}
            )
            if not required.issubset(names):
                raise InvalidOfficeImport("import_file_invalid")
            if extension == ".odt" and "META-INF/manifest.xml" in names:
                manifest = archive.read("META-INF/manifest.xml")
                if b"encryption-data" in manifest:
                    raise InvalidOfficeImport("import_file_encrypted")
    except InvalidOfficeImport:
        raise
    except (
        OSError,
        RuntimeError,
        ValueError,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
    ) as exc:
        raise InvalidOfficeImport("import_file_invalid") from exc


def _block(kind: str, nodes: list[dict], *, level: int = 0, alignment: str = "") -> dict:
    if kind == "sceneBreak":
        return {"type": "sceneBreak"}
    attrs = {}
    if kind == "heading":
        attrs["level"] = level
    if alignment:
        attrs["textAlign"] = alignment
    result: dict = {"type": kind}
    if attrs:
        result["attrs"] = attrs
    if nodes:
        result["content"] = nodes
    return result


def _docx_style_value(style, attribute: str):
    seen: set[int] = set()
    current = style
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        value = getattr(current.font, attribute)
        if value is not None:
            return value
        current = current.base_style
    return None


def _docx_run_marks(run: DocxRun) -> set[str]:
    marks = set()
    for mark, attribute in (("bold", "bold"), ("italic", "italic"), ("strike", "strike")):
        value = getattr(run.font, attribute)
        if value is None:
            value = _docx_style_value(run.style, attribute)
        if value:
            marks.add(mark)
    return marks


def _docx_run_hidden(run: DocxRun) -> bool:
    value = run.font.hidden
    if value is None:
        value = _docx_style_value(run.style, "hidden")
    return bool(value)


def _docx_visible_runs(element, paragraph: DocxParagraph):
    for child in element:
        local_name = child.tag.rsplit("}", 1)[-1]
        if local_name == "r":
            yield DocxRun(child, paragraph)
        elif local_name not in {"del", "moveFrom"}:
            yield from _docx_visible_runs(child, paragraph)


def _docx_paragraph_inlines(paragraph: DocxParagraph) -> list[dict]:
    builder = _InlineBuilder()
    for run in _docx_visible_runs(paragraph._p, paragraph):
        if _docx_run_hidden(run):
            continue
        builder.text(run.text, _docx_run_marks(run))
    return builder.nodes


def _docx_heading_level(paragraph: DocxParagraph) -> int | None:
    paragraph_properties = paragraph._p.pPr
    if paragraph_properties is not None and paragraph_properties.outlineLvl is not None:
        level = int(paragraph_properties.outlineLvl.val) + 1
        return level if level <= 3 else None

    style = paragraph.style
    seen: set[int] = set()
    while style is not None and id(style) not in seen:
        seen.add(id(style))
        style_properties = style._element.pPr
        if style_properties is not None and style_properties.outlineLvl is not None:
            level = int(style_properties.outlineLvl.val) + 1
            return level if level <= 3 else None
        for candidate in (style.style_id, style.name):
            match = re.search(r"heading[ _-]?(\d+)", candidate or "", re.IGNORECASE)
            if match:
                level = int(match.group(1))
                return level if level <= 3 else None
        style = style.base_style
    return None


def _docx_alignment(paragraph: DocxParagraph) -> str:
    alignment = paragraph.alignment
    style = paragraph.style
    seen: set[int] = set()
    while alignment is None and style is not None and id(style) not in seen:
        seen.add(id(style))
        alignment = style.paragraph_format.alignment
        style = style.base_style
    return {
        WD_ALIGN_PARAGRAPH.LEFT: "left",
        WD_ALIGN_PARAGRAPH.CENTER: "center",
        WD_ALIGN_PARAGRAPH.RIGHT: "right",
    }.get(alignment, "")


def _docx_paragraph_block(paragraph: DocxParagraph) -> dict:
    nodes = _docx_paragraph_inlines(paragraph)
    visible_text = "".join(node.get("text", "") for node in nodes).strip()
    if visible_text == "***":
        return _block("sceneBreak", [])
    level = _docx_heading_level(paragraph)
    return _block(
        "heading" if level else "paragraph",
        nodes,
        level=level or 0,
        alignment=_docx_alignment(paragraph),
    )


def _docx_cell_inlines(cell) -> list[dict]:
    builder = _InlineBuilder()
    for index, item in enumerate(cell.iter_inner_content()):
        if index:
            builder.hard_break()
        if isinstance(item, DocxParagraph):
            builder.extend(_docx_paragraph_inlines(item))
        elif isinstance(item, DocxTable):
            for block_index, block in enumerate(_docx_table_blocks(item)):
                if block_index:
                    builder.hard_break()
                builder.extend(block.get("content", []))
    return builder.nodes


def _docx_table_blocks(table: DocxTable) -> list[dict]:
    blocks = []
    for row in table.rows:
        builder = _InlineBuilder()
        seen_cells: set[int] = set()
        for cell in row.cells:
            cell_key = id(cell._tc)
            if cell_key in seen_cells:
                continue
            if seen_cells:
                builder.text(" | ")
            seen_cells.add(cell_key)
            builder.extend(_docx_cell_inlines(cell))
        blocks.append(_block("paragraph", builder.nodes))
    return blocks


def _docx_to_document(data: bytes) -> dict:
    document = DocxDocument(BytesIO(data))
    blocks: list[dict] = []
    for item in document.iter_inner_content():
        if isinstance(item, DocxParagraph):
            blocks.append(_docx_paragraph_block(item))
        elif isinstance(item, DocxTable):
            blocks.extend(_docx_table_blocks(item))
    return {"type": "doc", "content": blocks or [{"type": "paragraph"}]}


def _odt_style_chain(document: OdfDocument, family: str, name: str | None) -> list:
    chain = []
    seen: set[str] = set()
    current_name = name
    while current_name and current_name not in seen:
        seen.add(current_name)
        style = document.get_style(family, current_name)
        if style is None:
            break
        chain.append(style)
        current_name = style.parent_style
    chain.reverse()
    return chain


def _odt_style_marks(
    document: OdfDocument,
    style_name: str | None,
    inherited: set[str],
) -> set[str]:
    marks = set(inherited)
    for style in _odt_style_chain(document, "text", style_name):
        properties = style.get_properties("text") or {}
        weight = properties.get("fo:font-weight")
        if weight is not None:
            try:
                bold = int(weight) >= 600
            except (TypeError, ValueError):
                bold = str(weight).lower() == "bold"
            if bold:
                marks.add("bold")
            else:
                marks.discard("bold")
        font_style = properties.get("fo:font-style")
        if font_style is not None:
            italic = str(font_style).lower() in {"italic", "oblique"}
            if italic:
                marks.add("italic")
            else:
                marks.discard("italic")
        strike = properties.get("style:text-line-through-style")
        if strike is not None:
            enabled = str(strike).lower() not in {"", "none"}
            if enabled:
                marks.add("strike")
            else:
                marks.discard("strike")
    return marks


def _odt_inline_nodes(document: OdfDocument, element, inherited=None) -> list[dict]:
    marks = set(inherited or ())
    builder = _InlineBuilder()
    builder.text(element.text or "", marks)
    skipped = {"draw:frame", "draw:object", "office:annotation", "text:note"}
    for child in element.children:
        tag = child.tag
        if tag == "text:line-break":
            builder.hard_break()
        elif tag == "text:tab":
            builder.text("\t", marks)
        elif tag == "text:s":
            raw_count = child.get_attribute("text:c") or 1
            try:
                count = min(int(raw_count), 1_000)
            except (TypeError, ValueError):
                count = 1
            builder.text(" " * max(count, 1), marks)
        elif tag in skipped:
            pass
        else:
            child_marks = marks
            if tag == "text:span":
                child_marks = _odt_style_marks(document, child.style, marks)
            builder.extend(_odt_inline_nodes(document, child, child_marks))
        builder.text(child.tail or "", marks)
    return builder.nodes


def _odt_heading_level(document: OdfDocument, element) -> int | None:
    raw_level = element.get_attribute("text:outline-level")
    if raw_level is not None:
        try:
            level = int(raw_level)
        except (TypeError, ValueError):
            level = 0
        return level if 1 <= level <= 3 else None
    for style in reversed(_odt_style_chain(document, "paragraph", element.style)):
        raw_level = style.get_attribute("style:default-outline-level")
        if raw_level is not None:
            try:
                level = int(raw_level)
            except (TypeError, ValueError):
                level = 0
            return level if 1 <= level <= 3 else None
        match = re.search(r"(?:heading|heading_20_)(\d+)", style.name or "", re.IGNORECASE)
        if match:
            level = int(match.group(1))
            return level if level <= 3 else None
    return None


def _odt_alignment(document: OdfDocument, element) -> str:
    alignment = ""
    for style in _odt_style_chain(document, "paragraph", element.style):
        properties = style.get_properties("paragraph") or {}
        value = str(properties.get("fo:text-align") or "").lower()
        alignment = {
            "left": "left",
            "start": "left",
            "center": "center",
            "right": "right",
            "end": "right",
        }.get(value, alignment)
    return alignment


def _odt_paragraph_block(document: OdfDocument, element) -> dict:
    nodes = _odt_inline_nodes(document, element)
    visible_text = "".join(node.get("text", "") for node in nodes).strip()
    if visible_text == "***":
        return _block("sceneBreak", [])
    level = _odt_heading_level(document, element)
    return _block(
        "heading" if level else "paragraph",
        nodes,
        level=level or 0,
        alignment=_odt_alignment(document, element),
    )


def _odt_physical_rows(container):
    for child in container.children:
        if child.tag == "table:table-row":
            yield child
        elif child.tag in {
            "table:table-header-rows",
            "table:table-row-group",
            "table:table-rows",
        }:
            yield from _odt_physical_rows(child)


def _odt_table_blocks(document: OdfDocument, table) -> list[dict]:
    blocks = []
    for row in _odt_physical_rows(table):
        builder = _InlineBuilder()
        cells = [
            child
            for child in row.children
            if child.tag in {"table:table-cell", "table:covered-table-cell"}
        ]
        for index, cell in enumerate(cells):
            if index:
                builder.text(" | ")
            cell_blocks = _odt_container_blocks(document, cell)
            for block_index, block in enumerate(cell_blocks):
                if block_index:
                    builder.hard_break()
                if block["type"] == "sceneBreak":
                    builder.text("***")
                else:
                    builder.extend(block.get("content", []))
        blocks.append(_block("paragraph", builder.nodes))
    return blocks


def _odt_container_blocks(document: OdfDocument, container) -> list[dict]:
    blocks = []
    for child in container.children:
        if child.tag in {"text:p", "text:h"}:
            blocks.append(_odt_paragraph_block(document, child))
        elif child.tag == "table:table":
            blocks.extend(_odt_table_blocks(document, child))
        elif child.tag in {"draw:frame", "office:annotation", "text:tracked-changes"}:
            continue
        elif child.children:
            blocks.extend(_odt_container_blocks(document, child))
    return blocks


def _odt_to_document(data: bytes) -> dict:
    document = OdfDocument(BytesIO(data))
    blocks = _odt_container_blocks(document, document.body)
    return {"type": "doc", "content": blocks or [{"type": "paragraph"}]}


def office_source_to_document(data: bytes, extension: str) -> dict:
    if extension not in {".docx", ".odt"}:
        raise InvalidOfficeImport("import_file_invalid")
    _validated_archive(data, extension)
    try:
        content = _docx_to_document(data) if extension == ".docx" else _odt_to_document(data)
        return validate_document_content(content)
    except InvalidOfficeImport:
        raise
    except InvalidDocument as exc:
        raise InvalidOfficeImport(str(exc)) from exc
    except Exception as exc:
        raise InvalidOfficeImport("import_file_invalid") from exc
