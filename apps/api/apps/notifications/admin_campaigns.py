from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from uuid import UUID

from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_http_methods, require_POST

from apps.accounts.models import User
from apps.accounts.views import require_recent_auth
from apps.audit.service import write_audit_event

from .models import AdminNotificationCampaign, AdminNotificationRecipient

logger = logging.getLogger(__name__)
VALID_TIERS = {User.TIER_NOVICE, User.TIER_AUTHOR, User.TIER_BELIEVER, User.TIER_GOD}
EDITABLE_STATUSES = {
    AdminNotificationCampaign.STATUS_DRAFT,
    AdminNotificationCampaign.STATUS_SCHEDULED,
}


def _superuser_error(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if not request.user.is_superuser:
        return JsonResponse({"error": "superuser_required"}, status=403)
    return None


def _read_json(request) -> dict | None:
    try:
        value = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _validate_content(payload: dict) -> tuple[str, str, list[str]] | JsonResponse:
    title = str(payload.get("title", "")).strip()
    body = str(payload.get("body", "")).strip()
    tiers = payload.get("tiers", [])
    if not title or len(title) > 120:
        return JsonResponse({"error": "campaign_title_invalid"}, status=400)
    if not body or len(body) > 4000:
        return JsonResponse({"error": "campaign_body_invalid"}, status=400)
    if not isinstance(tiers, list) or any(
        not isinstance(tier, str) or tier not in VALID_TIERS for tier in tiers
    ):
        return JsonResponse({"error": "campaign_tiers_invalid"}, status=400)
    return title, body, sorted(set(tiers))


def _campaign(
    request,
    campaign_id: UUID,
    *,
    for_update: bool = False,
) -> AdminNotificationCampaign | JsonResponse:
    if error := _superuser_error(request):
        return error
    queryset = AdminNotificationCampaign.objects
    if for_update:
        queryset = queryset.select_for_update()
    campaign = queryset.filter(public_id=campaign_id).first()
    if campaign is None:
        return JsonResponse({"error": "campaign_not_found"}, status=404)
    return campaign


def campaign_payload(campaign: AdminNotificationCampaign, *, content: bool = True) -> dict:
    payload = {
        "id": str(campaign.public_id),
        "tiers": campaign.tiers,
        "status": campaign.status,
        "scheduledFor": campaign.scheduled_for.isoformat() if campaign.scheduled_for else None,
        "author": campaign.author.get_username() if campaign.author else None,
        "recipientCount": campaign.recipient_count,
        "sentCount": campaign.sent_count,
        "failedCount": campaign.failed_count,
        "createdAt": campaign.created_at.isoformat(),
        "updatedAt": campaign.updated_at.isoformat(),
    }
    if content:
        payload.update({"title": campaign.title, "body": campaign.body})
    return payload


def _audit(request, event: str, campaign: AdminNotificationCampaign) -> None:
    write_audit_event(
        request,
        event,
        actor=request.user,
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


def _enqueue(campaign_id: int) -> None:
    from .tasks import process_admin_notification_campaign

    try:
        process_admin_notification_campaign.delay(campaign_id)
    except Exception:
        logger.exception("Unable to enqueue admin notification campaign id=%s", campaign_id)


@require_http_methods(["GET", "POST"])
def campaigns(request):
    if error := _superuser_error(request):
        return error
    if request.method == "GET":
        queryset = AdminNotificationCampaign.objects.select_related("author")[:100]
        return JsonResponse({"items": [campaign_payload(item) for item in queryset]})

    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    validated = _validate_content(payload)
    if isinstance(validated, JsonResponse):
        return validated
    title, body, tiers = validated
    campaign = AdminNotificationCampaign(author=request.user, tiers=tiers)
    campaign.title = title
    campaign.body = body
    campaign.save()
    _audit(request, "admin.notification_campaign_created", campaign)
    return JsonResponse({"campaign": campaign_payload(campaign)}, status=201)


@require_http_methods(["GET", "PATCH"])
def campaign_detail(request, campaign_id: UUID):
    campaign = _campaign(request, campaign_id)
    if isinstance(campaign, JsonResponse):
        return campaign
    if request.method == "GET":
        return JsonResponse({"campaign": campaign_payload(campaign)})
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    validated = _validate_content(payload)
    if isinstance(validated, JsonResponse):
        return validated
    title, body, tiers = validated
    with transaction.atomic():
        campaign = _campaign(request, campaign_id, for_update=True)
        if isinstance(campaign, JsonResponse):
            return campaign
        if campaign.status not in EDITABLE_STATUSES:
            return JsonResponse({"error": "campaign_not_editable"}, status=409)
        campaign.title = title
        campaign.body = body
        campaign.tiers = tiers
        campaign.save(update_fields=["title", "body", "tiers", "updated_at"])
        _audit(request, "admin.notification_campaign_updated", campaign)
    return JsonResponse({"campaign": campaign_payload(campaign)})


def _scheduled_time(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


@require_POST
def schedule_campaign(request, campaign_id: UUID):
    if error := _superuser_error(request):
        return error
    if response := require_recent_auth(request):
        return response
    payload = _read_json(request)
    scheduled_for = _scheduled_time(payload.get("scheduledFor")) if payload else None
    if scheduled_for is None or scheduled_for <= timezone.now():
        return JsonResponse({"error": "campaign_schedule_invalid"}, status=400)
    with transaction.atomic():
        campaign = _campaign(request, campaign_id, for_update=True)
        if isinstance(campaign, JsonResponse):
            return campaign
        if campaign.status not in EDITABLE_STATUSES:
            return JsonResponse({"error": "campaign_not_schedulable"}, status=409)
        campaign.status = AdminNotificationCampaign.STATUS_SCHEDULED
        campaign.scheduled_for = scheduled_for
        campaign.save(update_fields=["status", "scheduled_for", "updated_at"])
        _audit(request, "admin.notification_campaign_scheduled", campaign)
    return JsonResponse({"campaign": campaign_payload(campaign)})


@require_POST
def send_campaign(request, campaign_id: UUID):
    if error := _superuser_error(request):
        return error
    if response := require_recent_auth(request):
        return response
    with transaction.atomic():
        campaign = _campaign(request, campaign_id, for_update=True)
        if isinstance(campaign, JsonResponse):
            return campaign
        if campaign.status not in EDITABLE_STATUSES:
            return JsonResponse({"error": "campaign_not_sendable"}, status=409)
        campaign.status = AdminNotificationCampaign.STATUS_SCHEDULED
        campaign.scheduled_for = timezone.now()
        campaign.save(update_fields=["status", "scheduled_for", "updated_at"])
        _audit(request, "admin.notification_campaign_send_requested", campaign)
        transaction.on_commit(lambda: _enqueue(campaign.id))
    return JsonResponse({"campaign": campaign_payload(campaign)}, status=202)


@require_POST
def cancel_campaign(request, campaign_id: UUID):
    if error := _superuser_error(request):
        return error
    if response := require_recent_auth(request):
        return response
    with transaction.atomic():
        campaign = _campaign(request, campaign_id, for_update=True)
        if isinstance(campaign, JsonResponse):
            return campaign
        if campaign.status not in EDITABLE_STATUSES:
            return JsonResponse({"error": "campaign_not_cancelable"}, status=409)
        campaign.status = AdminNotificationCampaign.STATUS_CANCELED
        campaign.canceled_at = timezone.now()
        campaign.save(update_fields=["status", "canceled_at", "updated_at"])
        _audit(request, "admin.notification_campaign_canceled", campaign)
    return JsonResponse({"campaign": campaign_payload(campaign)})


@require_POST
def retry_campaign(request, campaign_id: UUID):
    if error := _superuser_error(request):
        return error
    if response := require_recent_auth(request):
        return response
    with transaction.atomic():
        campaign = _campaign(request, campaign_id, for_update=True)
        if isinstance(campaign, JsonResponse):
            return campaign
        if campaign.status != AdminNotificationCampaign.STATUS_FAILED:
            return JsonResponse({"error": "campaign_not_retryable"}, status=409)
        campaign.recipients.filter(status=AdminNotificationRecipient.STATUS_FAILED).update(
            status=AdminNotificationRecipient.STATUS_PENDING,
            error_code="",
        )
        campaign.status = AdminNotificationCampaign.STATUS_SCHEDULED
        campaign.scheduled_for = timezone.now()
        campaign.failed_at = None
        campaign.save(update_fields=["status", "scheduled_for", "failed_at", "updated_at"])
        _audit(request, "admin.notification_campaign_retried", campaign)
        transaction.on_commit(lambda: _enqueue(campaign.id))
    return JsonResponse({"campaign": campaign_payload(campaign)}, status=202)
