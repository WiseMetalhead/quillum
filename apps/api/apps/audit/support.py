from __future__ import annotations

import json
from typing import Any

from django.http import HttpRequest
from django.utils import timezone

from .service import client_ip


def _submitted_username(request: HttpRequest) -> str | None:
    if request.path not in {"/api/auth/login/", "/api/auth/register/"}:
        return None
    try:
        payload: Any = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    username = payload.get("username") if isinstance(payload, dict) else None
    if username is None:
        return None
    return str(username).strip()[:150] or None


def error_support_context(request: HttpRequest, occurred_at=None) -> dict[str, Any]:
    user = getattr(request, "user", None)
    authenticated = bool(user and user.is_authenticated)
    return {
        "occurredAt": (occurred_at or timezone.now()).isoformat(),
        "username": user.get_username() if authenticated else _submitted_username(request),
        "userId": user.pk if authenticated else None,
        "ipAddress": client_ip(request),
    }
