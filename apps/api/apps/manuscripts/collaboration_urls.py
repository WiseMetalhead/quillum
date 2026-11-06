from django.urls import path

from .collaboration_views import (
    internal_collaboration_commit,
    internal_collaboration_fail,
    internal_collaboration_initialize,
    internal_collaboration_load,
    internal_collaboration_ticket_consume,
)

urlpatterns = [
    path("tickets/consume/", internal_collaboration_ticket_consume),
    path("documents/load/", internal_collaboration_load),
    path("documents/initialize/", internal_collaboration_initialize),
    path("documents/commit/", internal_collaboration_commit),
    path("documents/fail/", internal_collaboration_fail),
]
