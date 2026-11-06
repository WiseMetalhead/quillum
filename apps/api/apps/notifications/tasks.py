from __future__ import annotations

from datetime import timedelta
from itertools import islice
from zoneinfo import ZoneInfo

from celery import shared_task
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone

from apps.accounts.tiers import storage_usage_bytes, tier_quotas
from apps.adminpanel.runtime_settings import runtime_setting
from apps.audit.models import AuditEvent
from apps.manuscripts.models import ManuscriptExport, ManuscriptShareLink

from .email import send_notification_email
from .models import (
    AdminNotificationCampaign,
    AdminNotificationRecipient,
    Notification,
    NotificationRule,
    ServiceEventReceipt,
    ServiceReminderState,
)
from .service import create_notification, deduplication_hash
from .user_rules import process_timed_rule

User = get_user_model()


@shared_task(bind=True, autoretry_for=(Exception,), retry_backoff=True, max_retries=3)
def deliver_notification_email(self, notification_id: int) -> None:
    notification = (
        Notification.objects.filter(id=notification_id).select_related("recipient").first()
    )
    if notification is None or notification.email_sent_at is not None:
        return
    Notification.objects.filter(id=notification.id).update(
        email_attempts=notification.email_attempts + 1,
        email_error_code="",
    )
    if not notification.recipient.email:
        Notification.objects.filter(id=notification.id).update(
            email_error_code="recipient_email_missing"
        )
        return
    try:
        send_notification_email(notification)
    except Exception as exc:
        Notification.objects.filter(id=notification.id).update(
            email_error_code=exc.__class__.__name__[:80]
        )
        raise
    Notification.objects.filter(id=notification.id).update(
        email_sent_at=timezone.now(),
        email_error_code="",
    )


def _reminder_due(state: ServiceReminderState, *, days: int, now) -> bool:
    return state.last_sent_at is None or state.last_sent_at <= now - timedelta(days=days)


def _mark_sent(state: ServiceReminderState, now) -> None:
    state.active = True
    state.last_sent_at = now
    state.save(update_fields=["active", "last_sent_at", "updated_at"])


def _scan_account_reminders(now) -> int:
    created = 0
    local_password_login_enabled = runtime_setting("local_password_login_enabled")
    due_timezones = []
    for timezone_name in (
        User.objects.filter(is_active=True).values_list("timezone", flat=True).distinct()
    ):
        try:
            local_now = now.astimezone(ZoneInfo(timezone_name))
        except (KeyError, TypeError):
            continue
        if local_now.hour == 10 and local_now.minute < 5:
            due_timezones.append(timezone_name)
    if not due_timezones:
        return 0
    for user in User.objects.filter(
        is_active=True,
        timezone__in=due_timezones,
    ).iterator():
        if local_password_login_enabled and user.has_usable_password():
            password_state, _ = ServiceReminderState.objects.get_or_create(
                user=user, kind="service.password_stale"
            )
            if user.password_changed_at <= now - timedelta(days=90) and _reminder_due(
                password_state, days=30, now=now
            ):
                _, was_created = create_notification(
                    recipient=user,
                    kind="service.password_stale",
                    payload={"actionPath": "/settings?tab=security"},
                    deduplication_key=f"password-stale:{user.id}:{now.date().isoformat()}",
                    email=True,
                )
                if was_created:
                    _mark_sent(password_state, now)
                    created += 1

            two_factor_state, _ = ServiceReminderState.objects.get_or_create(
                user=user, kind="service.two_factor_missing"
            )
            if user.two_factor_method == User.TWO_FACTOR_NONE:
                if _reminder_due(two_factor_state, days=14, now=now):
                    _, was_created = create_notification(
                        recipient=user,
                        kind="service.two_factor_missing",
                        payload={"actionPath": "/settings?tab=security"},
                        deduplication_key=(
                            f"two-factor-missing:{user.id}:{now.date().isoformat()}"
                        ),
                        email=True,
                    )
                    if was_created:
                        _mark_sent(two_factor_state, now)
                        created += 1
            elif two_factor_state.active:
                two_factor_state.active = False
                two_factor_state.save(update_fields=["active", "updated_at"])

        if user.author_workspace_enabled_at is None and not user.is_superuser:
            ServiceReminderState.objects.filter(
                user=user,
                kind="service.storage_near_limit",
                active=True,
            ).update(active=False, updated_at=now)
            continue

        storage_state, _ = ServiceReminderState.objects.get_or_create(
            user=user, kind="service.storage_near_limit"
        )
        limit = tier_quotas(user.tier)["storage_bytes"]
        used = storage_usage_bytes(user)
        near_limit = limit > 0 and used * 100 >= limit * 90
        if near_limit and (
            not storage_state.active or _reminder_due(storage_state, days=30, now=now)
        ):
            _, was_created = create_notification(
                recipient=user,
                kind="service.storage_near_limit",
                payload={
                    "usedBytes": used,
                    "limitBytes": limit,
                    "tier": user.tier,
                    "actionPath": "/settings?tab=storage",
                },
                deduplication_key=f"storage-near-limit:{user.id}:{now.date().isoformat()}",
                email=True,
            )
            if was_created:
                _mark_sent(storage_state, now)
                created += 1
        elif not near_limit and storage_state.active:
            storage_state.active = False
            storage_state.save(update_fields=["active", "updated_at"])
    return created


