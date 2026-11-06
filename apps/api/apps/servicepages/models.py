from django.conf import settings
from django.db import models


class ServicePage(models.Model):
    PRIVACY = "privacy"
    TERMS = "terms"
    CONTACT = "contact"
    SLUG_CHOICES = (
        (PRIVACY, "Privacy"),
        (TERMS, "Terms"),
        (CONTACT, "Contact"),
    )
    SLUGS = (PRIVACY, TERMS, CONTACT)

    slug = models.CharField(max_length=16, choices=SLUG_CHOICES, primary_key=True)
    draft_markdown = models.TextField(blank=True)
    is_published = models.BooleanField(default=False)
    active_revision = models.ForeignKey(
        "ServicePageRevision",
        blank=True,
        null=True,
        on_delete=models.SET_NULL,
        related_name="active_for_pages",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        blank=True,
        null=True,
        on_delete=models.SET_NULL,
        related_name="updated_service_pages",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["slug"]

    def __str__(self) -> str:
        return self.slug


class ServicePageRevision(models.Model):
    page = models.ForeignKey(ServicePage, on_delete=models.CASCADE, related_name="revisions")
    version = models.PositiveIntegerField()
    markdown = models.TextField()
    published_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        blank=True,
        null=True,
        on_delete=models.SET_NULL,
        related_name="published_service_page_revisions",
    )
    published_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["page_id", "-version"]
        constraints = [
            models.UniqueConstraint(
                fields=["page", "version"],
                name="unique_service_page_revision_version",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.page_id} v{self.version}"
