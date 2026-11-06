from datetime import UTC, date, datetime, timedelta
from unittest.mock import patch

import pytest
from django.core.cache import cache
from django.utils import timezone

from .adapters.base import (
    NormalizedContestDetail,
    NormalizedContestItem,
    NormalizedContestPhase,
    NormalizedNewsItem,
    SourceFetchError,
)
from .models import (
    ContestDetail,
    ContestItem,
    ContestSourceSubscription,
    ContestStatus,
    NewsItem,
    NewsSourceSubscription,
    SourceSyncState,
)
from .registry import (
    CONTEST_SOURCE_BY_KEY,
    NEWS_SOURCE_BY_KEY,
    ContestSourceDefinition,
    NewsSourceDefinition,
)
from .services import sync_contest_detail, sync_contest_source, sync_news_source
from .tasks import (
    ADMIN_CONTESTS_REFRESH_LOCK_KEY,
    ADMIN_NEWS_REFRESH_LOCK_KEY,
    SourceMaintenanceBusy,
    admin_refresh_contest_sources,
    admin_refresh_news_sources,
)
from .tasks import sync_contest_source as sync_contest_source_task


class StubAdapter:
    source_key = "author_today.news"
    items: list[NormalizedNewsItem] = []
    error: Exception | None = None
    calls = 0

    def fetch(self):
        type(self).calls += 1
        if self.error:
            raise self.error
        return self.items


class StubContestAdapter:
    source_key = "author_today.contests"
    items: list[NormalizedContestItem] = []
    error: Exception | None = None
    calls = 0

    def fetch(self):
        type(self).calls += 1
        if self.error:
            raise self.error
        return self.items


class StubContestDetailAdapter:
    source_key = "author_today.contests"
    item: NormalizedContestDetail | None = None
    error: Exception | None = None
    calls = 0

    def fetch(self, external_id: str):
        type(self).calls += 1
        if self.error:
            raise self.error
        assert self.item is not None
        return self.item


def _item(summary: str = "Summary", *, external_id: str = "42") -> NormalizedNewsItem:
    return NormalizedNewsItem(
        external_id=external_id,
        canonical_url=f"https://author.today/post/{external_id}",
        title=f"Title {external_id}",
        author_name="Editorial team",
        summary=summary,
        published_at=datetime(2026, 9, 8, 8, 15, tzinfo=UTC),
    )


def _contest_item(
    status: str = ContestStatus.ACCEPTING,
    *,
    external_id: str = "45",
    description: str = "Contest description",
    position: int = 0,
) -> NormalizedContestItem:
    action_kind = "results" if status == ContestStatus.FINISHED else "works"
    return NormalizedContestItem(
        external_id=external_id,
        canonical_url=f"https://author.today/contest/{external_id}",
        title=f"Contest {external_id}",
        description=description,
        status=status,
        discussion_url="https://author.today/post/931906",
        action_kind=action_kind,
        action_url=f"https://author.today/contest/{external_id}/{action_kind}",
        source_position=position,
    )


def _contest_detail() -> NormalizedContestDetail:
    return NormalizedContestDetail(
        external_id="45",
        conditions_sections=[{"kind": "requirements", "title": "Requirements", "text": "A novel."}],
        condition_facts=[{"kind": "form", "value": "novel", "sourceText": "Form: novel."}],
        phases=[
            NormalizedContestPhase(
                key="submission",
                kind="submission",
                label="Entries",
                raw_text="Entries through 30 November 2026",
                starts_on=None,
                ends_on=date(2026, 11, 30),
                deadline_at=None,
                precision="exact",
                source_section="timeline",
                position=0,
            )
        ],
    )


@pytest.fixture(autouse=True)
def stub_source(monkeypatch):
    StubAdapter.items = [_item()]
    StubAdapter.error = None
    StubAdapter.calls = 0
    StubContestAdapter.items = [_contest_item()]
    StubContestAdapter.error = None
    StubContestAdapter.calls = 0
    StubContestDetailAdapter.item = _contest_detail()
    StubContestDetailAdapter.error = None
    StubContestDetailAdapter.calls = 0
    cache.clear()
    monkeypatch.setitem(
        NEWS_SOURCE_BY_KEY,
        "author_today.news",
        NewsSourceDefinition(
            key="author_today.news",
            name="Author Today",
            website_url="https://author.today/",
            adapter_factory=StubAdapter,
        ),
    )
    monkeypatch.setitem(
        CONTEST_SOURCE_BY_KEY,
        "author_today.contests",
        ContestSourceDefinition(
            key="author_today.contests",
            name="Author Today",
            website_url="https://author.today/contests",
            adapter_factory=StubContestAdapter,
            detail_adapter_factory=StubContestDetailAdapter,
        ),
    )


