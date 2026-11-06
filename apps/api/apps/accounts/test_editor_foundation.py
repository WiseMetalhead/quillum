from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from io import BytesIO

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections, connection
from django.db.migrations.executor import MigrationExecutor
from django.test import Client
from django.utils import timezone
from PIL import Image

from apps.accounts.editor_service import (
    EDITOR_INVITATION_SESSION_KEY,
    EditorFlowError,
    create_editor_invitation,
    invitation_token,
)
from apps.accounts.models import EditorConnection, EditorInvitation, OidcIdentity
from apps.accounts.oidc import resolve_oidc_user
from apps.accounts.views import OIDC_FLOW_SESSION_KEY
from apps.adminpanel.runtime_settings import set_runtime_override
from apps.audit.models import AuditEvent
from apps.notifications.models import Notification
from apps.notifications.tasks import _scan_account_reminders

PASSWORD = "Correct-password-42!"


class FakeOidcClient:
    def __init__(self, claims):
        self.claims = claims

    def authorize_access_token(self, _request):
        return {"userinfo": self.claims}


def create_writer(django_user_model, username="writer"):
    return django_user_model.objects.create_user(
        username=username,
        email=f"{username}@example.test",
        password=PASSWORD,
    )


def create_editor(django_user_model, username="editor"):
    return django_user_model.objects.create_user(
        username=username,
        email=f"{username}@example.test",
        password=PASSWORD,
        author_workspace_enabled_at=None,
        editor_workspace_enabled_at=timezone.now(),
    )


def create_invitation(client, writer):
    client.force_login(writer)
    response = client.post("/api/editor/invitations/", {}, content_type="application/json")
    assert response.status_code == 201
    return response.json()["pendingInvitations"][0]


def set_oidc_invitation_session(client, invitation):
    session = client.session
    session[OIDC_FLOW_SESSION_KEY] = {
        "started": True,
        "reauthenticate": False,
        "invitation": True,
        "userId": None,
        "language": "en",
        "theme": "system",
        "timezone": "UTC",
    }
    session[EDITOR_INVITATION_SESSION_KEY] = str(invitation.public_id)
    session.save()


@pytest.mark.django_db
def test_existing_and_normal_users_keep_author_workspace(client, django_user_model):
    writer = create_writer(django_user_model)
    client.force_login(writer)

    response = client.get("/api/auth/session/")

    assert writer.author_workspace_enabled_at is not None
    assert response.json()["user"]["authorWorkspaceEnabled"] is True


@pytest.mark.django_db
def test_ordinary_registration_creates_writer_workspace(client, django_user_model):
    set_runtime_override("open_registration", True)

    response = client.post(
        "/api/auth/register/",
        {
            "username": "ordinary-writer",
            "email": "ordinary-writer@example.test",
            "password": PASSWORD,
            "language": "en",
            "theme": "system",
            "timezone": "UTC",
        },
        content_type="application/json",
    )

    assert response.status_code == 201
    writer = django_user_model.objects.get(username="ordinary-writer")
    assert writer.author_workspace_enabled_at is not None
    assert response.json()["user"]["authorWorkspaceEnabled"] is True


@pytest.mark.django_db
def test_workspace_activation_is_idempotent_and_session_switch_is_capability_scoped(
    client,
    django_user_model,
):
    writer = create_writer(django_user_model, "workspace-writer")
    original_onboarding = writer.onboarding_completed_at
    client.force_login(writer)

    session = client.get("/api/auth/session/")
    assert session.status_code == 200
    assert session.json()["activeWorkspace"] == "author"

    first = client.post(
        "/api/auth/workspaces/editor/activate/",
        {},
        content_type="application/json",
    )
    repeated = client.post(
        "/api/auth/workspaces/editor/activate/",
        {},
        content_type="application/json",
    )
    assert first.status_code == repeated.status_code == 200
    assert first.json()["activeWorkspace"] == "author"
    assert repeated.json()["user"]["editorWorkspaceEnabled"] is True
    assert AuditEvent.objects.filter(
        event="auth.workspace_activated",
        actor=writer,
        payload__workspace="editor",
    ).count() == 1

    switched = client.post(
        "/api/auth/workspace/switch/",
        {"workspace": "editor"},
        content_type="application/json",
    )
    assert switched.status_code == 200
    assert switched.json()["activeWorkspace"] == "editor"
    assert client.get("/api/auth/session/").json()["activeWorkspace"] == "editor"

    unavailable_user = create_writer(django_user_model, "workspace-unavailable")
    client.force_login(unavailable_user)
    assert client.get("/api/auth/session/").json()["activeWorkspace"] == "author"
    unavailable = client.post(
        "/api/auth/workspace/switch/",
        {"workspace": "editor"},
        content_type="application/json",
    )
    assert unavailable.status_code == 403
    assert unavailable.json()["error"] == "workspace_unavailable"
    assert client.get("/api/auth/session/").json()["activeWorkspace"] == "author"

    writer.refresh_from_db()
    assert writer.onboarding_completed_at == original_onboarding
    assert writer.tier == writer.TIER_NOVICE


