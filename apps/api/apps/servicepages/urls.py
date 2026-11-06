from django.urls import path

from .views import service_page_detail, service_pages

urlpatterns = [
    path("", service_pages, name="service-pages"),
    path("<slug:slug>/", service_page_detail, name="service-page-detail"),
]
