from django.http import JsonResponse

WORKSPACE_AUTHOR = "author"
WORKSPACE_EDITOR = "editor"
WORKSPACE_KINDS = {WORKSPACE_AUTHOR, WORKSPACE_EDITOR}
ACTIVE_WORKSPACE_SESSION_KEY = "quillum_active_workspace"


def has_author_workspace(user) -> bool:
    return bool(user.is_superuser or user.author_workspace_enabled_at is not None)


def has_editor_workspace(user) -> bool:
    return bool(user.editor_workspace_enabled_at is not None)


def workspace_available(user, workspace: str) -> bool:
    if workspace == WORKSPACE_AUTHOR:
        return has_author_workspace(user)
    if workspace == WORKSPACE_EDITOR:
        return has_editor_workspace(user)
    return False


def active_workspace(request, *, user=None) -> str:
    user = user or request.user
    selected = request.session.get(ACTIVE_WORKSPACE_SESSION_KEY)
    if selected in WORKSPACE_KINDS and workspace_available(user, selected):
        return selected
    selected = WORKSPACE_AUTHOR if has_author_workspace(user) else WORKSPACE_EDITOR
    request.session[ACTIVE_WORKSPACE_SESSION_KEY] = selected
    request.session.modified = True
    return selected


def set_active_workspace(request, workspace: str) -> None:
    request.session[ACTIVE_WORKSPACE_SESSION_KEY] = workspace
    request.session.modified = True

ALLOWED_AUTH_PATHS = (
    "/api/auth/account/delete/",
    "/api/auth/csrf/",
    "/api/auth/login/",
    "/api/auth/login/2fa/",
    "/api/auth/logout/",
    "/api/auth/onboarding/complete/",
    "/api/auth/profile/",
    "/api/auth/reauthenticate/",
    "/api/auth/session/",
    "/api/auth/setup/status/",
)
ALLOWED_AUTH_PREFIXES = (
    "/api/auth/login/passkey/",
    "/api/auth/oidc/",
    "/api/auth/profile/avatar/",
    "/api/auth/profile/email/",
    "/api/auth/security/",
    "/api/auth/workspaces/",
)


class AuthorWorkspaceCapabilityMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = getattr(request, "user", None)
        if (
            not getattr(user, "is_authenticated", False)
            or has_author_workspace(user)
            or not request.path.startswith("/api/")
        ):
            return self.get_response(request)

        path = request.path
        if path in ALLOWED_AUTH_PATHS or any(
            path.startswith(prefix) for prefix in ALLOWED_AUTH_PREFIXES
        ):
            return self.get_response(request)
        if path == "/api/auth/workspace/switch/":
            return self.get_response(request)
        if path.startswith("/api/editor/") or path.startswith("/api/service-pages/"):
            return self.get_response(request)
        if path.startswith("/api/manuscripts/review/"):
            return self.get_response(request)
        if path.startswith("/api/notifications/") and path != "/api/notifications/preferences/":
            return self.get_response(request)
        return JsonResponse({"error": "author_workspace_required"}, status=403)
