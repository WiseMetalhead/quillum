from django.urls import path, register_converter

from .annotations import (
    annotation_detail,
    annotation_replies,
    annotation_reply_detail,
    document_annotations,
)
from .boards import (
    board_detail,
    bulk_note_lifecycle,
    empty_note_trash,
    manuscript_audio_notes,
    manuscript_boards,
    manuscript_note_context,
    manuscript_note_tags,
    manuscript_notes,
    note_audio_content,
    note_audio_transcription,
    note_detail,
    note_lifecycle,
    note_tag_detail,
)
from .book_views import book_detail, book_item_detail, book_tree, books
from .collaboration_views import (
    owner_collaboration_flush,
    owner_collaboration_replace,
    owner_collaboration_ticket,
)
from .converters import (
    DocumentPublicIdConverter,
    ManuscriptPublicIdConverter,
    SeriesPublicIdConverter,
)
from .dashboard import (
    dashboard_memo,
    dashboard_settings,
    recent_documents,
    workspace_recent_work,
    workspace_search,
    workspace_stats,
    workspace_useful_links,
    writing_activity,
)
from .drawer import drawer_items, drawer_manuscript, drawer_series
from .editor_grants import manuscript_editor_grant_detail, manuscript_editor_grants
from .exports import export_detail, export_download, export_plan, manuscript_exports
from .glossary import (
    glossary_article_alias_detail,
    glossary_article_aliases,
    glossary_article_assets,
    glossary_article_content,
    glossary_article_cover,
    glossary_article_detail,
    glossary_article_export,
    glossary_article_thumbnail,
    glossary_articles,
    glossary_asset_content,
    glossary_asset_detail,
    glossary_associations,
    glossary_categories,
    glossary_category_detail,
    glossary_context,
    spellcheck_custom_word_detail,
    spellcheck_custom_words,
    spellcheck_lexicon,
)
from .planner import (
    manuscript_planner,
    planner_item_detail,
    planner_items,
    planner_statuses,
    planner_task_detail,
    planner_tasks,
)
from .review_shares import (
    manuscript_review_shares,
    public_review_annotation_detail,
    public_review_annotations,
    public_review_asset,
    public_review_detail,
    public_review_document_anchors,
    public_review_participant,
    public_review_replies,
    public_review_unlock,
    review_share_detail,
)
from .series_views import (
    book_series_membership,
    series_book_detail,
    series_books,
    series_collection,
    series_cover_content,
    series_detail,
)
from .versions import document_versions, restore_document_version, version_detail
from .views import (
    asset_content,
    cover_content,
    document_content,
    editor_preferences,
    manuscript_asset_detail,
    manuscript_assets,
    manuscript_detail,
    oneshot_detail,
    oneshots,
)

register_converter(ManuscriptPublicIdConverter, "manuscript")
register_converter(SeriesPublicIdConverter, "series")
register_converter(DocumentPublicIdConverter, "document")