def _scan_expiring_objects(now) -> int:
    created = 0
    shares = (
        ManuscriptShareLink.objects.filter(expires_at__lte=now, revoked_at__isnull=True)
        .select_related("created_by", "manuscript__workspace")
        .order_by("expires_at")
    )
    for share in shares.iterator():
        deduplication_key = f"review-share-expired:{share.public_id}"
        source_hash = deduplication_hash(deduplication_key)
        if ServiceEventReceipt.objects.filter(
            user=share.created_by,
            kind="service.review_share_expired",
            source_hash=source_hash,
        ).exists():
            continue
        _, was_created = create_notification(
            recipient=share.created_by,
            kind="service.review_share_expired",
            payload={
                "manuscriptId": str(share.manuscript.public_id),
                "manuscriptTitle": share.manuscript.title,
                "shareId": str(share.public_id),
                "actionPath": (
                    f"/manuscripts/{share.manuscript.public_id}/editor"
                    "?dialog=share&workspace=author"
                ),
            },
            deduplication_key=deduplication_key,
        )
        ServiceEventReceipt.objects.get_or_create(
            user=share.created_by,
            kind="service.review_share_expired",
            source_hash=source_hash,
        )
        created += int(was_created)
        if created >= 200:
            break

    exports = (
        ManuscriptExport.objects.filter(
            status=ManuscriptExport.STATUS_READY,
            expires_at__gt=now,
            expires_at__lte=now + timedelta(minutes=10),
        )
        .select_related("owner", "manuscript__workspace")
        .order_by("expires_at")[:200]
    )
    for export in exports:
        _, was_created = create_notification(
            recipient=export.owner,
            kind="service.export_expiring",
            payload={
                "manuscriptId": str(export.manuscript.public_id),
                "manuscriptTitle": export.manuscript.title,
                "exportId": str(export.public_id),
                "expiresAt": export.expires_at.isoformat(),
                "downloadPath": (f"/api/manuscripts/exports/{export.public_id}/download/"),
            },
            deduplication_key=f"export-expiring:{export.public_id}",
        )
        created += int(was_created)
    return created


@shared_task
def scan_service_notifications() -> int:
    now = timezone.now()
    created = _scan_expiring_objects(now)
    created += _scan_account_reminders(now)
    return created


@shared_task(bind=True, autoretry_for=(Exception,), retry_backoff=True, max_retries=3)
def process_user_notification_rule(self, rule_id: int) -> int:
    rule = (
        NotificationRule.objects.filter(id=rule_id, enabled=True)
        .select_related("user")
        .prefetch_related("manuscripts")
        .first()
    )
    if rule is None or rule.next_run_at is None or rule.next_run_at > timezone.now():
        return 0
    return process_timed_rule(rule)


@shared_task
def scan_due_user_notification_rules() -> int:
    rule_ids = list(
        NotificationRule.objects.filter(
            enabled=True,
            next_run_at__isnull=False,
            next_run_at__lte=timezone.now(),
        ).values_list("id", flat=True)[:500]
    )
    for rule_id in rule_ids:
        process_user_notification_rule.delay(rule_id)
    return len(rule_ids)


@shared_task
def purge_expired_notifications() -> int:
    now = timezone.now()
    deleted, _details = Notification.objects.filter(expires_at__lte=now).delete()
    campaign_deleted, _campaign_details = AdminNotificationCampaign.objects.filter(
        status__in=[
            AdminNotificationCampaign.STATUS_SENT,
            AdminNotificationCampaign.STATUS_CANCELED,
            AdminNotificationCampaign.STATUS_FAILED,
        ],
        updated_at__lte=now - timedelta(days=90),
    ).delete()
    return deleted + campaign_deleted


