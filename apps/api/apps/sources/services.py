from __future__ import annotations

import hashlib
import json
import logging

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from .adapters.base import (
    NormalizedContestDetail,
    NormalizedContestItem,
    NormalizedNewsItem,
    SourceAdapterError,
)
from .models import (
    ContestDetail,
    ContestItem,
    ContestPhase,
    ContestStatus,
    NewsItem,
    SourceSyncState,
)
from .registry import CONTEST_SOURCE_BY_KEY, NEWS_SOURCE_BY_KEY

logger = logging.getLogger(__name__)
SYNC_LOCK_SECONDS = 5 * 60


def _hash_payload(payload: dict) -> str:
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _news_content_hash(item: NormalizedNewsItem) -> str:
    payload = {
        "author": item.author_name,
        "publishedAt": item.published_at.isoformat(),
        "summary": item.summary,
        "title": item.title,
        "url": item.canonical_url,
    }
    return _hash_payload(payload)


def _contest_content_hash(item: NormalizedContestItem) -> str:
    return _hash_payload(
        {
            "actionKind": item.action_kind,
            "actionUrl": item.action_url,
            "description": item.description,
            "discussionUrl": item.discussion_url,
            "status": item.status,
            "title": item.title,
            "url": item.canonical_url,
        }
    )


def _contest_detail_content_hash(item: NormalizedContestDetail) -> str:
    return _hash_payload(
        {
            "conditionFacts": item.condition_facts,
            "conditionsSections": item.conditions_sections,
            "phases": [
                {
                    "deadlineAt": phase.deadline_at.isoformat() if phase.deadline_at else None,
                    "endsOn": phase.ends_on.isoformat() if phase.ends_on else None,
                    "key": phase.key,
                    "kind": phase.kind,
                    "label": phase.label,
                    "position": phase.position,
                    "precision": phase.precision,
                    "rawText": phase.raw_text,
                    "sourceSection": phase.source_section,
                    "startsOn": phase.starts_on.isoformat() if phase.starts_on else None,
                }
                for phase in item.phases
            ],
        }
    )


def _record_failure(source_key: str, error_code: str) -> None:
    now = timezone.now()
    state, _created = SourceSyncState.objects.get_or_create(source_key=source_key)
    state.last_attempted_at = now
    state.consecutive_failures += 1
    state.last_error_code = error_code[:80]
    state.save(
        update_fields=[
            "last_attempted_at",
            "consecutive_failures",
            "last_error_code",
            "updated_at",
        ]
    )


def sync_news_source(source_key: str) -> int | None:
    definition = NEWS_SOURCE_BY_KEY.get(source_key)
    if definition is None:
        raise ValueError("news_source_unknown")
    lock_key = f"sources:news-sync:{source_key}"
    if not cache.add(lock_key, "1", timeout=SYNC_LOCK_SECONDS):
        return None
    try:
        try:
            items = definition.adapter_factory().fetch()
            if not items:
                raise SourceAdapterError("news_items_missing")
        except SourceAdapterError as exc:
            error_code = getattr(exc, "error_code", "source_adapter_error")
            _record_failure(source_key, error_code)
            logger.warning("News source sync failed source=%s code=%s", source_key, error_code)
            raise

        now = timezone.now()
        with transaction.atomic():
            for item in items:
                content_hash = _news_content_hash(item)
                stored, created = NewsItem.objects.get_or_create(
                    source_key=source_key,
                    external_id=item.external_id,
                    defaults={
                        "canonical_url": item.canonical_url,
                        "title": item.title,
                        "author_name": item.author_name,
                        "summary": item.summary,
                        "published_at": item.published_at,
                        "content_hash": content_hash,
                        "last_seen_at": now,
                    },
                )
                if created:
                    continue
                stored.last_seen_at = now
                update_fields = ["last_seen_at", "updated_at"]
                if stored.content_hash != content_hash:
                    stored.canonical_url = item.canonical_url
                    stored.title = item.title
                    stored.author_name = item.author_name
                    stored.summary = item.summary
                    stored.published_at = item.published_at
                    stored.content_hash = content_hash
                    update_fields.extend(
                        [
                            "canonical_url",
                            "title",
                            "author_name",
                            "summary",
                            "published_at",
                            "content_hash",
                        ]
                    )
                stored.save(update_fields=update_fields)
            SourceSyncState.objects.update_or_create(
                source_key=source_key,
                defaults={
                    "last_attempted_at": now,
                    "last_succeeded_at": now,
                    "last_item_count": len(items),
                    "consecutive_failures": 0,
                    "last_error_code": "",
                },
            )
        return len(items)
    finally:
        cache.delete(lock_key)


