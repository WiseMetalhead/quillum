from __future__ import annotations

import json
import re
import uuid

MAX_NOTE_BYTES = 1024 * 1024
NOTE_TITLE_MAX_LENGTH = 240
ALLOWED_MARKS = {"bold", "italic", "strike"}
ALLOWED_ALIGNMENTS = {"left", "center", "right"}


class InvalidNote(ValueError):
    pass


def _validate_marks(marks: object) -> None:
    if not isinstance(marks, list):
        raise InvalidNote("note_marks_invalid")
    for mark in marks:
        if not isinstance(mark, dict) or mark.get("type") not in ALLOWED_MARKS:
            raise InvalidNote("note_mark_unsupported")
        if set(mark) != {"type"}:
            raise InvalidNote("note_mark_invalid")


def _validate_inline(node: object) -> None:
    if not isinstance(node, dict) or not isinstance(node.get("type"), str):
        raise InvalidNote("note_node_invalid")
    if node["type"] == "hardBreak":
        if set(node) != {"type"}:
            raise InvalidNote("note_node_invalid")
        return
    if node["type"] != "text" or not isinstance(node.get("text"), str) or not node["text"]:
        raise InvalidNote("note_node_unsupported")
    if not set(node).issubset({"type", "text", "marks"}):
        raise InvalidNote("note_node_invalid")
    if "marks" in node:
        _validate_marks(node["marks"])


def _validate_paragraph(node: object) -> None:
    if not isinstance(node, dict) or node.get("type") != "paragraph":
        raise InvalidNote("note_paragraph_invalid")
    if not set(node).issubset({"type", "attrs", "content"}):
        raise InvalidNote("note_paragraph_invalid")
    attrs = node.get("attrs", {})
    if not isinstance(attrs, dict) or not set(attrs).issubset({"textAlign"}):
        raise InvalidNote("note_alignment_invalid")
    if attrs.get("textAlign") is not None and attrs["textAlign"] not in ALLOWED_ALIGNMENTS:
        raise InvalidNote("note_alignment_unsupported")
    content = node.get("content", [])
    if not isinstance(content, list):
        raise InvalidNote("note_content_invalid")
    for child in content:
        _validate_inline(child)


def _validate_list(node: object) -> None:
    if not isinstance(node, dict) or node.get("type") != "bulletList":
        raise InvalidNote("note_list_invalid")
    if not set(node).issubset({"type", "content"}) or not isinstance(node.get("content"), list):
        raise InvalidNote("note_list_invalid")
    for item in node["content"]:
        if not isinstance(item, dict) or item.get("type") != "listItem":
            raise InvalidNote("note_list_item_invalid")
        if set(item) != {"type", "content"} or not isinstance(item["content"], list):
            raise InvalidNote("note_list_item_invalid")
        if not item["content"]:
            raise InvalidNote("note_list_item_invalid")
        for paragraph in item["content"]:
            _validate_paragraph(paragraph)


def _validate_task_list(node: object) -> None:
    if not isinstance(node, dict) or node.get("type") != "taskList":
        raise InvalidNote("note_task_list_invalid")
    if not set(node).issubset({"type", "content"}) or not isinstance(node.get("content"), list):
        raise InvalidNote("note_task_list_invalid")
    for item in node["content"]:
        if not isinstance(item, dict) or item.get("type") != "taskItem":
            raise InvalidNote("note_task_item_invalid")
        if set(item) != {"type", "attrs", "content"} or not isinstance(item["content"], list):
            raise InvalidNote("note_task_item_invalid")
        attrs = item["attrs"]
        if (
            not isinstance(attrs, dict)
            or set(attrs) != {"checked"}
            or not isinstance(attrs["checked"], bool)
        ):
            raise InvalidNote("note_task_item_invalid")
        if not item["content"]:
            raise InvalidNote("note_task_item_invalid")
        for paragraph in item["content"]:
            _validate_paragraph(paragraph)


def _validate_illustration(node: object) -> None:
    if not isinstance(node, dict) or set(node) != {"type", "attrs"}:
        raise InvalidNote("note_illustration_invalid")
    attrs = node["attrs"]
    if not isinstance(attrs, dict) or set(attrs) != {
        "assetId", "alt", "caption", "alignment"
    }:
        raise InvalidNote("note_illustration_invalid")
    try:
        uuid.UUID(str(attrs["assetId"]))
    except (ValueError, TypeError, AttributeError) as exc:
        raise InvalidNote("note_illustration_asset_invalid") from exc
    if not isinstance(attrs["alt"], str) or len(attrs["alt"]) > 500:
        raise InvalidNote("note_illustration_alt_invalid")
    if not isinstance(attrs["caption"], str) or len(attrs["caption"]) > 2_000:
        raise InvalidNote("note_illustration_caption_invalid")
    if attrs["alignment"] not in ALLOWED_ALIGNMENTS:
        raise InvalidNote("note_illustration_alignment_invalid")


def validate_note_content(value: object, *, allow_task_lists: bool = False) -> dict:
    if not isinstance(value, dict) or value.get("type") != "doc":
        raise InvalidNote("note_root_invalid")
    if (
        not set(value).issubset({"type", "content"})
        or not isinstance(value.get("content", []), list)
    ):
        raise InvalidNote("note_root_invalid")
    for block in value.get("content", []):
        block_type = block.get("type") if isinstance(block, dict) else None
        if block_type == "paragraph":
            _validate_paragraph(block)
        elif block_type == "bulletList":
            _validate_list(block)
        elif block_type == "taskList" and allow_task_lists:
            _validate_task_list(block)
        elif block_type == "illustration":
            _validate_illustration(block)
        else:
            raise InvalidNote("note_block_unsupported")
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(serialized) > MAX_NOTE_BYTES:
        raise InvalidNote("note_too_large")
    return value


def plain_text_to_note_content(value: str) -> dict:
    """Convert normalized plain text to the Boards paragraph/hard-break schema."""
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    blocks: list[dict] = []
    inline: list[dict] = []
    for part in re.split(r"(\n+)", normalized):
        if not part:
            continue
        if not part.startswith("\n"):
            inline.append({"type": "text", "text": part})
            continue
        newline_count = len(part)
        if newline_count == 1:
            inline.append({"type": "hardBreak"})
            continue
        paragraph = {"type": "paragraph"}
        if inline:
            paragraph["content"] = inline
        blocks.append(paragraph)
        inline = []
        blocks.extend({"type": "paragraph"} for _ in range(newline_count - 2))
    paragraph = {"type": "paragraph"}
    if inline:
        paragraph["content"] = inline
    blocks.append(paragraph)
    return {"type": "doc", "content": blocks}


def note_asset_ids(content: dict) -> set[str]:
    return {
        block["attrs"]["assetId"]
        for block in content.get("content", [])
        if block.get("type") == "illustration"
    }


def note_plain_text(content: dict) -> str:
    parts: list[str] = []
    for block in content.get("content", []):
        if block.get("type") == "illustration":
            continue
        children = block.get("content", [])
        if block.get("type") in {"bulletList", "taskList"}:
            list_parts = []
            for item in children:
                item_parts = [
                    "".join(child.get("text", "") for child in paragraph.get("content", []))
                    for paragraph in item.get("content", [])
                ]
                list_parts.append("\n".join(part for part in item_parts if part))
            parts.append("\n".join(part for part in list_parts if part))
        else:
            parts.append("".join(child.get("text", "") for child in children))
    return "\n".join(part for part in parts if part).strip()
