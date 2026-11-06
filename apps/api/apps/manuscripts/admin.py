from django.contrib import admin

from .models import (
    AnnotationReply,
    Document,
    DocumentAnnotation,
    DocumentCollaborationState,
    DocumentCollaborationUpdate,
    DocumentVersion,
    EditorPreference,
    Glossary,
    GlossaryArticle,
    GlossaryArticleAlias,
    GlossaryAsset,
    GlossaryCategory,
    GlossaryCustomWord,
    Manuscript,
    ManuscriptAsset,
    ManuscriptEditorGrant,
    ManuscriptExport,
    ManuscriptItem,
    Series,
    SeriesMembership,
    Workspace,
)


@admin.register(Workspace)
class WorkspaceAdmin(admin.ModelAdmin):
    list_display = ("id", "owner", "created_at", "updated_at")
    search_fields = ("owner__username",)


@admin.register(Manuscript)
class ManuscriptAdmin(admin.ModelAdmin):
    list_display = ("public_id", "id", "workspace", "kind", "created_at", "updated_at")
    list_filter = ("kind",)
    search_fields = ("public_id", "workspace__owner__username")


@admin.register(ManuscriptEditorGrant)
class ManuscriptEditorGrantAdmin(admin.ModelAdmin):
    list_display = (
        "public_id",
        "manuscript",
        "editor_connection",
        "granted_at",
        "revoked_at",
    )
    list_filter = ("revoked_at",)
    search_fields = (
        "public_id",
        "manuscript__public_id",
        "manuscript__workspace__owner__username",
        "editor_connection__editor__username",
    )
    readonly_fields = list_display

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Series)
class SeriesAdmin(admin.ModelAdmin):
    list_display = ("public_id", "id", "workspace", "created_at", "updated_at")
    search_fields = ("public_id", "workspace__owner__username")


@admin.register(SeriesMembership)
class SeriesMembershipAdmin(admin.ModelAdmin):
    list_display = ("series", "manuscript", "position", "created_at", "updated_at")
    search_fields = (
        "series__workspace__owner__username",
        "manuscript__workspace__owner__username",
    )


@admin.register(ManuscriptItem)
class ManuscriptItemAdmin(admin.ModelAdmin):
    list_display = ("public_id", "manuscript", "kind", "parent", "position", "trashed_at")
    list_filter = ("kind", "trashed_at")


@admin.register(Document)
class DocumentAdmin(admin.ModelAdmin):
    list_display = (
        "public_id",
        "id",
        "manuscript",
        "schema_version",
        "created_at",
        "updated_at",
    )
    search_fields = ("public_id", "manuscript__workspace__owner__username")


@admin.register(DocumentCollaborationState)
class DocumentCollaborationStateAdmin(admin.ModelAdmin):
    list_display = (
        "document",
        "status",
        "epoch",
        "latest_sequence",
        "materialized_sequence",
        "diagnostic_status",
        "updated_at",
    )
    list_filter = ("status", "diagnostic_status")
    search_fields = ("document__public_id", "document__manuscript__public_id")
    readonly_fields = (
        "document",
        "epoch",
        "snapshot_sequence",
        "latest_sequence",
        "materialized_sequence",
        "schema_version",
        "diagnostic_status",
        "diagnostic_code",
        "materialized_at",
        "created_at",
        "updated_at",
    )


@admin.register(DocumentCollaborationUpdate)
class DocumentCollaborationUpdateAdmin(admin.ModelAdmin):
    list_display = ("update_id", "state", "epoch", "sequence", "actor", "role", "created_at")
    list_filter = ("role",)
    search_fields = ("update_id", "state__document__public_id", "actor__username")
    readonly_fields = (
        "state",
        "update_id",
        "epoch",
        "sequence",
        "actor",
        "role",
        "timezone",
        "positive_word_delta",
        "created_at",
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(DocumentVersion)
class DocumentVersionAdmin(admin.ModelAdmin):
    list_display = (
        "public_id",
        "document",
        "kind",
        "word_count",
        "character_count",
        "created_at",
    )
    list_filter = ("kind",)
    search_fields = ("public_id", "document__manuscript__workspace__owner__username")


@admin.register(EditorPreference)
class EditorPreferenceAdmin(admin.ModelAdmin):
    list_display = (
        "user",
        "font_size",
        "smart_quotes",
        "quote_style",
        "auto_capitalize",
        "auto_replace",
        "spellcheck_enabled",
        "spellcheck_dictionary",
        "updated_at",
    )


@admin.register(ManuscriptAsset)
class ManuscriptAssetAdmin(admin.ModelAdmin):
    list_display = ("public_id", "manuscript", "content_type", "width", "height", "created_at")
    search_fields = ("public_id", "manuscript__workspace__owner__username")


@admin.register(ManuscriptExport)
class ManuscriptExportAdmin(admin.ModelAdmin):
    list_display = (
        "public_id",
        "owner",
        "manuscript",
        "export_format",
        "epub_version",
        "status",
        "expires_at",
        "created_at",
    )
    list_filter = ("export_format", "epub_version", "status")
    search_fields = ("public_id", "owner__username", "manuscript__workspace__owner__username")


@admin.register(Glossary)
class GlossaryAdmin(admin.ModelAdmin):
    list_display = ("id", "manuscript", "series", "created_at", "updated_at")


@admin.register(GlossaryCategory)
class GlossaryCategoryAdmin(admin.ModelAdmin):
    list_display = ("public_id", "glossary", "system_key", "position", "is_hidden")
    list_filter = ("system_key", "is_hidden")
    search_fields = ("public_id",)


@admin.register(GlossaryCustomWord)
class GlossaryCustomWordAdmin(admin.ModelAdmin):
    list_display = ("public_id", "glossary", "created_at", "updated_at")
    search_fields = ("public_id",)


@admin.register(GlossaryArticle)
class GlossaryArticleAdmin(admin.ModelAdmin):
    list_display = (
        "public_id",
        "glossary",
        "category",
        "is_favourite",
        "save_generation",
        "updated_at",
    )
    list_filter = ("is_favourite",)
    search_fields = ("public_id",)


@admin.register(GlossaryArticleAlias)
class GlossaryArticleAliasAdmin(admin.ModelAdmin):
    list_display = ("public_id", "article", "created_at", "updated_at")
    search_fields = ("public_id",)


@admin.register(GlossaryAsset)
class GlossaryAssetAdmin(admin.ModelAdmin):
    list_display = ("public_id", "article", "kind", "content_type", "created_at")
    list_filter = ("kind",)
    search_fields = ("public_id",)


@admin.register(DocumentAnnotation)
class DocumentAnnotationAdmin(admin.ModelAdmin):
    list_display = ("public_id", "document", "author", "status", "created_at", "updated_at")
    list_filter = ("status",)
    search_fields = ("public_id", "author__username")


@admin.register(AnnotationReply)
class AnnotationReplyAdmin(admin.ModelAdmin):
    list_display = ("public_id", "annotation", "author", "created_at", "updated_at")
    search_fields = ("public_id", "author__username")
