from __future__ import annotations

import json
from datetime import UTC, date, datetime

import pytest
from django.utils import timezone

from apps.manuscripts.models import Document, Manuscript, Series, SeriesMembership, Workspace

from .contest_recommendations import contest_manuscript_recommendations
from .contest_tracking import contest_deadlines_payload
from .models import (
    ContestDatePrecision,
    ContestDetail,
    ContestItem,
    ContestParticipation,
    ContestPhase,
    ContestPhaseKind,
    ContestSourceSubscription,
    ContestStatus,
)


def _contest(*, status=ContestStatus.ACCEPTING, maximum=2):
    now = timezone.now()
    contest = ContestItem.objects.create(
        source_key="author_today.contests",
        external_id="recommendations-45",
        canonical_url="https://author.today/contest/45",
        title="Romance contest",
        description="Contest description",
        status=status,
        discussion_url="",
        action_kind="works",
        action_url="https://author.today/contest/45/works",
        source_position=0,
        content_hash="a" * 64,
        first_seen_at=now,
        last_seen_at=now,
    )
    facts = [
        {"kind": "form", "value": "Роман", "sourceText": "Форма: роман."},
        {
            "kind": "genre",
            "value": "Любовный роман",
            "sourceText": "Жанр: любовный роман.",
        },
        {
            "kind": "length",
            "min": 100,
            "max": 1_000,
            "sourceText": "Размер: от 100 до 1000 знаков.",
        },
        {
            "kind": "submission_length",
            "min": 100,
            "sourceText": "Минимальный объём текста для подачи заявки — 100 знаков.",
        },
        {"kind": "max_works", "value": maximum, "sourceText": "Не более 2 работ."},
    ]
    ContestDetail.objects.create(
        contest=contest,
        condition_facts=facts,
        conditions_sections=[],
        content_hash="b" * 64,
        status_at_last_sync=status,
        last_attempted_at=now,
        last_succeeded_at=now,
    )
    return contest


def _manuscript(
    user,
    title,
    *,
    kind=Manuscript.KIND_BOOK,
    genres=None,
    characters=200,
    drawer=False,
):
    manuscript = Manuscript.objects.create(
        workspace=Workspace.objects.create(owner=user),
        kind=kind,
        title=title,
        genres=genres or [],
        drawer_at=timezone.now() if drawer else None,
    )
    Document.objects.create(
        manuscript=manuscript,
        content={
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "x" * characters}],
                }
            ],
        },
    )
    return manuscript


def _enable_contests(user):
    ContestSourceSubscription.objects.create(
        user=user,
        source_key="author_today.contests",
        enabled=True,
    )


@pytest.mark.django_db
def test_recommendations_rank_metadata_and_include_books_from_series(django_user_model):
    user = django_user_model.objects.create_user(username="author", password="password")
    contest = _contest()
    romance = _manuscript(user, "Romance", genres=["romance"])
    _manuscript(user, "Battle fantasy", genres=["fantasy", "adventure"])
    _manuscript(
        user,
        "Story",
        kind=Manuscript.KIND_ONESHOT,
        genres=["romance", "short_story"],
    )
    _manuscript(user, "In drawer", genres=["romance"], drawer=True)
    series_book = _manuscript(user, "Series romance", genres=["historical_romance"])
    series = Series.objects.create(
        workspace=Workspace.objects.create(owner=user),
        title="Series",
    )
    SeriesMembership.objects.create(series=series, manuscript=series_book, position=1)

    recommendations = contest_manuscript_recommendations(contest, user)

    assert [item.manuscript for item in recommendations] == [romance, series_book]
    assert all(item.character_count == 200 for item in recommendations)


@pytest.mark.django_db
def test_participation_persists_after_drawer_and_metadata_changes(client, django_user_model):
    user = django_user_model.objects.create_user(username="author", password="password")
    contest = _contest()
    manuscript = _manuscript(user, "Romance", genres=["romance"])
    _enable_contests(user)
    client.force_login(user)
    participation_url = (
        f"/api/contests/{contest.public_id}/participation/{manuscript.public_id}/"
    )

    assert client.put(participation_url).json()["participating"] is True
    assert client.put(participation_url).json()["participating"] is True
    assert ContestParticipation.objects.count() == 1

    manuscript.drawer_at = timezone.now()
    manuscript.genres = ["fantasy"]
    manuscript.save(update_fields=["drawer_at", "genres"])
    contest.status = ContestStatus.IN_PROGRESS
    contest.save(update_fields=["status"])

    details = client.get(f"/api/contests/{contest.public_id}/details/").json()
    assert details["recommendedManuscripts"] == [
        {
            "id": str(manuscript.public_id),
            "kind": "book",
            "title": "Romance",
            "characterCount": 200,
            "coverThumbnailSmallUrl": "",
            "coverVersion": "",
            "participating": True,
            "trackingEnabled": False,
            "canParticipate": True,
        }
    ]

    tracked = client.patch(
        participation_url,
        data=json.dumps({"trackDeadlines": True}),
        content_type="application/json",
    )
    assert tracked.status_code == 200
    assert tracked.json()["recommendedManuscripts"][0]["trackingEnabled"] is True
    assert ContestParticipation.objects.get().track_deadlines is True

    assert client.delete(participation_url).json()["participating"] is False
    assert not ContestParticipation.objects.exists()


