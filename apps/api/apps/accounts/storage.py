from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from uuid import UUID

from django.db import transaction
from django.db.models import Q
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from apps.audit.service import write_audit_event
from apps.manuscripts.document_schema import illustration_asset_ids
from apps.manuscripts.glossary_schema import glossary_asset_ids
from apps.manuscripts.models import (
    AudioRecording,
    Document,
    GlossaryArticle,
    GlossaryAsset,
    IdeaItem,
    Manuscript,
    ManuscriptAsset,
    Series,
    SeriesMembership,
)
from config.media_responses import private_media_response

from .media import media_total_size, media_variant_bytes, media_variant_metadata
from .models import UserMediaAsset
from .tier_progression import record_tier_activity
from .tiers import storage_usage_bytes, tier_quotas

GROUP_KEYS = {
    "all",
    "covers",
    "illustrations",
    "notes",
    "audioNotes",
    "glossary",
    "ideas",
    "other",
}
DEFAULT_PAGE_SIZE = 18
MAX_PAGE_SIZE = 48


@dataclass(frozen=True)
class UsageLocation:
    kind: str
    label: str
    detail: str
    url: str

    def payload(self) -> dict:
        return {
            "kind": self.kind,
            "label": self.label,
            "detail": self.detail,
            "url": self.url,
        }


def _file_size(field) -> int:
    if not field:
        return 0
    try:
        return int(field.size or 0)
    except (OSError, ValueError):
        return 0


def _field_sizes(item, fields: tuple[str, ...]) -> dict[str, int]:
    return {field: _file_size(getattr(item, field)) for field in fields}


def _file_total(item, fields: tuple[str, ...]) -> int:
    return sum(_field_sizes(item, fields).values())


def _delete_stored_files(files: list[tuple[object, str]]) -> None:
    for storage, name in files:
        storage.delete(name)


def _media_payload(
    *,
    item_id: str,
    group: str,
    media_type: str,
    title: str,
    subtitle: str,
    preview_url: str,
    display_url: str,
    download_url: str,
    content_type: str,
    width: int | None,
    height: int | None,
    original_bytes: int,
    variant_bytes: int,
    created_at,
    updated_at,
    usages: list[UsageLocation],
    deletable: bool,
    delete_reason: str,
    audio: dict | None = None,
) -> dict:
    return {
        "id": item_id,
        "group": group,
        "mediaType": media_type,
        "title": title,
        "subtitle": subtitle,
        "previewUrl": preview_url,
        "displayUrl": display_url,
        "downloadUrl": download_url,
        "contentType": content_type,
        "width": width,
        "height": height,
        "originalBytes": original_bytes,
        "variantBytes": variant_bytes,
        "totalBytes": original_bytes + variant_bytes,
        "createdAt": created_at.isoformat(),
        "updatedAt": updated_at.isoformat(),
        "usages": [usage.payload() for usage in usages],
        "deletable": deletable,
        "deleteReason": delete_reason,
        "audio": audio,
    }


def _document_url(manuscript_public_id, item_id) -> str:
    if item_id:
        return f"/manuscripts/{manuscript_public_id}/editor?item={item_id}"
    return f"/manuscripts/{manuscript_public_id}/editor"


def _glossary_article_url(article: GlossaryArticle) -> str:
    glossary = article.glossary
    if glossary.manuscript_id:
        return (
            f"/manuscripts/{glossary.manuscript.public_id}/glossary?article={article.public_id}"
        )
    manuscript_public_id = (
        SeriesMembership.objects.filter(series_id=glossary.series_id)
        .order_by("position", "created_at")
        .values_list("manuscript__public_id", flat=True)
        .first()
    )
    return (
        f"/manuscripts/{manuscript_public_id}/glossary?article={article.public_id}"
        if manuscript_public_id
        else ""
    )


def _glossary_manuscript_public_id(article: GlossaryArticle):
    glossary = article.glossary
    if glossary.manuscript_id:
        return glossary.manuscript.public_id
    return (
        SeriesMembership.objects.filter(series_id=glossary.series_id)
        .order_by("position", "created_at")
        .values_list("manuscript__public_id", flat=True)
        .first()
    )


def _glossary_asset_preview_url(asset: GlossaryAsset) -> str:
    manuscript_id = _glossary_manuscript_public_id(asset.article)
    return (
        f"/api/manuscripts/{manuscript_id}/glossary/assets/{asset.public_id}/medium/"
        if manuscript_id
        else ""
    )


