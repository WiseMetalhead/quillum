from __future__ import annotations

import json
import uuid
from urllib.parse import urlparse

MAX_GLOSSARY_BYTES = 5 * 1024 * 1024
ALLOWED_TEXT_ALIGNMENTS = {"left", "center", "right"}
ALLOWED_ILLUSTRATION_ALIGNMENTS = {"left", "center", "right"}
# note/tip remain readable for articles created before the current callout palette.
ALLOWED_CALLOUT_KINDS = {"info", "attention", "warning", "check", "note", "tip"}
SIMPLE_MARKS = {"bold", "italic", "strike", "underline"}


class InvalidGlossaryContent(ValueError):
    pass


def _validate_external_link(attrs: object) -> None:
    if not isinstance(attrs, dict) or not set(attrs).issubset(
        {"href", "target", "rel", "class", "title"}
    ):
        raise InvalidGlossaryContent("glossary_link_invalid")
    href = attrs.get("href")
    if not isinstance(href, str) or not href or len(href) > 2_000:
        raise InvalidGlossaryContent("glossary_link_invalid")
    parsed = urlparse(href)
    if parsed.scheme.lower() not in {"http", "https", "mailto"}:
        raise InvalidGlossaryContent("glossary_link_protocol_unsupported")
    for name in ("target", "rel", "class", "title"):
        value = attrs.get(name)
        if value is not None and not isinstance(value, str):
            raise InvalidGlossaryContent("glossary_link_invalid")


def _validate_marks(marks: object) -> None:
    if not isinstance(marks, list):
        raise InvalidGlossaryContent("glossary_marks_invalid")
    for mark in marks:
        if not isinstance(mark, dict) or not isinstance(mark.get("type"), str):
            raise InvalidGlossaryContent("glossary_mark_invalid")
        mark_type = mark["type"]
        if mark_type in SIMPLE_MARKS:
            if set(mark) != {"type"}:
                raise InvalidGlossaryContent("glossary_mark_invalid")
        elif mark_type == "link":
            if set(mark) != {"type", "attrs"}:
                raise InvalidGlossaryContent("glossary_link_invalid")
            _validate_external_link(mark["attrs"])
        elif mark_type == "glossaryLink":
            if set(mark) != {"type", "attrs"} or not isinstance(mark["attrs"], dict):
                raise InvalidGlossaryContent("glossary_internal_link_invalid")
            if set(mark["attrs"]) != {"articleId"}:
                raise InvalidGlossaryContent("glossary_internal_link_invalid")
            try:
                uuid.UUID(str(mark["attrs"]["articleId"]))
            except (ValueError, TypeError, AttributeError) as exc:
                raise InvalidGlossaryContent("glossary_internal_link_invalid") from exc
        else:
            raise InvalidGlossaryContent("glossary_mark_unsupported")


def _validate_inline(node: object) -> None:
    if not isinstance(node, dict) or not isinstance(node.get("type"), str):
        raise InvalidGlossaryContent("glossary_node_invalid")
    if node["type"] == "hardBreak":
        if set(node) != {"type"}:
            raise InvalidGlossaryContent("glossary_node_invalid")
        return
    if node["type"] != "text" or not isinstance(node.get("text"), str) or not node["text"]:
        raise InvalidGlossaryContent("glossary_node_unsupported")
    if not set(node).issubset({"type", "text", "marks"}):
        raise InvalidGlossaryContent("glossary_node_invalid")
    if "marks" in node:
        _validate_marks(node["marks"])


def _validate_text_block(node: object, *, heading: bool = False) -> None:
    expected_type = "heading" if heading else "paragraph"
    if not isinstance(node, dict) or node.get("type") != expected_type:
        raise InvalidGlossaryContent("glossary_block_invalid")
    if not set(node).issubset({"type", "attrs", "content"}):
        raise InvalidGlossaryContent("glossary_block_invalid")
    attrs = node.get("attrs", {})
    if not isinstance(attrs, dict):
        raise InvalidGlossaryContent("glossary_block_invalid")
    allowed_attrs = {"textAlign", "level"} if heading else {"textAlign"}
    if not set(attrs).issubset(allowed_attrs):
        raise InvalidGlossaryContent("glossary_block_invalid")
    if heading and (
        isinstance(attrs.get("level"), bool) or attrs.get("level") not in {1, 2, 3, 4, 5}
    ):
        raise InvalidGlossaryContent("glossary_heading_invalid")
    alignment = attrs.get("textAlign")
    if alignment is not None and alignment not in ALLOWED_TEXT_ALIGNMENTS:
        raise InvalidGlossaryContent("glossary_alignment_unsupported")
    content = node.get("content", [])
    if not isinstance(content, list):
        raise InvalidGlossaryContent("glossary_content_invalid")
    for child in content:
        _validate_inline(child)


