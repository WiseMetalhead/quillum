from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from django.db.models import Q

from apps.adminpanel.models import TierQuotaOverride

MiB = 1024 * 1024
GiB = 1024 * MiB

TIER_ORDER = ("novice", "author", "believer", "god")
TIER_LABELS = {
    "novice": "Novice",
    "author": "Author",
    "believer": "Believer",
    "god": "God",
}
QUOTA_KEYS = (
    "oneshots",
    "books",
    "series",
    "drafts_per_document",
    "revisions_per_document",
    "storage_bytes",
    "editor_invites",
    "image_upload_bytes",
)
QUOTA_LABELS = {
    "oneshots": "One-Shots",
    "books": "Books",
    "series": "Series",
    "drafts_per_document": "Drafts per document",
    "revisions_per_document": "Revisions per document",
    "storage_bytes": "Storage",
    "image_upload_bytes": "Image upload size",
    "editor_invites": "Editor invitations",
}
DEFAULT_QUOTAS = {
    "novice": {
        "oneshots": 5,
        "books": 3,
        "series": 1,
        "drafts_per_document": 10,
        "revisions_per_document": 3,
        "storage_bytes": 512 * MiB,
        "image_upload_bytes": 2 * MiB,
        "editor_invites": 1,
    },
    "author": {
        "oneshots": 10,
        "books": 6,
        "series": 2,
        "drafts_per_document": 15,
        "revisions_per_document": 5,
        "storage_bytes": 1 * GiB,
        "image_upload_bytes": 5 * MiB,
        "editor_invites": 2,
    },
    "believer": {
        "oneshots": 25,
        "books": 15,
        "series": 4,
        "drafts_per_document": 20,
        "revisions_per_document": 10,
        "storage_bytes": 2 * GiB,
        "image_upload_bytes": 10 * MiB,
        "editor_invites": 3,
    },
    "god": {
        "oneshots": 100,
        "books": 50,
        "series": 20,
        "drafts_per_document": 20,
        "revisions_per_document": 20,
        "storage_bytes": 5 * GiB,
        "image_upload_bytes": 20 * MiB,
        "editor_invites": 5,
    },
}
QUOTA_MAXIMUMS = {
    "oneshots": 1_000_000,
    "books": 1_000_000,
    "series": 1_000_000,
    "drafts_per_document": 10_000,
    "revisions_per_document": 10_000,
    "storage_bytes": 10 * 1024 * GiB,
    "image_upload_bytes": 1024 * MiB,
    "editor_invites": 1_000_000,
}


@dataclass(frozen=True)
class QuotaViolation:
    key: str
    used: int
    limit: int
    tier: str

    def payload(self) -> dict:
        return {
            "error": "quota_limit_reached",
            "quotaKey": self.key,
            "used": self.used,
            "limit": self.limit,
            "tier": self.tier,
        }


def valid_tier(value: str) -> bool:
    return value in TIER_ORDER


def valid_quota_key(value: str) -> bool:
    return value in QUOTA_KEYS


def validate_quota_value(key: str, value) -> int:
    if key not in QUOTA_KEYS:
        raise ValueError("quota_key_invalid")
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("quota_value_invalid")
    if value < 0:
        raise ValueError("quota_value_invalid")
    if value > QUOTA_MAXIMUMS[key]:
        raise ValueError("quota_value_too_large")
    return value


def tier_quotas(tier: str) -> dict[str, int]:
    if tier not in DEFAULT_QUOTAS:
        tier = "novice"
    quotas = DEFAULT_QUOTAS[tier].copy()
    overrides = TierQuotaOverride.objects.filter(tier=tier, key__in=QUOTA_KEYS)
    for item in overrides:
        quotas[item.key] = item.value
    return quotas


def quota_admin_payload() -> dict:
    overrides = {
        (item.tier, item.key): item
        for item in TierQuotaOverride.objects.filter(tier__in=TIER_ORDER, key__in=QUOTA_KEYS)
    }
    return {
        "tiers": [
            {
                "id": tier,
                "label": TIER_LABELS[tier],
                "quotas": [
                    {
                        "key": key,
                        "label": QUOTA_LABELS[key],
                        "default": DEFAULT_QUOTAS[tier][key],
                        "value": overrides.get((tier, key)).value
                        if (tier, key) in overrides
                        else DEFAULT_QUOTAS[tier][key],
                        "source": "database" if (tier, key) in overrides else "default",
                        "minimum": 0,
                        "maximum": QUOTA_MAXIMUMS[key],
                    }
                    for key in QUOTA_KEYS
                ],
            }
            for tier in TIER_ORDER
        ]
    }


