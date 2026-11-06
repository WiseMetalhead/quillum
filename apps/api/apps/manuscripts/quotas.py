from __future__ import annotations

from django.http import JsonResponse

from apps.accounts.tiers import QuotaViolation, quota_violation, storage_usage_bytes


def quota_response(violation: QuotaViolation, *, status: int = 409) -> JsonResponse:
    return JsonResponse(violation.payload(), status=status)


def image_size_response(user, *, used: int, limit: int) -> JsonResponse:
    return JsonResponse(
        {
            "error": "quota_limit_reached",
            "quotaKey": "image_upload_bytes",
            "used": used,
            "limit": limit,
            "tier": user.tier,
        },
        status=413,
    )


def stored_file_size(field) -> int:
    if not field:
        return 0
    try:
        return int(field.size or 0)
    except (OSError, ValueError):
        return 0


def processed_cover_size(cover) -> int:
    if cover is None:
        return 0
    return cover.original.size + sum(item.size for item in cover.thumbnails.values())


def processed_asset_size(asset) -> int:
    if asset is None:
        return 0
    return asset.original.size + sum(item.size for item in asset.variants.values())


def storage_quota_response(user, *, added: int, replacing: int = 0) -> JsonResponse | None:
    used = max(0, storage_usage_bytes(user) - replacing)
    violation = quota_violation(user, "storage_bytes", used=used, added=added)
    return quota_response(violation) if violation else None
