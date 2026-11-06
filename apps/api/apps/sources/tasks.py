from celery import shared_task
from django.core.cache import cache
from django.db.models import F, Q

from . import services
from .models import ContestItem, ContestStatus
from .registry import CONTEST_SOURCES, NEWS_SOURCES

ADMIN_NEWS_REFRESH_TASK_NAME = "apps.sources.tasks.admin_refresh_news_sources"
ADMIN_CONTESTS_REFRESH_TASK_NAME = "apps.sources.tasks.admin_refresh_contest_sources"
ADMIN_NEWS_REFRESH_LOCK_KEY = "admin:maintenance:refresh-news"
ADMIN_CONTESTS_REFRESH_LOCK_KEY = "admin:maintenance:refresh-contests"
ADMIN_REFRESH_LOCK_SECONDS = 60 * 60


class SourceMaintenanceBusy(RuntimeError):
    pass


def contest_detail_candidate_ids(source_key: str):
    return ContestItem.objects.filter(source_key=source_key).filter(
        Q(
            status__in=[
                ContestStatus.ACCEPTING,
                ContestStatus.PREPARATION,
                ContestStatus.IN_PROGRESS,
            ]
        )
        | Q(detail__isnull=True)
        | ~Q(detail__status_at_last_sync=F("status"))
    ).values_list("id", flat=True)


@shared_task(name="apps.sources.tasks.sync_news_source")
def sync_news_source(source_key: str) -> int | None:
    return services.sync_news_source(source_key)


@shared_task(name="apps.sources.tasks.sync_all_news_sources")
def sync_all_news_sources() -> int:
    for source in NEWS_SOURCES:
        sync_news_source.delay(source.key)
    return len(NEWS_SOURCES)


@shared_task(name="apps.sources.tasks.sync_contest_source")
def sync_contest_source(source_key: str) -> int | None:
    result = services.sync_contest_source(source_key)
    if result is None:
        return None
    for contest_id in contest_detail_candidate_ids(source_key):
        sync_contest_detail.delay(contest_id)
    return result


@shared_task(name="apps.sources.tasks.sync_contest_detail")
def sync_contest_detail(contest_id: int) -> bool | None:
    return services.sync_contest_detail(contest_id)


@shared_task(name="apps.sources.tasks.sync_all_contest_sources")
def sync_all_contest_sources() -> int:
    for source in CONTEST_SOURCES:
        sync_contest_source.delay(source.key)
    return len(CONTEST_SOURCES)


@shared_task(name=ADMIN_NEWS_REFRESH_TASK_NAME)
def admin_refresh_news_sources() -> int:
    total = 0
    try:
        for source in NEWS_SOURCES:
            result = services.sync_news_source(source.key)
            if result is None:
                raise SourceMaintenanceBusy("news_source_sync_in_progress")
            total += result
        return total
    finally:
        cache.delete(ADMIN_NEWS_REFRESH_LOCK_KEY)


@shared_task(name=ADMIN_CONTESTS_REFRESH_TASK_NAME)
def admin_refresh_contest_sources() -> int:
    total = 0
    try:
        for source in CONTEST_SOURCES:
            result = services.sync_contest_source(source.key)
            if result is None:
                raise SourceMaintenanceBusy("contest_source_sync_in_progress")
            total += result
            for contest_id in list(contest_detail_candidate_ids(source.key)):
                detail_result = services.sync_contest_detail(contest_id)
                if detail_result is None:
                    raise SourceMaintenanceBusy("contest_detail_sync_in_progress")
        return total
    finally:
        cache.delete(ADMIN_CONTESTS_REFRESH_LOCK_KEY)
