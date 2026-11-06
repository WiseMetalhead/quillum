from django.contrib.sessions.models import Session
from django.utils import timezone


def revoke_user_sessions(user_id: int) -> int:
    session_keys = []
    sessions = Session.objects.filter(expire_date__gte=timezone.now()).only(
        "session_key",
        "session_data",
    )
    for session in sessions.iterator():
        try:
            session_user_id = session.get_decoded().get("_auth_user_id")
        except Exception:
            continue
        if str(session_user_id) == str(user_id):
            session_keys.append(session.session_key)
    if not session_keys:
        return 0
    deleted, _details = Session.objects.filter(session_key__in=session_keys).delete()
    return deleted
