from __future__ import annotations

import json
import uuid
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.paginator import EmptyPage, Paginator
from django.core.validators import validate_email
from django.db import transaction
from django.db.models import OuterRef, Q, Subquery
from django.http import JsonResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from apps.accounts.capabilities import has_author_workspace, has_editor_workspace
from apps.accounts.email import send_templated_runtime_email
from apps.accounts.lookups import audit_ip_lookup_q, email_lookup_q
from apps.accounts.models import RegistrationCounter, TierActivityProgress
from apps.accounts.oidc import oidc_status_payload
from apps.accounts.services import delete_account_data
from apps.accounts.sessions import revoke_user_sessions
from apps.accounts.tier_progression import (
    MAXIMUM_DAYS,
    MINIMUM_DAYS,
    progression_policy,
    reset_tier_activity,
)
from apps.accounts.tier_progression import (
    policy_payload as tier_progression_policy_payload,
)
from apps.accounts.tiers import (
    TIER_LABELS,
    delete_quota_override,
    quota_admin_payload,
    set_quota_override,
    user_quota_usage,
    valid_tier,
)
from apps.accounts.views import require_recent_auth
from apps.audit.models import AuditEvent
from apps.audit.service import write_audit_event
from apps.manuscripts.transcription import transcription_model_status_payload
from apps.notifications.service import create_notification, service_notification_for_tier_change
from apps.notifications.views import notification_payload
from apps.sources.tasks import (
    ADMIN_CONTESTS_REFRESH_LOCK_KEY,
    ADMIN_CONTESTS_REFRESH_TASK_NAME,
    ADMIN_NEWS_REFRESH_LOCK_KEY,
    ADMIN_NEWS_REFRESH_TASK_NAME,
    ADMIN_REFRESH_LOCK_SECONDS,
    admin_refresh_contest_sources,
    admin_refresh_news_sources,
)

from .models import BackgroundTaskRun
from .runtime_settings import (
    delete_runtime_override,
    environment_value,
    runtime_setting,
    set_runtime_override,
    setting_definition,
    settings_payload,
)
from .status import (
    check_celery_worker,
    check_collaboration,
    check_database,
    check_redis,
    check_storage,
    task_activity_payload,
)

User = get_user_model()
DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100
SERVICE_NOTIFICATION_KINDS = {
    "service.password_stale",
    "service.two_factor_missing",
    "service.review_share_expired",
    "service.export_expiring",
    "service.storage_near_limit",
    "service.tier_changed",
    "service.new_login",
    "service.account_export_ready",
    "service.audio_transcription_ready",
    "service.audio_transcription_failed",
    "service.editor_manuscript_access_granted",
    "service.editor_manuscript_access_revoked",
}
SERVICE_EMAIL_KINDS = {
    "service.password_stale",
    "service.two_factor_missing",
    "service.storage_near_limit",
    "service.tier_changed",
    "service.new_login",
    "service.account_export_ready",
    "service.editor_manuscript_access_granted",
    "service.editor_manuscript_access_revoked",
}


