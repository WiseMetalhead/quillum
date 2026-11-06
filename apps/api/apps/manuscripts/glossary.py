from __future__ import annotations

import json
import logging
import re
import unicodedata
import uuid

from django.db import IntegrityError, transaction
from django.db.models import F
from django.db.models.deletion import RestrictedError
from django.http import FileResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods

from apps.accounts.media import (
    ProcessedUserMedia,
    create_or_get_user_media,
    media_variant_bytes,
    media_variant_metadata,
    process_user_media,
    processed_user_media_size,
)
from apps.accounts.models import UserMediaAsset
from apps.accounts.tier_progression import record_tier_activity
from apps.accounts.tiers import image_upload_limit
from apps.audit.service import write_audit_event
from config.media_responses import private_media_response

from .assets import InvalidAsset
from .download_names import content_disposition
from .glossary_exports import GlossaryExportError, build_glossary_export
from .glossary_import import InvalidGlossaryImport, imported_glossary_content
from .glossary_schema import (
    InvalidGlossaryContent,
    glossary_article_links,
    glossary_asset_ids,
    glossary_asset_ids_in_order,
    validate_glossary_content,
)
from .models import (
    Document,
    DocumentGlossaryAssociation,
    Glossary,
    GlossaryArticle,
    GlossaryArticleAlias,
    GlossaryArticleLink,
    GlossaryAsset,
    GlossaryCategory,
    GlossaryCustomWord,
    Manuscript,
)
from .quotas import (
    image_size_response,
    storage_quota_response,
)

ARTICLE_TITLE_MAX_LENGTH = 240
ARTICLE_ALIAS_MAX_LENGTH = 240
ARTICLE_SYNOPSIS_MAX_LENGTH = 2_000
CATEGORY_NAME_MAX_LENGTH = 80
CATEGORY_DESCRIPTION_MAX_LENGTH = 500
ASSET_ALT_MAX_LENGTH = 500
ASSET_CAPTION_MAX_LENGTH = 2_000
MAX_CUSTOM_CATEGORIES = 100
DEFAULT_PAGE_SIZE = 48
MAX_PAGE_SIZE = 100
CUSTOM_WORD_MAX_LENGTH = 80
MAX_CUSTOM_WORDS = 5_000
CUSTOM_WORD_PATTERN = re.compile(r"^[^\W\d_]+(?:[-'’][^\W\d_]+)*$", re.UNICODE)
logger = logging.getLogger(__name__)

SYSTEM_CATEGORIES = (
    ("characters", "solar:user-linear"),
    ("places", "solar:map-point-linear"),
    ("races", "solar:cat-linear"),
    ("organizations", "solar:buildings-2-linear"),
    ("items", "solar:sledgehammer-linear"),
    ("flora", "solar:leaf-linear"),
    ("fauna", "solar:paw-linear"),
)

# This whitelist is shared with the generated frontend picker. Persisted IDs stay renderable even
# when a future picker hides them.
CUSTOM_ICON_IDS = {
    f"game-icons:{name}"
    for name in {
        "anvil",
        "anchor",
        "ancient-sword",
        "angel-wings",
        "archer",
        "arena",
        "archive-register",
        "armor-vest",
        "axe-in-stump",
        "backpack",
        "barbed-sun",
        "barn-owl",
        "barracks-tent",
        "bear-head",
        "beast-eye",
        "birch-trees",
        "bird-house",
        "black-book",
        "black-knight-helm",
        "bone-knife",
        "bonsai-tree",
        "book-cover",
        "bookmark",
        "boot-prints",
        "bow-arrow",
        "brain",
        "bridge",
        "broadsword",
        "bullseye",
        "campfire",
        "camping-tent",
        "candle-light",
        "castle",
        "castle-ruins",
        "cat",
        "cave-entrance",
        "cauldron",
        "centurion-helmet",
        "chained-heart",
        "chest",
        "chess-bishop",
        "chess-king",
        "chess-knight",
        "chess-pawn",
        "chess-queen",
        "chess-rook",
        "cloak",
        "clock-tower",
        "closed-doors",
        "coins",
        "coins-pile",
        "compass",
        "crossbow",
        "crossed-axes",
        "crossed-bones",
        "crossed-swords",
        "crystal-ball",
        "crystal-cluster",
        "crystal-eye",
        "crystal-wand",
        "crown",
        "crowned-skull",
        "dagger-rose",
        "daggers",
        "deer-head",
        "desert",
        "desert-camp",
        "diamond-ring",
        "drakkar",
        "dragon-head",
        "dragon-spiral",
        "dungeon-gate",
        "dwarf-helmet",
        "eagle-emblem",
        "earth-africa-europe",
        "elf-helmet",
        "emerald",
        "ember-shot",
        "fairy-wand",
        "farm-tractor",
        "feather",
        "fishing-boat",
        "flamingo",
        "forest",
        "fox-head",
        "frog",
        "gate",
        "gear-hammer",
        "gem-chain",
        "ghost",
        "globe",
        "goblin-head",
        "gold-shell",
        "greek-temple",
        "griffin-symbol",
        "hammer-drop",
        "hammer-sickle",
        "helmet-head-shot",
        "heraldic-sun",
        "hood",
        "horse-head",
        "hourglass",
        "house",
        "ink-swirl",
        "island",
        "key",
        "king",
        "knight-banner",
        "lantern",
        "leaf-swirl",
        "lighthouse",
        "lion",
        "locked-fortress",
        "locked-chest",
        "magic-gate",
        "magic-lamp",
        "maple-leaf",
        "moon",
        "mountain-cave",
        "mountains",
        "mushroom-house",
        "oak",
        "oak-leaf",
        "old-king",
        "open-book",
        "owl",
        "paw-heart",
        "pine-tree",
        "pirate-flag",
        "planet-core",
        "potion-ball",
        "rabbit-head",
        "raven",
        "ring",
        "road",
        "rose",
        "round-table",
        "rune-stone",
        "cargo-ship",
        "scroll-unfurled",
        "seagull",
        "shield",
        "snake",
        "snowflake-1",
        "spear-hook",
        "spider-web",
        "spiral-shell",
        "star-swirl",
        "stone-tower",
        "sun",
        "sword-brandish",
        "sword-spade",
        "tentacles-skull",
        "tower-flag",
        "treasure-map",
        "tree-branch",
        "treehouse",
        "tribal-mask",
        "tropical-fish",
        "unicorn",
        "village",
        "waterfall",
        "warlock-eye",
        "wolf-head",
        "wooden-sign",
        "wyvern",
    }
}


def _read_json(request):
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _scope_queryset():
    return Manuscript.objects.select_related(
        "workspace",
        "series_membership__series__workspace",
    )


def _manuscript_for_owner(manuscript_id: int, user) -> Manuscript | None:
    return _scope_queryset().filter(id=manuscript_id, workspace__owner=user).first()


