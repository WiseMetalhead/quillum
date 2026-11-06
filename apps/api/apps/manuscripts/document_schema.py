from __future__ import annotations

import json
import uuid

MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
ALLOWED_MARKS = {"bold", "italic", "strike"}
ALLOWED_TEXT_ALIGNMENTS = {"left", "center", "right"}
ALLOWED_ILLUSTRATION_ALIGNMENTS = {"left", "center", "right"}


class InvalidDocument(ValueError):
    pass


def _validate_marks(marks: object) -> None:
    if not isinstance(marks, list):
        raise InvalidDocument("document_marks_invalid")
    for mark in marks:
        if not isinstance(mark, dict) or not isinstance(mark.get("type"), str):
            raise InvalidDocument("document_mark_invalid")
        if mark["type"] in ALLOWED_MARKS:
            if set(mark) == {"type", "attrs"} and mark["attrs"] == {}:
                # Tiptap's Yjs transformer emits empty attrs for simple marks. Keep the
                # canonical REST/export shape stable after accepting that equivalent form.
                mark.pop("attrs")
            elif set(mark) != {"type"}:
                raise InvalidDocument("document_mark_invalid")
            continue
        if mark["type"] == "annotationAnchor":
            if set(mark) != {"type", "attrs"} or not isinstance(mark["attrs"], dict):
                raise InvalidDocument("document_annotation_mark_invalid")
            if set(mark["attrs"]) != {"annotationId"}:
                raise InvalidDocument("document_annotation_mark_invalid")
            try:
                uuid.UUID(str(mark["attrs"]["annotationId"]))
            except (ValueError, TypeError, AttributeError) as exc:
                raise InvalidDocument("document_annotation_id_invalid") from exc
            continue
        else:
            raise InvalidDocument("document_mark_unsupported")


def _validate_inline_node(node: object) -> None:
    if not isinstance(node, dict) or not isinstance(node.get("type"), str):
        raise InvalidDocument("document_node_invalid")
    node_type = node["type"]
    if node_type == "hardBreak":
        if set(node) != {"type"}:
            raise InvalidDocument("document_node_invalid")
        return
    if node_type != "text" or not isinstance(node.get("text"), str) or not node["text"]:
        raise InvalidDocument("document_node_unsupported")
    if not set(node).issubset({"type", "text", "marks"}):
        raise InvalidDocument("document_node_invalid")
    if "marks" in node:
        _validate_marks(node["marks"])


