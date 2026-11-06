import logging

from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from .collaboration import publish_annotation_change
from .models import AnnotationReply, AudioRecording, Document, DocumentAnnotation

logger = logging.getLogger(__name__)


def _delete_audio_file(storage, name: str) -> None:
    try:
        storage.delete(name)
    except Exception:
        logger.exception("Failed to delete audio note file name=%s", name)


@receiver(post_delete, sender=AudioRecording)
def delete_audio_note_file(sender, instance: AudioRecording, **_kwargs) -> None:
    del sender
    if not instance.file or not instance.file.name:
        return
    storage = instance.file.storage
    name = instance.file.name
    transaction.on_commit(lambda: _delete_audio_file(storage, name))


def _annotation_document_public_id(document_id: int):
    return Document.objects.filter(id=document_id).values_list("public_id", flat=True).first()


@receiver(post_save, sender=DocumentAnnotation)
@receiver(post_delete, sender=DocumentAnnotation)
def notify_annotation_change(sender, instance: DocumentAnnotation, **_kwargs) -> None:
    del sender
    document_id = instance.document_id
    transaction.on_commit(
        lambda: (
            publish_annotation_change(document_public_id)
            if (document_public_id := _annotation_document_public_id(document_id))
            else None
        )
    )


@receiver(post_save, sender=AnnotationReply)
@receiver(post_delete, sender=AnnotationReply)
def notify_annotation_reply_change(sender, instance: AnnotationReply, **_kwargs) -> None:
    del sender
    document_id = (
        DocumentAnnotation.objects.filter(id=instance.annotation_id)
        .values_list("document_id", flat=True)
        .first()
    )
    if document_id is None:
        # A cascading annotation delete publishes its own document-level event.
        return
    transaction.on_commit(
        lambda: (
            publish_annotation_change(document_public_id)
            if (document_public_id := _annotation_document_public_id(document_id))
            else None
        )
    )
