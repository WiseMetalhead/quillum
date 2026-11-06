from __future__ import annotations

import hashlib
import re

from django.core.cache import cache
from django.http import HttpRequest, JsonResponse

from apps.adminpanel.runtime_settings import runtime_setting
from apps.audit.service import client_ip

RATE_PATTERN = re.compile(
    r"^(?P<count>\d+)\s*/\s*(?P<period>\d+)?"
    r"(?P<unit>s|m|h|d|second|minute|hour|day)s?$"
)
PERIOD_SECONDS = {
    "s": 1,
    "second": 1,
    "m": 60,
    "minute": 60,
    "h": 60 * 60,
    "hour": 60 * 60,
    "d": 60 * 60 * 24,
    "day": 60 * 60 * 24,
}


def parse_rate(rate: str) -> tuple[int, int]:
    match = RATE_PATTERN.match(rate)
    if not match:
        raise ValueError(f"Invalid rate limit value: {rate}")
    count = int(match.group("count"))
    period = int(match.group("period") or "1")
    unit = match.group("unit")
    return count, period * PERIOD_SECONDS[unit]


def fingerprint(value: object) -> str:
    normalized = str(value or "").strip().lower() or "blank"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def rate_key(scope: str, *parts: object) -> str:
    joined = ":".join(fingerprint(part) for part in parts)
    return f"quillum:rate:{scope}:{joined}"


def request_ip(request: HttpRequest) -> str:
    return client_ip(request) or "unknown"


def rate_limit_exceeded(scope: str, rate: str, *parts: object) -> bool:
    limit, window = parse_rate(rate)
    key = rate_key(scope, *parts)
    current = cache.get(key, 0)
    return int(current) >= limit


def record_rate_limit_hit(scope: str, rate: str, *parts: object) -> bool:
    limit, window = parse_rate(rate)
    key = rate_key(scope, *parts)
    added = cache.add(key, 1, timeout=window)
    if added:
        return False
    try:
        current = cache.incr(key)
    except ValueError:
        cache.add(key, 1, timeout=window)
        current = 1
    return int(current) > limit


def rate_limited_response() -> JsonResponse:
    return JsonResponse({"error": "rate_limited"}, status=429)


def login_ip_limited(request: HttpRequest) -> bool:
    return rate_limit_exceeded(
        "login-ip",
        runtime_setting("login_ip_rate_limit"),
        request_ip(request),
    )


def login_account_limited(request: HttpRequest, username: str) -> bool:
    return rate_limit_exceeded(
        "login-account",
        runtime_setting("login_account_rate_limit"),
        request_ip(request),
        username,
    )


def record_failed_login(request: HttpRequest, username: str) -> bool:
    ip_limited = record_rate_limit_hit(
        "login-ip",
        runtime_setting("login_ip_rate_limit"),
        request_ip(request),
    )
    account_limited = record_rate_limit_hit(
        "login-account",
        runtime_setting("login_account_rate_limit"),
        request_ip(request),
        username,
    )
    return ip_limited or account_limited
