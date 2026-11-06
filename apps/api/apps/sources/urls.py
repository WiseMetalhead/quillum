from django.urls import path

from .views import news, news_sources

urlpatterns = [
    path("", news, name="news-list"),
    path("sources/", news_sources, name="news-sources"),
]
