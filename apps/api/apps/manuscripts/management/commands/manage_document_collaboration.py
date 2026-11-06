from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.manuscripts.collaboration import publish_collaboration_event
from apps.manuscripts.document_schema import InvalidDocument, validate_document_content
from apps.manuscripts.models import Document, DocumentCollaborationState


class Command(BaseCommand):
    help = "Enable, disable, diagnose, compact, or fall back collaboration for one document."

    def add_arguments(self, parser):
        parser.add_argument(
            "action", choices=("enable", "disable", "diagnose", "compact", "fallback")
        )
        parser.add_argument("--document", required=True, help="Document public UUID")

    def handle(self, *args, **options):
        action = options["action"]
        document_id = options["document"]
        diagnostic_errors = []
        with transaction.atomic():
            document = (
                Document.objects.select_for_update()
                .select_related("manuscript")
                .filter(public_id=document_id)
                .first()
            )
            if document is None:
                raise CommandError("Document not found.")
            state = (
                DocumentCollaborationState.objects.select_for_update()
                .filter(document=document)
                .first()
            )
            state_created = state is None
            if state_created:
                if action in {"diagnose", "compact"}:
                    raise CommandError("Document has no collaboration state.")
                state = DocumentCollaborationState.objects.create(
                    document=document,
                    status=(
                        DocumentCollaborationState.STATUS_ACTIVE
                        if action == "enable"
                        else DocumentCollaborationState.STATUS_LEGACY
                    ),
                    schema_version=document.schema_version,
                )
            if action in {"enable", "disable", "fallback"}:
                state.status = (
                    DocumentCollaborationState.STATUS_ACTIVE
                    if action == "enable"
                    else DocumentCollaborationState.STATUS_LEGACY
                )
                if not state_created:
                    state.epoch += 1
                state.ydoc_state = b""
                state.snapshot_sequence = 0
                state.latest_sequence = 0
                state.materialized_sequence = 0
                state.schema_version = document.schema_version
                state.diagnostic_status = DocumentCollaborationState.DIAGNOSTIC_READY
                state.diagnostic_code = ""
                state.materialized_at = None
                state.save()
                state.updates.all().delete()
                transaction.on_commit(
                    lambda: publish_collaboration_event(
                        {
                            "type": "epoch.changed",
                            "documentId": str(document.public_id),
                            "epoch": state.epoch,
                        }
                    )
                )
            elif action == "compact":
                state.updates.filter(
                    epoch=state.epoch,
                    sequence__lte=state.snapshot_sequence,
                ).delete()
            else:
                try:
                    validate_document_content(document.content)
                except InvalidDocument as exc:
                    diagnostic_errors.append(str(exc))
                if state.schema_version != document.schema_version:
                    diagnostic_errors.append("schema_version_mismatch")
                if state.materialized_sequence > state.latest_sequence:
                    diagnostic_errors.append("materialized_sequence_ahead")
                if state.snapshot_sequence > state.latest_sequence:
                    diagnostic_errors.append("snapshot_sequence_ahead")
                if state.latest_sequence and not state.ydoc_state:
                    diagnostic_errors.append("snapshot_missing")
                state.diagnostic_status = (
                    DocumentCollaborationState.DIAGNOSTIC_FAILED
                    if diagnostic_errors
                    else DocumentCollaborationState.DIAGNOSTIC_READY
                )
                state.diagnostic_code = diagnostic_errors[0][:64] if diagnostic_errors else ""
                state.save(update_fields=["diagnostic_status", "diagnostic_code", "updated_at"])

        if diagnostic_errors:
            raise CommandError(", ".join(diagnostic_errors))

        self.stdout.write(
            self.style.SUCCESS(
                f"{action}: document={document.public_id} status={state.status} "
                f"epoch={state.epoch} sequence={state.latest_sequence}"
            )
        )
