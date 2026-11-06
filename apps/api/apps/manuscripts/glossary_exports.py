from __future__ import annotations

import copy
import html
import posixpath
import re
import tempfile
import zipfile
from dataclasses import dataclass
from types import SimpleNamespace
from typing import BinaryIO
from urllib.parse import quote

from apps.accounts.media import media_variant_bytes

from .download_names import safe_download_name
from .glossary_schema import glossary_asset_ids
from .models import GlossaryArticle, GlossaryAsset

GLOSSARY_EXPORT_FORMATS = {"markdown", "html"}
GLOSSARY_EXPORT_MAX_ASSET_BYTES = 250 * 1024 * 1024
GLOSSARY_EXPORT_SPOOL_BYTES = 8 * 1024 * 1024


class GlossaryExportError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class GlossaryExportAsset:
    path: str


@dataclass(frozen=True)
class GlossaryExportBuild:
    file: BinaryIO
    file_name: str


def build_account_glossary_document(
    article: GlossaryArticle,
    export_format: str,
    *,
    asset_paths: dict[str, str],
    cover_path: str | None,
    article_paths: dict[str, str],
    current_path: str,
) -> bytes:
    """Render one article with archive-relative assets and internal article links."""
    if export_format not in GLOSSARY_EXPORT_FORMATS:
        raise GlossaryExportError("account_export_glossary_format_invalid")
    content = copy.deepcopy(article.content)
    current_directory = posixpath.dirname(current_path)

    def visit(value) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        marks = value.get("marks")
        if isinstance(marks, list):
            rewritten = []
            for mark in marks:
                if isinstance(mark, dict) and mark.get("type") == "glossaryLink":
                    target = article_paths.get(str(mark.get("attrs", {}).get("articleId", "")))
                    if target:
                        rewritten.append(
                            {
                                "type": "link",
                                "attrs": {
                                    "href": posixpath.relpath(target, current_directory),
                                    "title": None,
                                },
                            }
                        )
                        continue
                rewritten.append(mark)
            value["marks"] = rewritten
        for child in value.values():
            visit(child)

    visit(content)
    export_article = SimpleNamespace(
        title=article.title,
        synopsis=article.synopsis,
        content=content,
    )
    assets = {
        asset_id: GlossaryExportAsset(path)
        for asset_id, path in asset_paths.items()
    }
    cover = GlossaryExportAsset(cover_path) if cover_path else None
    if export_format == "markdown":
        return _markdown_document(export_article, assets, cover).encode("utf-8")
    return _html_document(export_article, assets, cover).encode("utf-8")


