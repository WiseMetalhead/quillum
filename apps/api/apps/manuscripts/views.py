from __future__ import annotations

import json

from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods

from apps.accounts.media import (
    create_or_get_user_media,
    media_variant_bytes,
    media_variant_metadata,
    process_user_media,
    processed_user_media_size,
)
from apps.accounts.models import UserMediaAsset
from apps.accounts.tier_progression import record_tier_activity
from apps.accounts.tiers import image_upload_limit, quota_violation
from apps.audit.service import write_audit_event
from config.media_responses import private_media_response

from .assets import InvalidAsset
from .collaboration import collaboration_metadata, document_uses_collaboration
from .document_schema import (
    InvalidDocument,
    annotation_ids,
    illustration_asset_ids,
    validate_document_content,
)
from .media_cache import cover_cache_version
from .metadata import (
    InvalidManuscriptMetadata,
    normalize_manuscript_genres,
    normalize_manuscript_language,
)
from .models import (
    Document,
    DocumentAnnotation,
    EditorPreference,
    Manuscript,
    ManuscriptAsset,
    ManuscriptItem,
    ManuscriptPlanStatus,
)
from .planner import local_date, record_words_written
from .quotas import (
    image_size_response,
    quota_response,
    storage_quota_response,
)
from .services import (
    create_imported_oneshot,
    create_manuscript_asset_from_media,
    create_oneshot,
    delete_manuscript,
    update_manuscript_metadata,
)
from .text_import import InvalidTextImport, parse_import_plan
from .versioning import document_statistics, mark_history_changed

TITLE_MAX_LENGTH = 240
SYNOPSIS_MAX_LENGTH = 5_000
EDITOR_FONT_SIZES = {14, 16, 18, 20, 22, 24}
ASSET_ALT_MAX_LENGTH = 500
ASSET_CAPTION_MAX_LENGTH = 2_000
MANUSCRIPT_STATUS_NEW = "new"
MANUSCRIPT_STATUS_IN_PROGRESS = "in_progress"
MANUSCRIPT_STATUS_COMPLETE = "complete"


def manuscript_lifecycle_status(manuscript: Manuscript) -> str:
    complete_status_ids = {
        str(status_id)
        for status_id in ManuscriptPlanStatus.objects.filter(
            manuscript=manuscript,
            counts_as_complete=True,
        ).values_list("public_id", flat=True)
    }
    if complete_status_ids:
        active_document_items = ManuscriptItem.objects.filter(
            manuscript=manuscript,
            kind=ManuscriptItem.KIND_DOCUMENT,
            trashed_at__isnull=True,
        ).select_related("manuscript__workspace")
        has_documents = False
        all_complete = True
        for item in active_document_items:
            has_documents = True
            if item.planner_metadata.get("statusId") not in complete_status_ids:
                all_complete = False
                break
        if has_documents and all_complete:
            return MANUSCRIPT_STATUS_COMPLETE
    if manuscript.first_edited_at is not None:
        return MANUSCRIPT_STATUS_IN_PROGRESS
    return MANUSCRIPT_STATUS_NEW


def manuscript_payload(manuscript: Manuscript) -> dict:
    has_cover = bool(manuscript.cover_media_id)
    first_document = next(iter(manuscript.documents.all()), None)
    return {
        "id": str(manuscript.public_id),
        "kind": manuscript.kind,
        "title": manuscript.title,
        "synopsis": manuscript.synopsis,
        "language": manuscript.language,
        "genres": manuscript.genres,
        "status": manuscript_lifecycle_status(manuscript),
        "documentId": str(first_document.public_id) if first_document is not None else None,
        "structureGeneration": manuscript.structure_generation,
        "coverThumbnailSmallUrl": (
            f"/api/manuscripts/{manuscript.public_id}/cover/small/" if has_cover else ""
        ),
        "coverThumbnailMediumUrl": (
            f"/api/manuscripts/{manuscript.public_id}/cover/medium/" if has_cover else ""
        ),
        "coverVersion": cover_cache_version(manuscript),
        "coverWidth": manuscript.cover_width,
        "coverHeight": manuscript.cover_height,
        "createdAt": manuscript.created_at.isoformat(),
        "updatedAt": manuscript.updated_at.isoformat(),
    }