@pytest.mark.django_db
def test_sync_news_source_deduplicates_and_updates_changed_content():
    assert sync_news_source("author_today.news") == 1
    first = NewsItem.objects.get()
    first_hash = first.content_hash

    StubAdapter.items = [_item("Changed summary")]
    assert sync_news_source("author_today.news") == 1

    first.refresh_from_db()
    assert NewsItem.objects.count() == 1
    assert first.summary == "Changed summary"
    assert first.content_hash != first_hash
    state = SourceSyncState.objects.get(source_key="author_today.news")
    assert state.last_item_count == 1
    assert state.consecutive_failures == 0
    assert state.last_succeeded_at is not None


@pytest.mark.django_db
def test_sync_failure_preserves_cached_news_and_records_safe_state():
    sync_news_source("author_today.news")
    cached_hash = NewsItem.objects.get().content_hash
    StubAdapter.error = SourceFetchError("network details")

    with pytest.raises(SourceFetchError):
        sync_news_source("author_today.news")

    assert NewsItem.objects.get().content_hash == cached_hash
    state = SourceSyncState.objects.get(source_key="author_today.news")
    assert state.consecutive_failures == 1
    assert state.last_error_code == "source_fetch_failed"


@pytest.mark.django_db
def test_sync_lock_prevents_overlapping_fetch():
    cache.add("sources:news-sync:author_today.news", "1", timeout=60)

    assert sync_news_source("author_today.news") is None
    assert StubAdapter.calls == 0


@pytest.mark.django_db
def test_news_sources_default_off_and_patch_enables_source(
    client, django_user_model, django_capture_on_commit_callbacks
):
    user = django_user_model.objects.create_user(username="reader", password="password-1234")
    client.force_login(user)

    response = client.get("/api/news/sources/")
    assert response.status_code == 200
    assert response.json()["newsEnabled"] is False
    assert response.json()["items"][0]["enabled"] is False

    with (
        patch("apps.sources.tasks.sync_news_source.delay") as delayed,
        django_capture_on_commit_callbacks(execute=True),
    ):
        response = client.patch(
            "/api/news/sources/",
            data={"enabledSourceKeys": ["author_today.news"]},
            content_type="application/json",
        )
    assert response.status_code == 200
    assert response.json()["newsEnabled"] is True
    delayed.assert_called_once_with("author_today.news")
    assert NewsSourceSubscription.objects.filter(user=user, enabled=True).exists()
    assert client.get("/api/auth/session/").json()["user"]["newsEnabled"] is True


@pytest.mark.django_db
def test_news_sources_reject_unknown_or_duplicate_keys(client, django_user_model):
    user = django_user_model.objects.create_user(username="reader", password="password-1234")
    client.force_login(user)

    for keys in (["unknown.news"], ["author_today.news", "author_today.news"]):
        response = client.patch(
            "/api/news/sources/",
            data={"enabledSourceKeys": keys},
            content_type="application/json",
        )
        assert response.status_code == 400
        assert response.json()["error"] == "news_sources_invalid"


@pytest.mark.django_db
def test_news_feed_filters_disabled_sources_and_uses_cursor_pagination(client, django_user_model):
    user = django_user_model.objects.create_user(username="reader", password="password-1234")
    now = timezone.now()
    for index in range(21):
        NewsItem.objects.create(
            source_key="author_today.news",
            external_id=str(index),
            canonical_url=f"https://author.today/post/{index}",
            title=f"Title {index}",
            author_name="Editorial team",
            summary="Summary",
            published_at=now - timedelta(minutes=index),
            content_hash=str(index).zfill(64),
            last_seen_at=now,
        )
    client.force_login(user)

    assert client.get("/api/news/").json() == {"items": [], "nextCursor": None}
    NewsSourceSubscription.objects.create(user=user, source_key="author_today.news", enabled=True)
    first = client.get("/api/news/")
    assert first.status_code == 200
    assert len(first.json()["items"]) == 20
    assert first.json()["nextCursor"]
    second = client.get("/api/news/", {"cursor": first.json()["nextCursor"]})
    assert len(second.json()["items"]) == 1
    assert second.json()["nextCursor"] is None


