from datetime import timedelta

import pytest
from django.utils import timezone

from .models import Manuscript


def create_oneshot(client, title="Story"):
    return client.post("/api/manuscripts/oneshots/", {"title": title}).json()["manuscript"]


def create_book(client, title="Book"):
    return client.post(
        "/api/manuscripts/books/",
        {"title": title, "template": "chapters"},
    ).json()["manuscript"]


def create_series(client, title="Series"):
    return client.post("/api/manuscripts/series/", {"title": title}).json()["series"]


@pytest.mark.django_db
def test_drawer_hides_top_level_library_items_and_restores_them(client, django_user_model):
    user = django_user_model.objects.create_user(username="drawer-owner", password="password")
    client.force_login(user)
    oneshot = create_oneshot(client)
    book = create_book(client)
    series = create_series(client)

    assert client.put(f"/api/manuscripts/drawer/manuscripts/{oneshot['id']}/").status_code == 200
    assert client.put(f"/api/manuscripts/drawer/manuscripts/{book['id']}/").status_code == 200
    assert client.put(f"/api/manuscripts/drawer/series/{series['id']}/").status_code == 200

    assert client.get("/api/manuscripts/oneshots/").json()["items"] == []
    assert client.get("/api/manuscripts/books/").json()["items"] == []
    assert client.get("/api/manuscripts/series/").json()["items"] == []

    drawer_items = client.get("/api/manuscripts/drawer/").json()["items"]
    assert {(item["kind"], item["id"]) for item in drawer_items} == {
        ("oneshot", oneshot["id"]),
        ("book", book["id"]),
        ("series", series["id"]),
    }
    assert all(item["drawerAt"] for item in drawer_items)
    quotas = {
        item["key"]: item["used"]
        for item in client.get("/api/auth/tier/").json()["tier"]["quotas"]
    }
    assert quotas["oneshots"] == 1
    assert quotas["books"] == 1
    assert quotas["series"] == 1

    assert client.get(f"/api/manuscripts/oneshots/{oneshot['id']}/").status_code == 200
    assert client.get(f"/api/manuscripts/books/{book['id']}/").status_code == 200
    assert client.get(f"/api/manuscripts/series/{series['id']}/").status_code == 200

    assert client.delete(
        f"/api/manuscripts/drawer/manuscripts/{oneshot['id']}/"
    ).status_code == 200
    assert client.delete(
        f"/api/manuscripts/drawer/manuscripts/{book['id']}/"
    ).status_code == 200
    assert client.delete(f"/api/manuscripts/drawer/series/{series['id']}/").status_code == 200

    assert client.get("/api/manuscripts/oneshots/").json()["items"][0]["id"] == oneshot["id"]
    assert client.get("/api/manuscripts/books/").json()["items"][0]["id"] == book["id"]
    assert client.get("/api/manuscripts/series/").json()["items"][0]["id"] == series["id"]


@pytest.mark.django_db
def test_drawer_rejects_series_books_and_is_owner_scoped(client, django_user_model):
    owner = django_user_model.objects.create_user(username="drawer-series", password="password")
    other = django_user_model.objects.create_user(username="drawer-other", password="password")
    client.force_login(owner)
    book = create_book(client)
    series = create_series(client)
    added = client.put(
        f"/api/manuscripts/books/{book['id']}/series-membership/",
        data={"seriesId": series["id"], "seriesPosition": 1},
        content_type="application/json",
    )
    assert added.status_code == 200

    response = client.put(f"/api/manuscripts/drawer/manuscripts/{book['id']}/")
    assert response.status_code == 400
    assert response.json()["error"] == "drawer_series_book_forbidden"

    client.force_login(other)
    assert client.get("/api/manuscripts/drawer/").json()["items"] == []
    response = client.put(f"/api/manuscripts/drawer/series/{series['id']}/")
    assert response.status_code == 404
    assert response.json()["error"] == "drawer_item_not_found"


@pytest.mark.django_db
def test_series_membership_transfers_the_drawer_state(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="drawer-membership",
        password="password",
    )
    client.force_login(user)
    book = create_book(client)
    series = create_series(client)

    assert client.put(f"/api/manuscripts/drawer/manuscripts/{book['id']}/").status_code == 200
    added = client.put(
        f"/api/manuscripts/books/{book['id']}/series-membership/",
        data={"seriesId": series["id"], "seriesPosition": None},
        content_type="application/json",
    )
    assert added.status_code == 200
    assert client.get("/api/manuscripts/drawer/").json()["items"] == []

    assert client.put(f"/api/manuscripts/drawer/series/{series['id']}/").status_code == 200
    removed = client.delete(f"/api/manuscripts/books/{book['id']}/series-membership/")
    assert removed.status_code == 200
    drawer_items = client.get("/api/manuscripts/drawer/").json()["items"]
    assert {(item["kind"], item["id"]) for item in drawer_items} == {
        ("series", series["id"]),
        ("book", book["id"]),
    }
    assert client.get("/api/manuscripts/books/").json()["items"] == []


@pytest.mark.django_db
def test_drawer_removes_daily_focus_without_changing_author_statistics(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="drawer-focus", password="password")
    client.force_login(user)
    oneshot = create_oneshot(client, "Paused story")
    document = client.get(f"/api/manuscripts/oneshots/{oneshot['id']}/document/").json()[
        "document"
    ]
    saved = client.put(
        f"/api/manuscripts/oneshots/{oneshot['id']}/document/",
        data={
            "expectedGeneration": document["saveGeneration"],
            "schemaVersion": 3,
            "timezone": "UTC",
            "content": {
                "type": "doc",
                "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "Two words"}]}
                ],
            },
        },
        content_type="application/json",
    )
    assert saved.status_code == 200
    deadline = (timezone.now().date() + timedelta(days=14)).isoformat()
    planner = client.patch(
        f"/api/manuscripts/{oneshot['id']}/planner/",
        data={
            "deadline": deadline,
            "dailyWordGoal": 0,
            "manuscriptWordGoal": 0,
            "timezone": "UTC",
        },
        content_type="application/json",
    )
    assert planner.status_code == 200

    before = client.get("/api/manuscripts/dashboard/stats/?timezone=UTC").json()["stats"]
    assert before["manuscriptsInProgress"] == 1
    assert before["totalWords"] == 2
    assert before["wordsWrittenToday"] == 2
    assert before["nearestDeadline"]["manuscriptId"] == oneshot["id"]
    assert client.get("/api/manuscripts/dashboard/recent-work/").json()["recentWork"] is not None

    assert client.put(f"/api/manuscripts/drawer/manuscripts/{oneshot['id']}/").status_code == 200
    after = client.get("/api/manuscripts/dashboard/stats/?timezone=UTC").json()["stats"]
    assert after["manuscriptsInProgress"] == 0
    assert after["totalWords"] == 2
    assert after["wordsWrittenToday"] == 2
    assert after["nearestDeadline"] is None
    assert client.get("/api/manuscripts/dashboard/recent-work/").json()["recentWork"] is None

    assert Manuscript.objects.get(public_id=oneshot["id"]).drawer_at is not None
