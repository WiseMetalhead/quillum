import pytest
from django.core.exceptions import ImproperlyConfigured

from config.deployment import load_deployment_profile


def test_development_profile_preserves_local_defaults():
    profile = load_deployment_profile(None, None)

    assert profile.environment == "development"
    assert profile.public_origin == "http://localhost:5173"
    assert profile.allowed_hosts == ("localhost", "127.0.0.1")
    assert profile.browser_origins == (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )
    assert profile.webauthn_rp_id == "localhost"
    assert profile.is_production is False


def test_production_profile_derives_browser_security_defaults():
    profile = load_deployment_profile(
        "production",
        "https://write.example.com/",
    )

    assert profile.public_origin == "https://write.example.com"
    assert profile.allowed_hosts == ("write.example.com",)
    assert profile.browser_origins == ("https://write.example.com",)
    assert profile.webauthn_rp_id == "write.example.com"
    assert profile.is_production is True


@pytest.mark.parametrize(
    ("environment", "origin"),
    [
        ("staging", "https://write.example.com"),
        ("production", None),
        ("production", "http://write.example.com"),
        ("development", "https://user:password@write.example.com"),
        ("development", "https://write.example.com/application"),
        ("development", "https://write.example.com?mode=test"),
    ],
)
def test_deployment_profile_rejects_unsafe_configuration(environment, origin):
    with pytest.raises(ImproperlyConfigured):
        load_deployment_profile(environment, origin)
