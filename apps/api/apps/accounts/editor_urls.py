from django.urls import path

from .editor_views import (
    editor_connection_detail,
    editor_invitation_accept,
    editor_invitation_claim,
    editor_invitation_detail,
    editor_invitation_register,
    editor_invitations,
)

urlpatterns = [
    path("invitations/", editor_invitations, name="editor-invitations"),
    path(
        "invitations/<uuid:invitation_id>/",
        editor_invitation_detail,
        name="editor-invitation-detail",
    ),
    path(
        "connections/<int:connection_id>/",
        editor_connection_detail,
        name="editor-connection-detail",
    ),
    path("invitation-claim/", editor_invitation_claim, name="editor-invitation-claim"),
    path(
        "invitation-claim/register/",
        editor_invitation_register,
        name="editor-invitation-register",
    ),
    path(
        "invitation-claim/accept/",
        editor_invitation_accept,
        name="editor-invitation-accept",
    ),
]
