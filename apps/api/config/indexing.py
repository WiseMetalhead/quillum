from __future__ import annotations

from collections.abc import Callable

from django.http import HttpRequest, HttpResponse


class NoIndexMiddleware:
    """Keep application and API responses out of cooperative search indexes."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        response.setdefault("X-Robots-Tag", "noindex, nofollow")
        return response