def build_glossary_export(
    article: GlossaryArticle,
    export_format: str,
) -> GlossaryExportBuild:
    if export_format not in GLOSSARY_EXPORT_FORMATS:
        raise GlossaryExportError("glossary_export_format_invalid")

    content = article.content
    referenced_ids = glossary_asset_ids(content)
    assets = list(
        GlossaryAsset.objects.filter(
            article=article,
            kind=GlossaryAsset.KIND_ILLUSTRATION,
            public_id__in=referenced_ids,
        ).select_related(
            "article__glossary__manuscript__workspace",
            "article__glossary__series__workspace",
            "media__owner",
        )
    )
    if len(assets) != len(referenced_ids):
        raise GlossaryExportError("glossary_export_asset_missing")

    cover = (
        GlossaryAsset.objects.filter(
            article=article,
            kind=GlossaryAsset.KIND_COVER,
        )
        .select_related(
            "article__glossary__manuscript__workspace",
            "article__glossary__series__workspace",
            "media__owner",
        )
        .first()
    )
    selected_assets = [*assets, *([cover] if cover else [])]
    if sum(asset.byte_size for asset in selected_assets) > GLOSSARY_EXPORT_MAX_ASSET_BYTES:
        raise GlossaryExportError("glossary_export_too_large")

    export_assets = [
        _export_asset_descriptor(asset, cover=asset is cover) for asset in selected_assets
    ]
    by_id = {
        str(asset.public_id): export_asset
        for asset, export_asset in zip(selected_assets, export_assets, strict=True)
        if asset.kind == GlossaryAsset.KIND_ILLUSTRATION
    }
    cover_asset = export_assets[-1] if cover else None

    base_name = safe_download_name(article.title, fallback="glossary-article")
    if export_format == "markdown":
        document = _markdown_document(article, by_id, cover_asset)
        document_name = f"{base_name}.md"
    else:
        document = _html_document(article, by_id, cover_asset)
        document_name = f"{base_name}.html"

    output = tempfile.SpooledTemporaryFile(max_size=GLOSSARY_EXPORT_SPOOL_BYTES, mode="w+b")
    try:
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr(
                document_name,
                document.encode("utf-8"),
                compress_type=zipfile.ZIP_DEFLATED,
            )
            actual_asset_bytes = 0
            for source, asset in zip(selected_assets, export_assets, strict=True):
                data = _export_asset_bytes(source)
                actual_asset_bytes += len(data)
                if actual_asset_bytes > GLOSSARY_EXPORT_MAX_ASSET_BYTES:
                    raise GlossaryExportError("glossary_export_too_large")
                archive.writestr(asset.path, data, compress_type=zipfile.ZIP_STORED)
        output.seek(0)
    except Exception:
        output.close()
        raise
    return GlossaryExportBuild(output, f"{base_name}.zip")


def _export_asset_descriptor(asset: GlossaryAsset, *, cover: bool) -> GlossaryExportAsset:
    content_type = asset.media.content_type
    extension = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
    }.get(content_type, "bin")
    path = f"assets/cover.{extension}" if cover else f"assets/{asset.public_id}.{extension}"
    return GlossaryExportAsset(path)


def _export_asset_bytes(asset: GlossaryAsset) -> bytes:
    value = media_variant_bytes(asset.media, "original")
    if value is None:
        raise GlossaryExportError("glossary_export_asset_missing")
    return value[0]


def _markdown_document(
    article: GlossaryArticle,
    assets: dict[str, GlossaryExportAsset],
    cover: GlossaryExportAsset | None,
) -> str:
    parts = [f"# {_markdown_text(article.title)}"]
    if cover:
        parts.append(f"![{_markdown_text(article.title)}]({cover.path})")
    if article.synopsis:
        parts.append(f"*{_markdown_text(article.synopsis)}*")
    parts.extend(_markdown_block(block, assets) for block in article.content.get("content", []))
    return "\n\n".join(part for part in parts if part).rstrip() + "\n"


def _markdown_block(node: dict, assets: dict[str, GlossaryExportAsset]) -> str:
    node_type = node.get("type")
    if node_type == "paragraph":
        return _markdown_inlines(node.get("content", []))
    if node_type == "heading":
        level = min(max(int(node.get("attrs", {}).get("level", 1)), 1), 5)
        return f"{'#' * level} {_markdown_inlines(node.get('content', []))}"
    if node_type in {"bulletList", "orderedList"}:
        return _markdown_list(node, assets)
    if node_type == "blockquote":
        body = "\n\n".join(_markdown_block(child, assets) for child in node.get("content", []))
        return "\n".join(f"> {line}" if line else ">" for line in body.splitlines())
    if node_type == "callout":
        kind = str(node.get("attrs", {}).get("kind", "info")).upper()
        body = "\n\n".join(_markdown_block(child, assets) for child in node.get("content", []))
        quoted = "\n".join(f"> {line}" if line else ">" for line in body.splitlines())
        return f"> **{kind}**\n>\n{quoted}"
    if node_type == "table":
        return _markdown_table(node)
    if node_type == "horizontalRule":
        return "---"
    if node_type == "illustration":
        return _markdown_illustration(node, assets)
    if node_type == "illustrationGallery":
        return "\n\n".join(
            _markdown_illustration(child, assets) for child in node.get("content", [])
        )
    return ""