def set_quota_override(*, tier: str, key: str, value: int, updated_by) -> TierQuotaOverride:
    if not valid_tier(tier):
        raise ValueError("tier_invalid")
    value = validate_quota_value(key, value)
    row = TierQuotaOverride.objects.filter(tier=tier, key=key).first()
    if row is None:
        row = TierQuotaOverride(tier=tier, key=key)
    row.value = value
    row.updated_by = updated_by
    row.save()
    return row


def delete_quota_override(*, tier: str, key: str) -> None:
    if not valid_tier(tier):
        raise ValueError("tier_invalid")
    if not valid_quota_key(key):
        raise ValueError("quota_key_invalid")
    TierQuotaOverride.objects.filter(tier=tier, key=key).delete()


def _field_size(field) -> int:
    if not field:
        return 0
    try:
        return int(field.size or 0)
    except (OSError, ValueError):
        return 0


def _sum_file_fields(items: Iterable[object], field_names: tuple[str, ...]) -> int:
    total = 0
    for item in items:
        for field_name in field_names:
            total += _field_size(getattr(item, field_name))
    return total


def storage_usage_bytes(user) -> int:
    from apps.manuscripts.models import AudioRecording

    from .media import media_total_size
    from .models import UserMediaAsset

    total = _field_size(user.avatar)
    total += sum(media_total_size(media) for media in UserMediaAsset.objects.filter(owner=user))
    total += _sum_file_fields(
        AudioRecording.objects.filter(
            Q(note__manuscript__workspace__owner=user) | Q(idea__owner=user)
        ).distinct(),
        ("file",),
    )
    return total


def total_storage_usage_bytes() -> int:
    from apps.manuscripts.models import AudioRecording

    from .media import media_total_size
    from .models import User, UserMediaAsset

    total = _sum_file_fields(User.objects.exclude(avatar=""), ("avatar",))
    total += sum(media_total_size(media) for media in UserMediaAsset.objects.all())
    total += _sum_file_fields(AudioRecording.objects.all(), ("file",))
    return total


def user_quota_usage(user) -> dict[str, int]:
    from apps.manuscripts.models import Manuscript, Series

    from .editor_service import editor_slot_usage

    return {
        "oneshots": Manuscript.objects.filter(
            workspace__owner=user,
            kind=Manuscript.KIND_ONESHOT,
        ).count(),
        "books": Manuscript.objects.filter(
            workspace__owner=user,
            kind=Manuscript.KIND_BOOK,
        ).count(),
        "series": Series.objects.filter(workspace__owner=user).count(),
        "drafts_per_document": 0,
        "revisions_per_document": 0,
        "storage_bytes": storage_usage_bytes(user),
        "image_upload_bytes": 0,
        "editor_invites": editor_slot_usage(user),
    }


def user_tier_payload(user) -> dict:
    from .tier_progression import automatic_promotion_payload

    quotas = tier_quotas(user.tier)
    usage = user_quota_usage(user)
    return {
        "tier": user.tier,
        "tierLabel": TIER_LABELS.get(user.tier, TIER_LABELS["novice"]),
        "quotas": [
            {
                "key": key,
                "label": QUOTA_LABELS[key],
                "used": usage[key],
                "limit": quotas[key],
            }
            for key in QUOTA_KEYS
        ],
        "automaticPromotion": automatic_promotion_payload(user),
    }


def quota_violation(
    user,
    key: str,
    *,
    used: int | None = None,
    added: int = 1,
) -> QuotaViolation | None:
    quotas = tier_quotas(user.tier)
    limit = quotas[key]
    if used is None:
        used = user_quota_usage(user)[key]
    if used + added > limit:
        return QuotaViolation(key=key, used=used, limit=limit, tier=user.tier)
    return None


def image_upload_limit(user) -> int:
    return tier_quotas(user.tier)["image_upload_bytes"]


def document_version_limit(user, key: str) -> int:
    return tier_quotas(user.tier)[key]