def manuscript_metadata_from_request(request):
    try:
        language = normalize_manuscript_language(request.POST.get("language"))
        genres = normalize_manuscript_genres(request.POST.get("genres"))
    except InvalidManuscriptMetadata as exc:
        return None, JsonResponse({"error": exc.code}, status=400)
    return (language, genres), None


def _cover_media_from_request(request, *, replacing_media: UserMediaAsset | None = None):
    uploaded_cover = request.FILES.get("cover")
    media_id = request.POST.get("coverMediaId", "").strip()
    if uploaded_cover is None and not media_id:
        return None, None
    if uploaded_cover is not None and media_id:
        return None, JsonResponse({"error": "manuscript_cover_update_invalid"}, status=400)
    if media_id:
        media = UserMediaAsset.objects.filter(public_id=media_id, owner=request.user).first()
        return (
            (media, None)
            if media is not None
            else (None, JsonResponse({"error": "storage_item_not_found"}, status=404))
        )
    image_limit = image_upload_limit(request.user)
    if uploaded_cover.size > image_limit:
        return None, image_size_response(request.user, used=uploaded_cover.size, limit=image_limit)
    try:
        processed = process_user_media(uploaded_cover, max_bytes=image_limit)
    except InvalidAsset as exc:
        return None, JsonResponse({"error": exc.code.replace("asset_", "cover_")}, status=400)
    existing = UserMediaAsset.objects.filter(
        owner=request.user, content_hash=processed.content_hash
    ).first()
    storage_error = storage_quota_response(
        request.user,
        added=0 if existing else processed_user_media_size(processed),
        replacing=0,
    )
    if storage_error is not None:
        return None, storage_error
    media, _created = create_or_get_user_media(user=request.user, processed=processed)
    return media, None