def _markdown_list(node: dict, assets: dict[str, GlossaryExportAsset], depth: int = 0) -> str:
    ordered = node.get("type") == "orderedList"
    number = int(node.get("attrs", {}).get("start", 1))
    lines: list[str] = []
    for index, item in enumerate(node.get("content", [])):
        children = item.get("content", [])
        marker = f"{number + index}." if ordered else "-"
        first = _markdown_block(children[0], assets) if children else ""
        first_lines = first.splitlines() or [""]
        indent = "  " * depth
        lines.append(f"{indent}{marker} {first_lines[0]}")
        continuation = " " * (len(indent) + len(marker) + 1)
        lines.extend(f"{continuation}{line}" for line in first_lines[1:])
        for child in children[1:]:
            if child.get("type") in {"bulletList", "orderedList"}:
                lines.append(_markdown_list(child, assets, depth + 1))
            else:
                lines.append(f"{continuation}{_markdown_block(child, assets)}")
    return "\n".join(lines)


def _markdown_inlines(nodes: list[dict]) -> str:
    result: list[str] = []
    for node in nodes:
        if node.get("type") == "hardBreak":
            result.append("  \n")
            continue
        if node.get("type") != "text":
            continue
        value = _markdown_text(str(node.get("text", "")))
        marks = node.get("marks", [])
        mark_types = {mark.get("type") for mark in marks}
        if "underline" in mark_types:
            value = f"<u>{value}</u>"
        if "strike" in mark_types:
            value = f"~~{value}~~"
        if "italic" in mark_types:
            value = f"*{value}*"
        if "bold" in mark_types:
            value = f"**{value}**"
        external = next((mark for mark in marks if mark.get("type") == "link"), None)
        if external:
            attrs = external.get("attrs", {})
            href = quote(
                str(attrs.get("href", "")),
                safe=":/?#[]@!$&'+,;=%~.-_",
            )
            title = attrs.get("title")
            safe_title = str(title).replace("\\", "\\\\").replace('"', r"\"")
            title_part = f' "{safe_title}"' if title else ""
            value = f"[{value}]({href}{title_part})"
        result.append(value)
    return "".join(result)


def _markdown_table(node: dict) -> str:
    rows = node.get("content", [])
    if _table_has_spans(rows):
        return _html_table(node)

    column_count = max((len(row.get("content", [])) for row in rows), default=0)
    if column_count == 0:
        return ""

    rendered_rows: list[list[str]] = []
    for row in rows:
        cells = _markdown_table_cells(row)
        cells.extend([""] * (column_count - len(cells)))
        rendered_rows.append(cells)
    first_cells = rows[0].get("content", [])
    has_header = bool(first_cells) and all(
        cell.get("type") == "tableHeader" for cell in first_cells
    )
    header = rendered_rows[0] if has_header else [""] * column_count
    body = rendered_rows[1:] if has_header else rendered_rows
    alignments = [_markdown_table_alignment(rows, index) for index in range(column_count)]
    delimiters = {
        "left": ":---",
        "center": ":---:",
        "right": "---:",
    }

    lines = [
        _markdown_table_row(header),
        _markdown_table_row([delimiters.get(alignment, "---") for alignment in alignments]),
    ]
    lines.extend(_markdown_table_row(row) for row in body)
    return "\n".join(lines)


def _table_has_spans(rows: list[dict]) -> bool:
    return any(
        int(cell.get("attrs", {}).get(attribute, 1)) != 1
        for row in rows
        for cell in row.get("content", [])
        for attribute in ("colspan", "rowspan")
    )


def _markdown_table_cells(row: dict) -> list[str]:
    return [_markdown_table_cell(cell) for cell in row.get("content", [])]


def _markdown_table_cell(cell: dict) -> str:
    paragraphs = [_markdown_inlines(child.get("content", [])) for child in cell.get("content", [])]
    value = "<br><br>".join(paragraphs).replace("  \n", "<br>").replace("\n", "<br>")
    return value.replace("|", "&#124;")