def sync_contest_source(source_key: str) -> int | None:
    definition = CONTEST_SOURCE_BY_KEY.get(source_key)
    if definition is None:
        raise ValueError("contest_source_unknown")
    lock_key = f"sources:contest-sync:{source_key}"
    if not cache.add(lock_key, "1", timeout=SYNC_LOCK_SECONDS):
        return None
    try:
        try:
            items = definition.adapter_factory().fetch()
        except SourceAdapterError as exc:
            error_code = getattr(exc, "error_code", "source_adapter_error")
            _record_failure(source_key, error_code)
            logger.warning("Contest source sync failed source=%s code=%s", source_key, error_code)
            raise

        now = timezone.now()
        with transaction.atomic():
            stored_by_external_id = {
                contest.external_id: contest
                for contest in ContestItem.objects.filter(
                    source_key=source_key,
                    external_id__in=[item.external_id for item in items],
                )
            }
            for item in items:
                stored = stored_by_external_id.get(item.external_id)
                if stored is None and item.status == ContestStatus.FINISHED:
                    continue
                content_hash = _contest_content_hash(item)
                if stored is None:
                    ContestItem.objects.create(
                        source_key=source_key,
                        external_id=item.external_id,
                        canonical_url=item.canonical_url,
                        title=item.title,
                        description=item.description,
                        status=item.status,
                        discussion_url=item.discussion_url,
                        action_kind=item.action_kind,
                        action_url=item.action_url,
                        source_position=item.source_position,
                        content_hash=content_hash,
                        first_seen_at=now,
                        last_seen_at=now,
                    )
                    continue
                stored.last_seen_at = now
                stored.source_position = item.source_position
                update_fields = ["last_seen_at", "source_position", "updated_at"]
                if stored.content_hash != content_hash:
                    stored.canonical_url = item.canonical_url
                    stored.title = item.title
                    stored.description = item.description
                    stored.status = item.status
                    stored.discussion_url = item.discussion_url
                    stored.action_kind = item.action_kind
                    stored.action_url = item.action_url
                    stored.content_hash = content_hash
                    update_fields.extend(
                        [
                            "canonical_url",
                            "title",
                            "description",
                            "status",
                            "discussion_url",
                            "action_kind",
                            "action_url",
                            "content_hash",
                        ]
                    )
                stored.save(update_fields=update_fields)
            SourceSyncState.objects.update_or_create(
                source_key=source_key,
                defaults={
                    "last_attempted_at": now,
                    "last_succeeded_at": now,
                    "last_item_count": len(items),
                    "consecutive_failures": 0,
                    "last_error_code": "",
                },
            )
        return len(items)
    finally:
        cache.delete(lock_key)


def sync_contest_detail(contest_id: int) -> bool | None:
    contest = ContestItem.objects.get(id=contest_id)
    definition = CONTEST_SOURCE_BY_KEY.get(contest.source_key)
    if definition is None:
        raise ValueError("contest_source_unknown")
    lock_key = f"sources:contest-detail-sync:{contest.id}"
    if not cache.add(lock_key, "1", timeout=SYNC_LOCK_SECONDS):
        return None
    try:
        now = timezone.now()
        try:
            normalized = definition.detail_adapter_factory().fetch(contest.external_id)
            if normalized.external_id != contest.external_id:
                raise SourceAdapterError("contest_detail_mismatched")
        except SourceAdapterError as exc:
            error_code = getattr(exc, "error_code", "source_adapter_error")
            detail, _created = ContestDetail.objects.get_or_create(contest=contest)
            detail.last_attempted_at = now
            detail.consecutive_failures += 1
            detail.last_error_code = error_code[:80]
            detail.save(
                update_fields=[
                    "last_attempted_at",
                    "consecutive_failures",
                    "last_error_code",
                    "updated_at",
                ]
            )
            logger.warning(
                "Contest detail sync failed source=%s contest=%s code=%s",
                contest.source_key,
                contest.external_id,
                error_code,
            )
            raise

        content_hash = _contest_detail_content_hash(normalized)
        with transaction.atomic():
            detail, _created = ContestDetail.objects.select_for_update().get_or_create(
                contest=contest
            )
            if detail.content_hash != content_hash:
                detail.conditions_sections = normalized.conditions_sections
                detail.condition_facts = normalized.condition_facts
                detail.content_hash = content_hash
                detail.phases.all().delete()
                ContestPhase.objects.bulk_create(
                    [
                        ContestPhase(
                            detail=detail,
                            key=phase.key,
                            kind=phase.kind,
                            label=phase.label,
                            raw_text=phase.raw_text,
                            starts_on=phase.starts_on,
                            ends_on=phase.ends_on,
                            deadline_at=phase.deadline_at,
                            precision=phase.precision,
                            source_section=phase.source_section,
                            position=phase.position,
                        )
                        for phase in normalized.phases
                    ]
                )
            detail.status_at_last_sync = contest.status
            detail.last_attempted_at = now
            detail.last_succeeded_at = now
            detail.consecutive_failures = 0
            detail.last_error_code = ""
            detail.save(
                update_fields=[
                    "conditions_sections",
                    "condition_facts",
                    "content_hash",
                    "status_at_last_sync",
                    "last_attempted_at",
                    "last_succeeded_at",
                    "consecutive_failures",
                    "last_error_code",
                    "updated_at",
                ]
            )
        return True
    finally:
        cache.delete(lock_key)
