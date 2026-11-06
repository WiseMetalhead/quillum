from celery import shared_task


@shared_task
def build_account_export(export_id: int) -> None:
    from .account_exports import materialize_account_export

    materialize_account_export(export_id)


@shared_task
def cleanup_expired_account_exports() -> int:
    from .account_exports import cleanup_expired_account_exports as cleanup

    return cleanup()
