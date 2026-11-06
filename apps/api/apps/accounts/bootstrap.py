import logging

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import BootstrapState

logger = logging.getLogger(__name__)


def ensure_bootstrap_admin(user_model) -> None:
    if not settings.QUILLUM_BOOTSTRAP_ADMIN_ENABLED:
        return

    with transaction.atomic():
        state, _created = BootstrapState.objects.select_for_update().get_or_create(singleton_id=1)
        if state.completed_at is not None:
            return
        if user_model.objects.exists():
            state.completed_at = timezone.now()
            state.save(update_fields=["completed_at"])
            return

        user = user_model.objects.create_superuser(
            username=settings.QUILLUM_BOOTSTRAP_ADMIN_USERNAME,
            email=settings.QUILLUM_BOOTSTRAP_ADMIN_EMAIL,
            password=settings.QUILLUM_BOOTSTRAP_ADMIN_PASSWORD,
        )
        state.completed_at = timezone.now()
        state.save(update_fields=["completed_at"])
        logger.info(
            "bootstrap administrator created user_id=%s username=%s",
            user.id,
            user.get_username(),
        )
