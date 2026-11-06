from __future__ import annotations

import logging

from celery import states
from celery.signals import task_failure, task_postrun, task_prerun
from django.utils import timezone

from .models import BackgroundTaskRun

logger = logging.getLogger(__name__)
TASK_RUN_RETENTION = 200


def _task_name(sender, task) -> str:
    return str(getattr(sender, "name", "") or getattr(task, "name", "") or "unknown")


def _worker_name(sender, task) -> str:
    request = getattr(task or sender, "request", None)
    return str(getattr(request, "hostname", "") or "")


def _duration_ms(started_at, finished_at) -> int:
    return max(0, int((finished_at - started_at).total_seconds() * 1000))


def _safe_record(action) -> None:
    try:
        action()
    except Exception as exc:
        logger.warning(
            "Unable to record background task state: %s",
            exc.__class__.__name__,
        )


def _prune_finished_runs() -> None:
    retained_ids = list(
        BackgroundTaskRun.objects.filter(finished_at__isnull=False)
        .order_by("-finished_at")
        .values_list("id", flat=True)[:TASK_RUN_RETENTION]
    )
    if len(retained_ids) == TASK_RUN_RETENTION:
        BackgroundTaskRun.objects.filter(finished_at__isnull=False).exclude(
            id__in=retained_ids
        ).delete()


@task_prerun.connect(weak=False)
def record_task_started(sender=None, task_id=None, task=None, **_kwargs) -> None:
    if not task_id:
        return

    def record() -> None:
        BackgroundTaskRun.objects.update_or_create(
            task_id=str(task_id),
            defaults={
                "task_name": _task_name(sender, task),
                "worker": _worker_name(sender, task),
                "status": BackgroundTaskRun.STATUS_RUNNING,
                "started_at": timezone.now(),
                "finished_at": None,
                "duration_ms": None,
                "error_type": "",
            },
        )

    _safe_record(record)


@task_failure.connect(weak=False)
def record_task_failure(task_id=None, exception=None, sender=None, **_kwargs) -> None:
    if not task_id:
        return

    def record() -> None:
        now = timezone.now()
        run, _created = BackgroundTaskRun.objects.get_or_create(
            task_id=str(task_id),
            defaults={
                "task_name": _task_name(sender, sender),
                "worker": _worker_name(sender, sender),
                "status": BackgroundTaskRun.STATUS_FAILED,
                "started_at": now,
            },
        )
        run.status = BackgroundTaskRun.STATUS_FAILED
        run.finished_at = now
        run.duration_ms = _duration_ms(run.started_at, now)
        run.error_type = exception.__class__.__name__ if exception is not None else "TaskError"
        run.save(
            update_fields=[
                "status",
                "finished_at",
                "duration_ms",
                "error_type",
                "updated_at",
            ]
        )

    _safe_record(record)


@task_postrun.connect(weak=False)
def record_task_finished(sender=None, task_id=None, task=None, state=None, **_kwargs) -> None:
    if not task_id:
        return

    status_map = {
        states.SUCCESS: BackgroundTaskRun.STATUS_SUCCEEDED,
        states.FAILURE: BackgroundTaskRun.STATUS_FAILED,
        states.RETRY: BackgroundTaskRun.STATUS_RETRYING,
        states.REVOKED: BackgroundTaskRun.STATUS_REVOKED,
    }
    final_status = status_map.get(state, BackgroundTaskRun.STATUS_SUCCEEDED)

    def record() -> None:
        now = timezone.now()
        run, _created = BackgroundTaskRun.objects.get_or_create(
            task_id=str(task_id),
            defaults={
                "task_name": _task_name(sender, task),
                "worker": _worker_name(sender, task),
                "status": final_status,
                "started_at": now,
            },
        )
        run.status = final_status
        run.finished_at = None if final_status == BackgroundTaskRun.STATUS_RETRYING else now
        run.duration_ms = (
            None
            if final_status == BackgroundTaskRun.STATUS_RETRYING
            else _duration_ms(run.started_at, now)
        )
        if final_status != BackgroundTaskRun.STATUS_FAILED:
            run.error_type = ""
        run.save(
            update_fields=[
                "status",
                "finished_at",
                "duration_ms",
                "error_type",
                "updated_at",
            ]
        )
        if run.finished_at is not None:
            _prune_finished_runs()

    _safe_record(record)