@require_http_methods(["GET", "POST"])
def oneshots(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    if request.method == "GET":
        manuscripts = (
            Manuscript.objects.filter(
                workspace__owner=request.user,
                kind=Manuscript.KIND_ONESHOT,
                drawer_at__isnull=True,
            )
            .select_related("workspace")
            .prefetch_related("documents")
            .order_by("-updated_at")
        )
        return JsonResponse({"items": [manuscript_payload(item) for item in manuscripts]})

    title = request.POST.get("title", "").strip()
    synopsis = request.POST.get("synopsis", "").strip()
    if not title:
        return JsonResponse({"error": "oneshot_title_required"}, status=400)
    if len(title) > TITLE_MAX_LENGTH:
        return JsonResponse({"error": "oneshot_title_too_long"}, status=400)
    if len(synopsis) > SYNOPSIS_MAX_LENGTH:
        return JsonResponse({"error": "oneshot_synopsis_too_long"}, status=400)
    metadata, error = manuscript_metadata_from_request(request)
    if error is not None:
        return error
    language, genres = metadata
    violation = quota_violation(request.user, "oneshots")
    if violation is not None:
        return quota_response(violation)

    cover, error = _cover_media_from_request(request)
    if error is not None:
        return error

    raw_import_manifest = request.POST.get("importManifest")
    try:
        if raw_import_manifest:
            import_plan = parse_import_plan(
                raw_import_manifest,
                request.FILES,
                kind="oneshot",
            )
            manuscript = create_imported_oneshot(
                user=request.user,
                title=title,
                synopsis=synopsis,
                cover=cover,
                import_plan=import_plan,
                language=language,
                genres=genres,
            )
        else:
            manuscript = create_oneshot(
                user=request.user,
                title=title,
                synopsis=synopsis,
                cover=cover,
                language=language,
                genres=genres,
            )
    except InvalidTextImport as exc:
        return JsonResponse({"error": exc.code}, status=400)
    write_audit_event(
        request,
        "manuscript.oneshot_created",
        actor=request.user,
        subject=f"manuscript:{manuscript.public_id}",
        payload={"kind": manuscript.kind, "imported": bool(raw_import_manifest)},
    )
    return JsonResponse({"manuscript": manuscript_payload(manuscript)}, status=201)


@require_http_methods(["GET", "PATCH"])
def oneshot_detail(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = (
        Manuscript.objects.filter(
            id=manuscript_id,
            workspace__owner=request.user,
            kind=Manuscript.KIND_ONESHOT,
        )
        .select_related("workspace", "cover_media__owner")
        .prefetch_related("documents")
        .first()
    )
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if request.method == "PATCH":
        try:
            payload = json.loads(request.body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "invalid_json"}, status=400)
        if not isinstance(payload, dict):
            return JsonResponse({"error": "invalid_json"}, status=400)
        title = str(payload.get("title") or "").strip()
        if not title:
            return JsonResponse({"error": "oneshot_title_required"}, status=400)
        if len(title) > TITLE_MAX_LENGTH:
            return JsonResponse({"error": "oneshot_title_too_long"}, status=400)
        if title != manuscript.title:
            with transaction.atomic():
                manuscript.title = title
                manuscript.save(update_fields=["title", "updated_at"])
                document_item = (
                    manuscript.documents.select_related("item__manuscript__workspace").get().item
                )
                document_item.title = title
                document_item.save(update_fields=["title", "updated_at"])
            write_audit_event(
                request,
                "manuscript.renamed",
                actor=request.user,
                subject=f"manuscript:{manuscript.public_id}",
                payload={"kind": manuscript.kind},
            )
    return JsonResponse({"manuscript": manuscript_payload(manuscript)})


@require_http_methods(["GET", "POST", "PATCH", "DELETE"])
def manuscript_detail(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = (
        Manuscript.objects.filter(id=manuscript_id, workspace__owner=request.user)
        .select_related("workspace")
        .prefetch_related("documents")
        .first()
    )
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if request.method == "DELETE":
        manuscript_kind = manuscript.kind
        with transaction.atomic():
            delete_manuscript(manuscript)
            write_audit_event(
                request,
                "manuscript.deleted",
                actor=request.user,
                subject=f"manuscript:{manuscript_id}",
                payload={"kind": manuscript_kind},
            )
        return JsonResponse({})
    if request.method == "POST":
        title = request.POST.get("title", "").strip()
        synopsis = request.POST.get("synopsis", "").strip()
        remove_cover = request.POST.get("removeCover") == "true"
        if not title:
            return JsonResponse({"error": "manuscript_title_required"}, status=400)
        if len(title) > TITLE_MAX_LENGTH:
            return JsonResponse({"error": "manuscript_title_too_long"}, status=400)
        if len(synopsis) > SYNOPSIS_MAX_LENGTH:
            return JsonResponse({"error": "manuscript_synopsis_too_long"}, status=400)
        metadata, error = manuscript_metadata_from_request(request)
        if error is not None:
            return error
        language, genres = metadata
        if (
            request.FILES.get("cover") is not None or request.POST.get("coverMediaId")
        ) and remove_cover:
            return JsonResponse({"error": "manuscript_cover_update_invalid"}, status=400)
        cover, error = _cover_media_from_request(request, replacing_media=manuscript.cover_media)
        if error is not None:
            return error
        update_manuscript_metadata(
            manuscript=manuscript,
            title=title,
            synopsis=synopsis,
            cover=cover,
            remove_cover=remove_cover,
            language=language,
            genres=genres,
        )
        write_audit_event(
            request,
            "manuscript.metadata_updated",
            actor=request.user,
            subject=f"manuscript:{manuscript.public_id}",
            payload={"kind": manuscript.kind, "coverChanged": bool(cover or remove_cover)},
        )
    elif request.method == "PATCH":
        try:
            payload = json.loads(request.body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "invalid_json"}, status=400)
        if not isinstance(payload, dict) or set(payload) != {"title"}:
            return JsonResponse({"error": "manuscript_update_invalid"}, status=400)
        title = str(payload.get("title") or "").strip()
        if not title:
            return JsonResponse({"error": "manuscript_title_required"}, status=400)
        if len(title) > TITLE_MAX_LENGTH:
            return JsonResponse({"error": "manuscript_title_too_long"}, status=400)
        if manuscript.title != title:
            manuscript.title = title
            with transaction.atomic():
                manuscript.save(update_fields=["title", "updated_at"])
                if manuscript.kind == Manuscript.KIND_ONESHOT:
                    document_item = (
                        manuscript.documents.select_related("item__manuscript__workspace")
                        .get()
                        .item
                    )
                    document_item.title = title
                    document_item.save(update_fields=["title", "updated_at"])
                record_tier_activity(request.user)
    return JsonResponse({"manuscript": manuscript_payload(manuscript)})


def document_payload(document: Document) -> dict:
    return {
        "id": str(document.public_id),
        "content": document.content,
        "schemaVersion": document.schema_version,
        "saveGeneration": document.save_generation,
        "updatedAt": document.updated_at.isoformat(),
        **collaboration_metadata(document),
    }


def editor_preferences_payload(preferences: EditorPreference) -> dict:
    return {
        "fontSize": preferences.font_size,
        "smartQuotes": preferences.smart_quotes,
        "quoteStyle": preferences.quote_style,
        "autoCapitalize": preferences.auto_capitalize,
        "autoReplace": preferences.auto_replace,
        "spellcheckEnabled": preferences.spellcheck_enabled,
        "spellcheckDictionary": preferences.spellcheck_dictionary,
    }


@require_http_methods(["GET", "PATCH"])
def editor_preferences(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    preferences = EditorPreference.objects.filter(user=request.user).first()
    if request.method == "GET":
        if preferences is None:
            preferences = EditorPreference(user=request.user)
        return JsonResponse({"preferences": editor_preferences_payload(preferences)})

    try:
        payload = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "invalid_json"}, status=400)
    if not isinstance(payload, dict):
        return JsonResponse({"error": "invalid_json"}, status=400)

    allowed_fields = {
        "fontSize",
        "smartQuotes",
        "quoteStyle",
        "autoCapitalize",
        "autoReplace",
        "spellcheckEnabled",
        "spellcheckDictionary",
    }
    if not payload or not set(payload).issubset(allowed_fields):
        return JsonResponse({"error": "editor_preferences_invalid"}, status=400)
    if "fontSize" in payload and payload["fontSize"] not in EDITOR_FONT_SIZES:
        return JsonResponse({"error": "editor_font_size_invalid"}, status=400)
    if "quoteStyle" in payload and payload["quoteStyle"] not in {
        EditorPreference.QUOTE_STYLE_GUILLEMETS,
        EditorPreference.QUOTE_STYLE_CURLY,
    }:
        return JsonResponse({"error": "editor_quote_style_invalid"}, status=400)
    for field_name in ("smartQuotes", "autoCapitalize", "autoReplace", "spellcheckEnabled"):
        if field_name in payload and not isinstance(payload[field_name], bool):
            return JsonResponse({"error": "editor_preferences_invalid"}, status=400)
    if "spellcheckDictionary" in payload and payload["spellcheckDictionary"] not in {
        choice[0] for choice in EditorPreference.SPELLCHECK_DICTIONARY_CHOICES
    }:
        return JsonResponse({"error": "editor_spellcheck_dictionary_invalid"}, status=400)

    if preferences is None:
        preferences = EditorPreference(user=request.user)
    field_map = {
        "fontSize": "font_size",
        "smartQuotes": "smart_quotes",
        "quoteStyle": "quote_style",
        "autoCapitalize": "auto_capitalize",
        "autoReplace": "auto_replace",
        "spellcheckEnabled": "spellcheck_enabled",
        "spellcheckDictionary": "spellcheck_dictionary",
    }
    update_fields = []
    for payload_name, model_name in field_map.items():
        if payload_name in payload:
            setattr(preferences, model_name, payload[payload_name])
            update_fields.append(model_name)
    if preferences.pk:
        preferences.save(update_fields=[*update_fields, "updated_at"])
    else:
        preferences.save()
    return JsonResponse({"preferences": editor_preferences_payload(preferences)})