def _markdown_table_alignment(rows: list[dict], column_index: int) -> str | None:
    for row in rows:
        cells = row.get("content", [])
        if column_index >= len(cells):
            continue
        cell = cells[column_index]
        alignment = cell.get("attrs", {}).get("align")
        if alignment in {"left", "center", "right"}:
            return alignment
        for child in cell.get("content", []):
            alignment = child.get("attrs", {}).get("textAlign")
            if alignment in {"left", "center", "right"}:
                return alignment
    return None


def _markdown_table_row(cells: list[str]) -> str:
    return f"| {' | '.join(cells)} |"


def _markdown_illustration(
    node: dict,
    assets: dict[str, GlossaryExportAsset],
) -> str:
    attrs = node.get("attrs", {})
    asset = assets.get(str(attrs.get("assetId", "")))
    if asset is None:
        raise GlossaryExportError("glossary_export_asset_missing")
    alt = _markdown_text(str(attrs.get("alt", "")))
    result = f"![{alt}]({asset.path})"
    caption = str(attrs.get("caption", ""))
    if caption:
        result += f"\n\n*{_markdown_text(caption)}*"
    return result


def _markdown_text(value: str) -> str:
    return re.sub(r"([\\`*{}_\[\]<>])", r"\\\1", value)


def _html_document(
    article: GlossaryArticle,
    assets: dict[str, GlossaryExportAsset],
    cover: GlossaryExportAsset | None,
) -> str:
    title = html.escape(article.title)
    cover_html = (
        f'<figure class="cover"><img src="{cover.path}" alt="{title}"></figure>' if cover else ""
    )
    synopsis = (
        f'<p class="synopsis">{html.escape(article.synopsis)}</p>' if article.synopsis else ""
    )
    body = "\n".join(_html_block(block, assets) for block in article.content.get("content", []))
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
  <title>{title}</title>
  <style>
    :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.6; }}
    body {{ max-width: 920px; margin: 0 auto; padding: 2rem; }}
    img {{ max-width: 100%; height: auto; }} figure {{ margin: 1.5rem 0; }}
    figcaption, .synopsis {{ color: color-mix(in srgb, currentColor 72%, transparent); }}
    .cover {{ text-align: center; }} .cover img {{ max-height: 65vh; }}
    .callout {{ border-inline-start: .3rem solid currentColor; padding: .75rem 1rem;
                margin: 1rem 0; }}
    .callout-label {{ font-weight: 700; margin: 0 0 .5rem; }}
    .gallery {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                gap: .75rem; }}
    .gallery figure {{ margin: 0; }} table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border: 1px solid currentColor; padding: .4rem .6rem; vertical-align: top; }}
    blockquote {{ border-inline-start: .25rem solid currentColor; margin-inline: 0;
                  padding-inline-start: 1rem; }}
  </style>
</head>
<body>
<article>
  <h1>{title}</h1>
  {cover_html}
  {synopsis}
  {body}
