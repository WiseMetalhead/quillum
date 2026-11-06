from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.manuscripts.document_schema import illustration_asset_ids
from apps.manuscripts.glossary_schema import glossary_asset_ids
from apps.manuscripts.models import (
    Document,
    DocumentVersion,
    GlossaryArticle,
    GlossaryAsset,
    ManuscriptAsset,
    ManuscriptNote,
)


class Command(BaseCommand):
    help = "Delete manuscript and Glossary assets that are no longer referenced."

    def add_arguments(self, parser):
        parser.add_argument("--older-than-hours", type=int, default=24)

    def handle(self, *args, **options):
        hours = options["older_than_hours"]
        if hours < 1:
            self.stderr.write("--older-than-hours must be at least 1")
            return
        referenced = set()
        for document in Document.objects.select_related("manuscript__workspace").iterator():
            referenced.update(illustration_asset_ids(document.content))
        referenced.update(
            str(asset_id)
            for asset_id in DocumentVersion.objects.values_list(
                "assets__public_id", flat=True
            )
            if asset_id is not None
        )
        referenced.update(
            str(asset_id)
            for asset_id in ManuscriptNote.objects.values_list("assets__public_id", flat=True)
            if asset_id is not None
        )
        cutoff = timezone.now() - timedelta(hours=hours)
        unused = ManuscriptAsset.objects.filter(created_at__lt=cutoff).exclude(
            public_id__in=referenced
        )
        deleted, _ = unused.delete()
        glossary_referenced = {
            asset_id
            for article in GlossaryArticle.objects.select_related(
                "glossary__manuscript__workspace",
                "glossary__series__workspace",
            ).iterator()
            for asset_id in glossary_asset_ids(article.content)
        }
        glossary_referenced.update(
            GlossaryAsset.objects.filter(kind=GlossaryAsset.KIND_THUMBNAIL).values_list(
                "public_id", flat=True
            )
        )
        glossary_unused = GlossaryAsset.objects.filter(
            kind=GlossaryAsset.KIND_ILLUSTRATION,
            created_at__lt=cutoff,
        ).exclude(public_id__in=glossary_referenced)
        glossary_deleted, _ = glossary_unused.delete()
        self.stdout.write(
            f"Deleted {deleted} unused manuscript asset records and "
            f"{glossary_deleted} unused Glossary asset records."
        )
