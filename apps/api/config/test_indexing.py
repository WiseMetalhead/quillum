import pytest
from django.http import HttpResponse
from django.test import RequestFactory

from .indexing import NoIndexMiddleware


def test_no_index_middleware_marks_django_responses():
    request = RequestFactory().get("/api/health/")
    middleware = NoIndexMiddleware(lambda _request: HttpResponse("ok"))

    response = middleware(request)

    assert response["X-Robots-Tag"] == "noindex, nofollow"


def test_no_index_middleware_preserves_explicit_response_policy():
    request = RequestFactory().get("/api/health/")

    def explicit_policy(_request):
        response = HttpResponse("ok")
        response["X-Robots-Tag"] = "noindex, nofollow, noimageindex"
        return response

    response = NoIndexMiddleware(explicit_policy)(request)

    assert response["X-Robots-Tag"] == "noindex, nofollow, noimageindex"


@pytest.mark.django_db
def test_public_review_responses_are_not_indexed_or_stored(client):
    response = client.get("/api/manuscripts/review/not-a-real-share/")

    assert response.status_code == 404
    assert response["X-Robots-Tag"] == "noindex, nofollow"
    assert response["Cache-Control"] == "private, no-store"