def _seed_system_categories(glossary: Glossary) -> None:
    existing = set(
        GlossaryCategory.objects.filter(glossary=glossary)
        .exclude(system_key="")
        .values_list("system_key", flat=True)
    )
    GlossaryCategory.objects.bulk_create(
        [
            GlossaryCategory(
                glossary=glossary,
                system_key=key,
                name="",
                description="",
                icon=icon,
                position=(index + 1) * 1024,
            )
            for index, (key, icon) in enumerate(SYSTEM_CATEGORIES)
            if key not in existing
        ],
        ignore_conflicts=True,
    )


def resolve_glossary(manuscript_id: int, user, *, create: bool = True):
    manuscript = _manuscript_for_owner(manuscript_id, user)
    if manuscript is None:
        return None, None
    membership = getattr(manuscript, "series_membership", None)
    target = {"series": membership.series} if membership else {"manuscript": manuscript}
    glossary = (
        Glossary.objects.select_related("manuscript__workspace", "series__workspace")
        .filter(**target)
        .first()
    )
    if glossary is None and create:
        try:
            with transaction.atomic():
                glossary = Glossary.objects.create(**target)
                _seed_system_categories(glossary)
        except IntegrityError:
            glossary = Glossary.objects.select_related(
                "manuscript__workspace", "series__workspace"
            ).get(**target)
    elif glossary is not None and create:
        _seed_system_categories(glossary)
    return manuscript, glossary


def _category_queryset(glossary: Glossary):
    return GlossaryCategory.objects.filter(glossary=glossary).select_related(
        "glossary__manuscript__workspace",
        "glossary__series__workspace",
    )


def _article_queryset(glossary: Glossary):
    return (
        GlossaryArticle.objects.filter(glossary=glossary)
        .select_related(
            "glossary__manuscript__workspace",
            "glossary__series__workspace",
            "category__glossary__manuscript__workspace",
            "category__glossary__series__workspace",
        )
        .prefetch_related("assets", "aliases")
    )


def _custom_word_queryset(glossary: Glossary):
    return GlossaryCustomWord.objects.filter(glossary=glossary).select_related(
        "glossary__manuscript__workspace",
        "glossary__series__workspace",
    )


