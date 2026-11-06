from __future__ import annotations

import base64
from datetime import UTC, datetime
from uuid import UUID

from django.db.models import Q
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .models import Notification
from .service import publish_notification_change

PAGE_SIZE = 20


def _authentication_error(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    return None


def _encode_cursor(item: Notification) -> str:
    raw = f"{item.created_at.isoformat()}|{item.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(value: str) -> tuple[datetime, int] | None:
    try:
        padded = value + "=" * (-len(value) % 4)
        raw_date, raw_id = base64.urlsafe_b64decode(padded).decode().split("|", 1)
        parsed = datetime.fromisoformat(raw_date)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed, int(raw_id)
    except (ValueError, TypeError, UnicodeError):
        return None


def notification_payload(item: Notification) -> dict:
    return {
        "id": str(item.public_id),
        "category": item.category,
        "kind": item.kind,
        "payload": item.payload,
        "readAt": item.read_at.isoformat() if item.read_at else None,
        "createdAt": item.created_at.isoformat(),
    }


@require_GET
def summary(request):
    if error := _authentication_error(request):
        return error
    unread = Notification.objects.filter(
        recipient=request.user,
        read_at__isnull=True,
        expires_at__gt=timezone.now(),
    ).count()
    return JsonResponse({"unreadCount": unread})


@require_GET
def notifications(request):
    if error := _authentication_error(request):
        return error
    selected_filter = request.GET.get("filter", "all")
    if selected_filter not in {"all", "unread"}:
        return JsonResponse({"error": "notification_filter_invalid"}, status=400)
    now = timezone.now()
    queryset = Notification.objects.filter(
        recipient=request.user,
        expires_at__gt=now,
    ).select_related("recipient")
    if selected_filter == "unread":
        queryset = queryset.filter(read_at__isnull=True)
    cursor_value = request.GET.get("cursor", "")
    if cursor_value:
        cursor = _decode_cursor(cursor_value)
        if cursor is None:
            return JsonResponse({"error": "notification_cursor_invalid"}, status=400)
        created_at, item_id = cursor
        queryset = queryset.filter(
            Q(created_at__lt=created_at) | Q(created_at=created_at, id__lt=item_id)
        )
    page = list(queryset[: PAGE_SIZE + 1])
    has_more = len(page) > PAGE_SIZE
    page = page[:PAGE_SIZE]
    return JsonResponse(
        {
            "items": [notification_payload(item) for item in page],
            "nextCursor": _encode_cursor(page[-1]) if has_more and page else None,
            "unreadCount": Notification.objects.filter(
                recipient=request.user,
                read_at__isnull=True,
                expires_at__gt=now,
            ).count(),
        }
    )


@require_http_methods(["PATCH"])
def mark_read(request, notification_id: UUID):
    if error := _authentication_error(request):
        return error
    item = Notification.objects.filter(
        recipient=request.user,
        public_id=notification_id,
        expires_at__gt=timezone.now(),
    ).select_related("recipient").first()
    if item is None:
        return JsonResponse({"error": "notification_not_found"}, status=404)
    if item.read_at is None:
        item.read_at = timezone.now()
        item.save(update_fields=["read_at"])
        publish_notification_change(request.user.id)
    return JsonResponse({"notification": notification_payload(item)})


@require_POST
def mark_all_read(request):
    if error := _authentication_error(request):
        return error
    updated = Notification.objects.filter(
        recipient=request.user,
        read_at__isnull=True,
        expires_at__gt=timezone.now(),
    ).update(read_at=timezone.now())
    if updated:
        publish_notification_change(request.user.id)
    return JsonResponse({"updated": updated, "unreadCount": 0})