def _glossary_asset_display_url(asset: GlossaryAsset) -> str:
    manuscript_id = _glossary_manuscript_public_id(asset.article)
    return (
        f"/api/manuscripts/{manuscript_id}/glossary/assets/{asset.public_id}/large/"
        if manuscript_id
        else ""
    )


def _glossary_asset_download_url(asset: GlossaryAsset) -> str:
    manuscript_id = _glossary_manuscript_public_id(asset.article)
    return (
        f"/api/manuscripts/{manuscript_id}/glossary/assets/{asset.public_id}/original/"
        if manuscript_id
        else ""
    )


def _owned_manuscript_assets(user):
    return (
        ManuscriptAsset.objects.filter(manuscript__workspace__owner=user)
        .select_related("manuscript__workspace")
        .prefetch_related(
            "notes",
            "document_versions",
            "document_versions__document",
            "document_versions__document__item",
        )
    )


def _owned_glossary_assets(user):
    return (
        GlossaryAsset.objects.filter(
            Q(article__glossary__manuscript__workspace__owner=user)
            | Q(article__glossary__series__workspace__owner=user)
        )
        .distinct()
        .select_related(
            "article__glossary__manuscript__workspace",
            "article__glossary__series__workspace",
        )
    )


def _document_references(user) -> dict[str, list[Document]]:
    references: dict[str, list[Document]] = defaultdict(list)
    documents = Document.objects.filter(manuscript__workspace__owner=user).select_related(
        "manuscript__workspace", "item"
    )
    for document in documents.iterator():
        for asset_id in illustration_asset_ids(document.content):
            references[str(asset_id)].append(document)
    return references


def _glossary_references(user) -> dict[str, list[GlossaryArticle]]:
    references: dict[str, list[GlossaryArticle]] = defaultdict(list)
    articles = (
        GlossaryArticle.objects.filter(
            Q(glossary__manuscript__workspace__owner=user)
            | Q(glossary__series__workspace__owner=user)
        )
        .distinct()
        .select_related(
            "glossary__manuscript__workspace",
            "glossary__series__workspace",
        )
    )
    for article in articles.iterator():
        for asset_id in glossary_asset_ids(article.content):
            references[str(asset_id)].append(article)
    return references


def _manuscript_asset_usages(
    asset: ManuscriptAsset,
    document_references: dict[str, list[Document]],
) -> list[UsageLocation]:
    asset_id = str(asset.public_id)
    usages: list[UsageLocation] = []
    for document in document_references.get(asset_id, []):
        usages.append(
            UsageLocation(
                kind="document",
                label=document.title,
                detail=asset.manuscript.title,
                url=_document_url(
                    asset.manuscript.public_id,
                    document.item.public_id if document.item else None,
                ),
            )
        )
    for note in asset.notes.all():
        usages.append(
            UsageLocation(
                kind="note",
                label=note.title,
                detail=asset.manuscript.title,
                url=f"/manuscripts/{asset.manuscript.public_id}/boards?note={note.public_id}",
            )
        )
    for version in asset.document_versions.all():
        document = version.document
        usages.append(
            UsageLocation(
                kind="version",
                label=document.title,
                detail=version.kind,
                url=_document_url(
                    asset.manuscript.public_id,
                    document.item.public_id if document.item else None,
                ),
            )
        )
    return usages


def _glossary_asset_usages(
    asset: GlossaryAsset,
    glossary_references: dict[str, list[GlossaryArticle]],
) -> list[UsageLocation]:
    article = asset.article
    usages: list[UsageLocation] = []
    if asset.kind in {GlossaryAsset.KIND_THUMBNAIL, GlossaryAsset.KIND_COVER}:
        usages.append(
            UsageLocation(
                kind=f"glossary_{asset.kind}",
                label=article.title,
                detail=asset.kind,
                url=_glossary_article_url(article),
            )
        )
    for referenced_article in glossary_references.get(str(asset.public_id), []):
        usages.append(
            UsageLocation(
                kind="glossary_article",
                label=referenced_article.title,
                detail=asset.kind,
                url=_glossary_article_url(referenced_article),
            )
        )
    return usages


