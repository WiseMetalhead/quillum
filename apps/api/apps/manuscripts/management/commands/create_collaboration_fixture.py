from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import EditorConnection, EditorInvitation
from apps.manuscripts.models import (
    Document,
    DocumentAnnotation,
    DocumentCollaborationState,
    DocumentVersion,
    ManuscriptEditorGrant,
)
from apps.manuscripts.services import create_oneshot
from apps.manuscripts.versioning import create_version_from_locked_document


class Command(BaseCommand):
    help = "Create a local author/editor manuscript fixture for live-collaboration acceptance."

    def add_arguments(self, parser):
        parser.add_argument("--owner", required=True, help="Existing author username")
        parser.add_argument("--editor", required=True, help="Existing editor username")
        parser.add_argument("--title", default="Live collaboration acceptance")

    def handle(self, *args, **options):
        user_model = get_user_model()
        owner = user_model.objects.filter(username=options["owner"], is_active=True).first()
        editor = user_model.objects.filter(username=options["editor"], is_active=True).first()
        if owner is None or editor is None:
            raise CommandError("Both --owner and --editor must name existing active users.")
        if owner.id == editor.id:
            raise CommandError("Owner and editor must be different users.")

        with transaction.atomic():
            connection = EditorConnection.objects.filter(
                author=owner,
                editor=editor,
                disconnected_at__isnull=True,
            ).first()
            if connection is None:
                now = timezone.now()
                invitation = EditorInvitation.objects.create(
                    author=owner,
                    expires_at=now + timedelta(days=2),
                    accepted_at=now,
                    accepted_by=editor,
                )
                connection = EditorConnection.objects.create(
                    author=owner,
                    editor=editor,
                    invitation=invitation,
                )
            manuscript = create_oneshot(
                user=owner,
                title=options["title"],
                synopsis="Manual acceptance fixture for simultaneous author/editor work.",
                cover=None,
                language="en",
            )
            ManuscriptEditorGrant.objects.create(
                manuscript=manuscript,
                editor_connection=connection,
            )
            document = (
                Document.objects.select_for_update()
                .select_related("manuscript__workspace__owner")
                .get(manuscript=manuscript)
            )
            annotation = DocumentAnnotation.objects.create(
                document=document,
                author=owner,
                quote="anchored comment",
                comment="This seeded comment must stay attached during concurrent edits.",
            )
            document.content = {
                "type": "doc",
                "content": [
                    {
                        "type": "heading",
                        "attrs": {"level": 1, "textAlign": "left"},
                        "content": [{"type": "text", "text": "Live collaboration acceptance"}],
                    },
                    {
                        "type": "paragraph",
                        "attrs": {"textAlign": "left"},
                        "content": [
                            {
                                "type": "text",
                                "text": "Edit this paragraph in both browser sessions. ",
                            },
                            {
                                "type": "text",
                                "text": "anchored comment",
                                "marks": [
                                    {
                                        "type": "annotationAnchor",
                                        "attrs": {"annotationId": str(annotation.public_id)},
                                    }
                                ],
                            },
                            {"type": "text", "text": " must remain linked."},
                        ],
                    },
                    {"type": "sceneBreak"},
                    {
                        "type": "paragraph",
                        "attrs": {"textAlign": "left"},
                        "content": [
                            {
                                "type": "text",
                                "text": "Use this paragraph for cursor and reconnect checks.",
                            }
                        ],
                    },
                ],
            }
            document.save_generation = 1
            document.history_generation = 1
            document.save(
                update_fields=["content", "save_generation", "history_generation", "updated_at"]
            )
            create_version_from_locked_document(
                document,
                kind=DocumentVersion.KIND_REVISION,
                name="Acceptance baseline",
                description="Seeded before concurrent editing.",
            )
            state = DocumentCollaborationState.objects.create(
                document=document,
                status=DocumentCollaborationState.STATUS_ACTIVE,
                schema_version=document.schema_version,
            )

        self.stdout.write(self.style.SUCCESS("Collaboration fixture created."))
        self.stdout.write(f"manuscript={manuscript.public_id}")
        self.stdout.write(f"document={document.public_id}")
        self.stdout.write(f"collaboration_epoch={state.epoch}")
        self.stdout.write(f"owner_path=/manuscripts/{manuscript.public_id}/editor")
        self.stdout.write(
            f"editor_path=/manuscripts/{manuscript.public_id}/editor?workspace=editor"
        )
