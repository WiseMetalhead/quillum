import pytest

from apps.accounts.models import EmailChangeRequest


@pytest.mark.django_db
def test_user_sensitive_fields_are_stored_directly(django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="Writer@Example.Test",
        password="correct-password",
        display_name="Visible Writer",
        author_email="author@example.test",
    )

    stored = django_user_model.objects.filter(id=user.id).values().get()

    assert stored["email"] == "writer@example.test"
    assert stored["display_name"] == "Visible Writer"
    assert stored["author_email"] == "author@example.test"


@pytest.mark.django_db
def test_email_change_request_stores_normalized_email(django_user_model):
    user = django_user_model.objects.create_user(
        username="writer",
        email="writer@example.test",
        password="correct-password",
    )
    pending = EmailChangeRequest.objects.create(
        user=user,
        new_email="New-Writer@Example.Test",
        code_hash="hash",
        expires_at=user.date_joined,
    )

    stored = EmailChangeRequest.objects.filter(id=pending.id).values().get()

    assert stored["new_email"] == "new-writer@example.test"