def _inventory_items(user) -> list[dict]:
    document_references = _document_references(user)
    glossary_references = _glossary_references(user)
    items: list[dict] = []

    if user.avatar:
        original = _file_size(user.avatar)
        items.append(
            _media_payload(
                item_id=f"avatar:{user.id}",
                group="other",
                media_type="avatar",
                title=user.display_name or user.get_username(),
                subtitle="avatar",
                preview_url=f"/api/auth/profile/avatar/{user.id}/",
                display_url=f"/api/auth/profile/avatar/{user.id}/",
                download_url=f"/api/auth/profile/avatar/{user.id}/",
                content_type="image/webp",
                width=None,
                height=None,
                original_bytes=original,
                variant_bytes=0,
                created_at=user.date_joined,
                updated_at=user.date_joined,
                usages=[
                    UsageLocation(
                        kind="account",
                        label=user.display_name or user.get_username(),
                        detail="avatar",
                        url="/settings?tab=account",
                    )
                ],
                deletable=False,
                delete_reason="attached",
            )
        )

    items.extend(_shared_media_items(user, document_references, glossary_references))
    items.extend(_audio_note_items(user))
    return sorted(items, key=lambda item: item["updatedAt"], reverse=True)


def _audio_note_items(user) -> list[dict]:
    items = []
    audios = (
        AudioRecording.objects.filter(
            Q(note__manuscript__workspace__owner=user) | Q(idea__owner=user)
        )
        .distinct()
        .select_related("note__manuscript__workspace", "idea")
    )
    for audio in audios:
        note = audio.note if audio.note_id else None
        idea = audio.idea if audio.idea_id else None
        if note is not None:
            manuscript = note.manuscript
            location_id = str(note.public_id)
            title = note.title
            subtitle = manuscript.title
            playback_url = f"/api/manuscripts/notes/{note.public_id}/audio/"
            download_url = f"{playback_url}?download=1"
            transcription_url = f"/api/manuscripts/notes/{note.public_id}/transcription/"
            usage = UsageLocation(
                kind="audio_note",
                label=note.title,
                detail=manuscript.title,
                url=f"/manuscripts/{manuscript.public_id}/boards?note={note.public_id}",
            )
            item_id = f"audio-note:{note.public_id}"
            updated_at = note.updated_at
        else:
            location_id = str(idea.public_id)
            title = idea.title
            subtitle = "ideas"
            playback_url = f"/api/ideas/{idea.public_id}/audio/"
            download_url = f"{playback_url}?download=1"
            transcription_url = f"/api/ideas/{idea.public_id}/transcription/"
            usage = UsageLocation(
                kind="idea",
                label=idea.title,
                detail="idea",
                url=f"/ideas?item={idea.public_id}",
            )
            item_id = f"audio-idea:{idea.public_id}"
            updated_at = idea.updated_at
        items.append(
            _media_payload(
                item_id=item_id,
                group="audioNotes",
                media_type="audio_note",
                title=title,
                subtitle=subtitle,
                preview_url="",
                display_url="",
                download_url=download_url,
                content_type=audio.content_type,
                width=None,
                height=None,
                original_bytes=_file_size(audio.file),
                variant_bytes=0,
                created_at=audio.created_at,
                updated_at=updated_at,
                usages=[usage],
                deletable=idea is not None,
                delete_reason="" if idea is not None else "referenced",
                audio={
                    "locationId": location_id,
                    "noteId": str(note.public_id) if note is not None else None,
                    "codec": audio.codec,
                    "durationMs": audio.duration_ms,
                    "waveform": audio.waveform,
                    "playbackUrl": playback_url,
                    "transcriptionUrl": transcription_url,
                },
            )
        )
    return items


