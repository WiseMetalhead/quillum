from celery import shared_task
from django.utils import timezone

from .models import Document
from .versioning import materialize_due_draft


@shared_task
def materialize_due_drafts(batch_size: int = 100) -> int:
    now = timezone.now()
    document_ids = list(
        Document.objects.filter(draft_due_at__lte=now)
        .order_by("draft_due_at")
        .values_list("id", flat=True)[:batch_size]
    )
    created = 0
    for document_id in document_ids:
        try:
            if materialize_due_draft(document_id, now=now) is not None:
                created += 1
        except Document.DoesNotExist:
            continue
    return created


@shared_task
def build_manuscript_export(export_id: int) -> None:
    from .exports import materialize_export

    materialize_export(export_id)


@shared_task
def cleanup_expired_exports() -> int:
    from .exports import cleanup_expired_exports as cleanup

    return cleanup()


@shared_task(
    bind=True,
    acks_late=True,
    reject_on_worker_lost=True,
    name="apps.manuscripts.tasks.process_audio_transcription_queue",
)
def process_audio_transcription_queue(self) -> bool:
    from .transcription import process_next_audio_transcription

    processed = process_next_audio_transcription(self.request.id)
    if processed:
        process_audio_transcription_queue.delay()
    return processed


@shared_task(name="apps.manuscripts.tasks.recover_audio_transcription_queue")
def recover_audio_transcription_queue() -> bool:
    from .transcription import queued_transcriptions_exist

    if not queued_transcriptions_exist():
        return False
    process_audio_transcription_queue.delay()
    return True
