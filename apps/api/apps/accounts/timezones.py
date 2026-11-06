from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def validate_timezone_name(value: object) -> str:
    timezone_name = str(value or "").strip()
    if not timezone_name or len(timezone_name) > 64:
        raise ValueError("timezone_invalid")
    try:
        ZoneInfo(timezone_name)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError("timezone_invalid") from exc
    return timezone_name
