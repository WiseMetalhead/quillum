from django.urls import path

from apps.notifications.admin_campaigns import (
    campaign_detail,
    campaigns,
    cancel_campaign,
    retry_campaign,
    schedule_campaign,
    send_campaign,
)
from apps.servicepages.admin_views import (
    admin_service_pages,
    publish_service_page,
    save_service_page_draft,
    unpublish_service_page,
)

from .views import (
    audit_events,
    block_user,
    delete_user,
    maintenance,
    refresh_contests,
    refresh_news,
    service_settings,
    status,
    test_email_settings,
    test_service_notification,
    tier_progression,
    tier_quotas,
    unblock_user,
    update_user_role,
    update_user_tier,
    users,
)

urlpatterns = [
    path("maintenance/", maintenance, name="adminpanel-maintenance"),
    path(
        "maintenance/news/refresh/",
        refresh_news,
        name="adminpanel-maintenance-news-refresh",
    ),
    path(
        "maintenance/contests/refresh/",
        refresh_contests,
        name="adminpanel-maintenance-contests-refresh",
    ),
    path("service-pages/", admin_service_pages, name="adminpanel-service-pages"),
    path(
        "service-pages/<slug:slug>/draft/",
        save_service_page_draft,
        name="adminpanel-service-page-draft",
    ),
    path(
        "service-pages/<slug:slug>/publish/",
        publish_service_page,
        name="adminpanel-service-page-publish",
    ),
    path(
        "service-pages/<slug:slug>/unpublish/",
        unpublish_service_page,
        name="adminpanel-service-page-unpublish",
    ),
    path("audit-events/", audit_events, name="adminpanel-audit-events"),
    path("settings/", service_settings, name="adminpanel-settings"),
    path("settings/email/test/", test_email_settings, name="adminpanel-email-test"),
    path("notifications/test/", test_service_notification, name="adminpanel-notification-test"),
    path("notifications/campaigns/", campaigns, name="adminpanel-notification-campaigns"),
    path(
        "notifications/campaigns/<uuid:campaign_id>/",
        campaign_detail,
        name="adminpanel-notification-campaign-detail",
    ),
    path(
        "notifications/campaigns/<uuid:campaign_id>/schedule/",
        schedule_campaign,
        name="adminpanel-notification-campaign-schedule",
    ),
    path(
        "notifications/campaigns/<uuid:campaign_id>/send/",
        send_campaign,
        name="adminpanel-notification-campaign-send",
    ),
    path(
        "notifications/campaigns/<uuid:campaign_id>/cancel/",
        cancel_campaign,
        name="adminpanel-notification-campaign-cancel",
    ),
    path(
        "notifications/campaigns/<uuid:campaign_id>/retry/",
        retry_campaign,
        name="adminpanel-notification-campaign-retry",
    ),
    path("status/", status, name="adminpanel-status"),
    path("tier-quotas/", tier_quotas, name="adminpanel-tier-quotas"),
    path("tier-progression/", tier_progression, name="adminpanel-tier-progression"),
    path("users/", users, name="adminpanel-users"),
    path("users/<int:user_id>/block/", block_user, name="adminpanel-user-block"),
    path("users/<int:user_id>/delete/", delete_user, name="adminpanel-user-delete"),
    path("users/<int:user_id>/role/", update_user_role, name="adminpanel-user-role"),
    path("users/<int:user_id>/tier/", update_user_tier, name="adminpanel-user-tier"),
    path("users/<int:user_id>/unblock/", unblock_user, name="adminpanel-user-unblock"),
]