def _shared_media_items(user, document_references, glossary_references) -> list[dict]:
    usages_by_media: dict[int, list[UsageLocation]] = defaultdict(list)
    groups_by_media: dict[int, set[str]] = defaultdict(set)
    media_types_by_media: dict[int, set[str]] = defaultdict(set)
    titles_by_media: dict[int, list[str]] = defaultdict(list)

    for manuscript in Manuscript.objects.filter(
        workspace__owner=user, cover_media__isnull=False
    ).select_related("cover_media"):
        usages_by_media[manuscript.cover_media_id].append(
            UsageLocation(
                "manuscript",
                manuscript.title,
                "cover",
                f"/manuscripts/{manuscript.public_id}?edit=metadata",
            )
        )
        groups_by_media[manuscript.cover_media_id].add("covers")
        media_types_by_media[manuscript.cover_media_id].add("manuscript_cover")
        titles_by_media[manuscript.cover_media_id].append(manuscript.title)
    for series in Series.objects.filter(
        workspace__owner=user, cover_media__isnull=False
    ).select_related("cover_media"):
        usages_by_media[series.cover_media_id].append(
            UsageLocation(
                "series",
                series.title,
                "cover",
                f"/manuscripts/series/{series.public_id}?edit=metadata",
            )
        )
        groups_by_media[series.cover_media_id].add("covers")
        media_types_by_media[series.cover_media_id].add("series_cover")
        titles_by_media[series.cover_media_id].append(series.title)
    for asset in _owned_manuscript_assets(user).filter(media__isnull=False).select_related("media"):
        media_id = asset.media_id
        usages = _manuscript_asset_usages(asset, document_references)
        usages_by_media[media_id].extend(usages)
        groups_by_media[media_id].add(
            "notes" if any(item.kind == "note" for item in usages) else "illustrations"
        )
        media_types_by_media[media_id].add("manuscript_asset")
        titles_by_media[media_id].append(asset.caption or asset.alt_text or asset.manuscript.title)
    for asset in _owned_glossary_assets(user).filter(media__isnull=False).select_related("media"):
        media_id = asset.media_id
        usages = _glossary_asset_usages(asset, glossary_references)
        usages_by_media[media_id].extend(usages)
        groups_by_media[media_id].add("glossary")
        media_types_by_media[media_id].add(f"glossary_{asset.kind}")
        titles_by_media[media_id].append(asset.caption or asset.alt_text or asset.article.title)
    for idea in IdeaItem.objects.filter(
        owner=user,
        kind=IdeaItem.KIND_IMAGE,
        image_media__isnull=False,
    ):
        usages_by_media[idea.image_media_id].insert(
            0,
            UsageLocation(
                "idea",
                "",
                "idea",
                f"/ideas?item={idea.public_id}",
            )
        )
        media_types_by_media[idea.image_media_id].add("idea_image")

    items = []
    for media in UserMediaAsset.objects.filter(owner=user):
        usages = usages_by_media.get(media.id, [])
        blocking_usages = [usage for usage in usages if usage.kind != "idea"]
        groups = groups_by_media.get(media.id, set())
        group = next(
            (item for item in ("covers", "illustrations", "notes", "glossary") if item in groups),
            "other",
        )
        sizes = _field_sizes(
            media,
            ("original", "thumbnail_small", "thumbnail_medium", "editor_medium", "editor_large"),
        )
        media_type = next(
            (
                item
                for item in (
                    "manuscript_cover",
                    "series_cover",
                    "manuscript_asset",
                    "glossary_thumbnail",
                    "glossary_cover",
                    "glossary_illustration",
                    "idea_image",
                )
                if item in media_types_by_media[media.id]
            ),
            "user_media",
        )
        title = next(
            (item for item in titles_by_media.get(media.id, []) if item),
            "" if media_type == "idea_image" else "Image",
        )
        items.append(
            _media_payload(
                item_id=f"media:{media.public_id}",
                group=group,
                media_type=media_type,
                title=title,
                subtitle=", ".join(sorted(groups)) or "library",
                preview_url=f"/api/auth/storage/media/{media.public_id}/medium/",
                display_url=f"/api/auth/storage/media/{media.public_id}/editor-large/",
                download_url=f"/api/auth/storage/media/{media.public_id}/original/",
                content_type=media.content_type,
                width=media.width,
                height=media.height,
                original_bytes=sizes["original"],
                variant_bytes=media_total_size(media) - sizes["original"],
                created_at=media.created_at,
                updated_at=media.updated_at,
                usages=usages,
                deletable=not blocking_usages,
                delete_reason="" if not blocking_usages else "referenced",
            )
        )
    return items


def _group_payload(items: list[dict]) -> list[dict]:
    groups = [
        {
            "key": "all",
            "count": len(items),
            "totalBytes": sum(item["totalBytes"] for item in items),
        }
    ]
    for key in (
        "covers",
        "illustrations",
        "notes",
        "audioNotes",
        "glossary",
        "ideas",
        "other",
    ):
        group_items = [
            item
            for item in items
            if (
                any(usage["kind"] == "idea" for usage in item["usages"])
                if key == "ideas"
                else item["group"] == key
            )
        ]
        groups.append(
            {
                "key": key,
                "count": len(group_items),
                "totalBytes": sum(item["totalBytes"] for item in group_items),
            }
        )
    return groups


