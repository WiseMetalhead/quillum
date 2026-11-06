from uuid import UUID

import pytest

from .models import Document, Manuscript, Series


@pytest.mark.django_db
def test_writing_api_uses_random_public_ids_and_rejects_database_ids(
    client, django_user_model
):
    user = django_user_model.objects.create_user(
        username="public-id-writer",
        email="public-id-writer@example.test",
        password="correct-password",
    )
    client.force_login(user)

    manuscript_response = client.post(
        "/api/manuscripts/oneshots/", {"title": "Public identifier"}
    )
    series_response = client.post("/api/manuscripts/series/", {"title": "Public series"})

    assert manuscript_response.status_code == 201
    assert series_response.status_code == 201
    manuscript_public_id = manuscript_response.json()["manuscript"]["id"]
    series_public_id = series_response.json()["series"]["id"]
    assert UUID(manuscript_public_id).version == 4
    assert UUID(series_public_id).version == 4

    manuscript = Manuscript.objects.get(public_id=manuscript_public_id)
    series = Series.objects.get(public_id=series_public_id)
    document = Document.objects.get(manuscript=manuscript)
    assert manuscript_response.json()["manuscript"]["documentId"] == str(document.public_id)
    assert client.get(f"/api/manuscripts/{manuscript_public_id}/").status_code == 200
    assert client.get(f"/api/manuscripts/series/{series_public_id}/").status_code == 200
    assert client.get(f"/api/manuscripts/{manuscript.id}/").status_code == 404
    assert client.get(f"/api/manuscripts/series/{series.id}/").status_code == 404