</article>
</body>
</html>
"""


def _html_block(node: dict, assets: dict[str, GlossaryExportAsset]) -> str:
    node_type = node.get("type")
    if node_type in {"paragraph", "heading"}:
        tag = (
            f"h{min(max(int(node.get('attrs', {}).get('level', 1)), 1), 5)}"
            if node_type == "heading"
            else "p"
        )
        align = node.get("attrs", {}).get("textAlign", "left")
        return f'<{tag} style="text-align:{align}">{_html_inlines(node.get("content", []))}</{tag}>'
    if node_type in {"bulletList", "orderedList"}:
        tag = "ol" if node_type == "orderedList" else "ul"
        attrs = node.get("attrs", {})
        extra = ""
        if tag == "ol":
            extra = f' start="{int(attrs.get("start", 1))}"'
            if attrs.get("type"):
                extra += f' type="{html.escape(str(attrs["type"]))}"'
        items = "".join(
            f"<li>{''.join(_html_block(child, assets) for child in item.get('content', []))}</li>"
            for item in node.get("content", [])
        )
        return f"<{tag}{extra}>{items}</{tag}>"
    if node_type == "blockquote":
        body = "".join(_html_block(child, assets) for child in node.get("content", []))
        return f"<blockquote>{body}</blockquote>"
    if node_type == "callout":
        kind = html.escape(str(node.get("attrs", {}).get("kind", "info")))
        body = "".join(_html_block(child, assets) for child in node.get("content", []))
        return (
            f'<aside class="callout {kind}"><p class="callout-label">'
            f"{kind.upper()}</p>{body}</aside>"
        )
    if node_type == "table":
        return _html_table(node)
    if node_type == "horizontalRule":
        return "<hr>"
    if node_type == "illustration":
        return _html_illustration(node, assets)
    if node_type == "illustrationGallery":
        figures = "".join(_html_illustration(child, assets) for child in node.get("content", []))
        return f'<div class="gallery">{figures}</div>'
    return ""


def _html_inlines(nodes: list[dict]) -> str:
    result: list[str] = []
    for node in nodes:
        if node.get("type") == "hardBreak":
            result.append("<br>")
            continue
        if node.get("type") != "text":
            continue
        value = html.escape(str(node.get("text", "")))
        marks = node.get("marks", [])
        wrappers = {
            "bold": ("<strong>", "</strong>"),
            "italic": ("<em>", "</em>"),
            "strike": ("<s>", "</s>"),
            "underline": ("<u>", "</u>"),
        }
        for mark_type in ("underline", "strike", "italic", "bold"):
            if any(mark.get("type") == mark_type for mark in marks):
                start, end = wrappers[mark_type]
                value = f"{start}{value}{end}"
        external = next((mark for mark in marks if mark.get("type") == "link"), None)
        if external:
            attrs = external.get("attrs", {})
            href = html.escape(str(attrs.get("href", "")), quote=True)
            title = attrs.get("title")
            title_attr = f' title="{html.escape(str(title), quote=True)}"' if title else ""
            value = f'<a href="{href}"{title_attr} rel="noopener noreferrer">{value}</a>'
        elif any(mark.get("type") == "glossaryLink" for mark in marks):
            value = f'<span class="glossary-link">{value}</span>'
        result.append(value)
    return "".join(result)


def _html_table(node: dict) -> str:
    rows: list[str] = []
    for row in node.get("content", []):
        cells: list[str] = []
        for cell in row.get("content", []):
            tag = "th" if cell.get("type") == "tableHeader" else "td"
            attrs = cell.get("attrs", {})
            colspan = int(attrs.get("colspan", 1))
            rowspan = int(attrs.get("rowspan", 1))
            align = attrs.get("align", "left")
            body = "".join(
                f'<p style="text-align:{child.get("attrs", {}).get("textAlign", "left")}">'
                f"{_html_inlines(child.get('content', []))}</p>"
                for child in cell.get("content", [])
            )
            cells.append(
                f'<{tag} colspan="{colspan}" rowspan="{rowspan}" '
                f'style="text-align:{align}">{body}</{tag}>'
            )
        rows.append(f"<tr>{''.join(cells)}</tr>")
    return f"<table>{''.join(rows)}</table>"


def _html_illustration(node: dict, assets: dict[str, GlossaryExportAsset]) -> str:
    attrs = node.get("attrs", {})
    asset = assets.get(str(attrs.get("assetId", "")))
    if asset is None:
        raise GlossaryExportError("glossary_export_asset_missing")
    alt = html.escape(str(attrs.get("alt", "")), quote=True)
    caption = str(attrs.get("caption", ""))
    align = attrs.get("alignment", "center")
    width = int(attrs.get("displayWidth", 100))
    caption_html = f"<figcaption>{html.escape(caption)}</figcaption>" if caption else ""
    return (
        f'<figure style="text-align:{align}"><img src="{asset.path}" alt="{alt}" '
        f'style="width:{width}%">{caption_html}</figure>'
    )