def _storage_payload(request) -> JsonResponse:
    group = request.GET.get("group", "all")
    if group not in GROUP_KEYS:
        group = "all"
    try:
        page = max(1, int(request.GET.get("page", "1")))
    except ValueError:
        page = 1
    try:
        page_size = int(request.GET.get("pageSize", str(DEFAULT_PAGE_SIZE)))
    except ValueError:
        page_size = DEFAULT_PAGE_SIZE
    page_size = min(MAX_PAGE_SIZE, max(1, page_size))

    items = _inventory_items(request.user)
    groups = _group_payload(items)
    filtered = items if group == "all" else [
        item
        for item in items
        if (
            any(usage["kind"] == "idea" for usage in item["usages"])
            if group == "ideas"
            else item["group"] == group
        )
    ]
    total = len(filtered)
    total_pages = max(1, math.ceil(total / page_size))
    page = min(page, total_pages)
    start = (page - 1) * page_size
    end = start + page_size
    return JsonResponse(
        {
            "summary": {
                "usedBytes": storage_usage_bytes(request.user),
                "limitBytes": tier_quotas(request.user.tier)["storage_bytes"],
                "tier": request.user.tier,
            },
            "groups": groups,
            "items": filtered[start:end],
            "pagination": {
                "page": page,
                "pageSize": page_size,
                "total": total,
                "totalPages": total_pages,
            },
        }
    )


def _manuscript_asset_in_use(user, asset: ManuscriptAsset) -> bool:
    asset_id = str(asset.public_id)
    if asset.notes.exists() or asset.document_versions.exists():
        return True
    documents = Document.objects.filter(manuscript__workspace__owner=user)
    return any(asset_id in illustration_asset_ids(document.content) for document in documents)


def _glossary_asset_in_use(user, asset: GlossaryAsset) -> bool:
    if asset.kind != GlossaryAsset.KIND_ILLUSTRATION:
        return True
    asset_id = asset.public_id
    articles = GlossaryArticle.objects.filter(
        Q(glossary__manuscript__workspace__owner=user) | Q(glossary__series__workspace__owner=user)
    ).distinct()
    return any(asset_id in glossary_asset_ids(article.content) for article in articles)


def _delete_user_media(
    user,
    media_id: int,
    *,
    remove_ideas: bool,
) -> tuple[bool, list[tuple[str, str]]]:
    with transaction.atomic():
        media = (
            UserMediaAsset.objects.select_for_update()
            .filter(id=media_id, owner=user)
            .first()
        )
        if media is None:
            return True, []
        if media.manuscript_covers.exists() or media.series_covers.exists():
            return False, []
        manuscript_attachments = list(media.manuscript_attachments.all())
        glossary_attachments = list(media.glossary_attachments.all())
        if any(
            _manuscript_asset_in_use(user, asset)
            for asset in manuscript_attachments
        ) or any(
            _glossary_asset_in_use(user, asset)
            for asset in glossary_attachments
        ):
            return False, []
        ideas = list(
            IdeaItem.objects.select_for_update()
            .filter(owner=user, image_media=media)
            .values_list("public_id", "kind")
        )
        if ideas and not remove_ideas:
            return False, []
        stored_files = [
            (field.storage, field.name)
            for field in (
                media.original,
                media.thumbnail_small,
                media.thumbnail_medium,
                media.editor_medium,
                media.editor_large,
            )
            if field
        ]
        if ideas:
            IdeaItem.objects.filter(
                owner=user,
                public_id__in=[public_id for public_id, _kind in ideas],
            ).delete()
        ManuscriptAsset.objects.filter(
            id__in=[asset.id for asset in manuscript_attachments]
        ).delete()
        GlossaryAsset.objects.filter(
            id__in=[asset.id for asset in glossary_attachments]
        ).delete()
        media.delete()
        transaction.on_commit(lambda files=stored_files: _delete_stored_files(files))
        return True, [(str(public_id), kind) for public_id, kind in ideas]


