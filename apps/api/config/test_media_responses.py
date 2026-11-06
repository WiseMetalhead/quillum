from django.test import RequestFactory

from .media_responses import private_media_response


def test_private_presentation_media_revalidates_without_loading_content():
    def fail_load():
        raise AssertionError("content was loaded")

    request = RequestFactory().get("/private-image")
    response = private_media_response(
        request,
        cache_key="image:one:medium",
        load_content=lambda: (b"image", "image/webp"),
    )

    etag = response["ETag"]
    conditional_request = RequestFactory().get(
        "/private-image",
        headers={"If-None-Match": f'W/{etag}, "another"'},
    )
    conditional_response = private_media_response(
        conditional_request,
        cache_key="image:one:medium",
        load_content=fail_load,
    )

    assert conditional_response.status_code == 304
    assert conditional_response["ETag"] == etag
    assert conditional_response["Cache-Control"] == "private, no-cache"
    assert conditional_response["X-Content-Type-Options"] == "nosniff"


def test_private_original_media_is_not_stored_or_given_a_validator():
    response = private_media_response(
        RequestFactory().get("/private-image"),
        load_content=lambda: (b"original", "image/png"),
    )

    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    assert "ETag" not in response