@pytest.mark.django_db
def test_active_workspace_does_not_remove_account_capabilities(client, django_user_model):
    combined = create_writer(django_user_model, "capability-combined")
    combined.editor_workspace_enabled_at = timezone.now()
    combined.save(update_fields=["editor_workspace_enabled_at"])
    client.force_login(combined)

    assert client.get("/api/editor/manuscripts/").status_code == 200
    assert client.post(
        "/api/auth/workspace/switch/",
        {"workspace": "editor"},
        content_type="application/json",
    ).status_code == 200
    assert client.get("/api/auth/dashboard/").status_code == 200


@pytest.mark.django_db(transaction=True)
def test_concurrent_workspace_activation_writes_one_audit_event(django_user_model):
    writer = create_writer(django_user_model, "concurrent-workspace")

    def activate():
        close_old_connections()
        try:
            local_client = Client()
            local_client.force_login(django_user_model.objects.get(pk=writer.pk))
            return local_client.post(
                "/api/auth/workspaces/editor/activate/",
                {},
                content_type="application/json",
            ).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = list(executor.map(lambda _index: activate(), range(2)))

    assert statuses == [200, 200]
    assert AuditEvent.objects.filter(
        event="auth.workspace_activated",
        actor_id=writer.id,
        payload__workspace="editor",
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_editor_foundation_migration_enables_author_workspace_for_existing_users():
    executor = MigrationExecutor(connection)
    latest_targets = executor.loader.graph.leaf_nodes()
    try:
        previous_target = [("accounts", "0026_remove_staff_role")]
        executor.migrate(previous_target)
        previous_apps = executor.loader.project_state(previous_target).apps
        legacy_user = previous_apps.get_model("accounts", "User").objects.create(
            username="pre-editor-foundation",
            password="!",
        )

        executor = MigrationExecutor(connection)
        current_target = [("accounts", "0027_editor_foundation")]
        executor.migrate(current_target)
        current_apps = executor.loader.project_state(current_target).apps
        migrated_user = current_apps.get_model("accounts", "User").objects.get(
            pk=legacy_user.pk,
        )

        assert migrated_user.author_workspace_enabled_at is not None
    finally:
        MigrationExecutor(connection).migrate(latest_targets)


@pytest.mark.django_db(transaction=True)
def test_editor_workspace_migration_backfills_editor_only_and_connected_users():
    executor = MigrationExecutor(connection)
    latest_targets = executor.loader.graph.leaf_nodes()
    try:
        previous_target = [("accounts", "0027_editor_foundation")]
        executor.migrate(previous_target)
        previous_apps = executor.loader.project_state(previous_target).apps
        User = previous_apps.get_model("accounts", "User")
        Invitation = previous_apps.get_model("accounts", "EditorInvitation")
        Connection = previous_apps.get_model("accounts", "EditorConnection")
        writer = User.objects.create(username="migration-writer", password="!")
        editor_only = User.objects.create(
            username="migration-editor-only",
            password="!",
            author_workspace_enabled_at=None,
        )
        connected_writer = User.objects.create(username="migration-connected", password="!")
        invitation = Invitation.objects.create(
            author=writer,
            expires_at=timezone.now() + timedelta(hours=48),
            accepted_at=timezone.now(),
            accepted_by=connected_writer,
        )
        Connection.objects.create(
            author=writer,
            editor=connected_writer,
            invitation=invitation,
        )

        current_target = [("accounts", "0028_editor_workspace_capability")]
        MigrationExecutor(connection).migrate(current_target)
        current_apps = MigrationExecutor(connection).loader.project_state(current_target).apps
        MigratedUser = current_apps.get_model("accounts", "User")

        assert MigratedUser.objects.get(pk=writer.pk).editor_workspace_enabled_at is None
        assert MigratedUser.objects.get(pk=editor_only.pk).editor_workspace_enabled_at is not None
        assert (
            MigratedUser.objects.get(pk=connected_writer.pk).editor_workspace_enabled_at
            is not None
        )
    finally:
        MigrationExecutor(connection).migrate(latest_targets)


@pytest.mark.django_db
def test_local_invitation_registration_bypasses_closed_registration(
    client,
    django_user_model,
):
    set_runtime_override("open_registration", False)
    invitation = create_invitation(client, create_writer(django_user_model))
    client.logout()
    token = invitation["shareUrl"].split("#", 1)[1]
    claim = client.post(
        "/api/editor/invitation-claim/",
        {"token": token},
        content_type="application/json",
    )
    assert claim.status_code == 200

    response = client.post(
        "/api/editor/invitation-claim/register/",
        {
            "username": "new-editor",
            "email": "new-editor@example.test",
            "password": PASSWORD,
            "language": "ru",
            "theme": "dark",
            "timezone": "Europe/Moscow",
        },
        content_type="application/json",
    )

    assert response.status_code == 201
    editor = django_user_model.objects.get(username="new-editor")
    assert editor.author_workspace_enabled_at is None
    assert editor.onboarding_completed_at is None
    assert EditorConnection.objects.filter(editor=editor, disconnected_at__isnull=True).exists()
    assert AuditEvent.objects.filter(event="editor.invitation_accepted", actor=editor).exists()


@pytest.mark.django_db
def test_invitation_quota_recopy_revoke_and_expiry(client, django_user_model):
    writer = create_writer(django_user_model)
    invitation = create_invitation(client, writer)

    repeated = client.get("/api/editor/invitations/")
    assert repeated.status_code == 200
    assert repeated.json()["pendingInvitations"][0]["shareUrl"] == invitation["shareUrl"]
    lifetime = (
        datetime.fromisoformat(invitation["expiresAt"])
        - datetime.fromisoformat(invitation["createdAt"])
    )
    assert timedelta(hours=47, minutes=59) < lifetime <= timedelta(hours=48)
    created_event = AuditEvent.objects.get(event="editor.invitation_created")
    assert "shareUrl" not in created_event.payload
    assert invitation["shareUrl"] not in str(created_event.payload)

    quota_response = client.post("/api/editor/invitations/", {}, content_type="application/json")
    assert quota_response.status_code == 409
    assert quota_response.json()["quotaKey"] == "editor_invites"

    revoked = client.delete(f"/api/editor/invitations/{invitation['id']}/")
    assert revoked.status_code == 200
    assert client.post(
        "/api/editor/invitations/",
        {},
        content_type="application/json",
    ).status_code == 201
    active = EditorInvitation.objects.get(revoked_at__isnull=True)
    active.expires_at = timezone.now() - timedelta(seconds=1)
    active.save(update_fields=["expires_at"])
    assert client.post(
        "/api/editor/invitations/",
        {},
        content_type="application/json",
    ).status_code == 201


@pytest.mark.django_db(transaction=True)
def test_concurrent_invitation_generation_cannot_exceed_quota(django_user_model):
    writer = create_writer(django_user_model)

    def create_one():
        close_old_connections()
        try:
            current_writer = django_user_model.objects.get(pk=writer.pk)
            try:
                create_editor_invitation(current_writer)
            except EditorFlowError as exc:
                return exc.code
            return "created"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: create_one(), range(2)))

    assert sorted(results) == ["created", "quota_limit_reached"]
    assert EditorInvitation.objects.filter(author=writer).count() == 1