@pytest.mark.django_db
def test_news_api_requires_authentication(client):
    assert client.get("/api/news/").status_code == 401
    assert client.get("/api/news/sources/").status_code == 401


@pytest.mark.django_db
def test_deleting_account_cascades_news_subscription(django_user_model):
    user = django_user_model.objects.create_user(username="reader", password="password-1234")
    NewsSourceSubscription.objects.create(user=user, source_key="author_today.news", enabled=True)

    user.delete()

    assert not NewsSourceSubscription.objects.exists()


@pytest.mark.django_db
def test_contest_sync_imports_only_active_and_updates_known_to_finished():
    StubContestAdapter.items = [
        _contest_item(),
        _contest_item(ContestStatus.FINISHED, external_id="44", position=1),
    ]

    assert sync_contest_source("author_today.contests") == 2
    assert list(ContestItem.objects.values_list("external_id", flat=True)) == ["45"]

    original_hash = ContestItem.objects.get().content_hash
    StubContestAdapter.items = [
        _contest_item(
            ContestStatus.FINISHED,
            external_id="45",
            description="Updated description",
        )
    ]
    assert sync_contest_source("author_today.contests") == 1

    contest = ContestItem.objects.get()
    assert contest.status == ContestStatus.FINISHED
    assert contest.description == "Updated description"
    assert contest.content_hash != original_hash


@pytest.mark.django_db
def test_contest_sync_treats_finished_only_page_as_success_without_backfill():
    StubContestAdapter.items = [_contest_item(ContestStatus.FINISHED, external_id="44")]

    assert sync_contest_source("author_today.contests") == 1

    assert not ContestItem.objects.exists()
    state = SourceSyncState.objects.get(source_key="author_today.contests")
    assert state.last_item_count == 1
    assert state.last_succeeded_at is not None


@pytest.mark.django_db
def test_contest_sync_does_not_infer_finished_or_delete_missing_items():
    sync_contest_source("author_today.contests")
    StubContestAdapter.items = [_contest_item(ContestStatus.FINISHED, external_id="99")]

    sync_contest_source("author_today.contests")

    contest = ContestItem.objects.get()
    assert contest.external_id == "45"
    assert contest.status == ContestStatus.ACCEPTING


@pytest.mark.django_db
def test_contest_sync_failure_preserves_cache_and_lock_prevents_overlap():
    sync_contest_source("author_today.contests")
    cached_hash = ContestItem.objects.get().content_hash
    StubContestAdapter.error = SourceFetchError("network details")

    with pytest.raises(SourceFetchError):
        sync_contest_source("author_today.contests")

    assert ContestItem.objects.get().content_hash == cached_hash
    state = SourceSyncState.objects.get(source_key="author_today.contests")
    assert state.consecutive_failures == 1
    assert state.last_error_code == "source_fetch_failed"

    StubContestAdapter.error = None
    cache.add("sources:contest-sync:author_today.contests", "1", timeout=60)
    calls = StubContestAdapter.calls
    assert sync_contest_source("author_today.contests") is None
    assert StubContestAdapter.calls == calls


@pytest.mark.django_db
def test_contest_detail_sync_updates_atomically_and_preserves_cache_on_failure():
    sync_contest_source("author_today.contests")
    contest = ContestItem.objects.get()

    assert sync_contest_detail(contest.id) is True
    detail = ContestDetail.objects.get(contest=contest)
    first_hash = detail.content_hash
    assert detail.phases.get().ends_on == date(2026, 11, 30)
    assert detail.condition_facts[0]["value"] == "novel"

    StubContestDetailAdapter.item = NormalizedContestDetail(
        external_id="45",
        conditions_sections=[{"kind": "requirements", "title": "Requirements", "text": "Updated."}],
        phases=[],
    )
    assert sync_contest_detail(contest.id) is True
    detail.refresh_from_db()
    assert detail.content_hash != first_hash
    assert detail.conditions_sections[0]["text"] == "Updated."
    assert not detail.phases.exists()

    cached_hash = detail.content_hash
    StubContestDetailAdapter.error = SourceFetchError("private network detail")
    with pytest.raises(SourceFetchError):
        sync_contest_detail(contest.id)
    detail.refresh_from_db()
    assert detail.content_hash == cached_hash
    assert detail.conditions_sections[0]["text"] == "Updated."
    assert detail.consecutive_failures == 1
    assert detail.last_error_code == "source_fetch_failed"


