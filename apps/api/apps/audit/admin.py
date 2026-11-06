from django.contrib import admin

from .models import AuditEvent


@admin.register(AuditEvent)
class AuditEventAdmin(admin.ModelAdmin):
    list_display = ("event", "actor", "subject", "ip_address", "created_at")
    list_filter = ("event", "created_at")
    search_fields = ("event", "subject", "actor__username")
    readonly_fields = (
        "event",
        "actor",
        "subject",
        "ip_address",
        "user_agent",
        "payload",
        "created_at",
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