def _normalized_custom_word(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    word = unicodedata.normalize("NFC", value.strip())
    if not word or len(word) > CUSTOM_WORD_MAX_LENGTH or not CUSTOM_WORD_PATTERN.fullmatch(word):
        return None
    return word


def _custom_word_payload(custom_word: GlossaryCustomWord) -> dict:
    return {
        "id": str(custom_word.public_id),
        "word": custom_word.word,
        "createdAt": custom_word.created_at.isoformat(),
    }


def _normalized_article_alias(value: object) -> tuple[str, str] | None:
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFC", value)
    if any(
        unicodedata.category(character).startswith("C")
        or unicodedata.category(character) in {"Zl", "Zp"}
        for character in normalized
    ):
        return None
    name = " ".join(normalized.split())
    if not name or len(name) > ARTICLE_ALIAS_MAX_LENGTH:
        return None
    return name, name.casefold()


def _article_alias_payload(alias: GlossaryArticleAlias) -> dict:
    return {
        "id": str(alias.public_id),
        "name": alias.name,
        "createdAt": alias.created_at.isoformat(),
        "updatedAt": alias.updated_at.isoformat(),
    }


def category_payload(category: GlossaryCategory) -> dict:
    return {
        "id": str(category.public_id),
        "systemKey": category.system_key or None,
        "name": "" if category.system_key else category.name,
        "description": "" if category.system_key else category.description,
        "icon": category.icon,
        "position": category.position,
        "hidden": category.is_hidden,
        "articleCount": category.articles.count(),
        "createdAt": category.created_at.isoformat(),
        "updatedAt": category.updated_at.isoformat(),
    }


def _thumbnail(article: GlossaryArticle):
    return next(
        (asset for asset in article.assets.all() if asset.kind == GlossaryAsset.KIND_THUMBNAIL),
        None,
    )


def _cover(article: GlossaryArticle):
    return next(
        (asset for asset in article.assets.all() if asset.kind == GlossaryAsset.KIND_COVER),
        None,
    )


def _current_article_assets(article: GlossaryArticle) -> list[GlossaryAsset]:
    assets = list(article.assets.all())
    result = [
        asset
        for kind in (GlossaryAsset.KIND_THUMBNAIL, GlossaryAsset.KIND_COVER)
        for asset in assets
        if asset.kind == kind
    ]
    illustrations = {
        asset.public_id: asset
        for asset in assets
        if asset.kind == GlossaryAsset.KIND_ILLUSTRATION
    }
    result.extend(
        illustrations[asset_id]
        for asset_id in glossary_asset_ids_in_order(article.content)
        if asset_id in illustrations
    )
    return result


def article_payload(article: GlossaryArticle, manuscript_id: int, *, content=False) -> dict:
    thumbnail = _thumbnail(article)
    cover = _cover(article)
    payload = {
        "id": str(article.public_id),
        "categoryId": str(article.category.public_id),
        "title": article.title,
        "synopsis": article.synopsis,
        "favourite": article.is_favourite,
        "schemaVersion": article.schema_version,
        "saveGeneration": article.save_generation,
        "thumbnailUrl": (
            f"/api/manuscripts/{manuscript_id}/glossary/assets/{thumbnail.public_id}/medium/"
            if thumbnail
            else ""
        ),
        "coverUrl": (
            f"/api/manuscripts/{manuscript_id}/glossary/assets/{cover.public_id}/large/"
            if cover
            else ""
        ),
        "createdAt": article.created_at.isoformat(),
        "updatedAt": article.updated_at.isoformat(),
    }
    if content:
        payload["content"] = article.content
        payload["aliases"] = [
            _article_alias_payload(alias) for alias in article.aliases.all()
        ]
        payload["mediaCount"] = len(_current_article_assets(article))
        payload["links"] = [
            article_payload(link.target, manuscript_id)
            for link in article.outgoing_links.select_related(
                "target__category",
                "target__glossary__manuscript__workspace",
                "target__glossary__series__workspace",
            ).prefetch_related("target__assets")
        ]
    return payload


def glossary_asset_payload(asset: GlossaryAsset, manuscript_id: int) -> dict:
    prefix = f"/api/manuscripts/{manuscript_id}/glossary/assets/{asset.public_id}"
    return {
        "id": str(asset.public_id),
        "kind": asset.kind,
        "contentType": asset.content_type,
        "width": asset.width,
        "height": asset.height,
        "byteSize": asset.byte_size,
        "alt": asset.alt_text,
        "caption": asset.caption,
        "mediumUrl": f"{prefix}/medium/",
        "largeUrl": f"{prefix}/large/",
    }


def _delete_files(files: list[tuple[object, str]]) -> None:
    for storage, name in files:
        storage.delete(name)


def _delete_unused_user_media(media: UserMediaAsset) -> None:
    with transaction.atomic():
        locked = UserMediaAsset.objects.select_for_update().filter(id=media.id).first()
        if locked is None:
            return
        if (
            locked.manuscript_covers.exists()
            or locked.series_covers.exists()
            or locked.manuscript_attachments.exists()
            or locked.glossary_attachments.exists()
        ):
            return
        stored_files = [
            (field.storage, field.name)
            for field in (
                locked.original,
                locked.thumbnail_small,
                locked.thumbnail_medium,
                locked.editor_medium,
                locked.editor_large,
            )
            if field
        ]
        locked.delete()
        transaction.on_commit(lambda files=stored_files: _delete_files(files))


def _new_user_media_size(user, processed_items: list[ProcessedUserMedia]) -> int:
    unique_items = {item.content_hash: item for item in processed_items}
    existing_hashes = set(
        UserMediaAsset.objects.filter(
            owner=user,
            content_hash__in=unique_items,
        ).values_list("content_hash", flat=True)
    )
    return sum(
        processed_user_media_size(item)
        for content_hash, item in unique_items.items()
        if content_hash not in existing_hashes
    )


def _user_media_from_upload(
    *,
    user,
    uploaded_file,
    image_limit: int,
    replacing: int = 0,
) -> tuple[UserMediaAsset | None, bool, JsonResponse | None]:
    try:
        processed = process_user_media(uploaded_file, max_bytes=image_limit)
    except InvalidAsset as exc:
        error = "glossary_asset_too_large" if exc.code == "asset_too_large" else exc.code
        return None, False, JsonResponse({"error": error}, status=400)
    existing = UserMediaAsset.objects.filter(
        owner=user,
        content_hash=processed.content_hash,
    ).exists()
    storage_error = storage_quota_response(
        user,
        added=0 if existing else processed_user_media_size(processed),
        replacing=replacing,
    )
    if storage_error is not None:
        return None, False, storage_error
    media, created = create_or_get_user_media(user=user, processed=processed)
    return media, created, None


def _create_asset_from_media(
    *, article: GlossaryArticle, kind: str, media: UserMediaAsset, alt_text: str, caption: str
) -> GlossaryAsset:
    asset = GlossaryAsset(
        article=article,
        kind=kind,
        media=media,
        content_type=media.content_type,
        width=media.width,
        height=media.height,
        byte_size=media.byte_size,
    )
    asset.alt_text = alt_text
    asset.caption = caption
    asset.save()
    return asset


def _uuid(value: object, code: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError(code) from exc


def _positive_int(value: object, default: int, maximum: int | None = None) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    if result < 1:
        return default
    return min(result, maximum) if maximum is not None else result


def _first_letter(title: str) -> str:
    normalized = unicodedata.normalize("NFKC", title.strip())
    return normalized[0].upper() if normalized else ""


def _audit_glossary_asset(
    request,
    manuscript: Manuscript,
    article: GlossaryArticle,
    *,
    kind: str,
    action: str,
) -> None:
    write_audit_event(
        request,
        "manuscript.glossary_article_assets_updated",
        actor=request.user,
        subject=f"glossary-article:{article.public_id}",
        payload={
            "manuscriptId": str(manuscript.public_id),
            "kind": kind,
            "action": action,
        },
    )


def _audit_glossary_alias(
    request,
    manuscript: Manuscript,
    article: GlossaryArticle,
    alias_id: str,
    action: str,
) -> None:
    write_audit_event(
        request,
        "manuscript.glossary_article_metadata_updated",
        actor=request.user,
        subject=f"glossary-article:{article.public_id}",
        payload={
            "manuscriptId": str(manuscript.public_id),
            "changedFields": ["aliases"],
            "aliasId": alias_id,
            "aliasAction": action,
        },
    )


@require_GET
def glossary_context(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if manuscript is None or glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    categories = list(_category_queryset(glossary))
    return JsonResponse(
        {
            "glossary": {
                "scopeType": glossary.scope_type,
                "scopeId": str(
                    glossary.series.public_id
                    if glossary.series_id
                    else glossary.manuscript.public_id
                ),
                "seriesTitle": glossary.series.title if glossary.series_id else "",
                "categories": [category_payload(category) for category in categories],
            }
        }
    )


@require_http_methods(["GET"])
def spellcheck_lexicon(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    articles = list(
        GlossaryArticle.objects.filter(glossary=glossary).select_related(
            "glossary__manuscript__workspace",
            "glossary__series__workspace",
        ).prefetch_related("aliases")
    )
    custom_words = list(_custom_word_queryset(glossary))
    return JsonResponse(
        {
            "lexicon": {
                "scope": {
                    "type": glossary.scope_type,
                    "id": str(
                        glossary.series.public_id
                        if glossary.series_id
                        else glossary.manuscript.public_id
                    ),
                },
                "revision": str(glossary.spellcheck_revision),
                "customWords": [_custom_word_payload(item) for item in custom_words],
                "glossaryTerms": [
                    term
                    for article in articles
                    for term in [article.title, *(alias.name for alias in article.aliases.all())]
                ],
            }
        }
    )


@require_http_methods(["POST"])
def spellcheck_custom_words(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    if set(payload) != {"word"}:
        return JsonResponse({"error": "spellcheck_word_invalid"}, status=400)
    word = _normalized_custom_word(payload.get("word"))
    if word is None:
        return JsonResponse({"error": "spellcheck_word_invalid"}, status=400)
    normalized = word.casefold()
    with transaction.atomic():
        Glossary.objects.select_for_update().get(id=glossary.id)
        existing_words = list(_custom_word_queryset(glossary))
        for existing in existing_words:
            if unicodedata.normalize("NFC", existing.word).casefold() == normalized:
                return JsonResponse({"word": _custom_word_payload(existing)})
        if len(existing_words) >= MAX_CUSTOM_WORDS:
            return JsonResponse({"error": "spellcheck_word_limit_reached"}, status=400)
        custom_word = GlossaryCustomWord(glossary=glossary)
        custom_word.word = word
        custom_word.save()
        Glossary.objects.filter(id=glossary.id).update(
            spellcheck_revision=F("spellcheck_revision") + 1
        )
    return JsonResponse({"word": _custom_word_payload(custom_word)}, status=201)


@require_http_methods(["DELETE"])
def spellcheck_custom_word_detail(request, manuscript_id: int, word_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    custom_word = _custom_word_queryset(glossary).filter(public_id=word_id).first()
    if custom_word is None:
        return JsonResponse({"error": "spellcheck_word_not_found"}, status=404)
    with transaction.atomic():
        custom_word.delete()
        Glossary.objects.filter(id=glossary.id).update(
            spellcheck_revision=F("spellcheck_revision") + 1
        )
    return JsonResponse({"deleted": True})


@require_http_methods(["POST"])
def glossary_categories(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    name = str(payload.get("name") or "").strip()
    description = str(payload.get("description") or "").strip()
    icon = str(payload.get("icon") or "")
    if not name or len(name) > CATEGORY_NAME_MAX_LENGTH:
        return JsonResponse({"error": "glossary_category_name_invalid"}, status=400)
    if len(description) > CATEGORY_DESCRIPTION_MAX_LENGTH:
        return JsonResponse({"error": "glossary_category_description_too_long"}, status=400)
    if icon not in CUSTOM_ICON_IDS:
        return JsonResponse({"error": "glossary_category_icon_invalid"}, status=400)
    categories = list(_category_queryset(glossary).filter(system_key=""))
    if len(categories) >= MAX_CUSTOM_CATEGORIES:
        return JsonResponse({"error": "glossary_category_limit_reached"}, status=400)
    if any(category.name.casefold() == name.casefold() for category in categories):
        return JsonResponse({"error": "glossary_category_name_duplicate"}, status=400)
    position = (
        max(
            _category_queryset(glossary).values_list("position", flat=True),
            default=0,
        )
        + 1024
    )
    category = GlossaryCategory(
        glossary=glossary,
        icon=icon,
        position=position,
    )
    category.name = name
    category.description = description
    category.save()
    write_audit_event(
        request,
        "manuscript.glossary_category_created",
        actor=request.user,
        subject=f"glossary-category:{category.public_id}",
        payload={"manuscriptId": str(manuscript.public_id)},
    )
    return JsonResponse({"category": category_payload(category)}, status=201)


@require_http_methods(["PATCH", "DELETE"])
def glossary_category_detail(request, manuscript_id: int, category_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    category = _category_queryset(glossary).filter(public_id=category_id).first()
    if category is None:
        return JsonResponse({"error": "glossary_category_not_found"}, status=404)
    if request.method == "DELETE":
        if category.system_key:
            return JsonResponse({"error": "glossary_system_category_immutable"}, status=400)
        if category.articles.exists():
            return JsonResponse({"error": "glossary_category_not_empty"}, status=409)
        category_public_id = str(category.public_id)
        category.delete()
        write_audit_event(
            request,
            "manuscript.glossary_category_deleted",
            actor=request.user,
            subject=f"glossary-category:{category_public_id}",
            payload={"manuscriptId": str(_manuscript.public_id)},
        )
        return JsonResponse({"deleted": True})

    payload = _read_json(request)
    if payload is None or not payload:
        return JsonResponse({"error": "invalid_json"}, status=400)
    if category.system_key:
        if set(payload) != {"hidden"} or not isinstance(payload["hidden"], bool):
            return JsonResponse({"error": "glossary_system_category_immutable"}, status=400)
        category.is_hidden = payload["hidden"]
        category.save(update_fields=["is_hidden", "updated_at"])
        return JsonResponse({"category": category_payload(category)})

    if not set(payload).issubset({"name", "description", "icon"}):
        return JsonResponse({"error": "glossary_category_update_invalid"}, status=400)
    name = str(payload.get("name", category.name) or "").strip()
    description = str(payload.get("description", category.description) or "").strip()
    icon = str(payload.get("icon", category.icon) or "")
    if not name or len(name) > CATEGORY_NAME_MAX_LENGTH:
        return JsonResponse({"error": "glossary_category_name_invalid"}, status=400)
    if len(description) > CATEGORY_DESCRIPTION_MAX_LENGTH:
        return JsonResponse({"error": "glossary_category_description_too_long"}, status=400)
    if icon not in CUSTOM_ICON_IDS:
        return JsonResponse({"error": "glossary_category_icon_invalid"}, status=400)
    siblings = _category_queryset(glossary).filter(system_key="").exclude(id=category.id)
    if any(sibling.name.casefold() == name.casefold() for sibling in siblings):
        return JsonResponse({"error": "glossary_category_name_duplicate"}, status=400)
    changed_fields = [
        field
        for field, old_value, new_value in (
            ("name", category.name, name),
            ("description", category.description, description),
            ("icon", category.icon, icon),
        )
        if old_value != new_value
    ]
    category.name = name
    category.description = description
    category.icon = icon
    category.save(update_fields=["name", "description", "icon", "updated_at"])
    if changed_fields:
        write_audit_event(
            request,
            "manuscript.glossary_category_updated",
            actor=request.user,
            subject=f"glossary-category:{category.public_id}",
            payload={
                "manuscriptId": str(_manuscript.public_id),
                "changedFields": changed_fields,
            },
        )
    return JsonResponse({"category": category_payload(category)})


@require_http_methods(["GET", "POST"])
def glossary_articles(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    if request.method == "POST":
        title = request.POST.get("title", "").strip()
        synopsis = request.POST.get("synopsis", "").strip()
        try:
            category_id = _uuid(request.POST.get("categoryId"), "glossary_category_id_invalid")
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        category = _category_queryset(glossary).filter(public_id=category_id).first()
        if category is None:
            return JsonResponse({"error": "glossary_category_not_found"}, status=404)
        if not title or len(title) > ARTICLE_TITLE_MAX_LENGTH:
            return JsonResponse({"error": "glossary_article_title_invalid"}, status=400)
        if len(synopsis) > ARTICLE_SYNOPSIS_MAX_LENGTH:
            return JsonResponse({"error": "glossary_article_synopsis_too_long"}, status=400)
        import_files = request.FILES.getlist("importFile")
        if len(import_files) > 1:
            return JsonResponse(
                {"error": "glossary_import_file_count_invalid"},
                status=400,
            )
        try:
            article_content = (
                imported_glossary_content(import_files[0])
                if import_files
                else GlossaryArticle.EMPTY_CONTENT
            )
        except InvalidGlossaryImport as exc:
            return JsonResponse({"error": exc.code}, status=400)
        thumbnail = request.FILES.get("thumbnail")
        cover = request.FILES.get("cover")
        thumbnail_media_id = request.POST.get("thumbnailMediaId", "").strip()
        cover_media_id = request.POST.get("coverMediaId", "").strip()
        if (thumbnail and thumbnail_media_id) or (cover and cover_media_id):
            return JsonResponse({"error": "glossary_asset_update_invalid"}, status=400)
        thumbnail_media = (
            UserMediaAsset.objects.filter(public_id=thumbnail_media_id, owner=request.user).first()
            if thumbnail_media_id
            else None
        )
        cover_media = (
            UserMediaAsset.objects.filter(public_id=cover_media_id, owner=request.user).first()
            if cover_media_id
            else None
        )
        if (thumbnail_media_id and thumbnail_media is None) or (
            cover_media_id and cover_media is None
        ):
            return JsonResponse({"error": "storage_item_not_found"}, status=404)
        image_limit = image_upload_limit(request.user)
        for uploaded in (thumbnail, cover):
            if uploaded is not None and uploaded.size > image_limit:
                return image_size_response(request.user, used=uploaded.size, limit=image_limit)
        try:
            processed_thumbnail = (
                process_user_media(thumbnail, max_bytes=image_limit)
                if thumbnail is not None
                else None
            )
            processed_cover = (
                process_user_media(cover, max_bytes=image_limit) if cover is not None else None
            )
        except InvalidAsset as exc:
            return JsonResponse(
                {
                    "error": (
                        "glossary_asset_too_large" if exc.code == "asset_too_large" else exc.code
                    )
                },
                status=400,
            )
        storage_error = storage_quota_response(
            request.user,
            added=_new_user_media_size(
                request.user,
                [item for item in (processed_thumbnail, processed_cover) if item is not None],
            ),
        )
        if storage_error is not None:
            return storage_error
        created_media: list[UserMediaAsset] = []
        try:
            if processed_thumbnail is not None:
                thumbnail_media, created = create_or_get_user_media(
                    user=request.user,
                    processed=processed_thumbnail,
                )
                if created:
                    created_media.append(thumbnail_media)
            if processed_cover is not None:
                cover_media, created = create_or_get_user_media(
                    user=request.user,
                    processed=processed_cover,
                )
                if created:
                    created_media.append(cover_media)
            with transaction.atomic():
                article = GlossaryArticle(
                    glossary=glossary,
                    category=category,
                )
                article.title = title
                article.synopsis = synopsis
                article.content = article_content
                article.save()
                if thumbnail_media is not None:
                    _create_asset_from_media(
                        article=article,
                        kind=GlossaryAsset.KIND_THUMBNAIL,
                        media=thumbnail_media,
                        alt_text=title,
                        caption="",
                    )
                if cover_media is not None:
                    _create_asset_from_media(
                        article=article,
                        kind=GlossaryAsset.KIND_COVER,
                        media=cover_media,
                        alt_text=title,
                        caption="",
                    )
                Glossary.objects.filter(id=glossary.id).update(
                    spellcheck_revision=F("spellcheck_revision") + 1
                )
        except Exception:
            for media in created_media:
                _delete_unused_user_media(media)
            raise
        article = _article_queryset(glossary).get(id=article.id)
        write_audit_event(
            request,
            "manuscript.glossary_article_created",
            actor=request.user,
            subject=f"glossary-article:{article.public_id}",
            payload={
                "manuscriptId": str(_manuscript.public_id),
                "assetKinds": list(article.assets.values_list("kind", flat=True)),
                "imported": bool(import_files),
            },
        )
        return JsonResponse(
            {"article": article_payload(article, manuscript_id, content=True)},
            status=201,
        )

    articles = list(_article_queryset(glossary))
    category_id = request.GET.get("categoryId", "").strip()
    if category_id:
        try:
            selected_category_id = _uuid(category_id, "glossary_category_id_invalid")
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        articles = [
            article for article in articles if article.category.public_id == selected_category_id
        ]
    view = request.GET.get("view", "all")
    if view == "favourites":
        articles = [article for article in articles if article.is_favourite]
    elif view not in {"all", "recent"}:
        return JsonResponse({"error": "glossary_view_invalid"}, status=400)
    linked_document_id = request.GET.get("linkedDocumentId", "").strip()
    if linked_document_id:
        document = _document_for_context(glossary, manuscript_id, linked_document_id)
        if document is None:
            return JsonResponse({"error": "glossary_document_not_found"}, status=404)
        linked_ids = set(
            DocumentGlossaryAssociation.objects.filter(
                document=document,
                article__glossary=glossary,
            ).values_list("article_id", flat=True)
        )
        articles = [article for article in articles if article.id in linked_ids]
    search = request.GET.get("search", "").strip().casefold()
    if search:
        articles = [
            article
            for article in articles
            if search in article.title.casefold() or search in article.synopsis.casefold()
        ]
    initials = sorted(
        {_first_letter(article.title) for article in articles if _first_letter(article.title)},
        key=str.casefold,
    )
    initial = request.GET.get("initial", "").strip().upper()
    if initial:
        articles = [article for article in articles if _first_letter(article.title) == initial]
    sort = request.GET.get("sort", "az")
    if view == "recent" and "sort" not in request.GET:
        sort = "updated-desc"
    if sort == "az":
        articles.sort(key=lambda article: article.title.casefold())
    elif sort == "za":
        articles.sort(key=lambda article: article.title.casefold(), reverse=True)
    elif sort == "updated-desc":
        articles.sort(key=lambda article: article.updated_at, reverse=True)
    elif sort == "updated-asc":
        articles.sort(key=lambda article: article.updated_at)
    else:
        return JsonResponse({"error": "glossary_sort_invalid"}, status=400)
    total = len(articles)
    page = _positive_int(request.GET.get("page"), 1)
    page_size = _positive_int(request.GET.get("pageSize"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    start = (page - 1) * page_size
    page_items = articles[start : start + page_size]
    return JsonResponse(
        {
            "items": [article_payload(article, manuscript_id) for article in page_items],
            "total": total,
            "page": page,
            "pageSize": page_size,
            "initials": initials,
        }
    )


@require_http_methods(["GET", "PATCH", "DELETE"])
def glossary_article_detail(request, manuscript_id: int, article_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    article = _article_queryset(glossary).filter(public_id=article_id).first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    if request.method == "GET":
        return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})
    if request.method == "DELETE":
        incoming = list(
            article.incoming_links.select_related(
                "source__glossary__manuscript__workspace",
                "source__glossary__series__workspace",
            )
        )
        if incoming:
            return JsonResponse(
                {
                    "error": "glossary_article_referenced",
                    "references": [
                        {"id": str(link.source.public_id), "title": link.source.title}
                        for link in incoming
                    ],
                },
                status=409,
            )
        article_public_id = str(article.public_id)
        try:
            with transaction.atomic():
                article.delete()
                Glossary.objects.filter(id=glossary.id).update(
                    spellcheck_revision=F("spellcheck_revision") + 1
                )
        except RestrictedError:
            return JsonResponse({"error": "glossary_article_referenced"}, status=409)
        write_audit_event(
            request,
            "manuscript.glossary_article_deleted",
            actor=request.user,
            subject=f"glossary-article:{article_public_id}",
            payload={"manuscriptId": str(_manuscript.public_id)},
        )
        return JsonResponse({"deleted": True})

    payload = _read_json(request)
    if (
        payload is None
        or not payload
        or not set(payload).issubset({"title", "synopsis", "categoryId", "favourite"})
    ):
        return JsonResponse({"error": "glossary_article_update_invalid"}, status=400)
    title = str(payload.get("title", article.title) or "").strip()
    synopsis = str(payload.get("synopsis", article.synopsis) or "").strip()
    if not title or len(title) > ARTICLE_TITLE_MAX_LENGTH:
        return JsonResponse({"error": "glossary_article_title_invalid"}, status=400)
    if len(synopsis) > ARTICLE_SYNOPSIS_MAX_LENGTH:
        return JsonResponse({"error": "glossary_article_synopsis_too_long"}, status=400)
    category = article.category
    if "categoryId" in payload:
        try:
            category_id = _uuid(payload["categoryId"], "glossary_category_id_invalid")
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        category = _category_queryset(glossary).filter(public_id=category_id).first()
        if category is None:
            return JsonResponse({"error": "glossary_category_not_found"}, status=404)
    favourite = payload.get("favourite", article.is_favourite)
    if not isinstance(favourite, bool):
        return JsonResponse({"error": "glossary_article_favourite_invalid"}, status=400)
    changed_fields = [
        field
        for field, old_value, new_value in (
            ("title", article.title, title),
            ("synopsis", article.synopsis, synopsis),
            ("category", article.category_id, category.id),
            ("favourite", article.is_favourite, favourite),
        )
        if old_value != new_value
    ]
    article.title = title
    article.synopsis = synopsis
    article.category = category
    article.is_favourite = favourite
    article.save(
        update_fields=[
            "title",
            "synopsis",
            "category",
            "is_favourite",
            "updated_at",
        ]
    )
    if "title" in changed_fields:
        Glossary.objects.filter(id=glossary.id).update(
            spellcheck_revision=F("spellcheck_revision") + 1
        )
    article = _article_queryset(glossary).get(id=article.id)
    if changed_fields:
        write_audit_event(
            request,
            "manuscript.glossary_article_metadata_updated",
            actor=request.user,
            subject=f"glossary-article:{article.public_id}",
            payload={
                "manuscriptId": str(_manuscript.public_id),
                "changedFields": changed_fields,
            },
        )
    return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})


@require_http_methods(["POST"])
def glossary_article_aliases(request, manuscript_id: int, article_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript, glossary = resolve_glossary(manuscript_id, request.user, create=False)
    if manuscript is None or glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    article = _article_queryset(glossary).filter(public_id=article_id).first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None or set(payload) != {"name"}:
        return JsonResponse({"error": "alias_invalid"}, status=400)
    alias_value = _normalized_article_alias(payload.get("name"))
    if alias_value is None:
        return JsonResponse({"error": "alias_invalid"}, status=400)
    name, normalized_name = alias_value
    with transaction.atomic():
        locked_article = GlossaryArticle.objects.select_for_update().get(id=article.id)
        if locked_article.aliases.filter(normalized_name=normalized_name).exists():
            return JsonResponse({"error": "alias_duplicate"}, status=409)
        alias = GlossaryArticleAlias.objects.create(
            article=locked_article,
            name=name,
            normalized_name=normalized_name,
        )
        Glossary.objects.filter(id=glossary.id).update(
            spellcheck_revision=F("spellcheck_revision") + 1
        )
    _audit_glossary_alias(request, manuscript, article, str(alias.public_id), "added")
    return JsonResponse({"alias": _article_alias_payload(alias)}, status=201)


@require_http_methods(["PATCH", "DELETE"])
def glossary_article_alias_detail(request, manuscript_id: int, article_id, alias_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript, glossary = resolve_glossary(manuscript_id, request.user, create=False)
    if manuscript is None or glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    article = _article_queryset(glossary).filter(public_id=article_id).first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    alias = article.aliases.filter(public_id=alias_id).first()
    if alias is None:
        return JsonResponse({"error": "alias_not_found"}, status=404)

    if request.method == "DELETE":
        alias_public_id = str(alias.public_id)
        with transaction.atomic():
            GlossaryArticle.objects.select_for_update().get(id=article.id)
            locked_alias = GlossaryArticleAlias.objects.select_for_update().filter(
                id=alias.id,
                article=article,
            ).first()
            if locked_alias is None:
                return JsonResponse({"error": "alias_not_found"}, status=404)
            locked_alias.delete()
            Glossary.objects.filter(id=glossary.id).update(
                spellcheck_revision=F("spellcheck_revision") + 1
            )
        _audit_glossary_alias(request, manuscript, article, alias_public_id, "deleted")
        return JsonResponse({"deleted": True})

    payload = _read_json(request)
    if payload is None or set(payload) != {"name"}:
        return JsonResponse({"error": "alias_invalid"}, status=400)
    alias_value = _normalized_article_alias(payload.get("name"))
    if alias_value is None:
        return JsonResponse({"error": "alias_invalid"}, status=400)
    name, normalized_name = alias_value
    if alias.name == name:
        return JsonResponse({"alias": _article_alias_payload(alias)})
    with transaction.atomic():
        GlossaryArticle.objects.select_for_update().get(id=article.id)
        if article.aliases.exclude(id=alias.id).filter(
            normalized_name=normalized_name
        ).exists():
            return JsonResponse({"error": "alias_duplicate"}, status=409)
        alias = GlossaryArticleAlias.objects.select_for_update().get(
            id=alias.id,
            article=article,
        )
        alias.name = name
        alias.normalized_name = normalized_name
        alias.save(update_fields=["name", "normalized_name", "updated_at"])
        Glossary.objects.filter(id=glossary.id).update(
            spellcheck_revision=F("spellcheck_revision") + 1
        )
    _audit_glossary_alias(request, manuscript, article, str(alias.public_id), "updated")
    return JsonResponse({"alias": _article_alias_payload(alias)})


@require_http_methods(["POST"])
def glossary_article_export(request, manuscript_id: int, article_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript, glossary = resolve_glossary(manuscript_id, request.user, create=False)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    article = _article_queryset(glossary).filter(public_id=article_id).first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None or set(payload) != {"format"}:
        return JsonResponse({"error": "glossary_export_format_invalid"}, status=400)
    export_format = payload.get("format")
    if not isinstance(export_format, str):
        return JsonResponse({"error": "glossary_export_format_invalid"}, status=400)
    try:
        build = build_glossary_export(article, export_format)
    except GlossaryExportError as exc:
        status = 413 if exc.code == "glossary_export_too_large" else 400
        return JsonResponse({"error": exc.code}, status=status)
    except Exception:
        logger.exception("Glossary article export build failed article=%s", article.public_id)
        return JsonResponse({"error": "glossary_export_build_failed"}, status=500)
    try:
        write_audit_event(
            request,
            "manuscript.glossary_article_exported",
            actor=request.user,
            subject=f"glossary-article:{article.public_id}",
            payload={
                "manuscriptId": str(manuscript.public_id),
                "articleId": str(article.public_id),
                "format": export_format,
            },
        )
    except Exception:
        build.file.close()
        logger.exception("Glossary article export audit failed article=%s", article.public_id)
        return JsonResponse({"error": "glossary_export_build_failed"}, status=500)
    response = FileResponse(build.file, content_type="application/zip")
    response["Content-Disposition"] = content_disposition(
        build.file_name,
        fallback="glossary-article",
    )
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


@require_http_methods(["PUT"])
def glossary_article_content(request, manuscript_id: int, article_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    expected_generation = payload.get("expectedGeneration")
    if isinstance(expected_generation, bool) or not isinstance(expected_generation, int):
        return JsonResponse({"error": "save_generation_required"}, status=400)
    if payload.get("schemaVersion") != GlossaryArticle.CURRENT_SCHEMA_VERSION:
        return JsonResponse({"error": "glossary_schema_unsupported"}, status=400)
    try:
        content = validate_glossary_content(payload.get("content"))
    except InvalidGlossaryContent as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    asset_ids = glossary_asset_ids(content)
    target_ids = glossary_article_links(content)
    article_query = _article_queryset(glossary).filter(public_id=article_id)
    article = article_query.first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    if asset_ids and GlossaryAsset.objects.filter(
        article=article,
        kind=GlossaryAsset.KIND_ILLUSTRATION,
        public_id__in=asset_ids,
    ).count() != len(asset_ids):
        return JsonResponse({"error": "glossary_asset_not_found"}, status=400)
    if article.public_id in target_ids:
        return JsonResponse({"error": "glossary_internal_link_self"}, status=400)
    targets = list(_article_queryset(glossary).filter(public_id__in=target_ids))
    if len(targets) != len(target_ids):
        return JsonResponse({"error": "glossary_link_target_not_found"}, status=400)
    target_by_public_id = {target.public_id: target for target in targets}
    with transaction.atomic():
        article = article_query.select_for_update(of=("self",)).first()
        if article is None:
            return JsonResponse({"error": "glossary_article_not_found"}, status=404)
        if article.save_generation != expected_generation:
            return JsonResponse(
                {
                    "error": "glossary_save_conflict",
                    "saveGeneration": article.save_generation,
                },
                status=409,
            )
        content_changed = article.content != content
        if content_changed:
            article.content = content
            article.save_generation += 1
            article.save(update_fields=["content", "save_generation", "updated_at"])
        article.outgoing_links.all().delete()
        GlossaryArticleLink.objects.bulk_create(
            [
                GlossaryArticleLink(
                    source=article,
                    target=target_by_public_id[target_id],
                    position=position,
                )
                for position, target_id in enumerate(target_ids)
            ]
        )
        if content_changed:
            record_tier_activity(request.user)
    article = _article_queryset(glossary).get(id=article.id)
    return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})


@require_http_methods(["POST", "DELETE"])
def glossary_article_thumbnail(request, manuscript_id: int, article_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    article = _article_queryset(glossary).filter(public_id=article_id).first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    current = GlossaryAsset.objects.filter(
        article=article,
        kind=GlossaryAsset.KIND_THUMBNAIL,
    ).first()
    if request.method == "DELETE":
        if current:
            current.delete()
            article.updated_at = timezone.now()
            article.save(update_fields=["updated_at"])
            _audit_glossary_asset(
                request,
                _manuscript,
                article,
                kind=GlossaryAsset.KIND_THUMBNAIL,
                action="removed",
            )
        article = _article_queryset(glossary).get(id=article.id)
        return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})
    media_id = request.POST.get("mediaId", "").strip()
    if media_id:
        media = UserMediaAsset.objects.filter(public_id=media_id, owner=request.user).first()
        if media is None:
            return JsonResponse({"error": "storage_item_not_found"}, status=404)
        replacement = _create_asset_from_media(
            article=article,
            kind=GlossaryAsset.KIND_ILLUSTRATION
            if current is not None
            else GlossaryAsset.KIND_THUMBNAIL,
            media=media,
            alt_text=article.title,
            caption="",
        )
        if current is not None:
            with transaction.atomic():
                current.delete()
                replacement.kind = GlossaryAsset.KIND_THUMBNAIL
                replacement.save(update_fields=["kind", "updated_at"])
        article.updated_at = timezone.now()
        article.save(update_fields=["updated_at"])
        _audit_glossary_asset(
            request,
            _manuscript,
            article,
            kind=GlossaryAsset.KIND_THUMBNAIL,
            action="replaced" if current is not None else "added",
        )
        article = _article_queryset(glossary).get(id=article.id)
        return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})
    uploaded_file = request.FILES.get("thumbnail")
    if uploaded_file is None:
        return JsonResponse({"error": "asset_image_required"}, status=400)
    image_limit = image_upload_limit(request.user)
    if uploaded_file.size > image_limit:
        return image_size_response(request.user, used=uploaded_file.size, limit=image_limit)
    media, created, media_error = _user_media_from_upload(
        user=request.user,
        uploaded_file=uploaded_file,
        image_limit=image_limit,
        replacing=0,
    )
    if media_error is not None:
        return media_error
    assert media is not None
    replacement_kind = (
        GlossaryAsset.KIND_ILLUSTRATION if current is not None else GlossaryAsset.KIND_THUMBNAIL
    )
    try:
        with transaction.atomic():
            replacement = _create_asset_from_media(
                article=article,
                kind=replacement_kind,
                media=media,
                alt_text=article.title,
                caption="",
            )
            if current is not None:
                current.delete()
                replacement.kind = GlossaryAsset.KIND_THUMBNAIL
                replacement.save(update_fields=["kind", "updated_at"])
    except Exception:
        if created:
            _delete_unused_user_media(media)
        raise
    article.updated_at = timezone.now()
    article.save(update_fields=["updated_at"])
    _audit_glossary_asset(
        request,
        _manuscript,
        article,
        kind=GlossaryAsset.KIND_THUMBNAIL,
        action="replaced" if current is not None else "added",
    )
    article = _article_queryset(glossary).get(id=article.id)
    return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})


@require_http_methods(["POST", "DELETE"])
def glossary_article_cover(request, manuscript_id: int, article_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    article = _article_queryset(glossary).filter(public_id=article_id).first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    current = GlossaryAsset.objects.filter(
        article=article,
        kind=GlossaryAsset.KIND_COVER,
    ).first()
    if request.method == "DELETE":
        if current:
            current.delete()
            article.updated_at = timezone.now()
            article.save(update_fields=["updated_at"])
            _audit_glossary_asset(
                request,
                _manuscript,
                article,
                kind=GlossaryAsset.KIND_COVER,
                action="removed",
            )
        article = _article_queryset(glossary).get(id=article.id)
        return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})
    media_id = request.POST.get("mediaId", "").strip()
    if media_id:
        media = UserMediaAsset.objects.filter(public_id=media_id, owner=request.user).first()
        if media is None:
            return JsonResponse({"error": "storage_item_not_found"}, status=404)
        replacement = _create_asset_from_media(
            article=article,
            kind=GlossaryAsset.KIND_ILLUSTRATION
            if current is not None
            else GlossaryAsset.KIND_COVER,
            media=media,
            alt_text=article.title,
            caption="",
        )
        if current is not None:
            with transaction.atomic():
                current.delete()
                replacement.kind = GlossaryAsset.KIND_COVER
                replacement.save(update_fields=["kind", "updated_at"])
        article.updated_at = timezone.now()
        article.save(update_fields=["updated_at"])
        _audit_glossary_asset(
            request,
            _manuscript,
            article,
            kind=GlossaryAsset.KIND_COVER,
            action="replaced" if current is not None else "added",
        )
        article = _article_queryset(glossary).get(id=article.id)
        return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})
    uploaded_file = request.FILES.get("cover")
    if uploaded_file is None:
        return JsonResponse({"error": "asset_image_required"}, status=400)
    image_limit = image_upload_limit(request.user)
    if uploaded_file.size > image_limit:
        return image_size_response(request.user, used=uploaded_file.size, limit=image_limit)
    media, created, media_error = _user_media_from_upload(
        user=request.user,
        uploaded_file=uploaded_file,
        image_limit=image_limit,
        replacing=0,
    )
    if media_error is not None:
        return media_error
    assert media is not None
    replacement_kind = (
        GlossaryAsset.KIND_ILLUSTRATION if current is not None else GlossaryAsset.KIND_COVER
    )
    try:
        with transaction.atomic():
            replacement = _create_asset_from_media(
                article=article,
                kind=replacement_kind,
                media=media,
                alt_text=article.title,
                caption="",
            )
            if current is not None:
                current.delete()
                replacement.kind = GlossaryAsset.KIND_COVER
                replacement.save(update_fields=["kind", "updated_at"])
    except Exception:
        if created:
            _delete_unused_user_media(media)
        raise
    article.updated_at = timezone.now()
    article.save(update_fields=["updated_at"])
    _audit_glossary_asset(
        request,
        _manuscript,
        article,
        kind=GlossaryAsset.KIND_COVER,
        action="replaced" if current is not None else "added",
    )
    article = _article_queryset(glossary).get(id=article.id)
    return JsonResponse({"article": article_payload(article, manuscript_id, content=True)})


@require_http_methods(["GET", "POST"])
def glossary_article_assets(request, manuscript_id: int, article_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    article = _article_queryset(glossary).filter(public_id=article_id).first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    if request.method == "GET":
        return JsonResponse(
            {
                "assets": [
                    glossary_asset_payload(asset, manuscript_id)
                    for asset in _current_article_assets(article)
                ]
            }
        )
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
            return JsonResponse(
                {
                    "error": "glossary_asset_too_large"
                    if exc.code == "asset_too_large"
                    else exc.code
                },
                status=400,
            )
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
    asset = _create_asset_from_media(
        article=article,
        kind=GlossaryAsset.KIND_ILLUSTRATION,
        media=media,
        alt_text=alt_text,
        caption=caption,
    )
    _audit_glossary_asset(
        request,
        _manuscript,
        article,
        kind=GlossaryAsset.KIND_ILLUSTRATION,
        action="added",
    )
    return JsonResponse(
        {"asset": glossary_asset_payload(asset, manuscript_id)},
        status=201,
    )


@require_http_methods(["PATCH"])
def glossary_asset_detail(request, manuscript_id: int, asset_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user, create=False)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    asset = (
        GlossaryAsset.objects.filter(public_id=asset_id, article__glossary=glossary)
        .select_related(
            "article__glossary__manuscript__workspace",
            "article__glossary__series__workspace",
        )
        .first()
    )
    if asset is None:
        return JsonResponse({"error": "glossary_asset_not_found"}, status=404)
    try:
        payload = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "invalid_json"}, status=400)
    if (
        not isinstance(payload, dict)
        or not payload
        or not set(payload).issubset({"alt", "caption"})
    ):
        return JsonResponse({"error": "glossary_asset_update_invalid"}, status=400)
    update_fields = []
    changed_fields = []
    for payload_name, model_name, max_length in (
        ("alt", "alt_text", ASSET_ALT_MAX_LENGTH),
        ("caption", "caption", ASSET_CAPTION_MAX_LENGTH),
    ):
        if payload_name not in payload:
            continue
        value = payload[payload_name]
        if not isinstance(value, str) or len(value.strip()) > max_length:
            return JsonResponse({"error": f"asset_{payload_name}_too_long"}, status=400)
        if getattr(asset, model_name) != value.strip():
            changed_fields.append(payload_name)
        setattr(asset, model_name, value.strip())
        update_fields.append(model_name)
    if not update_fields:
        return JsonResponse({"error": "glossary_asset_update_invalid"}, status=400)
    asset.save(update_fields=[*update_fields, "updated_at"])
    if changed_fields:
        write_audit_event(
            request,
            "manuscript.glossary_article_assets_updated",
            actor=request.user,
            subject=f"glossary-article:{asset.article.public_id}",
            payload={
                "manuscriptId": str(_manuscript.public_id),
                "kind": asset.kind,
                "action": "metadata_updated",
                "changedFields": changed_fields,
            },
        )
    return JsonResponse({"asset": glossary_asset_payload(asset, manuscript_id)})


@require_GET
def glossary_asset_content(request, manuscript_id: int, asset_id, variant: str):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    _manuscript, glossary = resolve_glossary(manuscript_id, request.user, create=False)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    asset = (
        GlossaryAsset.objects.filter(
            public_id=asset_id,
            article__glossary=glossary,
        )
        .select_related(
            "article__glossary__manuscript__workspace",
            "article__glossary__series__workspace",
            "media__owner",
        )
        .first()
    )
    if asset is None:
        return JsonResponse({"error": "glossary_asset_not_found"}, status=404)
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


def _document_for_context(
    glossary: Glossary,
    manuscript_id: int,
    document_item_id: object,
) -> Document | None:
    query = Document.objects.filter(manuscript_id=manuscript_id).select_related(
        "manuscript__workspace"
    )
    if document_item_id:
        try:
            item_id = uuid.UUID(str(document_item_id))
        except (ValueError, TypeError, AttributeError):
            return None
        query = query.filter(item__public_id=item_id, item__trashed_at__isnull=True)
    else:
        query = query.filter(manuscript__kind=Manuscript.KIND_ONESHOT)
    document = query.first()
    if document is None:
        return None
    active_manuscript, active_glossary = resolve_glossary(
        manuscript_id,
        document.manuscript.workspace.owner,
        create=False,
    )
    if active_manuscript is None or active_glossary is None or active_glossary.id != glossary.id:
        return None
    return document


@require_http_methods(["GET", "POST", "DELETE"])
def glossary_associations(request, manuscript_id: int):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    manuscript, glossary = resolve_glossary(manuscript_id, request.user)
    if glossary is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)
    payload = _read_json(request) if request.method != "GET" else None
    document_item_id = (
        request.GET.get("documentItemId")
        if request.method == "GET"
        else (payload or {}).get("documentItemId")
    )
    document = _document_for_context(glossary, manuscript_id, document_item_id)
    if document is None:
        return JsonResponse({"error": "glossary_document_not_found"}, status=404)
    if request.method == "GET":
        article_ids = DocumentGlossaryAssociation.objects.filter(
            document=document,
            article__glossary=glossary,
        ).values_list("article__public_id", flat=True)
        return JsonResponse({"articleIds": [str(article_id) for article_id in article_ids]})
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)
    try:
        article_id = _uuid(payload.get("articleId"), "glossary_article_id_invalid")
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    article = _article_queryset(glossary).filter(public_id=article_id).first()
    if article is None:
        return JsonResponse({"error": "glossary_article_not_found"}, status=404)
    if request.method == "DELETE":
        deleted, _details = DocumentGlossaryAssociation.objects.filter(
            document=document,
            article=article,
        ).delete()
        if deleted:
            write_audit_event(
                request,
                "manuscript.glossary_article_unlinked",
                actor=request.user,
                subject=f"glossary-article:{article.public_id}",
                payload={
                    "manuscriptId": str(manuscript.public_id),
                    "documentId": str(document.public_id),
                },
            )
        return JsonResponse({"linked": False})
    _association, created = DocumentGlossaryAssociation.objects.get_or_create(
        document=document,
        article=article,
    )
    if created:
        write_audit_event(
            request,
            "manuscript.glossary_article_linked",
            actor=request.user,
            subject=f"glossary-article:{article.public_id}",
            payload={
                "manuscriptId": str(manuscript.public_id),
                "documentId": str(document.public_id),
            },
        )
    return JsonResponse({"linked": True}, status=201 if created else 200)
