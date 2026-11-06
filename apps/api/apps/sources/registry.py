from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .adapters.author_today import AuthorTodayNewsAdapter
from .adapters.author_today_contests import (
    AuthorTodayContestAdapter,
    AuthorTodayContestDetailAdapter,
)
from .adapters.base import ContestDetailSourceAdapter, ContestSourceAdapter, NewsSourceAdapter


@dataclass(frozen=True)
class NewsSourceDefinition:
    key: str
    name: str
    website_url: str
    adapter_factory: Callable[[], NewsSourceAdapter]


@dataclass(frozen=True)
class ContestSourceDefinition:
    key: str
    name: str
    website_url: str
    adapter_factory: Callable[[], ContestSourceAdapter]
    detail_adapter_factory: Callable[[], ContestDetailSourceAdapter]


NEWS_SOURCES = (
    NewsSourceDefinition(
        key="author_today.news",
        name="Author Today",
        website_url="https://author.today/",
        adapter_factory=AuthorTodayNewsAdapter,
    ),
)
NEWS_SOURCE_BY_KEY = {source.key: source for source in NEWS_SOURCES}

CONTEST_SOURCES = (
    ContestSourceDefinition(
        key="author_today.contests",
        name="Author Today",
        website_url="https://author.today/contests",
        adapter_factory=AuthorTodayContestAdapter,
        detail_adapter_factory=AuthorTodayContestDetailAdapter,
    ),
)
CONTEST_SOURCE_BY_KEY = {source.key: source for source in CONTEST_SOURCES}
