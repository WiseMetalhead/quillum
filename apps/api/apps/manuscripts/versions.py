from __future__ import annotations

import json

from django.db import transaction
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from apps.accounts.tiers import document_version_limit
from apps.audit.service import write_audit_event

from .annotations import _annotation_payload
from .document_schema import annotation_ids
from .models import Document, DocumentAnnotation, DocumentVersion, Manuscript
from .versioning import (
    REVISION_DESCRIPTION_MAX_LENGTH,
    REVISION_NAME_MAX_LENGTH,
    VersionAssetMissing,
    VersionLimitReached,
    create_revision,
    restore_version,
)
from .views import document_payload


def _read_json(request):
    try:
        value = json.loads(request.body.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _document_for_owner(manuscript_id: int, user, item_id=None):
    query = Document.objects.filter(
        manuscript_id=manuscript_id,
        manuscript__workspace__owner=user,
    )
    if item_id is None:
        query = query.filter(manuscript__kind=Manuscript.KIND_ONESHOT)
    else:
        query = query.filter(
            manuscript__kind=Manuscript.KIND_BOOK,
            item__public_id=item_id,
            item__trashed_at__isnull=True,
        )
    return query.select_related("manuscript__workspace").first()


def _version_for_owner(version_id, user):
    return DocumentVersion.objects.filter(
        public_id=version_id,
        document__manuscript__workspace__owner=user,
    ).select_related("document__manuscript__workspace").first()


def version_payload(version: DocumentVersion) -> dict:
    return {
        "id": str(version.public_id),
        "kind": version.kind,
        "name": version.name if version.kind == DocumentVersion.KIND_REVISION else "",
        "description": (
            version.description if version.kind == DocumentVersion.KIND_REVISION else ""
        ),
        "schemaVersion": version.schema_version,
        "wordCount": version.word_count,
        "characterCount": version.character_count,
        "authorSheets": version.character_count / 40_000,
        "metadataVersion": version.metadata_version,
        "createdAt": version.created_at.isoformat(),
        "updatedAt": version.updated_at.isoformat(),
    }


@require_http_methods(["GET", "POST"])
def document_versions(request, manuscript_id: int, item_id=None):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    document = _document_for_owner(manuscript_id, request.user, item_id)
    if document is None:
        return JsonResponse({"error": "manuscript_not_found"}, status=404)

    if request.method == "GET":
        versions = DocumentVersion.objects.filter(document=document).select_related(
            "document__manuscript__workspace"
        )
        return JsonResponse(
            {
                "items": [version_payload(version) for version in versions],
                "limits": {
                    "drafts": document_version_limit(request.user, "drafts_per_document"),
                    "revisions": document_version_limit(
                        request.user,
                        "revisions_per_document",
                    ),
                },
            }
        )

    payload = _read_json(request)
    if payload is None or not set(payload).issubset(
        {"name", "description", "expectedGeneration"}
    ):
        return JsonResponse({"error": "revision_invalid"}, status=400)
    name = payload.get("name")
    description = payload.get("description", "")
    expected_generation = payload.get("expectedGeneration")
    if not isinstance(name, str) or not name.strip():
        return JsonResponse({"error": "revision_name_required"}, status=400)
    if len(name.strip()) > REVISION_NAME_MAX_LENGTH:
        return JsonResponse({"error": "revision_name_too_long"}, status=400)
    if not isinstance(description, str):
        return JsonResponse({"error": "revision_description_invalid"}, status=400)
    if len(description.strip()) > REVISION_DESCRIPTION_MAX_LENGTH:
        return JsonResponse({"error": "revision_description_too_long"}, status=400)
    if isinstance(expected_generation, bool) or not isinstance(expected_generation, int):
        return JsonResponse({"error": "save_generation_required"}, status=400)
    try:
        version = create_revision(
            document.id,
            expected_generation=expected_generation,
            name=name.strip(),
            description=description.strip(),
        )
    except VersionLimitReached:
        return JsonResponse({"error": "revision_limit_reached"}, status=409)
    if version is None:
        document.refresh_from_db()
        return JsonResponse(
            {
                "error": "document_save_conflict",
                "saveGeneration": document.save_generation,
            },
            status=409,
        )
    write_audit_event(
        request,
        "manuscript.revision_created",
        actor=request.user,
        subject=f"manuscript:{manuscript_id}",
        payload={"versionId": str(version.public_id)},
    )
    return JsonResponse({"version": version_payload(version)}, status=201)


@require_http_methods(["GET", "PATCH", "DELETE"])
def version_detail(request, version_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    version = _version_for_owner(version_id, request.user)
    if version is None:
        return JsonResponse({"error": "version_not_found"}, status=404)

    if request.method == "GET":
        snapshot = version.snapshot
        return JsonResponse(
            {
                "version": version_payload(version),
                "content": snapshot["content"],
                "annotations": snapshot.get("annotations", []),
                "currentContent": version.document.content,
            }
        )

    if version.kind != DocumentVersion.KIND_REVISION:
        return JsonResponse({"error": "draft_mutation_forbidden"}, status=403)
    payload = _read_json(request)
    if payload is None:
        return JsonResponse({"error": "invalid_json"}, status=400)

    if request.method == "DELETE":
        if set(payload) != {"expectedVersion"}:
            return JsonResponse({"error": "revision_delete_invalid"}, status=400)
        with transaction.atomic():
            locked = DocumentVersion.objects.select_for_update().get(id=version.id)
            if payload["expectedVersion"] != locked.metadata_version:
                return JsonResponse({"error": "revision_update_conflict"}, status=409)
            manuscript_id = locked.document.manuscript_id
            locked.delete()
        write_audit_event(
            request,
            "manuscript.revision_deleted",
            actor=request.user,
            subject=f"manuscript:{manuscript_id}",
            payload={"versionId": str(version_id)},
        )
        return JsonResponse({"ok": True})

    allowed = {"name", "description", "expectedVersion"}
    if not set(payload).issubset(allowed) or "expectedVersion" not in payload:
        return JsonResponse({"error": "revision_update_invalid"}, status=400)
    with transaction.atomic():
        version = DocumentVersion.objects.select_for_update().select_related(
            "document__manuscript__workspace"
        ).get(id=version.id)
        if payload["expectedVersion"] != version.metadata_version:
            return JsonResponse({"error": "revision_update_conflict"}, status=409)
        update_fields = []
        if "name" in payload:
            if not isinstance(payload["name"], str) or not payload["name"].strip():
                return JsonResponse({"error": "revision_name_required"}, status=400)
            if len(payload["name"].strip()) > REVISION_NAME_MAX_LENGTH:
                return JsonResponse({"error": "revision_name_too_long"}, status=400)
            version.name = payload["name"].strip()
            update_fields.append("name")
        if "description" in payload:
            if not isinstance(payload["description"], str):
                return JsonResponse({"error": "revision_description_invalid"}, status=400)
            if len(payload["description"].strip()) > REVISION_DESCRIPTION_MAX_LENGTH:
                return JsonResponse({"error": "revision_description_too_long"}, status=400)
            version.description = payload["description"].strip()
            update_fields.append("description")
        if not update_fields:
            return JsonResponse({"error": "revision_update_invalid"}, status=400)
        version.metadata_version += 1
        version.save(update_fields=[*update_fields, "metadata_version", "updated_at"])
    return JsonResponse({"version": version_payload(version)})


@require_http_methods(["POST"])
def restore_document_version(request, version_id):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "authentication_required"}, status=401)
    version = _version_for_owner(version_id, request.user)
    if version is None:
        return JsonResponse({"error": "version_not_found"}, status=404)
    payload = _read_json(request)
    if payload is None or set(payload) != {"expectedGeneration"}:
        return JsonResponse({"error": "version_restore_invalid"}, status=400)
    expected_generation = payload["expectedGeneration"]
    if isinstance(expected_generation, bool) or not isinstance(expected_generation, int):
        return JsonResponse({"error": "save_generation_required"}, status=400)
    try:
        document = restore_version(version.id, expected_generation=expected_generation)
    except VersionAssetMissing:
        return JsonResponse({"error": "version_asset_missing"}, status=409)
    if document is None:
        version.document.refresh_from_db()
        return JsonResponse(
            {
                "error": "document_save_conflict",
                "saveGeneration": version.document.save_generation,
            },
            status=409,
        )
    anchored_ids = annotation_ids(document.content)
    annotations = DocumentAnnotation.objects.filter(document=document).select_related(
        "document__manuscript__workspace", "author", "resolved_by"
    ).prefetch_related("replies__author")
    write_audit_event(
        request,
        "manuscript.version_restored",
        actor=request.user,
        subject=f"manuscript:{document.manuscript.public_id}",
        payload={"versionId": str(version.public_id), "kind": version.kind},
    )
    return JsonResponse(
        {
            "document": document_payload(document),
            "annotations": [
                _annotation_payload(item, request.user, anchored_ids) for item in annotations
            ],
        }
    )