@shared_task(bind=True, autoretry_for=(Exception,), retry_backoff=True, max_retries=3)
def process_admin_notification_campaign(self, campaign_id: int) -> int:
    with transaction.atomic():
        campaign = AdminNotificationCampaign.objects.select_for_update().get(id=campaign_id)
        if campaign.status not in {
            AdminNotificationCampaign.STATUS_SCHEDULED,
            AdminNotificationCampaign.STATUS_PROCESSING,
        }:
            return 0
        if campaign.status == AdminNotificationCampaign.STATUS_SCHEDULED:
            campaign.status = AdminNotificationCampaign.STATUS_PROCESSING
            campaign.processing_at = timezone.now()
            campaign.save(update_fields=["status", "processing_at", "updated_at"])
        if not campaign.recipients.exists():
            audience = User.objects.filter(is_active=True)
            if campaign.tiers:
                audience = audience.filter(tier__in=campaign.tiers)
            user_ids = audience.values_list("id", flat=True).iterator(chunk_size=500)
            while batch := list(islice(user_ids, 500)):
                AdminNotificationRecipient.objects.bulk_create(
                    [
                        AdminNotificationRecipient(campaign=campaign, recipient_id=user_id)
                        for user_id in batch
                    ],
                    ignore_conflicts=True,
                    batch_size=500,
                )
        campaign.recipient_count = campaign.recipients.count()
        campaign.save(update_fields=["recipient_count", "updated_at"])

    campaign = AdminNotificationCampaign.objects.get(id=campaign_id)
    title = campaign.title
    body = campaign.body
    deliveries = campaign.recipients.filter(
        Q(status=AdminNotificationRecipient.STATUS_PENDING)
        | Q(status=AdminNotificationRecipient.STATUS_FAILED)
    ).select_related("recipient")
    for delivery in deliveries.iterator(chunk_size=100):
        try:
            notification, _created = create_notification(
                recipient=delivery.recipient,
                category=Notification.CATEGORY_ADMIN,
                kind="admin.announcement",
                payload={
                    "campaignId": str(campaign.public_id),
                    "title": title,
                    "body": body,
                },
                deduplication_key=(
                    f"admin-campaign:{campaign.id}:recipient:{delivery.recipient_id}"
                ),
            )
            delivery.notification = notification
            delivery.status = AdminNotificationRecipient.STATUS_SENT
            delivery.sent_at = timezone.now()
            delivery.error_code = ""
        except Exception as exc:
            delivery.status = AdminNotificationRecipient.STATUS_FAILED
            delivery.error_code = exc.__class__.__name__[:80]
        delivery.attempts += 1
        delivery.save(
            update_fields=[
                "notification",
                "status",
                "sent_at",
                "error_code",
                "attempts",
                "updated_at",
            ]
        )

    with transaction.atomic():
        campaign = AdminNotificationCampaign.objects.select_for_update().get(id=campaign_id)
        if campaign.status != AdminNotificationCampaign.STATUS_PROCESSING:
            return campaign.sent_count
        counts = {
            row["status"]: row["count"]
            for row in campaign.recipients.values("status").annotate(count=Count("id"))
        }
        recipient_count = sum(counts.values())
        sent_count = counts.get(AdminNotificationRecipient.STATUS_SENT, 0)
        failed_count = counts.get(AdminNotificationRecipient.STATUS_FAILED, 0)
        now = timezone.now()
        campaign.status = (
            AdminNotificationCampaign.STATUS_FAILED
            if failed_count
            else AdminNotificationCampaign.STATUS_SENT
        )
        campaign.recipient_count = recipient_count
        campaign.sent_count = sent_count
        campaign.failed_count = failed_count
        campaign.sent_at = now if not failed_count else None
        campaign.failed_at = now if failed_count else None
        campaign.save(
            update_fields=[
                "status",
                "recipient_count",
                "sent_count",
                "failed_count",
                "sent_at",
                "failed_at",
                "updated_at",
            ]
        )
        AuditEvent.objects.create(
            event=(
                "admin.notification_campaign_failed"
                if failed_count
                else "admin.notification_campaign_sent"
            ),
            actor=campaign.author,
            subject=f"notification-campaign:{campaign.public_id}",
            payload={
                "campaignId": str(campaign.public_id),
                "tiers": campaign.tiers,
                "status": campaign.status,
                "recipientCount": campaign.recipient_count,
                "sentCount": campaign.sent_count,
                "failedCount": campaign.failed_count,
            },
        )
    return sent_count


@shared_task
def scan_scheduled_admin_notification_campaigns() -> int:
    campaign_ids = list(
        AdminNotificationCampaign.objects.filter(
            status=AdminNotificationCampaign.STATUS_SCHEDULED,
            scheduled_for__lte=timezone.now(),
        ).values_list("id", flat=True)[:100]
    )
    for campaign_id in campaign_ids:
        process_admin_notification_campaign.delay(campaign_id)
    return len(campaign_ids)
