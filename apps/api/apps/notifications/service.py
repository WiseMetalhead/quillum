from __future__ import annotations

import hashlib
import logging
from datetime import timedelta

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import Notification

RETENTION_DAYS = 90
logger = logging.getLogger(__name__)


def deduplication_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def user_group(user_id: int) -> str:
    return f"notifications.user.{user_id}"


def publish_notification_change(user_id: int) -> None:
    layer = get_channel_layer()
    if layer is None:
        return
    try:
        async_to_sync(layer.group_send)(
            user_group(user_id),
            {"type": "notifications.changed"},
        )
    except Exception:
        logger.exception("Unable to publish notification change user_id=%s", user_id)


def create_notification(
    *,
    recipient,
    kind: str,
    payload: dict,
    deduplication_key: str,
    email: bool = False,
    category: str = Notification.CATEGORY_SERVICE,
    expires_at=None,
) -> tuple[Notification, bool]:
    now = timezone.now()
    notification = Notification(
        recipient=recipient,
        kind=kind,
        category=category,
        deduplication_hash=deduplication_hash(deduplication_key),
        expires_at=expires_at or now + timedelta(days=RETENTION_DAYS),
        email_requested_at=now if email else None,
    )
    notification.payload = payload
    try:
        with transaction.atomic():
            notification.save()
    except IntegrityError:
        existing = Notification.objects.get(
            recipient=recipient,
            deduplication_hash=notification.deduplication_hash,
        )
        return existing, False

    def after_commit() -> None:
        publish_notification_change(recipient.id)
        if email:
            from .tasks import deliver_notification_email
            try:
                deliver_notification_email.delay(notification.id)
            except Exception:
                logger.exception("Unable to enqueue notification email id=%s", notification.id)

    transaction.on_commit(after_commit)
    return notification, True


def service_notification_for_login(request, user, method: str) -> None:
    from apps.accounts.rate_limit import request_ip

    now = timezone.now()
    create_notification(
        recipient=user,
        kind="service.new_login",
        payload={
            "ipAddress": request_ip(request),
            "method": method,
        },
        deduplication_key=f"login:{user.id}:{now.isoformat()}:{request.session.session_key}",
        email=True,
    )


def service_notification_for_tier_change(user, previous_tier: str, next_tier: str) -> None:
    create_notification(
        recipient=user,
        kind="service.tier_changed",
        payload={
            "previousTier": previous_tier,
            "nextTier": next_tier,
            "actionPath": "/settings?tab=tiers",
        },
        deduplication_key=(
            f"tier:{user.id}:{previous_tier}:{next_tier}:{timezone.now().isoformat()}"
        ),
        email=True,
    )
