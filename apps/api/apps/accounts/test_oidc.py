import pytest

from apps.accounts.models import OidcIdentity
from apps.accounts.oidc import OidcLoginError, resolve_oidc_user
from apps.adminpanel.runtime_settings import set_runtime_override


@pytest.mark.django_db
def test_oidc_links_an_exact_username_match(django_user_model):
    user = django_user_model.objects.create_user(
        username="OidcUser",
        email="local@example.test",
        password="correct-password",
    )

    resolved = resolve_oidc_user(
        {
            "iss": "https://idp.example.test/oidc",
            "sub": "oidc-subject",
            "preferred_username": "oidcuser",
            "email": "different@example.test",
            "email_verified": True,
        }
    )

    assert resolved.user == user
    assert resolved.linked is True
    assert resolved.created is False
    assert resolved.user.onboarding_completed_at is not None
    assert OidcIdentity.objects.filter(user=user, subject="oidc-subject").exists()


@pytest.mark.django_db
def test_oidc_rejects_username_and_verified_email_matching_different_users(django_user_model):
    django_user_model.objects.create_user(
        username="username-match",
        email="first@example.test",
        password="correct-password",
    )
    django_user_model.objects.create_user(
        username="email-owner",
        email="verified@example.test",
        password="correct-password",
    )

    with pytest.raises(OidcLoginError, match="oidc_identity_ambiguous"):
        resolve_oidc_user(
            {
                "iss": "https://idp.example.test/oidc",
                "sub": "ambiguous-subject",
                "preferred_username": "username-match",
                "email": "verified@example.test",
                "email_verified": True,
            }
        )


@pytest.mark.django_db
def test_oidc_creates_user_without_a_local_password(django_user_model):
    resolved = resolve_oidc_user(
        {
            "iss": "https://idp.example.test/oidc",
            "sub": "new-subject",
            "preferred_username": "new-oidc-user",
            "email": "new@example.test",
            "email_verified": True,
            "name": "New Writer",
        },
        language="ru",
        theme="dark",
    )

    assert resolved.created is True
    assert resolved.user.has_usable_password() is False
    assert resolved.user.email == "new@example.test"
    assert resolved.user.display_name == "New Writer"
    assert resolved.user.language == "ru"
    assert resolved.user.theme == "dark"
    assert resolved.user.onboarding_completed_at is None


@pytest.mark.django_db
def test_local_password_login_setting_is_enforced_by_api(client, django_user_model):
    django_user_model.objects.create_user(
        username="local-user",
        email="local-user@example.test",
        password="correct-password",
    )
    set_runtime_override("local_password_login_enabled", False)

    response = client.post(
        "/api/auth/login/",
        {"username": "local-user", "password": "correct-password"},
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "local_password_login_disabled"
