from django.db.models import Q


def normalize_email(value: str) -> str:
    return str(value or "").strip().casefold()


def email_lookup_q(value: str) -> Q:
    return Q(email=normalize_email(value))


def audit_ip_lookup_q(value: str) -> Q:
    return Q(ip_address=str(value or "").strip())
