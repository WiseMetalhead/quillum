from hashlib import sha256


def cover_cache_version(entity) -> str:
    if not entity.cover_media_id:
        return ""
    identity = f"media:{entity.cover_media_id}"
    return sha256(identity.encode("utf-8")).hexdigest()[:16]