def require_superuser(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    if not request.user.is_superuser:
        return JsonResponse({"error": "superuser_required"}, status=403)
    return None


def read_json(request):
    try:
        return json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def latest_audit_payload() -> dict[str, Any] | None:
    event = AuditEvent.objects.select_related("actor").first()
    if event is None:
        return None

    return {
        "id": event.id,
        "event": event.event,
        "actor": event.actor.get_username() if event.actor else None,
        "subject": event.subject,
        "createdAt": event.created_at.isoformat(),
    }


def audit_event_payload(event: AuditEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "event": event.event,
        "actor": event.actor.get_username() if event.actor else None,
        "actorId": event.actor_id,
        "subject": event.subject,
        "ipAddress": event.ip_address,
        "userAgent": event.user_agent,
        "payload": event.payload,
        "createdAt": event.created_at.isoformat(),
    }


def maintenance_run_payload(run: BackgroundTaskRun | None) -> dict[str, Any] | None:
    if run is None:
        return None
    return {
        "taskId": run.task_id,
        "status": run.status,
        "startedAt": run.started_at.isoformat(),
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
        "errorType": run.error_type or None,
    }


def latest_maintenance_run(
    task_name: str,
    lock_key: str | None = None,
) -> BackgroundTaskRun | None:
    run = BackgroundTaskRun.objects.filter(task_name=task_name).order_by("-started_at").first()
    if (
        run is not None
        and run.status in {BackgroundTaskRun.STATUS_RUNNING, BackgroundTaskRun.STATUS_RETRYING}
        and run.started_at
        < timezone.now() - timedelta(seconds=ADMIN_REFRESH_LOCK_SECONDS)
        and lock_key is not None
        and cache.get(lock_key) is None
    ):
        finished_at = timezone.now()
        run.status = BackgroundTaskRun.STATUS_FAILED
        run.finished_at = finished_at
        run.duration_ms = max(0, int((finished_at - run.started_at).total_seconds() * 1000))
        run.error_type = "MaintenanceTaskExpired"
        run.save(
            update_fields=[
                "status",
                "finished_at",
                "duration_ms",
                "error_type",
                "updated_at",
            ]
        )
    return run


def enqueue_maintenance_task(request, *, action: str, task, task_name: str, lock_key: str):
    if not cache.add(lock_key, str(request.user.pk), timeout=ADMIN_REFRESH_LOCK_SECONDS):
        return JsonResponse(
            {
                "error": "maintenance_already_running",
                "action": action,
                "run": maintenance_run_payload(latest_maintenance_run(task_name)),
            },
            status=409,
        )

    task_id = str(uuid.uuid4())
    now = timezone.now()
    run = BackgroundTaskRun.objects.create(
        task_id=task_id,
        task_name=task_name,
        status=BackgroundTaskRun.STATUS_RUNNING,
        started_at=now,
    )
    try:
        task.apply_async(task_id=task_id)
    except Exception as exc:
        cache.delete(lock_key)
        run.status = BackgroundTaskRun.STATUS_FAILED
        run.finished_at = timezone.now()
        run.duration_ms = max(0, int((run.finished_at - now).total_seconds() * 1000))
        run.error_type = exc.__class__.__name__
        run.save(
            update_fields=[
                "status",
                "finished_at",
                "duration_ms",
                "error_type",
                "updated_at",
            ]
        )
        return JsonResponse(
            {"error": "maintenance_queue_failed", "action": action},
            status=503,
        )

    write_audit_event(
        request,
        f"admin.maintenance_{action}_refresh_requested",
        actor=request.user,
        subject=f"feed:{action}",
        payload={"taskId": task_id},
    )
    run.refresh_from_db()
    return JsonResponse(
        {"action": action, "run": maintenance_run_payload(run)},
        status=202,
    )


def user_payload(user) -> dict[str, Any]:
    usage = user_quota_usage(user)
    last_activity = getattr(user, "last_activity_at", None)
    return {
        "id": user.id,
        "username": user.get_username(),
        "email": user.email,
        "displayName": user.display_name,
        "avatarUrl": f"/api/auth/profile/avatar/{user.id}/" if user.avatar else "",
        "language": user.language,
        "firstName": user.first_name,
        "lastName": user.last_name,
        "isActive": user.is_active,
        "isSuperuser": user.is_superuser,
        "authorWorkspaceEnabled": has_author_workspace(user),
        "editorWorkspaceEnabled": has_editor_workspace(user),
        "tier": user.tier,
        "tierLabel": TIER_LABELS.get(user.tier, user.tier),
        "lastActivity": last_activity.isoformat() if last_activity else None,
        "dateJoined": user.date_joined.isoformat(),
        "usage": {
            "books": usage["books"],
            "storageBytes": usage["storage_bytes"],
        },
    }


def positive_int(value: str | None, default: int, maximum: int | None = None) -> int:
    try:
        parsed = int(value or "")
    except ValueError:
        parsed = default
    if parsed < 1:
        parsed = default
    if maximum is not None:
        parsed = min(parsed, maximum)
    return parsed


@require_GET
def status(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error

    database = check_database()
    redis = check_redis()
    celery = check_celery_worker()
    storage = check_storage()
    collaboration = check_collaboration()
    users_count = User.objects.count()
    administrators_count = User.objects.filter(is_superuser=True).count()
    audit_events_count = AuditEvent.objects.count()
    task_activity = task_activity_payload(redis, celery)

    return JsonResponse(
        {
            "status": (
                "ok"
                if (
                    database["ok"]
                    and redis["ok"]
                    and celery["ok"]
                    and storage["ok"]
                    and collaboration["ok"]
                    and (
                        not task_activity["scheduler"]["configured"]
                        or task_activity["scheduler"]["online"]
                    )
                )
                else "degraded"
            ),
            "checkedAt": timezone.now().isoformat(),
            "app": {
                "name": "Quillum",
                "version": settings.QUILLUM_VERSION,
                "debug": settings.DEBUG,
                "environment": settings.QUILLUM_ENVIRONMENT,
            },
            "auth": {
                "mode": settings.AUTH_MODE,
                "oidcEnabled": settings.OIDC_ENABLED,
            },
            "services": {
                "database": database,
                "redis": redis,
                "celery": celery,
                "storage": storage,
                "collaboration": collaboration,
            },
            "usage": {
                "users": users_count,
                "administrators": administrators_count,
                "auditEvents": audit_events_count,
            },
            "latestAuditEvent": latest_audit_payload(),
            "taskActivity": task_activity,
        }
    )


@require_GET
def maintenance(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    return JsonResponse(
        {
            "actions": {
                "news": maintenance_run_payload(
                    latest_maintenance_run(
                        ADMIN_NEWS_REFRESH_TASK_NAME,
                        ADMIN_NEWS_REFRESH_LOCK_KEY,
                    )
                ),
                "contests": maintenance_run_payload(
                    latest_maintenance_run(
                        ADMIN_CONTESTS_REFRESH_TASK_NAME,
                        ADMIN_CONTESTS_REFRESH_LOCK_KEY,
                    )
                ),
            }
        }
    )


@require_POST
def refresh_news(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    return enqueue_maintenance_task(
        request,
        action="news",
        task=admin_refresh_news_sources,
        task_name=ADMIN_NEWS_REFRESH_TASK_NAME,
        lock_key=ADMIN_NEWS_REFRESH_LOCK_KEY,
    )


@require_POST
def refresh_contests(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    return enqueue_maintenance_task(
        request,
        action="contests",
        task=admin_refresh_contest_sources,
        task_name=ADMIN_CONTESTS_REFRESH_TASK_NAME,
        lock_key=ADMIN_CONTESTS_REFRESH_LOCK_KEY,
    )


@require_http_methods(["GET", "PATCH"])
def service_settings(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error

    if request.method == "GET":
        return JsonResponse(
            {
                "items": settings_payload(),
                "oidc": oidc_status_payload(),
                "transcription": transcription_model_status_payload(),
            }
        )

    if response := require_recent_auth(request):
        return response

    payload = read_json(request)
    if not isinstance(payload, dict):
        return JsonResponse({"error": "invalid_json"}, status=400)
    values = payload.get("values", {})
    reset = payload.get("reset", [])
    if (
        not isinstance(values, dict)
        or not isinstance(reset, list)
        or any(not isinstance(key, str) for key in reset)
        or set(values).intersection(reset)
    ):
        return JsonResponse({"error": "settings_payload_invalid"}, status=400)
    if not values and not reset:
        return JsonResponse({"error": "settings_payload_empty"}, status=400)

    validated = {}
    changed_keys = sorted(set(values) | set(reset))
    for key in changed_keys:
        try:
            definition = setting_definition(key)
        except KeyError:
            return JsonResponse(
                {"error": "setting_unknown", "key": key},
                status=400,
            )
        if environment_value(definition) is not None:
            return JsonResponse(
                {"error": "setting_locked", "key": key},
                status=409,
            )
        if key in values:
            if definition.kind == "secret" and not str(values[key]).strip():
                return JsonResponse(
                    {
                        "error": "setting_value_invalid",
                        "key": key,
                        "reason": "value_required",
                    },
                    status=400,
                )
            try:
                validated[key] = definition.validate(values[key])
            except ValueError as exc:
                return JsonResponse(
                    {
                        "error": "setting_value_invalid",
                        "key": key,
                        "reason": str(exc),
                    },
                    status=400,
                )

    def candidate_value(key):
        if key in validated:
            return validated[key]
        if key in reset:
            return setting_definition(key).default
        return runtime_setting(key)

    if candidate_value("email_use_tls") and candidate_value("email_use_ssl"):
        return JsonResponse(
            {
                "error": "settings_combination_invalid",
                "keys": ["email_use_tls", "email_use_ssl"],
            },
            status=400,
        )

    if (
        "audio_transcription_enabled" in changed_keys
        and candidate_value("audio_transcription_enabled")
        and not transcription_model_status_payload()["ready"]
    ):
        return JsonResponse(
            {"error": "audio_transcription_model_unavailable"},
            status=409,
        )

    if not candidate_value("local_password_login_enabled"):
        if candidate_value("open_registration"):
            return JsonResponse(
                {"error": "local_password_login_requires_closed_registration"},
                status=409,
            )
    with transaction.atomic():
        for key, value in validated.items():
            set_runtime_override(key, value, updated_by=request.user)
        for key in reset:
            delete_runtime_override(key)
        write_audit_event(
            request,
            "admin.settings_updated",
            actor=request.user,
            subject="service-settings",
            payload={"keys": changed_keys},
        )

    return JsonResponse(
        {
            "items": settings_payload(),
            "oidc": oidc_status_payload(),
            "transcription": transcription_model_status_payload(),
        }
    )


@require_POST
def test_email_settings(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    if response := require_recent_auth(request):
        return response

    payload = read_json(request)
    recipient = str(payload.get("recipient", "")).strip() if isinstance(payload, dict) else ""
    try:
        validate_email(recipient)
    except ValidationError:
        return JsonResponse({"error": "email_recipient_invalid"}, status=400)

    try:
        sent = send_templated_runtime_email(
            template="admin_email_test",
            recipient_list=[recipient],
            language=request.user.language,
        )
    except Exception as exc:
        write_audit_event(
            request,
            "admin.email_test_failed",
            actor=request.user,
            subject="service-settings",
            payload={"errorType": exc.__class__.__name__},
        )
        return JsonResponse(
            {
                "error": "email_test_failed",
                "errorType": exc.__class__.__name__,
            },
            status=502,
        )

    write_audit_event(
        request,
        "admin.email_test_succeeded",
        actor=request.user,
        subject="service-settings",
    )
    return JsonResponse({"ok": True, "sent": sent})


@require_GET
def users(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error

    latest_activity = AuditEvent.objects.filter(actor_id=OuterRef("pk")).order_by("-created_at")
    queryset = User.objects.annotate(
        last_activity_at=Subquery(latest_activity.values("created_at")[:1]),
    )
    search = request.GET.get("search", "").strip()
    role = request.GET.get("role", "").strip()
    active = request.GET.get("active", "").strip()

    if search:
        queryset = queryset.filter(Q(username__icontains=search) | email_lookup_q(search))
    if role == "superuser":
        queryset = queryset.filter(is_superuser=True)
    elif role == "editor":
        queryset = queryset.filter(editor_workspace_enabled_at__isnull=False)
    elif role in {"user", "writer"}:
        queryset = queryset.filter(
            Q(is_superuser=True) | Q(author_workspace_enabled_at__isnull=False)
        )
    elif role == "combined":
        queryset = queryset.filter(editor_workspace_enabled_at__isnull=False).filter(
            Q(is_superuser=True) | Q(author_workspace_enabled_at__isnull=False)
        )

    if active == "active":
        queryset = queryset.filter(is_active=True)
    elif active == "inactive":
        queryset = queryset.filter(is_active=False)

    queryset = queryset.order_by("username")
    page_number = positive_int(request.GET.get("page"), 1)
    page_size = positive_int(request.GET.get("pageSize"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    paginator = Paginator(queryset, page_size)

    try:
        page = paginator.page(page_number)
    except EmptyPage:
        page = paginator.page(paginator.num_pages or 1)

    counter = (
        RegistrationCounter.objects.filter(pk=1)
        .values_list(
            "total_registrations",
            flat=True,
        )
        .first()
    )
    current_users = User.objects.count()

    return JsonResponse(
        {
            "items": [user_payload(item) for item in page.object_list],
            "stats": {
                "registered": max(counter or 0, current_users),
                "active": User.objects.filter(is_active=True).count(),
                "blocked": User.objects.filter(is_active=False).count(),
            },
            "pagination": {
                "page": page.number,
                "pageSize": page_size,
                "totalItems": paginator.count,
                "totalPages": paginator.num_pages,
                "hasNext": page.has_next(),
                "hasPrevious": page.has_previous(),
            },
            "filters": {
                "search": search,
                "role": role,
                "active": active,
            },
        }
    )


def manageable_user(request, user_id):
    if request.user.id == user_id:
        return None, JsonResponse({"error": "admin_self_action_forbidden"}, status=400)
    user = User.objects.filter(id=user_id).first()
    if user is None:
        return None, JsonResponse({"error": "user_not_found"}, status=404)
    return user, None


@require_POST
def block_user(request, user_id):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    user, error = manageable_user(request, user_id)
    if error is not None:
        return error

    user.is_active = False
    user.save(update_fields=["is_active"])
    revoked_sessions = revoke_user_sessions(user.id)
    write_audit_event(
        request,
        "admin.user_blocked",
        actor=request.user,
        subject=f"user:{user.id}",
        payload={"revokedSessions": revoked_sessions},
    )
    return JsonResponse({"user": user_payload(user)})


@require_POST
def unblock_user(request, user_id):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    user, error = manageable_user(request, user_id)
    if error is not None:
        return error

    user.is_active = True
    user.save(update_fields=["is_active"])
    write_audit_event(
        request,
        "admin.user_unblocked",
        actor=request.user,
        subject=f"user:{user.id}",
    )
    return JsonResponse({"user": user_payload(user)})


@require_http_methods(["PATCH"])
def update_user_tier(request, user_id):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    user, error = manageable_user(request, user_id)
    if error is not None:
        return error
    if user.author_workspace_enabled_at is None and not user.is_superuser:
        return JsonResponse({"error": "editor_role_managed_by_invitation"}, status=409)
    payload = read_json(request)
    tier = str(payload.get("tier", "")).strip() if isinstance(payload, dict) else ""
    if not valid_tier(tier):
        return JsonResponse({"error": "tier_invalid"}, status=400)
    if user.is_superuser and tier != User.TIER_GOD:
        return JsonResponse({"error": "superuser_tier_locked"}, status=409)
    previous_tier = user.tier
    user.tier = tier
    user.save(update_fields=["tier"])
    if previous_tier != tier:
        reset_tier_activity(user)
        service_notification_for_tier_change(user, previous_tier, tier)
    write_audit_event(
        request,
        "admin.user_tier_updated",
        actor=request.user,
        subject=f"user:{user.id}",
        payload={"tier": tier},
    )
    return JsonResponse({"user": user_payload(user)})


@require_http_methods(["PATCH"])
def update_user_role(request, user_id):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    if response := require_recent_auth(request):
        return response
    user, error = manageable_user(request, user_id)
    if error is not None:
        return error
    if user.author_workspace_enabled_at is None and not user.is_superuser:
        return JsonResponse({"error": "editor_role_managed_by_invitation"}, status=409)

    payload = read_json(request)
    is_superuser = payload.get("isSuperuser") if isinstance(payload, dict) else None
    if not isinstance(is_superuser, bool):
        return JsonResponse({"error": "user_role_invalid"}, status=400)

    previous_tier = user.tier
    role_changed = user.is_superuser != is_superuser or user.is_staff != is_superuser
    user.is_superuser = is_superuser
    user.is_staff = is_superuser
    update_fields = ["is_superuser", "is_staff"]
    if is_superuser and user.tier != User.TIER_GOD:
        user.tier = User.TIER_GOD
        update_fields.append("tier")
    user.save(update_fields=update_fields)
    if role_changed or previous_tier != user.tier:
        reset_tier_activity(user)
    if previous_tier != user.tier:
        service_notification_for_tier_change(user, previous_tier, user.tier)
    write_audit_event(
        request,
        "admin.user_role_updated",
        actor=request.user,
        subject=f"user:{user.id}",
        payload={"isSuperuser": is_superuser},
    )
    return JsonResponse({"user": user_payload(user)})


@require_POST
def test_service_notification(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    payload = read_json(request)
    kind = str(payload.get("kind", "")) if isinstance(payload, dict) else ""
    if kind not in SERVICE_NOTIFICATION_KINDS:
        return JsonResponse({"error": "notification_kind_invalid"}, status=400)
    channel = str(payload.get("channel", "panel")) if isinstance(payload, dict) else ""
    if channel not in {"panel", "panel_email"}:
        return JsonResponse({"error": "notification_channel_invalid"}, status=400)
    if channel == "panel_email" and kind not in SERVICE_EMAIL_KINDS:
        return JsonResponse({"error": "notification_channel_invalid"}, status=400)
    samples = {
        "service.password_stale": {"actionPath": "/settings?tab=security"},
        "service.two_factor_missing": {"actionPath": "/settings?tab=security"},
        "service.review_share_expired": {"manuscriptTitle": "Sample manuscript"},
        "service.export_expiring": {"manuscriptTitle": "Sample manuscript"},
        "service.storage_near_limit": {
            "usedBytes": 483183820,
            "limitBytes": 536870912,
            "tier": request.user.tier,
            "actionPath": "/settings?tab=storage",
        },
        "service.tier_changed": {
            "previousTier": "novice",
            "nextTier": request.user.tier,
            "actionPath": "/settings?tab=tiers",
        },
        "service.new_login": {
            "ipAddress": "203.0.113.10",
            "method": "password",
        },
        "service.account_export_ready": {
            "fileName": "quillum-account-export.zip",
            "byteSize": 1048576,
            "actionPath": "/settings?tab=account",
        },
        "service.audio_transcription_ready": {
            "noteTitle": "Sample audio note",
            "actionPath": "/manuscripts/sample/boards?note=sample&workspace=author",
        },
        "service.audio_transcription_failed": {
            "noteTitle": "Sample audio note",
            "errorCode": "transcription_failed",
            "actionPath": "/manuscripts/sample/boards?note=sample&workspace=author",
        },
        "service.editor_manuscript_access_granted": {
            "authorName": "Sample Author",
            "manuscriptTitle": "Sample manuscript",
            "actionPath": (
                "/manuscripts/00000000-0000-0000-0000-000000000001/editor"
                "?workspace=editor"
            ),
        },
        "service.editor_manuscript_access_revoked": {
            "authorName": "Sample Author",
            "manuscriptTitle": "Sample manuscript",
            "actionPath": "/manuscripts?workspace=editor",
        },
    }
    item, _created = create_notification(
        recipient=request.user,
        kind=kind,
        payload={**samples[kind], "test": True},
        deduplication_key=f"admin-self-test:{request.user.id}:{kind}:{timezone.now().isoformat()}",
        email=channel == "panel_email",
    )
    write_audit_event(
        request,
        "admin.notification_test_sent",
        actor=request.user,
        subject=f"notification:{item.public_id}",
        payload={"kind": kind, "email": channel == "panel_email"},
    )
    return JsonResponse({"notification": notification_payload(item)}, status=201)


@require_POST
def delete_user(request, user_id):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    user, error = manageable_user(request, user_id)
    if error is not None:
        return error

    deleted_user_id = user.id
    revoke_user_sessions(deleted_user_id)
    delete_account_data(user)
    write_audit_event(
        request,
        "admin.user_deleted",
        actor=request.user,
        subject=f"deleted-user:{deleted_user_id}",
    )
    return JsonResponse({"ok": True})


@require_http_methods(["GET", "PATCH"])
def tier_quotas(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    if request.method == "GET":
        return JsonResponse(quota_admin_payload())

    if response := require_recent_auth(request):
        return response
    payload = read_json(request)
    if not isinstance(payload, dict):
        return JsonResponse({"error": "invalid_json"}, status=400)
    values = payload.get("values", [])
    reset = payload.get("reset", [])
    if not isinstance(values, list) or not isinstance(reset, list):
        return JsonResponse({"error": "tier_quota_payload_invalid"}, status=400)
    changed = []
    try:
        with transaction.atomic():
            for item in values:
                if not isinstance(item, dict):
                    return JsonResponse({"error": "tier_quota_payload_invalid"}, status=400)
                tier = str(item.get("tier", "")).strip()
                key = str(item.get("key", "")).strip()
                value = item.get("value")
                set_quota_override(tier=tier, key=key, value=value, updated_by=request.user)
                changed.append(f"{tier}.{key}")
            for item in reset:
                if not isinstance(item, dict):
                    return JsonResponse({"error": "tier_quota_payload_invalid"}, status=400)
                tier = str(item.get("tier", "")).strip()
                key = str(item.get("key", "")).strip()
                delete_quota_override(tier=tier, key=key)
                changed.append(f"{tier}.{key}")
            if not changed:
                return JsonResponse({"error": "tier_quota_payload_empty"}, status=400)
            write_audit_event(
                request,
                "admin.tier_quotas_updated",
                actor=request.user,
                subject="tier-quotas",
                payload={"keys": sorted(changed)},
            )
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    return JsonResponse(quota_admin_payload())


@require_http_methods(["GET", "PATCH"])
def tier_progression(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error
    if request.method == "GET":
        return JsonResponse(tier_progression_policy_payload())

    if response := require_recent_auth(request):
        return response
    payload = read_json(request)
    required_keys = {"enabled", "noviceToAuthorDays", "authorToBelieverDays"}
    if not isinstance(payload, dict) or set(payload) != required_keys:
        return JsonResponse({"error": "tier_progression_payload_invalid"}, status=400)
    enabled = payload.get("enabled")
    novice_days = payload.get("noviceToAuthorDays")
    author_days = payload.get("authorToBelieverDays")
    if (
        not isinstance(enabled, bool)
        or isinstance(novice_days, bool)
        or not isinstance(novice_days, int)
        or isinstance(author_days, bool)
        or not isinstance(author_days, int)
        or not MINIMUM_DAYS <= novice_days <= MAXIMUM_DAYS
        or not MINIMUM_DAYS <= author_days <= MAXIMUM_DAYS
    ):
        return JsonResponse({"error": "tier_progression_value_invalid"}, status=400)

    with transaction.atomic():
        policy = progression_policy()
        was_enabled = policy.enabled
        changed = []
        if policy.enabled != enabled:
            changed.append("enabled")
        if policy.novice_to_author_days != novice_days:
            changed.append("noviceToAuthorDays")
        if policy.author_to_believer_days != author_days:
            changed.append("authorToBelieverDays")
        policy.enabled = enabled
        policy.novice_to_author_days = novice_days
        policy.author_to_believer_days = author_days
        policy.save()
        if was_enabled != enabled:
            TierActivityProgress.objects.all().delete()
        if changed:
            write_audit_event(
                request,
                "admin.tier_progression_updated",
                actor=request.user,
                subject="tier-progression",
                payload={"keys": changed},
            )

    return JsonResponse(tier_progression_policy_payload())


@require_GET
def audit_events(request):
    permission_error = require_superuser(request)
    if permission_error is not None:
        return permission_error

    queryset = AuditEvent.objects.select_related("actor").all()

    event = request.GET.get("event", "").strip()
    event_codes = [
        item.strip() for item in request.GET.get("eventCodes", "").split(",")[:100] if item.strip()
    ]
    actor = request.GET.get("actor", "").strip()
    subject = request.GET.get("subject", "").strip()
    ip_address = request.GET.get("ip", "").strip()
    date_from = parse_datetime(request.GET.get("dateFrom", ""))
    date_to = parse_datetime(request.GET.get("dateTo", ""))

    if event or event_codes:
        event_filter = Q()
        if event:
            event_filter |= Q(event__icontains=event)
        if event_codes:
            event_filter |= Q(event__in=event_codes)
        queryset = queryset.filter(event_filter)
    if actor:
        queryset = queryset.filter(actor__username__icontains=actor)
    if subject:
        queryset = queryset.filter(subject__icontains=subject)
    if ip_address:
        queryset = queryset.filter(audit_ip_lookup_q(ip_address))
    if date_from:
        queryset = queryset.filter(created_at__gte=date_from)
    if date_to:
        queryset = queryset.filter(created_at__lte=date_to)

    page_number = positive_int(request.GET.get("page"), 1)
    page_size = positive_int(request.GET.get("pageSize"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    paginator = Paginator(queryset, page_size)

    try:
        page = paginator.page(page_number)
    except EmptyPage:
        page = paginator.page(paginator.num_pages or 1)

    return JsonResponse(
        {
            "items": [audit_event_payload(item) for item in page.object_list],
            "pagination": {
                "page": page.number,
                "pageSize": page_size,
                "totalItems": paginator.count,
                "totalPages": paginator.num_pages,
                "hasNext": page.has_next(),
                "hasPrevious": page.has_previous(),
            },
            "filters": {
                "event": event,
                "actor": actor,
                "subject": subject,
                "ip": ip_address,
                "dateFrom": request.GET.get("dateFrom", ""),
                "dateTo": request.GET.get("dateTo", ""),
            },
        }
    )
