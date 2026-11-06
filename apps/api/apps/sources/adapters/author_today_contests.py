from __future__ import annotations

import calendar
import re
import unicodedata
from datetime import UTC, date, datetime
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import requests
from django.conf import settings
from lxml import html

from .base import (
    NormalizedContestDetail,
    NormalizedContestItem,
    NormalizedContestPhase,
    SourceFetchError,
    SourceParseError,
)

SOURCE_KEY = "author_today.contests"
SOURCE_URL = "https://author.today/contests"
ALLOWED_HOST = "author.today"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ITEMS = 20

MONTHS = {
    "январь": 1,
    "января": 1,
    "февраль": 2,
    "февраля": 2,
    "март": 3,
    "марта": 3,
    "апрель": 4,
    "апреля": 4,
    "май": 5,
    "мая": 5,
    "июнь": 6,
    "июня": 6,
    "июль": 7,
    "июля": 7,
    "август": 8,
    "августа": 8,
    "сентябрь": 9,
    "сентября": 9,
    "октябрь": 10,
    "октября": 10,
    "ноябрь": 11,
    "ноября": 11,
    "декабрь": 12,
    "декабря": 12,
}
MONTH_PATTERN = "|".join(sorted(MONTHS, key=len, reverse=True))

SECTION_ALIASES = {
    "требования к произведениям": "requirements",
    "требования к произведению": "requirements",
    "сроки проведения конкурса": "timeline",
    "условия участия": "participation",
    "порядок подачи произведений на конкурс": "submission",
    "порядок подачи работ на конкурс": "submission",
}

STATUS_PREFIXES = (
    ("прием работ", "accepting"),
    ("приём работ", "accepting"),
    ("подготовка", "preparation"),
    ("в работе", "in_progress"),
    ("завершен", "finished"),
    ("завершён", "finished"),
)


def _plain_text(element) -> str:
    chunks: list[str] = []

    def append_text(node) -> None:
        if node.text:
            chunks.append(node.text)
        for child in node:
            if isinstance(child.tag, str) and child.tag.casefold() == "br":
                chunks.append(" ")
            else:
                append_text(child)
            if child.tail:
                chunks.append(child.tail)

    append_text(element)
    return " ".join("".join(chunks).split())


def _single_node(card, xpath: str, field: str):
    nodes = card.xpath(xpath)
    if not nodes:
        raise SourceParseError(f"missing_{field}")
    return nodes[0]


def _single_text(card, xpath: str, field: str) -> str:
    value = _plain_text(_single_node(card, xpath, field)).strip()
    if not value:
        raise SourceParseError(f"empty_{field}")
    return value


def _canonical_path_url(href: str, expected_path: str, field: str) -> str:
    absolute_url = urljoin(SOURCE_URL, href)
    parsed = urlparse(absolute_url)
    if parsed.scheme != "https" or parsed.hostname != ALLOWED_HOST:
        raise SourceParseError(f"invalid_{field}_url")
    if parsed.path != expected_path or parsed.params or parsed.query or parsed.fragment:
        raise SourceParseError(f"mismatched_{field}_url")
    return f"https://{ALLOWED_HOST}{expected_path}"


def _status_from_label(label) -> str:
    normalized = _plain_text(label).casefold().strip()
    for prefix, status in STATUS_PREFIXES:
        if normalized.startswith(prefix):
            return status
    classes = set(str(label.get("class", "")).casefold().split())
    if "label-primary" in classes:
        return "in_progress"
    raise SourceParseError("unknown_contest_status")


