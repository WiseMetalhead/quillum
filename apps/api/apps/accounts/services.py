import logging

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q

from apps.audit.models import AuditEvent

logger = logging.getLogger(__name__)


def _delete_stored_file(storage, name: str) -> None:
    try:
        storage.delete(name)
    except Exception:
        logger.exception("Failed to delete account file name=%s", name)


def delete_account_data(user) -> None:
    from apps.manuscripts.models import (
        ManuscriptExport,
    )

    from .models import AccountExport, UserMediaAsset

    user_id = user.id
    username = user.get_username()
    with transaction.atomic():
        locked_user = get_user_model().objects.select_for_update().get(id=user_id)
        stored_files = []
        if locked_user.avatar:
            stored_files.append((locked_user.avatar.storage, locked_user.avatar.name))
        for media in UserMediaAsset.objects.filter(owner_id=user_id):
            for field_name in (
                "original",
                "thumbnail_small",
                "thumbnail_medium",
                "editor_medium",
                "editor_large",
            ):
                field = getattr(media, field_name)
                if field:
                    stored_files.append((field.storage, field.name))
        for export in ManuscriptExport.objects.filter(owner_id=user_id):
            if export.artifact:
                stored_files.append((export.artifact.storage, export.artifact.name))
        account_export = AccountExport.objects.filter(owner_id=user_id).first()
        if account_export is not None and account_export.artifact:
            stored_files.append((account_export.artifact.storage, account_export.artifact.name))
        AuditEvent.objects.filter(
            Q(actor_id=user_id) | Q(subject=f"user:{user_id}") | Q(subject=username)
        ).delete()
        locked_user.delete()
        for storage, name in stored_files:
            transaction.on_commit(
                lambda storage=storage, name=name: _delete_stored_file(storage, name)
            )
