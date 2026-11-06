from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import urljoin, urlparse

import requests
from django.conf import settings
from lxml import html

from .base import NormalizedNewsItem, SourceFetchError, SourceParseError

SOURCE_KEY = "author_today.news"
SOURCE_URL = "https://author.today/discussions/all/announcements/recent"
ALLOWED_HOST = "author.today"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ITEMS = 20


def _plain_text(element) -> str:
    return " ".join(" ".join(element.itertext()).split())


def _single_text(article, xpath: str, field: str) -> str:
    nodes = article.xpath(xpath)
    if not nodes:
        raise SourceParseError(f"missing_{field}")
    value = _plain_text(nodes[0]).strip()
    if not value:
        raise SourceParseError(f"empty_{field}")
    return value


def parse_author_today_news(document: bytes | str) -> list[NormalizedNewsItem]:
    try:
        root = html.fromstring(document)
    except (ValueError, TypeError) as exc:
        raise SourceParseError("invalid_html") from exc

    articles = root.xpath("//article[starts-with(@id, 'post_')]")
    if not articles:
        raise SourceParseError("news_items_missing")

    items: list[NormalizedNewsItem] = []
    for article in articles[:MAX_ITEMS]:
        article_id = str(article.get("id", ""))
        external_id = article_id.removeprefix("post_").strip()
        if not external_id or not external_id.isdigit():
            raise SourceParseError("invalid_external_id")

        title_links = article.xpath(".//h3[contains(@class, 'post-title')]/a[1]")
        if not title_links:
            raise SourceParseError("missing_title")
        title = _plain_text(title_links[0])
        href = str(title_links[0].get("href", "")).strip()
        if not title or not href:
            raise SourceParseError("invalid_title")
        author_name = _single_text(article, ".//header/time//span[1]/a[1]", "author")
        summary = _single_text(
            article,
            ".//div[contains(concat(' ', normalize-space(@class), ' '), ' rich-content ')]",
            "summary",
        )
        published_nodes = article.xpath(".//*[@pubdate][@data-time][1]/@data-time")
        if not published_nodes:
            raise SourceParseError("missing_published_at")
        try:
            published_at = datetime.fromisoformat(str(published_nodes[0]).replace("Z", "+00:00"))
        except ValueError as exc:
            raise SourceParseError("invalid_published_at") from exc
        if published_at.tzinfo is None:
            raise SourceParseError("naive_published_at")

        canonical_url = urljoin(SOURCE_URL, href)
        parsed_url = urlparse(canonical_url)
        if parsed_url.scheme != "https" or parsed_url.hostname != ALLOWED_HOST:
            raise SourceParseError("invalid_canonical_url")
        if parsed_url.path != f"/post/{external_id}":
            raise SourceParseError("mismatched_canonical_url")
        canonical_url = f"https://{ALLOWED_HOST}/post/{external_id}"

        items.append(
            NormalizedNewsItem(
                external_id=external_id,
                canonical_url=canonical_url,
                title=title,
                author_name=author_name,
                summary=summary,
                published_at=published_at.astimezone(UTC),
            )
        )
    return items


class AuthorTodayNewsAdapter:
    source_key = SOURCE_KEY

    def fetch(self) -> list[NormalizedNewsItem]:
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
        return parse_author_today_news(b"".join(chunks))