@pytest.mark.django_db
def test_tracking_requires_participation_and_boolean_payload(client, django_user_model):
    user = django_user_model.objects.create_user(username="author", password="password")
    contest = _contest()
    manuscript = _manuscript(user, "Romance", genres=["romance"])
    _enable_contests(user)
    client.force_login(user)
    url = f"/api/contests/{contest.public_id}/participation/{manuscript.public_id}/"

    missing = client.patch(
        url,
        data=json.dumps({"trackDeadlines": True}),
        content_type="application/json",
    )
    assert missing.status_code == 404
    assert missing.json()["error"] == "contest_participation_not_found"

    assert client.put(url).status_code == 200
    invalid = client.patch(
        url,
        data=json.dumps({"trackDeadlines": "yes"}),
        content_type="application/json",
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "contest_tracking_invalid"


@pytest.mark.django_db
def test_tracked_contest_deadlines_are_derived_from_current_successful_cache(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="author", password="password")
    contest = _contest()
    manuscript = _manuscript(user, "Romance", genres=["romance"])
    participation = ContestParticipation.objects.create(
        contest=contest,
        manuscript=manuscript,
        track_deadlines=True,
    )
    exact = ContestPhase.objects.create(
        detail=contest.detail,
        key="submission",
        kind=ContestPhaseKind.SUBMISSION,
        label="Приём работ",
        raw_text="Приём работ до 15 октября 2026 года",
        starts_on=date(2026, 9, 1),
        ends_on=date(2026, 10, 15),
        deadline_at=datetime(2026, 10, 15, 20, 59, tzinfo=UTC),
        precision=ContestDatePrecision.EXACT,
        source_section="timeline",
        position=1,
    )
    ContestPhase.objects.create(
        detail=contest.detail,
        key="judging",
        kind=ContestPhaseKind.JUDGING,
        label="Работа жюри",
        raw_text="Ноябрь 2026 года",
        starts_on=date(2026, 11, 1),
        ends_on=date(2026, 11, 30),
        precision=ContestDatePrecision.MONTH,
        source_section="timeline",
        position=2,
    )
    ContestPhase.objects.create(
        detail=contest.detail,
        key="unknown",
        kind=ContestPhaseKind.OTHER,
        label="Позднее",
        raw_text="Будет объявлено позднее",
        precision=ContestDatePrecision.UNPARSED,
        source_section="timeline",
        position=3,
    )

    payload = contest_deadlines_payload(manuscript)
    assert payload[0]["contestTitle"] == "Romance contest"
    assert [phase["key"] for phase in payload[0]["phases"]] == ["submission", "judging"]
    assert payload[0]["phases"][0]["deadlineAt"] == "2026-10-15T20:59:00+00:00"
    assert payload[0]["phases"][1]["precision"] == "month"

    exact.ends_on = date(2026, 10, 20)
    exact.save(update_fields=["ends_on"])
    assert contest_deadlines_payload(manuscript)[0]["phases"][0]["endsOn"] == "2026-10-20"

    client.force_login(user)
    planner = client.get(f"/api/manuscripts/{manuscript.public_id}/planner/?timezone=UTC")
    assert planner.status_code == 200
    assert planner.json()["planner"]["contestDeadlines"][0]["contestId"] == str(
        contest.public_id
    )

    participation.track_deadlines = False
    participation.save(update_fields=["track_deadlines"])
    assert contest_deadlines_payload(manuscript) == []


@pytest.mark.django_db
def test_participation_enforces_owner_stage_and_per_author_limit(client, django_user_model):
    user = django_user_model.objects.create_user(username="author", password="password")
    other = django_user_model.objects.create_user(username="other", password="password")
    contest = _contest(maximum=1)
    first = _manuscript(user, "First", genres=["romance"])
    second = _manuscript(user, "Second", genres=["romance"])
    foreign = _manuscript(other, "Foreign", genres=["romance"])
    _enable_contests(user)
    client.force_login(user)

    base = f"/api/contests/{contest.public_id}/participation"
    assert client.put(f"{base}/{foreign.public_id}/").status_code == 404
    ContestParticipation.objects.create(contest=contest, manuscript=foreign)
    assert client.put(f"{base}/{first.public_id}/").status_code == 200
    limit = client.put(f"{base}/{second.public_id}/")
    assert limit.status_code == 409
    assert limit.json()["error"] == "contest_participation_limit_reached"

    ContestParticipation.objects.all().delete()
    contest.status = ContestStatus.IN_PROGRESS
    contest.save(update_fields=["status"])
    closed = client.put(f"{base}/{second.public_id}/")
    assert closed.status_code == 409
    assert closed.json()["error"] == "contest_not_accepting"


@pytest.mark.django_db
def test_new_participation_rejects_drawer_manuscript(client, django_user_model):
    user = django_user_model.objects.create_user(username="author", password="password")
    contest = _contest()
    manuscript = _manuscript(user, "In drawer", genres=["romance"], drawer=True)
    _enable_contests(user)
    client.force_login(user)

    response = client.put(
        f"/api/contests/{contest.public_id}/participation/{manuscript.public_id}/"
    )

    assert response.status_code == 409
    assert response.json()["error"] == "contest_manuscript_in_drawer"
    assert not ContestParticipation.objects.filter(manuscript=manuscript).exists()


@pytest.mark.django_db
def test_participation_requires_auth_and_enabled_source_and_cascades(client, django_user_model):
    user = django_user_model.objects.create_user(username="author", password="password")
    contest = _contest()
    manuscript = _manuscript(user, "Romance", genres=["romance"])
    url = f"/api/contests/{contest.public_id}/participation/{manuscript.public_id}/"

    assert client.put(url).status_code == 401
    client.force_login(user)
    assert client.put(url).status_code == 404
    _enable_contests(user)
    assert client.put(url).status_code == 200

    manuscript.delete()
    assert not ContestParticipation.objects.exists()