def delete_user_media_if_unreferenced(user, media_id: int) -> bool:
    """Delete one shared image and orphan attachments when it has no live domain usage."""
    deleted, _ideas = _delete_user_media(user, media_id, remove_ideas=False)
    return deleted


def _delete_user_media_from_storage(user, media_id: int) -> tuple[bool, list[tuple[str, str]]]:
    """Delete safe shared media, treating Ideas membership as removable ownership."""
    return _delete_user_media(user, media_id, remove_ideas=True)


def _delete_storage_item(request, item_id: str) -> JsonResponse:
    try:
        prefix, raw_id = item_id.split(":", 1)
    except ValueError:
        return JsonResponse({"error": "storage_item_not_found"}, status=404)
    try:
        public_id = UUID(raw_id)
    except ValueError:
        return JsonResponse({"error": "storage_item_not_found"}, status=404)

    if prefix == "media":
        media = UserMediaAsset.objects.filter(public_id=public_id, owner=request.user).first()
        if media is None:
            return JsonResponse({"error": "storage_item_not_found"}, status=404)
        deleted, deleted_ideas = _delete_user_media_from_storage(request.user, media.id)
        if not deleted:
            return JsonResponse({"error": "storage_item_in_use"}, status=409)
        if deleted_ideas:
            record_tier_activity(request.user)
            for idea_id, kind in deleted_ideas:
                write_audit_event(
                    request,
                    "idea.deleted",
                    actor=request.user,
                    subject=f"idea:{idea_id}",
                    payload={"kind": kind},
                )
        return JsonResponse({})

    if prefix == "audio-idea":
        with transaction.atomic():
            idea = (
                IdeaItem.objects.select_for_update()
                .filter(
                    owner=request.user,
                    public_id=public_id,
                    kind=IdeaItem.KIND_AUDIO,
                )
                .first()
            )
            if idea is None:
                return JsonResponse({"error": "storage_item_not_found"}, status=404)
            idea.delete()
            record_tier_activity(request.user)
        write_audit_event(
            request,
            "idea.deleted",
            actor=request.user,
            subject=f"idea:{public_id}",
            payload={"kind": IdeaItem.KIND_AUDIO},
        )
        return JsonResponse({})

    if prefix == "audio-note":
        exists = AudioRecording.objects.filter(
            note__public_id=public_id,
            note__manuscript__workspace__owner=request.user,
        ).exists()
        return JsonResponse(
            {"error": "storage_item_in_use" if exists else "storage_item_not_found"},
            status=409 if exists else 404,
        )

    if prefix == "manuscript-asset":
        asset = _owned_manuscript_assets(request.user).filter(public_id=public_id).first()
        if asset is None:
            return JsonResponse({"error": "storage_item_not_found"}, status=404)
        if _manuscript_asset_in_use(request.user, asset):
            return JsonResponse({"error": "storage_item_in_use"}, status=409)
        with transaction.atomic():
            asset.delete()
        return JsonResponse({})

    if prefix == "glossary-asset":
        asset = _owned_glossary_assets(request.user).filter(public_id=public_id).first()
        if asset is None:
            return JsonResponse({"error": "storage_item_not_found"}, status=404)
        if _glossary_asset_in_use(request.user, asset):
            return JsonResponse({"error": "storage_item_in_use"}, status=409)
        with transaction.atomic():
            asset.delete()
        return JsonResponse({})

    return JsonResponse({"error": "storage_item_not_found"}, status=404)


@require_http_methods(["GET"])
def storage(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    return _storage_payload(request)


@require_http_methods(["DELETE"])
def storage_item(request, item_id: str):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    return _delete_storage_item(request, item_id)


@require_http_methods(["GET"])
def storage_media_content(request, media_id, variant: str):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    media = (
        UserMediaAsset.objects.filter(public_id=media_id, owner=request.user)
        .select_related("owner")
        .first()
    )
    if media is None:
        return JsonResponse({"error": "storage_item_not_found"}, status=404)
    metadata = media_variant_metadata(media, variant)
    if metadata is None:
        return JsonResponse({"error": "asset_variant_not_found"}, status=404)
    return private_media_response(
        request,
        cache_key=(
            None
            if variant == "original"
            else f"user-media:{media.public_id}:{media.content_hash}:{metadata[1]}"
        ),
        load_content=lambda: media_variant_bytes(media, variant),
    )