@pytest.mark.django_db
def test_contest_detail_sync_lock_prevents_overlap():
    sync_contest_source("author_today.contests")
    contest = ContestItem.objects.get()
    cache.add(f"sources:contest-detail-sync:{contest.id}", "1", timeout=60)

    assert sync_contest_detail(contest.id) is None
    assert StubContestDetailAdapter.calls == 0


@pytest.mark.django_db
def test_contest_list_task_queues_active_and_final_detail_refresh():
    with patch("apps.sources.tasks.sync_contest_detail.delay") as delayed:
        assert sync_contest_source_task("author_today.contests") == 1
    contest = ContestItem.objects.get()
    delayed.assert_called_once_with(contest.id)

    sync_contest_detail(contest.id)
    StubContestAdapter.items = [_contest_item(ContestStatus.FINISHED)]
    with patch("apps.sources.tasks.sync_contest_detail.delay") as delayed:
        assert sync_contest_source_task("author_today.contests") == 1
    delayed.assert_called_once_with(contest.id)


@pytest.mark.django_db
def test_admin_news_refresh_runs_registered_sources_and_releases_action_lock():
    cache.add(ADMIN_NEWS_REFRESH_LOCK_KEY, "operator", timeout=60)

    assert admin_refresh_news_sources() == 1

    assert StubAdapter.calls == 1
    assert NewsItem.objects.count() == 1
    assert cache.get(ADMIN_NEWS_REFRESH_LOCK_KEY) is None


@pytest.mark.django_db
def test_admin_contest_refresh_waits_for_list_and_relevant_details():
    cache.add(ADMIN_CONTESTS_REFRESH_LOCK_KEY, "operator", timeout=60)

    assert admin_refresh_contest_sources() == 1

    contest = ContestItem.objects.get()
    assert StubContestAdapter.calls == 1
    assert StubContestDetailAdapter.calls == 1
    assert contest.detail.last_succeeded_at is not None
    assert cache.get(ADMIN_CONTESTS_REFRESH_LOCK_KEY) is None


@pytest.mark.django_db
def test_admin_refresh_reports_source_overlap_and_releases_action_lock():
    cache.add(ADMIN_NEWS_REFRESH_LOCK_KEY, "operator", timeout=60)
    cache.add("sources:news-sync:author_today.news", "scheduler", timeout=60)

    with pytest.raises(SourceMaintenanceBusy):
        admin_refresh_news_sources()

    assert cache.get(ADMIN_NEWS_REFRESH_LOCK_KEY) is None
    assert NewsItem.objects.count() == 0


@pytest.mark.django_db
def test_contest_sources_default_off_and_first_enable_queues_sync(
    client, django_user_model, django_capture_on_commit_callbacks
):
    user = django_user_model.objects.create_user(username="contest-reader", password="password")
    client.force_login(user)

    response = client.get("/api/contests/sources/")
    assert response.status_code == 200
    assert response.json()["contestsEnabled"] is False
    assert response.json()["items"][0]["enabled"] is False

    with (
        patch("apps.sources.tasks.sync_contest_source.delay") as delayed,
        django_capture_on_commit_callbacks(execute=True),
    ):
        response = client.patch(
            "/api/contests/sources/",
            data={"enabledSourceKeys": ["author_today.contests"]},
            content_type="application/json",
        )
    assert response.status_code == 200
    assert response.json()["contestsEnabled"] is True
    delayed.assert_called_once_with("author_today.contests")
    session_user = client.get("/api/auth/session/").json()["user"]
    assert session_user["newsEnabled"] is False
    assert session_user["contestsEnabled"] is True
    assert session_user["feedEnabled"] is True