@pytest.mark.django_db
def test_invitation_rejects_tampering_and_activates_writer_atomically(client, django_user_model):
    writer = create_writer(django_user_model)
    invitation = create_invitation(client, writer)
    token = invitation["shareUrl"].split("#", 1)[1]
    client.logout()

    tampered = client.post(
        "/api/editor/invitation-claim/",
        {"token": f"{token}x"},
        content_type="application/json",
    )
    assert tampered.status_code == 400
    assert tampered.json()["error"] == "editor_invitation_invalid"

    other_writer = create_writer(django_user_model, "other-writer")
    client.force_login(other_writer)
    assert client.post(
        "/api/editor/invitation-claim/",
        {"token": token},
        content_type="application/json",
    ).status_code == 200
    accepted = client.post(
        "/api/editor/invitation-claim/accept/",
        {},
        content_type="application/json",
    )
    assert accepted.status_code == 200
    assert accepted.json()["activeWorkspace"] == "editor"
    other_writer.refresh_from_db()
    assert other_writer.editor_workspace_enabled_at is not None
    assert EditorConnection.objects.filter(editor=other_writer).exists()
    replay = client.post(
        "/api/editor/invitation-claim/",
        {"token": token},
        content_type="application/json",
    )
    assert replay.status_code == 409


@pytest.mark.django_db
def test_self_invitation_does_not_activate_editor_workspace(client, django_user_model):
    writer = create_writer(django_user_model, "self-invitation")
    invitation = create_invitation(client, writer)
    token = invitation["shareUrl"].split("#", 1)[1]
    assert client.post(
        "/api/editor/invitation-claim/",
        {"token": token},
        content_type="application/json",
    ).status_code == 200

    response = client.post(
        "/api/editor/invitation-claim/accept/",
        {},
        content_type="application/json",
    )

    assert response.status_code == 409
    assert response.json()["error"] == "editor_invitation_self_connection"
    writer.refresh_from_db()
    assert writer.editor_workspace_enabled_at is None
    assert not EditorConnection.objects.filter(editor=writer).exists()