@require_http_methods(["GET", "PUT"])
def document_content(request, manuscript_id: int, item_id=None):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    document_query = Document.objects.filter(
        manuscript__id=manuscript_id,
        manuscript__workspace__owner=request.user,
    ).select_related("manuscript__workspace")
    if item_id is None:
        document_query = document_query.filter(manuscript__kind=Manuscript.KIND_ONESHOT)
    else:
        document_query = document_query.filter(
            manuscript__kind=Manuscript.KIND_BOOK,
            item__public_id=item_id,
            item__trashed_at__isnull=True,
        )
    if request.method == "GET":
        document = document_query.first()
        if document is None:
            return JsonResponse({"error": "manuscript_not_found"}, status=404)
        return JsonResponse({"document": document_payload(document)})

    try:
        payload = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "invalid_json"}, status=400)
    if not isinstance(payload, dict):
        return JsonResponse({"error": "invalid_json"}, status=400)
    expected_generation = payload.get("expectedGeneration")
    schema_version = payload.get("schemaVersion")
    if isinstance(expected_generation, bool) or not isinstance(expected_generation, int):
        return JsonResponse({"error": "save_generation_required"}, status=400)
    if expected_generation < 0:
        return JsonResponse({"error": "save_generation_invalid"}, status=400)
    if schema_version != Document.CURRENT_SCHEMA_VERSION:
        return JsonResponse({"error": "document_schema_unsupported"}, status=400)
    try:
        writing_date = local_date(payload.get("timezone", "UTC"))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    try:
        content = validate_document_content(payload.get("content"))
    except InvalidDocument as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    asset_ids = illustration_asset_ids(content)
    if asset_ids and ManuscriptAsset.objects.filter(
        manuscript_id=manuscript_id, public_id__in=asset_ids
    ).count() != len(asset_ids):
        return JsonResponse({"error": "document_asset_not_found"}, status=400)
    content_annotation_ids = annotation_ids(content)

    with transaction.atomic():
        document = document_query.select_for_update().first()
        if document is None:
            return JsonResponse({"error": "manuscript_not_found"}, status=404)
        if document_uses_collaboration(document):
            return JsonResponse({"error": "collaboration_required"}, status=409)
        if content_annotation_ids and DocumentAnnotation.objects.filter(
            document_id=document.id,
            public_id__in=content_annotation_ids,
        ).count() != len(content_annotation_ids):
            return JsonResponse({"error": "document_annotation_not_found"}, status=400)
        if document.save_generation != expected_generation:
            return JsonResponse(
                {
                    "error": "document_save_conflict",
                    "saveGeneration": document.save_generation,
                },
                status=409,
            )
        if document.content == content:
            return JsonResponse({"document": document_payload(document)})
        previous_word_count = document_statistics(document.content)[0]
        next_word_count = document_statistics(content)[0]
        document.content = content
        document.save_generation += 1
        mark_history_changed(document)
        document.save(
            update_fields=[
                "content",
                "save_generation",
                "history_generation",
                "draft_due_at",
                "updated_at",
            ]
        )
        manuscript_updated_at = timezone.now()
        manuscript_updates = {"updated_at": manuscript_updated_at}
        if document.manuscript.first_edited_at is None:
            manuscript_updates["first_edited_at"] = manuscript_updated_at
        Manuscript.objects.filter(id=document.manuscript_id).update(**manuscript_updates)
        record_words_written(
            manuscript_id=document.manuscript_id,
            writing_date=writing_date,
            words=max(0, next_word_count - previous_word_count),
        )
        record_tier_activity(request.user)
    return JsonResponse({"document": document_payload(document)})