@pytest.mark.django_db
def test_contest_sources_reject_unknown_and_duplicate_keys(client, django_user_model):
    user = django_user_model.objects.create_user(username="contest-reader", password="password")
    client.force_login(user)

    for keys in (["unknown.contests"], ["author_today.contests", "author_today.contests"]):
        response = client.patch(
            "/api/contests/sources/",
            data={"enabledSourceKeys": keys},
            content_type="application/json",
        )
        assert response.status_code == 400
        assert response.json()["error"] == "contest_sources_invalid"


@pytest.mark.django_db
def test_contest_feed_filters_status_and_uses_cursor_pagination(client, django_user_model):
    user = django_user_model.objects.create_user(username="contest-reader", password="password")
    now = timezone.now()
    for index in range(21):
        ContestItem.objects.create(
            source_key="author_today.contests",
            external_id=str(index),
            canonical_url=f"https://author.today/contest/{index}",
            title=f"Contest {index}",
            description="Description",
            status=ContestStatus.ACCEPTING,
            discussion_url="",
            action_kind="works",
            action_url=f"https://author.today/contest/{index}/works",
            source_position=index,
            content_hash=str(index).zfill(64),
            first_seen_at=now,
            last_seen_at=now,
        )
    client.force_login(user)

    assert client.get("/api/contests/").json() == {"items": [], "nextCursor": None}
    ContestSourceSubscription.objects.create(
        user=user, source_key="author_today.contests", enabled=True
    )

    first = client.get("/api/contests/", {"status": ContestStatus.ACCEPTING})
    assert first.status_code == 200
    assert len(first.json()["items"]) == 20
    assert first.json()["nextCursor"]
    assert first.json()["items"][0]["terminalAction"]["kind"] == "works"
    second = client.get("/api/contests/", {"cursor": first.json()["nextCursor"]})
    assert len(second.json()["items"]) == 1
    assert second.json()["nextCursor"] is None
    invalid = client.get("/api/contests/", {"status": "unknown"})
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "contest_status_invalid"
    assert client.get("/api/contests/", {"source": "unknown"}).status_code == 400
    assert client.get("/api/contests/", {"cursor": "invalid"}).status_code == 400


@pytest.mark.django_db
def test_contest_detail_api_requires_enabled_source_and_returns_cached_detail(
    client, django_user_model
):
    user = django_user_model.objects.create_user(username="contest-reader", password="password")
    sync_contest_source("author_today.contests")
    contest = ContestItem.objects.get()
    client.force_login(user)

    hidden = client.get(f"/api/contests/{contest.public_id}/details/")
    assert hidden.status_code == 404

    ContestSourceSubscription.objects.create(
        user=user, source_key="author_today.contests", enabled=True
    )
    pending = client.get(f"/api/contests/{contest.public_id}/details/")
    assert pending.status_code == 200
    assert pending.json()["state"] == "pending"

    sync_contest_detail(contest.id)
    response = client.get(f"/api/contests/{contest.public_id}/details/")
    assert response.status_code == 200
    payload = response.json()
    assert payload["state"] == "ready"
    assert payload["isStale"] is False
    assert payload["phases"][0]["endsOn"] == "2026-11-30"
    assert payload["conditionFacts"][0]["kind"] == "form"
    assert payload["conditionsSections"][0]["kind"] == "requirements"


@pytest.mark.django_db
def test_contest_list_reports_detail_state(client, django_user_model):
    user = django_user_model.objects.create_user(username="contest-reader", password="password")
    sync_contest_source("author_today.contests")
    contest = ContestItem.objects.get()
    ContestSourceSubscription.objects.create(
        user=user, source_key="author_today.contests", enabled=True
    )
    client.force_login(user)

    assert client.get("/api/contests/").json()["items"][0]["detailState"] == "pending"
    sync_contest_detail(contest.id)
    assert client.get("/api/contests/").json()["items"][0]["detailState"] == "ready"


@pytest.mark.django_db
def test_contest_api_requires_authentication_and_subscription_cascades(client, django_user_model):
    assert client.get("/api/contests/").status_code == 401
    assert client.get("/api/contests/sources/").status_code == 401
    assert (
        client.get("/api/contests/00000000-0000-0000-0000-000000000000/details/").status_code == 401
    )

    user = django_user_model.objects.create_user(username="contest-reader", password="password")
    ContestSourceSubscription.objects.create(
        user=user, source_key="author_today.contests", enabled=True
    )
    user.delete()
    assert not ContestSourceSubscription.objects.exists()