@pytest.mark.django_db
def test_duplicate_connection_rolls_back_editor_workspace_activation(client, django_user_model):
    author = create_writer(django_user_model, "duplicate-author")
    candidate = create_writer(django_user_model, "duplicate-candidate")
    accepted_invitation = EditorInvitation.objects.create(
        author=author,
        expires_at=timezone.now() + timedelta(hours=48),
        accepted_at=timezone.now(),
        accepted_by=candidate,
    )
    EditorConnection.objects.create(
        author=author,
        editor=candidate,
        invitation=accepted_invitation,
    )
    pending = EditorInvitation.objects.create(
        author=author,
        expires_at=timezone.now() + timedelta(hours=48),
    )
    client.force_login(candidate)
    assert client.post(
        "/api/editor/invitation-claim/",
        {"token": invitation_token(pending)},
        content_type="application/json",
    ).status_code == 200

    response = client.post(
        "/api/editor/invitation-claim/accept/",
        {},
        content_type="application/json",
    )

    assert response.status_code == 409
    assert response.json()["error"] == "editor_connection_already_exists"
    candidate.refresh_from_db()
    pending.refresh_from_db()
    assert candidate.editor_workspace_enabled_at is None
    assert pending.accepted_at is None


@pytest.mark.django_db
def test_editor_can_connect_to_multiple_writers_and_remains_limited_after_disconnect(
    client,
    django_user_model,
):
    editor = create_editor(django_user_model)
    avatar_bytes = BytesIO()
    Image.new("RGB", (2, 2), (100, 80, 60)).save(avatar_bytes, format="PNG")
    client.force_login(editor)
    avatar_response = client.post(
        "/api/auth/profile/avatar/",
        {
            "avatar": SimpleUploadedFile(
                "editor-avatar.png",
                avatar_bytes.getvalue(),
                content_type="image/png",
            )
        },
    )
    assert avatar_response.status_code == 200
    writers = [create_writer(django_user_model, f"writer-{index}") for index in range(2)]
    writer_avatar_bytes = BytesIO()
    Image.new("RGB", (2, 2), (60, 80, 100)).save(writer_avatar_bytes, format="PNG")
    client.force_login(writers[0])
    assert client.post(
        "/api/auth/profile/avatar/",
        {
            "avatar": SimpleUploadedFile(
                "writer-avatar.png",
                writer_avatar_bytes.getvalue(),
                content_type="image/png",
            )
        },
    ).status_code == 200
    for writer in writers:
        invitation = create_invitation(client, writer)
        token = invitation["shareUrl"].split("#", 1)[1]
        client.force_login(editor)
        assert client.post(
            "/api/editor/invitation-claim/",
            {"token": token},
            content_type="application/json",
        ).status_code == 200
        assert client.post(
            "/api/editor/invitation-claim/accept/",
            {},
            content_type="application/json",
        ).status_code == 200

    assert EditorConnection.objects.filter(editor=editor, disconnected_at__isnull=True).count() == 2
    client.force_login(editor)
    assert client.get(f"/api/auth/profile/avatar/{writers[0].id}/").status_code == 200
    client.force_login(writers[0])
    section = client.get("/api/editor/invitations/")
    assert section.status_code == 200
    assert section.json()["editors"][0]["avatarUrl"] == (
        f"/api/auth/profile/avatar/{editor.id}/"
    )
    assert client.get(f"/api/auth/profile/avatar/{editor.id}/").status_code == 200
    connection = EditorConnection.objects.get(author=writers[0], editor=editor)
    assert client.delete(f"/api/editor/connections/{connection.id}/").status_code == 200
    assert client.get(f"/api/auth/profile/avatar/{editor.id}/").status_code == 403
    client.force_login(editor)
    assert client.get(f"/api/auth/profile/avatar/{writers[0].id}/").status_code == 403
    editor.refresh_from_db()
    assert editor.author_workspace_enabled_at is None
    old_link = invitation_token(connection.invitation)
    rejected_reuse = client.post(
        "/api/editor/invitation-claim/",
        {"token": old_link},
        content_type="application/json",
    )
    assert rejected_reuse.status_code == 409
    assert rejected_reuse.json()["error"] == "editor_invitation_already_accepted"
    client.force_login(writers[0])
    assert client.post(
        "/api/editor/invitations/",
        {},
        content_type="application/json",
    ).status_code == 201