def validate_document_content(value: object) -> dict:
    if not isinstance(value, dict) or value.get("type") != "doc":
        raise InvalidDocument("document_root_invalid")
    if not set(value).issubset({"type", "content"}):
        raise InvalidDocument("document_root_invalid")
    blocks = value.get("content", [])
    if not isinstance(blocks, list):
        raise InvalidDocument("document_content_invalid")
    for block in blocks:
        if not isinstance(block, dict) or not isinstance(block.get("type"), str):
            raise InvalidDocument("document_block_invalid")
        block_type = block["type"]
        if block_type == "paragraph":
            if not set(block).issubset({"type", "attrs", "content"}):
                raise InvalidDocument("document_block_invalid")
            attrs = block.get("attrs", {})
            if not isinstance(attrs, dict) or not set(attrs).issubset({"textAlign"}):
                raise InvalidDocument("document_alignment_invalid")
        elif block_type == "heading":
            if not set(block).issubset({"type", "attrs", "content"}):
                raise InvalidDocument("document_block_invalid")
            attrs = block.get("attrs")
            if (
                not isinstance(attrs, dict)
                or "level" not in attrs
                or not set(attrs).issubset({"level", "textAlign"})
            ):
                raise InvalidDocument("document_heading_invalid")
            if isinstance(attrs["level"], bool) or attrs["level"] not in {1, 2, 3}:
                raise InvalidDocument("document_heading_unsupported")
        elif block_type == "sceneBreak":
            if set(block) != {"type"}:
                raise InvalidDocument("document_scene_break_invalid")
            continue
        elif block_type == "illustration":
            if set(block) != {"type", "attrs"}:
                raise InvalidDocument("document_illustration_invalid")
            attrs = block["attrs"]
            required_attrs = {"assetId", "alt", "caption", "alignment"}
            if (
                not isinstance(attrs, dict)
                or not required_attrs.issubset(attrs)
                or not set(attrs).issubset(required_attrs | {"displayWidth"})
            ):
                raise InvalidDocument("document_illustration_invalid")
            try:
                uuid.UUID(str(attrs["assetId"]))
            except (ValueError, TypeError, AttributeError) as exc:
                raise InvalidDocument("document_illustration_asset_invalid") from exc
            if not isinstance(attrs["alt"], str) or len(attrs["alt"]) > 500:
                raise InvalidDocument("document_illustration_alt_invalid")
            if not isinstance(attrs["caption"], str) or len(attrs["caption"]) > 2_000:
                raise InvalidDocument("document_illustration_caption_invalid")
            if attrs["alignment"] not in ALLOWED_ILLUSTRATION_ALIGNMENTS:
                raise InvalidDocument("document_illustration_alignment_invalid")
            display_width = attrs.get("displayWidth", 80)
            if (
                isinstance(display_width, bool)
                or not isinstance(display_width, int)
                or display_width < 25
                or display_width > 100
            ):
                raise InvalidDocument("document_illustration_width_invalid")
            continue
        else:
            raise InvalidDocument("document_block_unsupported")
        text_align = attrs.get("textAlign")
        if text_align is not None and text_align not in ALLOWED_TEXT_ALIGNMENTS:
            raise InvalidDocument("document_alignment_unsupported")
        inline_content = block.get("content", [])
        if not isinstance(inline_content, list):
            raise InvalidDocument("document_content_invalid")
        for node in inline_content:
            _validate_inline_node(node)
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(serialized) > MAX_DOCUMENT_BYTES:
        raise InvalidDocument("document_too_large")
    return value


def illustration_asset_ids(content: dict) -> set[str]:
    return {
        block["attrs"]["assetId"]
        for block in content.get("content", [])
        if block.get("type") == "illustration"
    }


def annotation_ids(content: dict) -> set[str]:
    result = set()
    for block in content.get("content", []):
        for node in block.get("content", []):
            for mark in node.get("marks", []):
                if mark.get("type") == "annotationAnchor":
                    result.add(mark["attrs"]["annotationId"])
    return result


def remove_annotation_mark(content: dict, annotation_id: str) -> dict:
    updated = json.loads(json.dumps(content))
    for block in updated.get("content", []):
        for node in block.get("content", []):
            marks = node.get("marks")
            if not marks:
                continue
            remaining = [
                mark
                for mark in marks
                if not (
                    mark.get("type") == "annotationAnchor"
                    and mark.get("attrs", {}).get("annotationId") == annotation_id
                )
            ]
            if remaining:
                node["marks"] = remaining
            else:
                node.pop("marks", None)
    return updated


def without_annotation_marks(content: dict) -> dict:
    updated = json.loads(json.dumps(content))
    for block in updated.get("content", []):
        attrs = block.get("attrs")
        if isinstance(attrs, dict):
            if attrs.get("textAlign") in {None, "left"}:
                attrs.pop("textAlign", None)
            if not attrs:
                block.pop("attrs", None)
        merged_content = []
        for node in block.get("content", []):
            marks = node.get("marks")
            remaining = [
                mark for mark in marks or [] if mark.get("type") != "annotationAnchor"
            ]
            if remaining:
                node["marks"] = sorted(
                    remaining,
                    key=lambda mark: json.dumps(mark, sort_keys=True),
                )
            elif "marks" in node:
                node.pop("marks", None)
            if (
                merged_content
                and node.get("type") == "text"
                and merged_content[-1].get("type") == "text"
                and merged_content[-1].get("marks") == node.get("marks")
            ):
                merged_content[-1]["text"] += node.get("text", "")
            else:
                merged_content.append(node)
        if "content" in block:
            block["content"] = merged_content
    return updated
