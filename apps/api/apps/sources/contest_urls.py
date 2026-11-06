from django.urls import path

from .views import contest_detail, contest_participation, contest_sources, contests

urlpatterns = [
    path("", contests, name="contest-list"),
    path("sources/", contest_sources, name="contest-sources"),
    path("<uuid:contest_public_id>/details/", contest_detail, name="contest-detail"),
    path(
        "<uuid:contest_public_id>/participation/<uuid:manuscript_public_id>/",
        contest_participation,
        name="contest-participation",
    ),
]