@pytest.mark.django_db
def test_editor_only_capability_boundary_and_profile_fields(client, django_user_model):
    editor = create_editor(django_user_model)
    client.force_login(editor)

    denied_requests = [
        ("get", "/api/auth/dashboard/"),
        ("get", "/api/manuscripts/dashboard/stats/"),
        ("get", "/api/manuscripts/books/"),
        ("post", "/api/manuscripts/books/"),
        ("get", "/api/ideas/"),
        ("post", "/api/ideas/"),
        ("get", "/api/news/"),
        ("get", "/api/auth/tier/"),
        ("get", "/api/auth/storage/"),
        ("get", "/api/auth/account/export/"),
        ("get", "/api/notifications/preferences/"),
        ("post", "/api/notifications/preferences/"),
    ]
    for method, path in denied_requests:
        response = getattr(client, method)(path, {}, content_type="application/json")
        assert response.status_code == 403, (method, path)
        assert response.json()["error"] == "author_workspace_required"

    assert client.get("/api/notifications/summary/").status_code == 200
    assert client.get("/api/auth/profile/").status_code == 200
    assert client.get("/api/auth/security/").status_code == 200
    profile = client.patch(
        "/api/auth/profile/",
        {"authorName": "Forbidden"},
        content_type="application/json",
    )
    assert profile.status_code == 403
    assert profile.json()["error"] == "author_workspace_required"

    oversized_avatar = client.post(
        "/api/auth/profile/avatar/",
        {
            "avatar": SimpleUploadedFile(
                "avatar.png",
                b"x" * (2 * 1024 * 1024 + 1),
                content_type="image/png",
            )
        },
    )
    assert oversized_avatar.status_code == 413
    assert oversized_avatar.json()["error"] == "editor_avatar_too_large"