def _validate_list(node: object) -> None:
    if (
        not isinstance(node, dict)
        or node.get("type") not in {"bulletList", "orderedList"}
        or not set(node).issubset({"type", "attrs", "content"})
        or not isinstance(node.get("content"), list)
    ):
        raise InvalidGlossaryContent("glossary_list_invalid")
    attrs = node.get("attrs", {})
    if not isinstance(attrs, dict) or not set(attrs).issubset({"start", "type"}):
        raise InvalidGlossaryContent("glossary_list_invalid")
    if "start" in attrs and (
        isinstance(attrs["start"], bool)
        or not isinstance(attrs["start"], int)
        or attrs["start"] < 1
    ):
        raise InvalidGlossaryContent("glossary_list_invalid")
    list_type = attrs.get("type")
    if list_type is not None and list_type not in {"1", "a", "A", "i", "I"}:
        raise InvalidGlossaryContent("glossary_list_invalid")
    for item in node["content"]:
        if (
            not isinstance(item, dict)
            or item.get("type") != "listItem"
            or set(item) != {"type", "content"}
            or not isinstance(item["content"], list)
            or not item["content"]
        ):
            raise InvalidGlossaryContent("glossary_list_item_invalid")
        for child in item["content"]:
            child_type = child.get("type") if isinstance(child, dict) else None
            if child_type == "paragraph":
                _validate_text_block(child)
            elif child_type in {"bulletList", "orderedList"}:
                _validate_list(child)
            else:
                raise InvalidGlossaryContent("glossary_list_item_invalid")


def _validate_blockquote(node: object) -> None:
    if (
        not isinstance(node, dict)
        or node.get("type") != "blockquote"
        or set(node) != {"type", "content"}
        or not isinstance(node["content"], list)
        or not node["content"]
    ):
        raise InvalidGlossaryContent("glossary_blockquote_invalid")
    for child in node["content"]:
        _validate_text_block(child)


def _validate_callout(node: object) -> None:
    if (
        not isinstance(node, dict)
        or node.get("type") != "callout"
        or set(node) != {"type", "attrs", "content"}
        or not isinstance(node["attrs"], dict)
        or set(node["attrs"]) != {"kind"}
        or node["attrs"]["kind"] not in ALLOWED_CALLOUT_KINDS
        or not isinstance(node["content"], list)
        or not node["content"]
    ):
        raise InvalidGlossaryContent("glossary_callout_invalid")
    for child in node["content"]:
        _validate_text_block(child)


def _validate_table_cell(cell: object) -> None:
    if (
        not isinstance(cell, dict)
        or cell.get("type") not in {"tableCell", "tableHeader"}
        or not set(cell).issubset({"type", "attrs", "content"})
        or not isinstance(cell.get("content"), list)
        or not cell["content"]
    ):
        raise InvalidGlossaryContent("glossary_table_cell_invalid")
    attrs = cell.get("attrs", {})
    if not isinstance(attrs, dict) or not set(attrs).issubset(
        {"colspan", "rowspan", "colwidth", "align"}
    ):
        raise InvalidGlossaryContent("glossary_table_cell_invalid")
    for span_name in ("colspan", "rowspan"):
        span = attrs.get(span_name, 1)
        if isinstance(span, bool) or not isinstance(span, int) or not 1 <= span <= 20:
            raise InvalidGlossaryContent("glossary_table_cell_invalid")
    colwidth = attrs.get("colwidth")
    if colwidth is not None and (
        not isinstance(colwidth, list)
        or any(
            isinstance(width, bool) or not isinstance(width, int) or width < 1
            for width in colwidth
        )
    ):
        raise InvalidGlossaryContent("glossary_table_cell_invalid")
    align = attrs.get("align")
    if align is not None and align not in ALLOWED_TEXT_ALIGNMENTS:
        raise InvalidGlossaryContent("glossary_table_cell_invalid")
    for child in cell["content"]:
        if isinstance(child, dict) and child.get("type") == "table":
            raise InvalidGlossaryContent("glossary_table_nested_invalid")
        _validate_text_block(child)


def _validate_table(node: object) -> None:
    if (
        not isinstance(node, dict)
        or node.get("type") != "table"
        or not set(node).issubset({"type", "attrs", "content"})
        or not isinstance(node.get("content"), list)
        or not node["content"]
    ):
        raise InvalidGlossaryContent("glossary_table_invalid")
    attrs = node.get("attrs", {})
    if not isinstance(attrs, dict) or attrs:
        raise InvalidGlossaryContent("glossary_table_invalid")
    for row in node["content"]:
        if (
            not isinstance(row, dict)
            or row.get("type") != "tableRow"
            or set(row) != {"type", "content"}
            or not isinstance(row["content"], list)
            or not row["content"]
        ):
            raise InvalidGlossaryContent("glossary_table_row_invalid")
        for cell in row["content"]:
            _validate_table_cell(cell)


