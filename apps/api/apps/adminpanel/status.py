from __future__ import annotations

import json
from datetime import timedelta
from time import perf_counter
from typing import Any
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.cache import cache
from django.core.files.storage import FileSystemStorage, default_storage
from django.db import connection
from django.utils import timezone
from redis import Redis

from apps.accounts.tiers import total_storage_usage_bytes
from config.celery import app as celery_app

from .models import BackgroundTaskRun

CELERY_PING_TIMEOUT_SECONDS = 0.75
SCHEDULER_FRESHNESS_SECONDS = 120
STORAGE_USAGE_CACHE_SECONDS = 60
STORAGE_USAGE_CACHE_KEY = "quillum:admin-status:storage-usage:v1"


def _elapsed_ms(started_at: float) -> float:
    return round((perf_counter() - started_at) * 1000, 1)


def check_database() -> dict[str, Any]:
    started_at = perf_counter()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    current_setting('server_version'),
                    pg_database_size(current_database()),
                    (
                        SELECT COUNT(*)
                        FROM pg_stat_activity
                        WHERE datname = current_database()
                    )
                """
            )
            version, size_bytes, active_connections = cursor.fetchone()
        return {
            "ok": True,
            "version": str(version),
            "sizeBytes": int(size_bytes),
            "activeConnections": int(active_connections),
            "latencyMs": _elapsed_ms(started_at),
        }
    except Exception as exc:
        return {
            "ok": False,
            "version": None,
            "sizeBytes": None,
            "activeConnections": None,
            "latencyMs": _elapsed_ms(started_at),
            "error": exc.__class__.__name__,
        }


def redis_client() -> Redis:
    return Redis.from_url(
        settings.REDIS_URL,
        socket_connect_timeout=1,
        socket_timeout=1,
    )


def check_redis() -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": False,
        "version": None,
        "usedMemoryBytes": None,
        "maxMemoryBytes": None,
        "keys": None,
        "latencyMs": None,
    }
    try:
        client = redis_client()
        started_at = perf_counter()
        payload["ok"] = bool(client.ping())
        payload["latencyMs"] = _elapsed_ms(started_at)
    except Exception as exc:
        payload["error"] = exc.__class__.__name__
        return payload

    try:
        server_info = client.info(section="server")
        memory_info = client.info(section="memory")
        payload["version"] = server_info.get("redis_version")
        payload["usedMemoryBytes"] = int(memory_info.get("used_memory", 0))
        max_memory = int(memory_info.get("maxmemory", 0))
        payload["maxMemoryBytes"] = max_memory or None
    except Exception as exc:
        payload["metricsError"] = exc.__class__.__name__

    try:
        payload["keys"] = int(client.dbsize())
    except Exception as exc:
        payload["keysError"] = exc.__class__.__name__
    return payload


def check_celery_worker() -> dict[str, Any]:
    configured = bool(settings.CELERY_BROKER_URL)
    broker = "redis" if str(settings.CELERY_BROKER_URL).startswith("redis://") else "other"
    payload: dict[str, Any] = {
        "ok": False,
        "configured": configured,
        "broker": broker,
        "workers": [],
        "workerCount": 0,
        "latencyMs": None,
    }
    if not configured:
        payload["error"] = "worker_not_configured"
        return payload

    started_at = perf_counter()
    try:
        replies = celery_app.control.ping(timeout=CELERY_PING_TIMEOUT_SECONDS) or []
        workers = sorted(
            str(worker)
            for reply in replies
            for worker, response in reply.items()
            if response and response.get("ok") == "pong"
        )
        payload.update(
            {
                "ok": bool(workers),
                "workers": workers,
                "workerCount": len(workers),
                "latencyMs": _elapsed_ms(started_at),
            }
        )
        if not workers:
            payload["error"] = "worker_unavailable"
    except Exception as exc:
        payload["latencyMs"] = _elapsed_ms(started_at)
        payload["error"] = exc.__class__.__name__
    return payload


def _cached_storage_usage() -> int:
    try:
        cached = cache.get(STORAGE_USAGE_CACHE_KEY)
    except Exception:
        cached = None
    if cached is not None:
        return int(cached)

    total = total_storage_usage_bytes()
    try:
        cache.set(STORAGE_USAGE_CACHE_KEY, total, STORAGE_USAGE_CACHE_SECONDS)
    except Exception:
        pass
    return total


def check_storage() -> dict[str, Any]:
    storage = default_storage
    provider = "local" if isinstance(storage, FileSystemStorage) else "other"
    try:
        return {
            "ok": True,
            "provider": provider,
            "usedBytes": _cached_storage_usage(),
        }
    except Exception as exc:
        return {
            "ok": False,
            "provider": provider,
            "usedBytes": None,
            "error": exc.__class__.__name__,
        }


def check_collaboration() -> dict[str, Any]:
    mode = settings.QUILLUM_COLLABORATION_MODE
    payload: dict[str, Any] = {
        "ok": mode == "disabled",
        "configured": mode != "disabled",
        "mode": mode,
        "documents": None,
        "connections": None,
        "latencyMs": None,
    }
    if mode == "disabled":
        return payload
    started_at = perf_counter()
    try:
        request = Request(
            f"{settings.QUILLUM_COLLABORATION_INTERNAL_ORIGIN}/healthz",
            headers={"Accept": "application/json"},
        )
        with urlopen(request, timeout=0.75) as response:  # noqa: S310 - operator-owned loopback URL
            body = json.loads(response.read(16_384).decode("utf-8"))
        payload.update(
            {
                "ok": body.get("status") == "ok",
                "documents": int(body.get("documents", 0)),
                "connections": int(body.get("connections", 0)),
                "latencyMs": _elapsed_ms(started_at),
            }
        )
    except (OSError, ValueError) as exc:
        payload["latencyMs"] = _elapsed_ms(started_at)
        payload["error"] = exc.__class__.__name__
    return payload


def _task_payload(run: BackgroundTaskRun | None) -> dict[str, Any] | None:
    if run is None:
        return None
    return {
        "id": run.task_id,
        "name": run.task_name,
        "status": run.status,
        "worker": run.worker,
        "startedAt": run.started_at.isoformat(),
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
        "durationMs": run.duration_ms,
        "errorType": run.error_type or None,
    }


def task_activity_payload(
    redis_status: dict[str, Any],
    celery_status: dict[str, Any],
) -> dict[str, Any]:
    now = timezone.now()
    recent_running_cutoff = now - timedelta(hours=6)
    last_task = (
        BackgroundTaskRun.objects.filter(finished_at__isnull=False)
        .order_by("-finished_at")
        .first()
    )
    running_count = BackgroundTaskRun.objects.filter(
        status=BackgroundTaskRun.STATUS_RUNNING,
        started_at__gte=recent_running_cutoff,
    ).count()
    failed_last_day = BackgroundTaskRun.objects.filter(
        status=BackgroundTaskRun.STATUS_FAILED,
        finished_at__gte=now - timedelta(hours=24),
    ).count()

    periodic_task_names = [
        str(item.get("task"))
        for item in settings.CELERY_BEAT_SCHEDULE.values()
        if isinstance(item, dict) and item.get("task")
    ]
    last_periodic_task = (
        BackgroundTaskRun.objects.filter(
            task_name__in=periodic_task_names,
            finished_at__isnull=False,
        )
        .order_by("-finished_at")
        .first()
    )
    scheduler_online = bool(
        last_periodic_task
        and last_periodic_task.finished_at
        and last_periodic_task.finished_at
        >= now - timedelta(seconds=SCHEDULER_FRESHNESS_SECONDS)
    )

    queued_count = None
    queue_error = None
    if redis_status.get("ok"):
        try:
            queue_name = str(celery_app.conf.task_default_queue or "celery")
            queued_count = int(redis_client().llen(queue_name))
        except Exception as exc:
            queue_error = exc.__class__.__name__

    if not redis_status.get("ok"):
        queue_state = "unavailable"
    elif not celery_status.get("ok") or queue_error:
        queue_state = "degraded"
    else:
        queue_state = "healthy"

    return {
        "queueState": queue_state,
        "queued": queued_count,
        "running": running_count,
        "failedLast24Hours": failed_last_day,
        "queueError": queue_error,
        "lastTask": _task_payload(last_task),
        "scheduler": {
            "configured": bool(periodic_task_names),
            "online": scheduler_online,
            "lastRunAt": (
                last_periodic_task.finished_at.isoformat()
                if last_periodic_task and last_periodic_task.finished_at
                else None
            ),
        },
    }
