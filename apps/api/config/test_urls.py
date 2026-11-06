from .urls import build_urlpatterns


def test_django_admin_route_is_opt_in():
    disabled = build_urlpatterns(django_admin_enabled=False)
    enabled = build_urlpatterns(django_admin_enabled=True)

    assert all(str(pattern.pattern) != "django-admin/" for pattern in disabled)
    assert any(str(pattern.pattern) == "django-admin/" for pattern in enabled)
    assert all(str(pattern.pattern) != "admin/" for pattern in enabled)
