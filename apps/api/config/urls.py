from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path


def build_urlpatterns(*, django_admin_enabled: bool):
    patterns = [
        path("api/internal/collaboration/", include("apps.manuscripts.collaboration_urls")),
        path("api/admin/", include("apps.adminpanel.urls")),
        path("api/auth/", include("apps.accounts.urls")),
        path("api/editor/", include("apps.accounts.editor_urls")),
        path("api/editor/", include("apps.manuscripts.editor_urls")),
        path("api/contests/", include("apps.sources.contest_urls")),
        path("api/health/", include("apps.health.urls")),
        path("api/ideas/", include("apps.manuscripts.idea_urls")),
        path("api/manuscripts/", include("apps.manuscripts.urls")),
        path("api/notifications/", include("apps.notifications.urls")),
        path("api/news/", include("apps.sources.urls")),
        path("api/service-pages/", include("apps.servicepages.urls")),
    ]
    if django_admin_enabled:
        patterns.insert(0, path("django-admin/", admin.site.urls))
    return patterns


urlpatterns = build_urlpatterns(
    django_admin_enabled=settings.QUILLUM_DJANGO_ADMIN_ENABLED,
)

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