def _normalized_heading(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
    return " ".join(re.sub(r"[^a-zа-я0-9]+", " ", value).split())


def _element_block(element) -> dict[str, object] | None:
    tag = str(element.tag).casefold() if isinstance(element.tag, str) else ""
    if tag in {"ul", "ol"}:
        items = [text for node in element.xpath("./li") if (text := _plain_text(node))]
        if not items:
            return None
        return {"type": "list", "ordered": tag == "ol", "items": items}
    text = _plain_text(element)
    return {"type": "paragraph", "text": text} if text else None


def _block_lines(block: dict[str, object]) -> list[str]:
    if block["type"] == "list":
        return [str(item) for item in block.get("items", [])]
    text = str(block.get("text", "")).strip()
    return [text] if text else []


def _extract_sections(content) -> list[tuple[str, str, list[dict[str, object]]]]:
    sections: list[tuple[str, str, list[dict[str, object]]]] = []
    current_key = ""
    current_title = ""
    current_blocks: list[dict[str, object]] = []
    for child in content:
        tag = str(child.tag).casefold() if isinstance(child.tag, str) else ""
        if tag == "h2":
            if current_key:
                sections.append((current_key, current_title, current_blocks))
            current_title = _plain_text(child).rstrip(":").strip()
            current_key = SECTION_ALIASES.get(_normalized_heading(current_title), "")
            current_blocks = []
            continue
        if current_key:
            block = _element_block(child)
            if block:
                current_blocks.append(block)
    if current_key:
        sections.append((current_key, current_title, current_blocks))
    return sections


def _section_lines(blocks: list[dict[str, object]]) -> list[str]:
    return [line for block in blocks for line in _block_lines(block)]


def _last_day(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


def _parse_exact_dates(value: str) -> list[date]:
    matches: list[tuple[int, date]] = []
    for match in re.finditer(
        rf"(?<!\d)(\d{{1,2}})\s+({MONTH_PATTERN})\s+(\d{{4}})",
        value.casefold(),
    ):
        try:
            matches.append(
                (
                    match.start(),
                    date(int(match.group(3)), MONTHS[match.group(2)], int(match.group(1))),
                )
            )
        except ValueError:
            continue
    for match in re.finditer(r"(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{4})(?!\d)", value):
        try:
            matches.append(
                (match.start(), date(int(match.group(3)), int(match.group(2)), int(match.group(1))))
            )
        except ValueError:
            continue
    return [parsed_date for _position, parsed_date in sorted(matches)]


def _parse_bounds(value: str) -> tuple[date | None, date | None, datetime | None, str]:
    normalized = value.casefold().replace("ё", "е")
    exact_dates = _parse_exact_dates(normalized)
    if exact_dates:
        starts_on = (
            exact_dates[0] if len(exact_dates) > 1 and re.search(r"\bс\s+", normalized) else None
        )
        ends_on = exact_dates[-1]
        deadline_at = None
        time_match = re.search(r"(?<!\d)(\d{1,2})[:\-](\d{2})(?!\d)", normalized)
        if time_match and ("мск" in normalized or "москов" in normalized):
            try:
                local = datetime.combine(
                    ends_on,
                    datetime.min.time().replace(
                        hour=int(time_match.group(1)), minute=int(time_match.group(2))
                    ),
                    tzinfo=ZoneInfo("Europe/Moscow"),
                )
                deadline_at = local.astimezone(UTC)
            except ValueError:
                deadline_at = None
        return starts_on, ends_on, deadline_at, "exact"

    month_range = re.search(
        rf"\b({MONTH_PATTERN})\s*[-–—]\s*({MONTH_PATTERN})\s+(\d{{4}})",
        normalized,
    )
    if month_range:
        year = int(month_range.group(3))
        first_month = MONTHS[month_range.group(1)]
        second_month = MONTHS[month_range.group(2)]
        return date(year, first_month, 1), _last_day(year, second_month), None, "month_range"

    month_match = re.search(rf"\b({MONTH_PATTERN})\s+(\d{{4}})", normalized)
    if month_match:
        month = MONTHS[month_match.group(1)]
        year = int(month_match.group(2))
        if re.search(r"\b(начало|в начале)\b", normalized):
            return date(year, month, 1), date(year, month, 10), None, "approximate"
        if re.search(r"\b(середина|в середине)\b", normalized):
            return date(year, month, 11), date(year, month, 20), None, "approximate"
        if re.search(r"\b(конец|в конце)\b", normalized):
            return date(year, month, 21), _last_day(year, month), None, "approximate"
        return date(year, month, 1), _last_day(year, month), None, "month"
    return None, None, None, "unparsed"


def _phase_kind(label: str) -> str:
    value = _normalized_heading(label)
    if "прием работ" in value or "прием произведений" in value:
        return "submission"
    if "лонг лист" in value:
        return "longlist"
    if "жюри" in value and "шорт лист" in value:
        return "judging_shortlist"
    if "шорт лист" in value:
        return "shortlist"
    if "жюри" in value:
        return "judging"
    if any(token in value for token in ("результат", "победител", "итог")):
        return "results"
    return "other"


def _source_value(line: str, prefix: str) -> str:
    match = re.match(rf"\s*{prefix}\s*:\s*(.+)", line, flags=re.IGNORECASE)
    if not match:
        return ""
    return match.group(1).split(". ", 1)[0].rstrip(".").strip()


def _source_integer(value: str) -> int:
    return int(re.sub(r"\s+", "", value))


def _condition_facts(sections: list[tuple[str, str, list[dict[str, object]]]]):
    facts: dict[str, dict[str, object]] = {}
    section_priority = {"participation": 0, "requirements": 1, "submission": 2}
    ordered_sections = sorted(sections, key=lambda section: section_priority.get(section[0], 9))
    for _section_key, _title, blocks in ordered_sections:
        for line in _section_lines(blocks):
            normalized = _normalized_heading(line)
            source_line = " ".join(line.casefold().replace("ё", "е").split())
            form = _source_value(line, "форма")
            if form and "form" not in facts:
                facts["form"] = {"kind": "form", "value": form, "sourceText": line}

            genre = _source_value(line, "жанр")
            if genre and "genre" not in facts:
                genre = re.split(
                    r",\s*основные\s+требования", genre, maxsplit=1, flags=re.IGNORECASE
                )[0].strip()
                facts["genre"] = {"kind": "genre", "value": genre, "sourceText": line}

            length_match = re.search(
                r"размер\s*:.*?от\s+([\d\s]+)\s+до\s+([\d\s]+)\s+знак",
                source_line,
            )
            if length_match and "length" not in facts:
                facts["length"] = {
                    "kind": "length",
                    "min": _source_integer(length_match.group(1)),
                    "max": _source_integer(length_match.group(2)),
                    "sourceText": line,
                }

            submission_length = re.search(
                r"минимальн\w*\s+об[ъь]?ем\w*\s+текста\s+для\s+подачи\s+заявки\s*[—–-]\s*"
                r"([\d\s]+)\s+знак",
                source_line,
            )
            if submission_length and "submission_length" not in facts:
                facts["submission_length"] = {
                    "kind": "submission_length",
                    "min": _source_integer(submission_length.group(1)),
                    "sourceText": line,
                }

            if not normalized.startswith("не принимаются") and "age" not in facts:
                age_match = re.search(r"возрастн\w*\s+ограничен\w*\s+(\d{1,2}\+)", source_line)
                if age_match:
                    facts["age"] = {
                        "kind": "age",
                        "value": age_match.group(1),
                        "sourceText": line,
                    }

            if "max_works" not in facts:
                max_works = re.search(
                    r"не более\s+(\d+)\s*[хx]?\s+(?:книг|работ|произвед)", normalized
                )
                if max_works:
                    facts["max_works"] = {
                        "kind": "max_works",
                        "value": int(max_works.group(1)),
                        "sourceText": line,
                    }
                elif re.search(r"принимается\s+одно\s+произвед", normalized):
                    facts["max_works"] = {
                        "kind": "max_works",
                        "value": 1,
                        "sourceText": line,
                    }
    fact_order = ("form", "genre", "length", "submission_length", "age", "max_works")
    return [facts[kind] for kind in fact_order if kind in facts]


def _phase_rank(phase: NormalizedContestPhase) -> tuple[int, int]:
    precision_rank = {
        "exact": 4,
        "month": 3,
        "month_range": 2,
        "approximate": 1,
        "unparsed": 0,
    }
    return (1 if phase.deadline_at else 0, precision_rank[phase.precision])


def _phase_from_line(
    line: str,
    *,
    key: str,
    kind: str,
    source_section: str,
    position: int,
    label_override: str = "",
) -> NormalizedContestPhase:
    label = label_override or (line.split(":", 1)[0].strip() if ":" in line else line.strip())
    starts_on, ends_on, deadline_at, precision = _parse_bounds(line)
    return NormalizedContestPhase(
        key=key,
        kind=kind,
        label=label,
        raw_text=line,
        starts_on=starts_on,
        ends_on=ends_on,
        deadline_at=deadline_at,
        precision=precision,
        source_section=source_section,
        position=position,
    )


def parse_author_today_contest_detail(
    document: bytes | str, expected_external_id: str
) -> NormalizedContestDetail:
    if not expected_external_id.isdigit():
        raise SourceParseError("invalid_external_id")
    try:
        root = html.fromstring(document)
    except (ValueError, TypeError) as exc:
        raise SourceParseError("invalid_html") from exc

    content_nodes = root.xpath(
        "//div[contains(concat(' ', normalize-space(@class), ' '), ' panel-body ') "
        "and contains(concat(' ', normalize-space(@class), ' '), ' rich-content ')]"
    )
    if not content_nodes:
        raise SourceParseError("contest_detail_missing")
    sections = _extract_sections(content_nodes[0])
    timeline_blocks = next((blocks for key, _title, blocks in sections if key == "timeline"), None)
    if timeline_blocks is None:
        raise SourceParseError("contest_timeline_missing")
    timeline = _section_lines(timeline_blocks)

    phases: list[NormalizedContestPhase] = []
    used_keys: set[str] = set()
    for line in timeline:
        kind = _phase_kind(line.split(":", 1)[0])
        bounds = _parse_bounds(line)
        if kind == "other" and bounds[3] == "unparsed" and ":" not in line:
            continue
        base_key = kind
        key = base_key
        suffix = 2
        while key in used_keys:
            key = f"{base_key}_{suffix}"
            suffix += 1
        used_keys.add(key)
        phases.append(
            _phase_from_line(
                line,
                key=key,
                kind=kind,
                source_section="timeline",
                position=len(phases),
            )
        )
    if not phases:
        raise SourceParseError("contest_timeline_empty")

    detail_sections: list[dict[str, object]] = []
    extra_phases: dict[str, NormalizedContestPhase] = {}
    for key, title, blocks in sections:
        lines = _section_lines(blocks)
        if key not in {"requirements", "participation", "submission"} or not blocks:
            continue
        detail_sections.append(
            {
                "kind": key,
                "title": title,
                "text": "\n".join(lines),
                "blocks": blocks,
            }
        )
        for line in lines:
            normalized = _normalized_heading(line)
            extra_kind = ""
            if re.search(r"синопсис\w*\s+принима", normalized) and " до " in f" {normalized} ":
                extra_kind = "synopsis"
            elif (
                any(token in normalized for token in ("заверш", "полного текста", "полный текст"))
                and " до " in f" {normalized} "
            ):
                extra_kind = "manuscript_completion"
            if not extra_kind or extra_kind in used_keys:
                continue
            sentence = next(
                (
                    fragment.strip()
                    for fragment in re.split(r"(?<=[.!?])\s+", line)
                    if (
                        extra_kind == "synopsis"
                        and re.search(r"синопсис\w*\s+принима", _normalized_heading(fragment))
                    )
                    or (
                        extra_kind == "manuscript_completion"
                        and any(
                            token in _normalized_heading(fragment)
                            for token in ("заверш", "полного текста", "полный текст")
                        )
                    )
                ),
                line,
            )
            phase = _phase_from_line(
                sentence,
                key=extra_kind,
                kind=extra_kind,
                source_section=key,
                position=0,
                label_override=extra_kind,
            )
            existing = extra_phases.get(extra_kind)
            if phase.precision != "unparsed" and (
                existing is None or _phase_rank(phase) > _phase_rank(existing)
            ):
                extra_phases[extra_kind] = phase

    for extra_kind in ("manuscript_completion", "synopsis"):
        phase = extra_phases.get(extra_kind)
        if phase:
            phases.append(
                NormalizedContestPhase(
                    key=phase.key,
                    kind=phase.kind,
                    label=phase.label,
                    raw_text=phase.raw_text,
                    starts_on=phase.starts_on,
                    ends_on=phase.ends_on,
                    deadline_at=phase.deadline_at,
                    precision=phase.precision,
                    source_section=phase.source_section,
                    position=len(phases),
                )
            )

    return NormalizedContestDetail(
        external_id=expected_external_id,
        conditions_sections=detail_sections,
        phases=phases,
        condition_facts=_condition_facts(sections),
    )


def parse_author_today_contests(document: bytes | str) -> list[NormalizedContestItem]:
    try:
        root = html.fromstring(document)
    except (ValueError, TypeError) as exc:
        raise SourceParseError("invalid_html") from exc

    cards = root.xpath(
        "//div[contains(concat(' ', normalize-space(@class), ' '), ' contest-wrapper ')]"
    )
    if not cards:
        raise SourceParseError("contest_items_missing")

    items: list[NormalizedContestItem] = []
    seen_external_ids: set[str] = set()
    for position, card in enumerate(cards[:MAX_ITEMS]):
        title_link = _single_node(
            card,
            ".//div[contains(concat(' ', normalize-space(@class), ' '), "
            "' contest-description ')]//h2/a[1]",
            "title",
        )
        title = _plain_text(title_link).strip()
        href = str(title_link.get("href", "")).strip()
        if not title or not href:
            raise SourceParseError("invalid_title")
        parsed_path = urlparse(urljoin(SOURCE_URL, href)).path
        path_parts = parsed_path.strip("/").split("/")
        if len(path_parts) != 2 or path_parts[0] != "contest" or not path_parts[1].isdigit():
            raise SourceParseError("invalid_external_id")
        external_id = path_parts[1]
        if external_id in seen_external_ids:
            raise SourceParseError("duplicate_external_id")
        seen_external_ids.add(external_id)
        canonical_url = _canonical_path_url(href, f"/contest/{external_id}", "contest")

        description = _single_text(
            card,
            ".//div[contains(concat(' ', normalize-space(@class), ' '), "
            "' contest-description ')]/p[1]",
            "description",
        )
        status_label = _single_node(
            card,
            ".//div[contains(concat(' ', normalize-space(@class), ' '), "
            "' contest-description ')]//label[1]",
            "status",
        )
        status = _status_from_label(status_label)

        description_url = ""
        discussion_url = ""
        action_kind = ""
        action_url = ""
        button_links = card.xpath(
            ".//div[contains(concat(' ', normalize-space(@class), ' '), ' contest-btns ')]/a"
        )
        for link in button_links:
            button_href = str(link.get("href", "")).strip()
            button_path = urlparse(urljoin(SOURCE_URL, button_href)).path
            if button_path == f"/contest/{external_id}":
                description_url = _canonical_path_url(button_href, button_path, "description")
            elif button_path.startswith("/post/") and button_path.removeprefix("/post/").isdigit():
                discussion_url = _canonical_path_url(button_href, button_path, "discussion")
            elif button_path == f"/contest/{external_id}/works":
                action_kind = "works"
                action_url = _canonical_path_url(button_href, button_path, "action")
            elif button_path == f"/contest/{external_id}/results":
                action_kind = "results"
                action_url = _canonical_path_url(button_href, button_path, "action")

        if description_url != canonical_url:
            raise SourceParseError("missing_description_url")

        items.append(
            NormalizedContestItem(
                external_id=external_id,
                canonical_url=canonical_url,
                title=title,
                description=description,
                status=status,
                discussion_url=discussion_url,
                action_kind=action_kind,
                action_url=action_url,
                source_position=position,
            )
        )
    return items


class AuthorTodayContestAdapter:
    source_key = SOURCE_KEY

    def fetch(self) -> list[NormalizedContestItem]:
        user_agent = f"Quillum/{settings.QUILLUM_VERSION} external-source-adapter"
        try:
            with requests.get(
                SOURCE_URL,
                headers={"Accept": "text/html", "User-Agent": user_agent},
                timeout=(5, 15),
                stream=True,
                allow_redirects=False,
            ) as response:
                if 300 <= response.status_code < 400:
                    raise SourceFetchError("unexpected_redirect")
                response.raise_for_status()
                final_url = urlparse(response.url)
                if final_url.scheme != "https" or final_url.hostname != ALLOWED_HOST:
                    raise SourceFetchError("unexpected_redirect")
                declared_size = int(response.headers.get("Content-Length", "0") or 0)
                if declared_size > MAX_RESPONSE_BYTES:
                    raise SourceFetchError("response_too_large")
                chunks: list[bytes] = []
                received = 0
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    received += len(chunk)
                    if received > MAX_RESPONSE_BYTES:
                        raise SourceFetchError("response_too_large")
                    chunks.append(chunk)
        except SourceFetchError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise SourceFetchError(exc.__class__.__name__) from exc
        return parse_author_today_contests(b"".join(chunks))


class AuthorTodayContestDetailAdapter:
    source_key = SOURCE_KEY

    def fetch(self, external_id: str) -> NormalizedContestDetail:
        if not external_id.isdigit():
            raise SourceParseError("invalid_external_id")
        detail_url = f"https://{ALLOWED_HOST}/contest/{external_id}"
        user_agent = f"Quillum/{settings.QUILLUM_VERSION} external-source-adapter"
        try:
            with requests.get(
                detail_url,
                headers={"Accept": "text/html", "User-Agent": user_agent},
                timeout=(5, 15),
                stream=True,
                allow_redirects=False,
            ) as response:
                if 300 <= response.status_code < 400:
                    raise SourceFetchError("unexpected_redirect")
                response.raise_for_status()
                final_url = urlparse(response.url)
                if (
                    final_url.scheme != "https"
                    or final_url.hostname != ALLOWED_HOST
                    or final_url.path != f"/contest/{external_id}"
                    or final_url.params
                    or final_url.query
                    or final_url.fragment
                ):
                    raise SourceFetchError("unexpected_redirect")
                declared_size = int(response.headers.get("Content-Length", "0") or 0)
                if declared_size > MAX_RESPONSE_BYTES:
                    raise SourceFetchError("response_too_large")
                chunks: list[bytes] = []
                received = 0
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    received += len(chunk)
                    if received > MAX_RESPONSE_BYTES:
                        raise SourceFetchError("response_too_large")
                    chunks.append(chunk)
        except SourceFetchError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise SourceFetchError(exc.__class__.__name__) from exc
        return parse_author_today_contest_detail(b"".join(chunks), external_id)
