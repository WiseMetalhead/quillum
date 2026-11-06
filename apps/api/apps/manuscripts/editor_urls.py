from django.urls import path

from .collaboration_views import editor_collaboration_flush, editor_collaboration_ticket
from .editor_dashboard import editor_workspace_search
from .editor_grants import available_manuscript_cover, available_manuscripts
from .editor_workspace import (
    editor_annotation_detail,
    editor_annotation_replies,
    editor_annotation_reply_detail,
    editor_asset_content,
    editor_document_annotations,
    editor_document_content,
    editor_document_drafts,
    editor_draft_detail,
    editor_manuscript_detail,
    editor_manuscript_tree,
    editor_workspace_preferences,
)

urlpatterns = [
    path("workspace/search/", editor_workspace_search, name="editor-workspace-search"),
    path("preferences/", editor_workspace_preferences, name="editor-workspace-preferences"),
    path("manuscripts/", available_manuscripts, name="editor-available-manuscripts"),
    path(
        "manuscripts/<uuid:manuscript_id>/",
        editor_manuscript_detail,
        name="editor-manuscript-detail",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/tree/",
        editor_manuscript_tree,
        name="editor-manuscript-tree",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/document/",
        editor_document_content,
        name="editor-manuscript-document",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/documents/<uuid:item_id>/",
        editor_document_content,
        name="editor-manuscript-item-document",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/document/collaboration-ticket/",
        editor_collaboration_ticket,
        name="editor-manuscript-collaboration-ticket",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/documents/<uuid:item_id>/collaboration-ticket/",
        editor_collaboration_ticket,
        name="editor-manuscript-item-collaboration-ticket",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/document/collaboration-flush/",
        editor_collaboration_flush,
        name="editor-manuscript-collaboration-flush",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/documents/<uuid:item_id>/collaboration-flush/",
        editor_collaboration_flush,
        name="editor-manuscript-item-collaboration-flush",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/document/annotations/",
        editor_document_annotations,
        name="editor-manuscript-annotations",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/documents/<uuid:item_id>/annotations/",
        editor_document_annotations,
        name="editor-manuscript-item-annotations",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/annotations/<uuid:annotation_id>/",
        editor_annotation_detail,
        name="editor-manuscript-annotation-detail",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/annotations/<uuid:annotation_id>/replies/",
        editor_annotation_replies,
        name="editor-manuscript-annotation-replies",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/annotation-replies/<uuid:reply_id>/",
        editor_annotation_reply_detail,
        name="editor-manuscript-annotation-reply-detail",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/document/drafts/",
        editor_document_drafts,
        name="editor-manuscript-drafts",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/documents/<uuid:item_id>/drafts/",
        editor_document_drafts,
        name="editor-manuscript-item-drafts",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/drafts/<uuid:version_id>/",
        editor_draft_detail,
        name="editor-manuscript-draft-detail",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/assets/<uuid:asset_id>/<str:variant>/",
        editor_asset_content,
        name="editor-manuscript-asset",
    ),
    path(
        "manuscripts/<uuid:manuscript_id>/cover/<str:variant>/",
        available_manuscript_cover,
        name="editor-available-manuscript-cover",
    ),
]
