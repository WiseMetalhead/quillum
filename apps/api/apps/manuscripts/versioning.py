from __future__ import annotations

import re
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.accounts.tiers import document_version_limit

from .document_schema import illustration_asset_ids, validate_document_content
from .models import (
    AnnotationReply,
    Document,
    DocumentAnnotation,
    DocumentVersion,
    ManuscriptAsset,
)

DRAFT_IDLE_SECONDS = 180
REVISION_NAME_MAX_LENGTH = 120
REVISION_DESCRIPTION_MAX_LENGTH = 2_000
SNAPSHOT_FORMAT_VERSION = 1


class VersionLimitReached(ValueError):
    pass


class VersionAssetMissing(ValueError):
    pass


def mark_history_changed(document: Document) -> None:
    document.history_generation += 1
    document.draft_due_at = timezone.now() + timedelta(seconds=DRAFT_IDLE_SECONDS)


def _plain_text(content: dict) -> str:
    blocks = []
    for block in content.get("content", []):
        if block.get("type") == "sceneBreak":
            blocks.append("***")
            continue
        parts = []
        for node in block.get("content", []):
            if node.get("type") == "text":
                parts.append(node.get("text", ""))
            elif node.get("type") == "hardBreak":
                parts.append("\n")
        blocks.append("".join(parts))
    return "\n".join(blocks)


def document_statistics(content: dict) -> tuple[int, int]:
    plain_text = _plain_text(content)
    return len(re.findall(r"\S+", plain_text)), len(plain_text)


def _iso(value):
    return value.isoformat() if value else None


def _annotation_snapshot(document: Document) -> list[dict]:
    annotations = (
        DocumentAnnotation.objects.filter(document=document)
        .select_related("author", "resolved_by")
        .prefetch_related("replies__author")
    )
    return [
        {
            "id": str(annotation.public_id),
            "authorId": annotation.author_id,
            "quote": annotation.quote,
            "comment": annotation.comment,
            "status": annotation.status,
            "version": annotation.version,
            "resolvedById": annotation.resolved_by_id,
            "resolvedAt": _iso(annotation.resolved_at),
            "createdAt": _iso(annotation.created_at),
            "updatedAt": _iso(annotation.updated_at),
            "replies": [
                {
                    "id": str(reply.public_id),
                    "authorId": reply.author_id,
                    "body": reply.body,
                    "version": reply.version,
                    "createdAt": _iso(reply.created_at),
                    "updatedAt": _iso(reply.updated_at),
                }
                for reply in annotation.replies.all()
            ],
        }
        for annotation in annotations
    ]


def _asset_snapshot(document: Document, content: dict) -> tuple[list[dict], list[ManuscriptAsset]]:
    asset_ids = illustration_asset_ids(content)
    assets = list(
        ManuscriptAsset.objects.filter(
            manuscript_id=document.manuscript_id,
            public_id__in=asset_ids,
        ).select_related("manuscript__workspace")
    )
    return (
        [
            {
                "id": str(asset.public_id),
                "alt": asset.alt_text,
                "caption": asset.caption,
            }
            for asset in assets
        ],
        assets,
    )


def create_version_from_locked_document(
    document: Document,
    *,
    kind: str,
    name: str = "",
    description: str = "",
) -> DocumentVersion:
    owner = document.manuscript.workspace.owner
    if kind == DocumentVersion.KIND_REVISION and DocumentVersion.objects.filter(
        document=document,
        kind=DocumentVersion.KIND_REVISION,
    ).count() >= document_version_limit(owner, "revisions_per_document"):
        raise VersionLimitReached("revision_limit_reached")

    content = document.content
    word_count, character_count = document_statistics(content)
    asset_snapshot, assets = _asset_snapshot(document, content)
    version = DocumentVersion(
        document=document,
        kind=kind,
        schema_version=document.schema_version,
        source_history_generation=document.history_generation,
        word_count=word_count,
        character_count=character_count,
    )
    version.name = name
    version.description = description
    version.snapshot = {
        "formatVersion": SNAPSHOT_FORMAT_VERSION,
        "content": content,
        "annotations": _annotation_snapshot(document),
        "assets": asset_snapshot,
    }
    version.save()
    version.assets.set(assets)

    if kind == DocumentVersion.KIND_DRAFT:
        stale_ids = list(
            DocumentVersion.objects.filter(
                document=document,
                kind=DocumentVersion.KIND_DRAFT,
            )
            .order_by("-created_at")
            .values_list("id", flat=True)[document_version_limit(owner, "drafts_per_document") :]
        )
        if stale_ids:
            DocumentVersion.objects.filter(id__in=stale_ids).delete()
    return version


def create_revision(document_id: int, *, expected_generation: int, name: str, description: str):
    with transaction.atomic():
        document = (
            Document.objects.select_for_update()
            .select_related("manuscript__workspace__owner")
            .get(id=document_id)
        )
        if document.save_generation != expected_generation:
            return None
        return create_version_from_locked_document(
            document,
            kind=DocumentVersion.KIND_REVISION,
            name=name,
            description=description,
        )