@require_GET
def cover_content(request, manuscript_id: int, variant: str):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)

    manuscript = (
        Manuscript.objects.filter(id=manuscript_id, workspace__owner=request.user)
        .select_related("workspace", "cover_media__owner")
        .first()
    )
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    if not manuscript.cover_media_id:
        return JsonResponse({"error": "cover_not_found"}, status=404)
    metadata = media_variant_metadata(manuscript.cover_media, variant)
    if metadata is None:
        return JsonResponse({"error": "cover_variant_not_found"}, status=404)
    return private_media_response(
        request,
        cache_key=(
            None
            if variant == "original"
            else (
                f"user-media:{manuscript.cover_media.public_id}:"
                f"{manuscript.cover_media.content_hash}:{metadata[1]}"
            )
        ),
        load_content=lambda: media_variant_bytes(manuscript.cover_media, variant),
    )


def asset_payload(asset: ManuscriptAsset) -> dict:
    return {
        "id": str(asset.public_id),
        "contentType": asset.content_type,
        "width": asset.width,
        "height": asset.height,
        "byteSize": asset.byte_size,
        "alt": asset.alt_text,
        "caption": asset.caption,
        "mediumUrl": f"/api/manuscripts/assets/{asset.public_id}/medium/",
        "largeUrl": f"/api/manuscripts/assets/{asset.public_id}/large/",
    }


