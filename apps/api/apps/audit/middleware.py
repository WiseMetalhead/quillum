from __future__ import annotations

import json

from django.http import HttpRequest, HttpResponse
from django.utils import timezone

from .support import error_support_context


class ErrorSupportContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        occurred_at = timezone.now()
        response = self.get_response(request)
        content_type = response.get("Content-Type", "")
        if response.status_code < 400 or not content_type.startswith("application/json"):
            return response

        try:
            payload = json.loads(response.content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return response
        if not isinstance(payload, dict) or not (
            payload.get("error") or payload.get("messages")
        ):
            return response

        payload["support"] = error_support_context(request, occurred_at)
        response.content = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        response["Content-Length"] = str(len(response.content))
        return response