def materialize_due_draft(document_id: int, *, now=None) -> DocumentVersion | None:
    now = now or timezone.now()
    with transaction.atomic():
        document = (
            Document.objects.select_for_update()
            .select_related("manuscript__workspace__owner")
            .get(id=document_id)
        )
        if document.draft_due_at is None or document.draft_due_at > now:
            return None
        version = None
        if document.history_generation > document.last_drafted_history_generation:
            version = create_version_from_locked_document(
                document,
                kind=DocumentVersion.KIND_DRAFT,
            )
        document.last_drafted_history_generation = document.history_generation
        document.draft_due_at = None
        document.save(update_fields=["last_drafted_history_generation", "draft_due_at"])
        return version


def _timestamp(value: str | None):
    return parse_datetime(value) if value else None


def _restore_annotations(document: Document, items: list[dict]) -> None:
    desired_ids = {item["id"] for item in items}
    DocumentAnnotation.objects.filter(document=document).exclude(public_id__in=desired_ids).delete()
    current = {
        str(item.public_id): item
        for item in DocumentAnnotation.objects.filter(document=document).select_related(
            "document__manuscript__workspace"
        )
    }
    referenced_users = {
        user_id
        for item in items
        for user_id in (item.get("authorId"), item.get("resolvedById"))
        if user_id is not None
    }
    referenced_users.update(
        reply.get("authorId")
        for item in items
        for reply in item.get("replies", [])
        if reply.get("authorId") is not None
    )
    existing_user_ids = set(
        get_user_model().objects.filter(id__in=referenced_users).values_list("id", flat=True)
    )

    for item in items:
        annotation = current.get(item["id"])
        if annotation is None:
            annotation = DocumentAnnotation(document=document, public_id=item["id"])
        author_id = item.get("authorId")
        annotation.author_id = author_id if author_id in existing_user_ids else None
        annotation.quote = item["quote"]
        annotation.comment = item["comment"]
        annotation.status = item["status"]
        annotation.version = item["version"]
        resolver_id = item.get("resolvedById")
        annotation.resolved_by_id = resolver_id if resolver_id in existing_user_ids else None
        annotation.resolved_at = _timestamp(item.get("resolvedAt"))
        annotation.save()
        DocumentAnnotation.objects.filter(id=annotation.id).update(
            created_at=_timestamp(item.get("createdAt")),
            updated_at=_timestamp(item.get("updatedAt")),
        )

        replies = {str(reply.public_id): reply for reply in annotation.replies.all()}
        desired_reply_ids = {reply["id"] for reply in item.get("replies", [])}
        annotation.replies.exclude(public_id__in=desired_reply_ids).delete()
        for reply_item in item.get("replies", []):
            reply = replies.get(reply_item["id"])
            if reply is None:
                reply = AnnotationReply(annotation=annotation, public_id=reply_item["id"])
            author_id = reply_item.get("authorId")
            reply.author_id = author_id if author_id in existing_user_ids else None
            reply.body = reply_item["body"]
            reply.version = reply_item["version"]
            reply.save()
            AnnotationReply.objects.filter(id=reply.id).update(
                created_at=_timestamp(reply_item.get("createdAt")),
                updated_at=_timestamp(reply_item.get("updatedAt")),
            )


def restore_version(version_id: int, *, expected_generation: int) -> Document | None:
    with transaction.atomic():
        version = DocumentVersion.objects.select_related("document__manuscript__workspace").get(
            id=version_id
        )
        document = (
            Document.objects.select_for_update()
            .select_related("manuscript__workspace")
            .get(id=version.document_id)
        )
        if document.save_generation != expected_generation:
            return None
        snapshot = version.snapshot
        content = validate_document_content(snapshot["content"])
        required_asset_ids = illustration_asset_ids(content)
        available_asset_ids = {
            str(asset_id)
            for asset_id in ManuscriptAsset.objects.filter(
                manuscript_id=document.manuscript_id,
                public_id__in=required_asset_ids,
            ).values_list("public_id", flat=True)
        }
        if available_asset_ids != required_asset_ids:
            raise VersionAssetMissing("version_asset_missing")
        _restore_annotations(document, snapshot.get("annotations", []))
        for item in snapshot.get("assets", []):
            asset = (
                ManuscriptAsset.objects.filter(
                    manuscript_id=document.manuscript_id,
                    public_id=item["id"],
                )
                .select_related("manuscript__workspace")
                .first()
            )
            if asset is not None:
                asset.alt_text = item.get("alt", "")
                asset.caption = item.get("caption", "")
                asset.save(update_fields=["alt_text", "caption", "updated_at"])
        document.content = content
        document.save_generation += 1
        document.history_generation += 1
        document.last_drafted_history_generation = document.history_generation
        document.draft_due_at = None
        document.save(
            update_fields=[
                "content",
                "save_generation",
                "history_generation",
                "last_drafted_history_generation",
                "draft_due_at",
                "updated_at",
            ]
        )
        from .collaboration import reset_collaboration_epoch

        reset_collaboration_epoch(document)
        return document