urlpatterns = [
    path("editor-preferences/", editor_preferences, name="editor-preferences"),
    path("drawer/", drawer_items, name="drawer-items"),
    path(
        "drawer/manuscripts/<manuscript:manuscript_id>/",
        drawer_manuscript,
        name="drawer-manuscript",
    ),
    path(
        "drawer/series/<series:series_id>/",
        drawer_series,
        name="drawer-series",
    ),
    path("review/<str:token>/", public_review_detail, name="public-review-detail"),
    path("review/<str:token>/unlock/", public_review_unlock, name="public-review-unlock"),
    path(
        "review/<str:token>/participant/",
        public_review_participant,
        name="public-review-participant",
    ),
    path(
        "review/<str:token>/assets/<uuid:asset_id>/<str:variant>/",
        public_review_asset,
        name="public-review-asset",
    ),
    path(
        "review/<str:token>/documents/<document:document_id>/annotations/",
        public_review_annotations,
        name="public-review-annotations",
    ),
    path(
        "review/<str:token>/documents/<document:document_id>/anchors/",
        public_review_document_anchors,
        name="public-review-document-anchors",
    ),
    path(
        "review/<str:token>/annotations/<uuid:annotation_id>/replies/",
        public_review_replies,
        name="public-review-replies",
    ),
    path(
        "review/<str:token>/annotations/<uuid:annotation_id>/",
        public_review_annotation_detail,
        name="public-review-annotation-detail",
    ),
    path("<manuscript:manuscript_id>/", manuscript_detail, name="manuscript-detail"),
    path(
        "<manuscript:manuscript_id>/editor-grants/",
        manuscript_editor_grants,
        name="manuscript-editor-grants",
    ),
    path(
        "<manuscript:manuscript_id>/editor-grants/<uuid:grant_id>/",
        manuscript_editor_grant_detail,
        name="manuscript-editor-grant-detail",
    ),
    path(
        "dashboard/recent-work/",
        workspace_recent_work,
        name="workspace-dashboard-recent-work",
    ),
    path(
        "dashboard/stats/",
        workspace_stats,
        name="workspace-dashboard-stats",
    ),
    path(
        "dashboard/search/",
        workspace_search,
        name="workspace-dashboard-search",
    ),
    path(
        "dashboard/useful-links/",
        workspace_useful_links,
        name="workspace-dashboard-useful-links",
    ),
    path(
        "<manuscript:manuscript_id>/review-shares/",
        manuscript_review_shares,
        name="manuscript-review-shares",
    ),
    path("review-shares/<uuid:share_id>/", review_share_detail, name="review-share-detail"),
    path("<manuscript:manuscript_id>/planner/", manuscript_planner, name="manuscript-planner"),
    path(
        "<manuscript:manuscript_id>/dashboard/recent-documents/",
        recent_documents,
        name="manuscript-dashboard-recent-documents",
    ),
    path(
        "<manuscript:manuscript_id>/dashboard/writing-activity/",
        writing_activity,
        name="manuscript-dashboard-writing-activity",
    ),
    path(
        "<manuscript:manuscript_id>/dashboard/memo/",
        dashboard_memo,
        name="manuscript-dashboard-memo",
    ),
    path(
        "<manuscript:manuscript_id>/dashboard/settings/",
        dashboard_settings,
        name="manuscript-dashboard-settings",
    ),
    path("<manuscript:manuscript_id>/export-plan/", export_plan, name="manuscript-export-plan"),
    path("<manuscript:manuscript_id>/exports/", manuscript_exports, name="manuscript-exports"),
    path("exports/<uuid:export_id>/", export_detail, name="manuscript-export-detail"),
    path(
        "exports/<uuid:export_id>/download/",
        export_download,
        name="manuscript-export-download",
    ),
    path("<manuscript:manuscript_id>/planner/items/", planner_items, name="planner-items"),
    path("<manuscript:manuscript_id>/planner/statuses/", planner_statuses, name="planner-statuses"),
    path("<manuscript:manuscript_id>/planner/tasks/", planner_tasks, name="planner-tasks"),
    path("<manuscript:manuscript_id>/boards/", manuscript_boards, name="manuscript-boards"),
    path("<manuscript:manuscript_id>/glossary/", glossary_context, name="glossary-context"),
    path(
        "<manuscript:manuscript_id>/spellcheck-lexicon/",
        spellcheck_lexicon,
        name="spellcheck-lexicon",
    ),
    path(
        "<manuscript:manuscript_id>/spellcheck-lexicon/words/",
        spellcheck_custom_words,
        name="spellcheck-custom-words",
    ),
    path(
        "<manuscript:manuscript_id>/spellcheck-lexicon/words/<uuid:word_id>/",
        spellcheck_custom_word_detail,
        name="spellcheck-custom-word-detail",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/categories/",
        glossary_categories,
        name="glossary-categories",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/categories/<uuid:category_id>/",
        glossary_category_detail,
        name="glossary-category-detail",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/",
        glossary_articles,
        name="glossary-articles",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/<uuid:article_id>/",
        glossary_article_detail,
        name="glossary-article-detail",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/<uuid:article_id>/content/",
        glossary_article_content,
        name="glossary-article-content",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/<uuid:article_id>/thumbnail/",
        glossary_article_thumbnail,
        name="glossary-article-thumbnail",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/<uuid:article_id>/cover/",
        glossary_article_cover,
        name="glossary-article-cover",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/<uuid:article_id>/assets/",
        glossary_article_assets,
        name="glossary-article-assets",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/<uuid:article_id>/aliases/",
        glossary_article_aliases,
        name="glossary-article-aliases",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/<uuid:article_id>/aliases/<uuid:alias_id>/",
        glossary_article_alias_detail,
        name="glossary-article-alias-detail",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/articles/<uuid:article_id>/export/",
        glossary_article_export,
        name="glossary-article-export",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/assets/<uuid:asset_id>/",
        glossary_asset_detail,
        name="glossary-asset-detail",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/assets/<uuid:asset_id>/<str:variant>/",
        glossary_asset_content,
        name="glossary-asset-content",
    ),
    path(
        "<manuscript:manuscript_id>/glossary/associations/",
        glossary_associations,
        name="glossary-associations",
    ),
    path("<manuscript:manuscript_id>/notes/", manuscript_notes, name="manuscript-notes"),
    path(
        "<manuscript:manuscript_id>/audio-notes/",
        manuscript_audio_notes,
        name="manuscript-audio-notes",
    ),
    path(
        "<manuscript:manuscript_id>/notes/bulk-lifecycle/",
        bulk_note_lifecycle,
        name="bulk-note-lifecycle",
    ),
    path(
        "<manuscript:manuscript_id>/notes/trash/",
        empty_note_trash,
        name="empty-note-trash",
    ),
    path(
        "<manuscript:manuscript_id>/note-tags/",
        manuscript_note_tags,
        name="manuscript-note-tags",
    ),
    path(
        "<manuscript:manuscript_id>/note-context/",
        manuscript_note_context,
        name="manuscript-note-context",
    ),
    path("boards/<uuid:board_id>/", board_detail, name="board-detail"),
    path("notes/<uuid:note_id>/", note_detail, name="note-detail"),
    path("notes/<uuid:note_id>/audio/", note_audio_content, name="note-audio-content"),
    path(
        "notes/<uuid:note_id>/transcription/",
        note_audio_transcription,
        name="note-audio-transcription",
    ),
    path("notes/<uuid:note_id>/lifecycle/", note_lifecycle, name="note-lifecycle"),
    path("note-tags/<uuid:tag_id>/", note_tag_detail, name="note-tag-detail"),
    path("planner-items/<uuid:item_id>/", planner_item_detail, name="planner-item-detail"),
    path("planner-tasks/<uuid:task_id>/", planner_task_detail, name="planner-task-detail"),
    path("<manuscript:manuscript_id>/assets/", manuscript_assets, name="generic-manuscript-assets"),
    path("oneshots/", oneshots, name="manuscript-oneshots"),
    path("books/", books, name="manuscript-books"),
    path("series/", series_collection, name="manuscript-series"),
    path("series/<series:series_id>/", series_detail, name="manuscript-series-detail"),
    path(
        "series/<series:series_id>/books/",
        series_books,
        name="manuscript-series-books",
    ),
    path(
        "series/<series:series_id>/books/<manuscript:manuscript_id>/",
        series_book_detail,
        name="manuscript-series-book-detail",
    ),
    path(
        "series/<series:series_id>/cover/<str:variant>/",
        series_cover_content,
        name="manuscript-series-cover",
    ),
    path(
        "books/<manuscript:manuscript_id>/series-membership/",
        book_series_membership,
        name="manuscript-book-series-membership",
    ),
    path("books/<manuscript:manuscript_id>/", book_detail, name="manuscript-book-detail"),
    path("books/<manuscript:manuscript_id>/tree/", book_tree, name="manuscript-book-tree"),
    path("book-items/<uuid:item_id>/", book_item_detail, name="manuscript-book-item"),
    path(
        "books/<manuscript:manuscript_id>/documents/<uuid:item_id>/",
        document_content,
        name="book-document",
    ),
    path(
        "books/<manuscript:manuscript_id>/documents/<uuid:item_id>/collaboration-ticket/",
        owner_collaboration_ticket,
        name="book-document-collaboration-ticket",
    ),
    path(
        "books/<manuscript:manuscript_id>/documents/<uuid:item_id>/collaboration-flush/",
        owner_collaboration_flush,
        name="book-document-collaboration-flush",
    ),
    path(
        "books/<manuscript:manuscript_id>/documents/<uuid:item_id>/collaboration-replace/",
        owner_collaboration_replace,
        name="book-document-collaboration-replace",
    ),
    path(
        "books/<manuscript:manuscript_id>/documents/<uuid:item_id>/annotations/",
        document_annotations,
        name="book-document-annotations",
    ),
    path(
        "books/<manuscript:manuscript_id>/documents/<uuid:item_id>/versions/",
        document_versions,
        name="book-document-versions",
    ),
    path("oneshots/<manuscript:manuscript_id>/", oneshot_detail, name="manuscript-oneshot-detail"),
    path(
        "oneshots/<manuscript:manuscript_id>/document/",
        document_content,
        name="manuscript-document",
    ),
    path(
        "oneshots/<manuscript:manuscript_id>/document/collaboration-ticket/",
        owner_collaboration_ticket,
        name="manuscript-document-collaboration-ticket",
    ),
    path(
        "oneshots/<manuscript:manuscript_id>/document/collaboration-flush/",
        owner_collaboration_flush,
        name="manuscript-document-collaboration-flush",
    ),
    path(
        "oneshots/<manuscript:manuscript_id>/document/collaboration-replace/",
        owner_collaboration_replace,
        name="manuscript-document-collaboration-replace",
    ),
    path(
        "oneshots/<manuscript:manuscript_id>/versions/",
        document_versions,
        name="document-versions",
    ),
    path("versions/<uuid:version_id>/", version_detail, name="document-version-detail"),
    path(
        "versions/<uuid:version_id>/restore/",
        restore_document_version,
        name="document-version-restore",
    ),
    path("<manuscript:manuscript_id>/cover/<str:variant>/", cover_content, name="manuscript-cover"),
    path(
        "oneshots/<manuscript:manuscript_id>/assets/",
        manuscript_assets,
        name="manuscript-assets",
    ),
    path("assets/<uuid:asset_id>/", manuscript_asset_detail, name="manuscript-asset-detail"),
    path("assets/<uuid:asset_id>/<str:variant>/", asset_content, name="manuscript-asset-content"),
    path(
        "oneshots/<manuscript:manuscript_id>/annotations/",
        document_annotations,
        name="document-annotations",
    ),
    path("annotations/<uuid:annotation_id>/", annotation_detail, name="annotation-detail"),
    path(
        "annotations/<uuid:annotation_id>/replies/",
        annotation_replies,
        name="annotation-replies",
    ),
    path(
        "annotation-replies/<uuid:reply_id>/",
        annotation_reply_detail,
        name="annotation-reply-detail",
    ),
]
