from django.urls import path

from .preferences import notification_preferences
from .views import mark_all_read, mark_read, notifications, summary

urlpatterns = [
    path("", notifications, name="notifications-list"),
    path("summary/", summary, name="notifications-summary"),
    path("preferences/", notification_preferences, name="notification-preferences"),
    path("read-all/", mark_all_read, name="notifications-read-all"),
    path("<uuid:notification_id>/read/", mark_read, name="notifications-read"),
]