@pytest.mark.django_db
def test_editor_can_activate_author_workspace_without_repeating_onboarding(
    client,
    django_user_model,
):
    editor = create_editor(django_user_model, "editor-author-activation")
    original_onboarding = editor.onboarding_completed_at
    client.force_login(editor)
    assert client.get("/api/auth/session/").json()["activeWorkspace"] == "editor"

    response = client.post(
        "/api/auth/workspaces/author/activate/",
        {},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["activeWorkspace"] == "editor"
    assert response.json()["user"]["authorWorkspaceEnabled"] is True
    editor.refresh_from_db()
    assert editor.onboarding_completed_at == original_onboarding
    assert editor.tier == editor.TIER_NOVICE
    assert client.get("/api/auth/storage/").status_code == 200


@pytest.mark.django_db
def test_editor_onboarding_ignores_author_fields(client, django_user_model):
    editor = create_editor(django_user_model)
    editor.onboarding_completed_at = None
    editor.save(update_fields=["onboarding_completed_at"])
    client.force_login(editor)

    response = client.post(
        "/api/auth/onboarding/complete/",
        {
            "language": "en",
            "timezone": "UTC",
            "theme": "system",
            "displayName": "Editor Name",
            "authorName": "Must not persist",
            "authorWebsite": "https://example.test",
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    editor.refresh_from_db()
    assert editor.display_name == "Editor Name"
    assert editor.author_name == ""
    assert editor.author_website == ""


@pytest.mark.django_db
def test_editor_oidc_creation_and_existing_writer_linking(
    django_user_model,
):
    claims = {
        "iss": "https://idp.example.test/oidc",
        "sub": "editor-subject",
        "preferred_username": "oidc-editor",
        "email": "oidc-editor@example.test",
        "email_verified": True,
    }
    resolved = resolve_oidc_user(
        claims,
        author_workspace_enabled=False,
        require_editor_only=True,
    )
    assert resolved.user.author_workspace_enabled_at is None
    assert resolved.user.editor_workspace_enabled_at is not None
    repeated = resolve_oidc_user(
        claims,
        author_workspace_enabled=False,
        require_editor_only=True,
    )
    assert repeated.user == resolved.user
    assert repeated.created is False

    writer = create_writer(django_user_model, "oidc-writer")
    writer_claims = {
        **claims,
        "sub": "writer-subject",
        "preferred_username": writer.username,
        "email": writer.email,
    }
    linked = resolve_oidc_user(
        writer_claims,
        author_workspace_enabled=False,
        require_editor_only=True,
    )
    assert linked.user == writer
    assert OidcIdentity.objects.filter(subject="writer-subject", user=writer).exists()


@pytest.mark.django_db
def test_oidc_invitation_callback_creates_editor_and_accepts_another_writer(
    client,
    django_user_model,
    monkeypatch,
):
    claims = {
        "iss": "https://idp.example.test/oidc",
        "sub": "callback-editor-subject",
        "preferred_username": "callback-editor",
        "email": "callback-editor@example.test",
        "email_verified": True,
    }
    writers = [create_writer(django_user_model, f"callback-writer-{index}") for index in range(2)]
    for writer in writers:
        invitation = EditorInvitation.objects.create(
            author=writer,
            expires_at=timezone.now() + timedelta(hours=48),
        )
        set_oidc_invitation_session(client, invitation)
        monkeypatch.setattr(
            "apps.accounts.views.oidc_client",
            lambda: FakeOidcClient(claims),
        )

        response = client.get("/api/auth/oidc/callback/")

        assert response.status_code == 302
        assert response.url == "/manuscripts"

    editor = django_user_model.objects.get(username="callback-editor")
    assert editor.author_workspace_enabled_at is None
    assert OidcIdentity.objects.filter(user=editor, subject="callback-editor-subject").count() == 1
    assert EditorConnection.objects.filter(
        editor=editor,
        disconnected_at__isnull=True,
    ).count() == 2


@pytest.mark.django_db
def test_oidc_invitation_callback_activates_existing_writer_and_accepts(
    client,
    django_user_model,
    monkeypatch,
):
    invitation = EditorInvitation.objects.create(
        author=create_writer(django_user_model, "callback-inviter"),
        expires_at=timezone.now() + timedelta(hours=48),
    )
    writer = create_writer(django_user_model, "callback-existing-writer")
    claims = {
        "iss": "https://idp.example.test/oidc",
        "sub": "callback-writer-subject",
        "preferred_username": writer.username,
        "email": writer.email,
        "email_verified": True,
    }
    set_oidc_invitation_session(client, invitation)
    monkeypatch.setattr(
        "apps.accounts.views.oidc_client",
        lambda: FakeOidcClient(claims),
    )

    response = client.get("/api/auth/oidc/callback/")

    assert response.status_code == 302
    assert response.url == "/manuscripts"
    writer.refresh_from_db()
    assert writer.editor_workspace_enabled_at is not None
    assert OidcIdentity.objects.filter(subject="callback-writer-subject", user=writer).exists()
    assert EditorConnection.objects.filter(editor=writer).exists()


@pytest.mark.django_db
def test_invitation_generation_requires_an_available_auth_method(
    client,
    django_user_model,
    settings,
):
    writer = create_writer(django_user_model)
    client.force_login(writer)
    set_runtime_override("local_password_login_enabled", False)
    settings.OIDC_ENABLED = False

    response = client.post("/api/editor/invitations/", {}, content_type="application/json")

    assert response.status_code == 409
    assert response.json()["error"] == "editor_invitation_auth_unavailable"


@pytest.mark.django_db
def test_invitation_registration_respects_disabled_password_login(client, django_user_model):
    invitation = create_invitation(client, create_writer(django_user_model))
    client.logout()
    token = invitation["shareUrl"].split("#", 1)[1]
    assert client.post(
        "/api/editor/invitation-claim/",
        {"token": token},
        content_type="application/json",
    ).status_code == 200
    set_runtime_override("local_password_login_enabled", False)

    response = client.post(
        "/api/editor/invitation-claim/register/",
        {
            "username": "disabled-password-editor",
            "email": "disabled-password-editor@example.test",
            "password": PASSWORD,
        },
        content_type="application/json",
    )

    assert response.status_code == 403
    assert response.json()["error"] == "local_password_login_disabled"
    assert not django_user_model.objects.filter(username="disabled-password-editor").exists()


@pytest.mark.django_db
def test_editor_can_mark_notifications_but_does_not_receive_storage_reminders(
    client,
    django_user_model,
    monkeypatch,
):
    editor = create_editor(django_user_model)
    editor.timezone = "UTC"
    editor.save(update_fields=["timezone"])
    client.force_login(editor)

    assert client.post(
        "/api/notifications/read-all/",
        {},
        content_type="application/json",
    ).status_code == 200

    monkeypatch.setattr(
        "apps.notifications.tasks.tier_quotas",
        lambda _tier: {"storage_bytes": 1},
    )
    monkeypatch.setattr("apps.notifications.tasks.storage_usage_bytes", lambda _user: 1)
    _scan_account_reminders(timezone.now().replace(hour=10, minute=1))

    assert not Notification.objects.filter(
        recipient=editor,
        kind="service.storage_near_limit",
    ).exists()


@pytest.mark.django_db
def test_author_and_editor_deletion_cleanup(client, django_user_model):
    writer = create_writer(django_user_model)
    editor = create_editor(django_user_model)
    invitation = EditorInvitation.objects.create(
        author=writer,
        expires_at=timezone.now() + timedelta(hours=48),
    )
    connection = EditorConnection.objects.create(
        author=writer,
        editor=editor,
        invitation=invitation,
    )
    invitation.accepted_at = timezone.now()
    invitation.accepted_by = editor
    invitation.save(update_fields=["accepted_at", "accepted_by"])

    editor.delete()
    invitation.refresh_from_db()
    assert invitation.accepted_by is None
    assert not EditorConnection.objects.filter(pk=connection.pk).exists()
    client.force_login(writer)
    assert client.post(
        "/api/editor/invitations/",
        {},
        content_type="application/json",
    ).status_code == 201

    writer_id = writer.pk
    writer.delete()
    assert not EditorInvitation.objects.filter(author_id=writer_id).exists()


@pytest.mark.django_db
def test_product_admin_filters_editor_and_locks_role_and_tier(client, django_user_model):
    admin = django_user_model.objects.create_superuser(
        username="admin",
        email="admin@example.test",
        password=PASSWORD,
    )
    editor = create_editor(django_user_model)
    writer = create_writer(django_user_model)
    combined = create_writer(django_user_model, "combined-user")
    combined.editor_workspace_enabled_at = timezone.now()
    combined.save(update_fields=["editor_workspace_enabled_at"])
    client.force_login(admin)

    response = client.get("/api/admin/users/?role=editor")
    assert response.status_code == 200
    assert {item["id"] for item in response.json()["items"]} == {editor.id, combined.id}
    editor_payload = next(item for item in response.json()["items"] if item["id"] == editor.id)
    assert editor_payload["authorWorkspaceEnabled"] is False
    assert editor_payload["editorWorkspaceEnabled"] is True

    writer_filter = client.get("/api/admin/users/?role=writer")
    assert writer_filter.status_code == 200
    assert {item["id"] for item in writer_filter.json()["items"]} >= {
        admin.id,
        writer.id,
        combined.id,
    }
    combined_filter = client.get("/api/admin/users/?role=combined")
    assert combined_filter.status_code == 200
    assert [item["id"] for item in combined_filter.json()["items"]] == [combined.id]

    tier = client.patch(
        f"/api/admin/users/{editor.id}/tier/",
        {"tier": "author"},
        content_type="application/json",
    )
    assert tier.status_code == 409
    assert tier.json()["error"] == "editor_role_managed_by_invitation"
