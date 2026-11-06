from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .lookups import email_lookup_q
from .models import (
    BootstrapState,
    EditorConnection,
    EditorInvitation,
    EmailChangeRequest,
    PasskeyCredential,
    PasswordChangeRequest,
    User,
)


@admin.register(User)
class QuillumUserAdmin(UserAdmin):
    list_display = (
        "username",
        "email_value",
        "is_superuser",
        "author_workspace_enabled_at",
        "editor_workspace_enabled_at",
        "tier",
        "is_active",
        "date_joined",
    )
    search_fields = ("username",)
    ordering = ("username",)
    fieldsets = (
        (None, {"fields": ("username", "password")}),
        (
            "Permissions",
            {
                "fields": (
                    "is_active",
                    "is_superuser",
                    "groups",
                    "user_permissions",
                )
            },
        ),
        ("Important dates", {"fields": ("last_login", "date_joined")}),
        (
            "Quillum profile",
            {
                "fields": (
                    "email_value",
                    "display_name_value",
                    "first_name_value",
                    "last_name_value",
                    "avatar",
                    "language",
                    "theme",
                    "tier",
                    "author_workspace_enabled_at",
                    "editor_workspace_enabled_at",
                )
            },
        ),
        ("Quillum security", {"fields": ("two_factor_method",)}),
    )
    readonly_fields = (
        "email_value",
        "display_name_value",
        "first_name_value",
        "last_name_value",
        "author_workspace_enabled_at",
        "editor_workspace_enabled_at",
    )

    @admin.display(description="Email")
    def email_value(self, obj):
        return obj.email

    @admin.display(description="Display name")
    def display_name_value(self, obj):
        return obj.display_name

    @admin.display(description="First name")
    def first_name_value(self, obj):
        return obj.first_name

    @admin.display(description="Last name")
    def last_name_value(self, obj):
        return obj.last_name

    def get_search_results(self, request, queryset, search_term):
        queryset, may_have_duplicates = super().get_search_results(request, queryset, search_term)
        if search_term:
            queryset = queryset | self.model.objects.filter(email_lookup_q(search_term))
        return queryset, may_have_duplicates


@admin.register(EmailChangeRequest)
class EmailChangeRequestAdmin(admin.ModelAdmin):
    list_display = ("user", "new_email_value", "created_at", "expires_at", "consumed_at")
    list_filter = ("created_at", "expires_at", "consumed_at")
    search_fields = ("user__username",)
    readonly_fields = (
        "user",
        "new_email_value",
        "code_hash",
        "created_at",
        "expires_at",
        "consumed_at",
    )

    @admin.display(description="New email")
    def new_email_value(self, obj):
        return obj.new_email


@admin.register(PasswordChangeRequest)
class PasswordChangeRequestAdmin(admin.ModelAdmin):
    list_display = ("user", "created_at", "expires_at", "consumed_at")
    list_filter = ("created_at", "expires_at", "consumed_at")
    search_fields = ("user__username",)
    readonly_fields = (
        "user",
        "password_hash",
        "code_hash",
        "created_at",
        "expires_at",
        "consumed_at",
    )


@admin.register(PasskeyCredential)
class PasskeyCredentialAdmin(admin.ModelAdmin):
    list_display = ("name", "user", "created_at", "last_used_at")
    search_fields = ("name", "user__username")
    readonly_fields = ("created_at", "last_used_at")


@admin.register(EditorInvitation)
class EditorInvitationAdmin(admin.ModelAdmin):
    list_display = (
        "public_id",
        "author",
        "created_at",
        "expires_at",
        "revoked_at",
        "accepted_at",
        "accepted_by",
    )
    search_fields = ("author__username", "accepted_by__username")
    readonly_fields = (
        "public_id",
        "author",
        "created_at",
        "expires_at",
        "revoked_at",
        "accepted_at",
        "accepted_by",
    )


@admin.register(EditorConnection)
class EditorConnectionAdmin(admin.ModelAdmin):
    list_display = ("author", "editor", "connected_at", "disconnected_at")
    search_fields = ("author__username", "editor__username")
    readonly_fields = (
        "author",
        "editor",
        "invitation",
        "connected_at",
        "disconnected_at",
    )


@admin.register(BootstrapState)
class BootstrapStateAdmin(admin.ModelAdmin):
    list_display = ("singleton_id", "completed_at")
    readonly_fields = ("singleton_id", "completed_at")

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
