from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Protocol


class SourceAdapterError(Exception):
    error_code = "source_adapter_error"


class SourceFetchError(SourceAdapterError):
    error_code = "source_fetch_failed"


class SourceParseError(SourceAdapterError):
    error_code = "source_parse_failed"


@dataclass(frozen=True)
class NormalizedNewsItem:
    external_id: str
    canonical_url: str
    title: str
    author_name: str
    summary: str
    published_at: datetime


class NewsSourceAdapter(Protocol):
    source_key: str

    def fetch(self) -> list[NormalizedNewsItem]: ...


@dataclass(frozen=True)
class NormalizedContestItem:
    external_id: str
    canonical_url: str
    title: str
    description: str
    status: str
    discussion_url: str
    action_kind: str
    action_url: str
    source_position: int


class ContestSourceAdapter(Protocol):
    source_key: str

    def fetch(self) -> list[NormalizedContestItem]: ...


@dataclass(frozen=True)
class NormalizedContestPhase:
    key: str
    kind: str
    label: str
    raw_text: str
    starts_on: date | None
    ends_on: date | None
    deadline_at: datetime | None
    precision: str
    source_section: str
    position: int


@dataclass(frozen=True)
class NormalizedContestDetail:
    external_id: str
    conditions_sections: list[dict[str, object]]
    phases: list[NormalizedContestPhase]
    condition_facts: list[dict[str, object]] = field(default_factory=list)


class ContestDetailSourceAdapter(Protocol):
    source_key: str

    def fetch(self, external_id: str) -> NormalizedContestDetail: ...