@require_http_methods(["POST"])
def manuscript_assets(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript = (
        Manuscript.objects.filter(id=manuscript_id, workspace__owner=request.user)
        .select_related("workspace")
        .first()
    )
    if manuscript is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    uploaded_file = request.FILES.get("image")
    media_id = request.POST.get("mediaId", "").strip()
    if uploaded_file is None and not media_id:
        return JsonResponse({"error": "asset_image_required"}, status=400)
    image_limit = image_upload_limit(request.user)
    if uploaded_file is not None and uploaded_file.size > image_limit:
        return image_size_response(request.user, used=uploaded_file.size, limit=image_limit)
    alt_text = request.POST.get("alt", "").strip()
    caption = request.POST.get("caption", "").strip()
    if len(alt_text) > ASSET_ALT_MAX_LENGTH:
        return JsonResponse({"error": "asset_alt_too_long"}, status=400)
    if len(caption) > ASSET_CAPTION_MAX_LENGTH:
        return JsonResponse({"error": "asset_caption_too_long"}, status=400)
    if media_id:
        media = UserMediaAsset.objects.filter(public_id=media_id, owner=request.user).first()
        if media is None:
            return JsonResponse({"error": "storage_item_not_found"}, status=404)
    else:
        try:
            processed = process_user_media(uploaded_file, max_bytes=image_limit)
        except InvalidAsset as exc:
            return JsonResponse({"error": exc.code}, status=400)
        existing = UserMediaAsset.objects.filter(
            owner=request.user, content_hash=processed.content_hash
        ).exists()
        storage_error = storage_quota_response(
            request.user,
            added=0 if existing else processed_user_media_size(processed),
        )
        if storage_error is not None:
            return storage_error
        media, _created = create_or_get_user_media(user=request.user, processed=processed)
    asset = create_manuscript_asset_from_media(
        manuscript=manuscript, media=media, alt_text=alt_text, caption=caption
    )
    return JsonResponse({"asset": asset_payload(asset)}, status=201)


@require_http_methods(["PATCH"])
def manuscript_asset_detail(request, asset_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    asset = (
        ManuscriptAsset.objects.filter(
            public_id=asset_id, manuscript__workspace__owner=request.user
        )
        .select_related("manuscript__workspace", "media__owner")
        .first()
    )
    if asset is None:
        return JsonResponse({"error": "asset_not_found"}, status=404)
    try:
        payload = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "invalid_json"}, status=400)
    if (
        not isinstance(payload, dict)
        or not payload
        or not set(payload).issubset({"alt", "caption"})
    ):
        return JsonResponse({"error": "asset_metadata_invalid"}, status=400)
    update_fields = []
    for payload_name, model_name, max_length in (
        ("alt", "alt_text", ASSET_ALT_MAX_LENGTH),
        ("caption", "caption", ASSET_CAPTION_MAX_LENGTH),
    ):
        if payload_name not in payload or not isinstance(payload[payload_name], str):
            continue
        value = payload[payload_name].strip()
        if len(value) > max_length:
            return JsonResponse({"error": f"asset_{payload_name}_too_long"}, status=400)
        setattr(asset, model_name, value)
        update_fields.append(model_name)
    if not update_fields:
        return JsonResponse({"error": "asset_metadata_invalid"}, status=400)
    with transaction.atomic():
        documents = list(
            Document.objects.select_for_update()
            .select_related("manuscript__workspace")
            .filter(manuscript_id=asset.manuscript_id)
        )
        asset = (
            ManuscriptAsset.objects.select_for_update()
            .select_related("manuscript__workspace")
            .get(id=asset.id)
        )
        for payload_name, model_name, _max_length in (
            ("alt", "alt_text", ASSET_ALT_MAX_LENGTH),
            ("caption", "caption", ASSET_CAPTION_MAX_LENGTH),
        ):
            if payload_name in payload and isinstance(payload[payload_name], str):
                setattr(asset, model_name, payload[payload_name].strip())
        asset.save(update_fields=[*update_fields, "updated_at"])
        for document in documents:
            if str(asset.public_id) in illustration_asset_ids(document.content):
                mark_history_changed(document)
                document.save(update_fields=["history_generation", "draft_due_at"])
    return JsonResponse({"asset": asset_payload(asset)})


@require_GET
def asset_content(request, asset_id, variant: str):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    asset = (
        ManuscriptAsset.objects.filter(
            public_id=asset_id, manuscript__workspace__owner=request.user
        )
        .select_related("manuscript__workspace", "media__owner")
        .first()
    )
    if asset is None:
        return JsonResponse({"error": "asset_not_found"}, status=404)
    media_variant = "editor-medium" if variant == "medium" else variant
    metadata = media_variant_metadata(asset.media, media_variant)
    if metadata is None:
        return JsonResponse({"error": "asset_variant_not_found"}, status=404)
    return private_media_response(
        request,
        cache_key=(
            None
            if variant == "original"
            else f"user-media:{asset.media.public_id}:{asset.media.content_hash}:{metadata[1]}"
        ),
        load_content=lambda: media_variant_bytes(asset.media, media_variant),
    )