def _validate_illustration(node: object) -> None:
    if (
        not isinstance(node, dict)
        or node.get("type") != "illustration"
        or set(node) != {"type", "attrs"}
    ):
        raise InvalidGlossaryContent("glossary_illustration_invalid")
    attrs = node["attrs"]
    if (
        not isinstance(attrs, dict)
        or not set(attrs).issubset(
            {"assetId", "alt", "caption", "alignment", "displayWidth"}
        )
        or not {"assetId", "alt", "caption", "alignment"}.issubset(attrs)
    ):
        raise InvalidGlossaryContent("glossary_illustration_invalid")
    try:
        uuid.UUID(str(attrs["assetId"]))
    except (ValueError, TypeError, AttributeError) as exc:
        raise InvalidGlossaryContent("glossary_illustration_asset_invalid") from exc
    if not isinstance(attrs["alt"], str) or len(attrs["alt"]) > 500:
        raise InvalidGlossaryContent("glossary_illustration_alt_invalid")
    if not isinstance(attrs["caption"], str) or len(attrs["caption"]) > 2_000:
        raise InvalidGlossaryContent("glossary_illustration_caption_invalid")
    if attrs["alignment"] not in ALLOWED_ILLUSTRATION_ALIGNMENTS:
        raise InvalidGlossaryContent("glossary_illustration_alignment_invalid")
    display_width = attrs.get("displayWidth", 100)
    if (
        isinstance(display_width, bool)
        or not isinstance(display_width, int)
        or not 25 <= display_width <= 100
    ):
        raise InvalidGlossaryContent("glossary_illustration_width_invalid")


def _validate_illustration_gallery(node: object) -> None:
    if (
        not isinstance(node, dict)
        or node.get("type") != "illustrationGallery"
        or set(node) != {"type", "content"}
        or not isinstance(node["content"], list)
        or len(node["content"]) < 2
    ):
        raise InvalidGlossaryContent("glossary_illustration_gallery_invalid")
    for illustration in node["content"]:
        _validate_illustration(illustration)


def _walk_nodes(node: object):
    if not isinstance(node, dict):
        return
    yield node
    for child in node.get("content", []):
        yield from _walk_nodes(child)


def validate_glossary_content(value: object) -> dict:
    if (
        not isinstance(value, dict)
        or value.get("type") != "doc"
        or not set(value).issubset({"type", "content"})
        or not isinstance(value.get("content", []), list)
    ):
        raise InvalidGlossaryContent("glossary_root_invalid")
    for block in value.get("content", []):
        block_type = block.get("type") if isinstance(block, dict) else None
        if block_type == "paragraph":
            _validate_text_block(block)
        elif block_type == "heading":
            _validate_text_block(block, heading=True)
        elif block_type in {"bulletList", "orderedList"}:
            _validate_list(block)
        elif block_type == "blockquote":
            _validate_blockquote(block)
        elif block_type == "callout":
            _validate_callout(block)
        elif block_type == "table":
            _validate_table(block)
        elif block_type == "horizontalRule":
            if set(block) != {"type"}:
                raise InvalidGlossaryContent("glossary_horizontal_rule_invalid")
        elif block_type == "illustration":
            _validate_illustration(block)
        elif block_type == "illustrationGallery":
            _validate_illustration_gallery(block)
        else:
            raise InvalidGlossaryContent("glossary_block_unsupported")
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(serialized) > MAX_GLOSSARY_BYTES:
        raise InvalidGlossaryContent("glossary_content_too_large")
    return value


def glossary_asset_ids_in_order(content: dict) -> list[uuid.UUID]:
    result: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for node in _walk_nodes(content):
        if node.get("type") == "illustration":
            asset_id = uuid.UUID(str(node["attrs"]["assetId"]))
            if asset_id not in seen:
                seen.add(asset_id)
                result.append(asset_id)
    return result


def glossary_asset_ids(content: dict) -> set[uuid.UUID]:
    return set(glossary_asset_ids_in_order(content))


def glossary_article_links(content: dict) -> list[uuid.UUID]:
    result: list[uuid.UUID] = []
    seen = set()
    for node in _walk_nodes(content):
        for mark in node.get("marks", []):
            if mark.get("type") != "glossaryLink":
                continue
            article_id = uuid.UUID(str(mark["attrs"]["articleId"]))
            if article_id not in seen:
                seen.add(article_id)
                result.append(article_id)
    return result
