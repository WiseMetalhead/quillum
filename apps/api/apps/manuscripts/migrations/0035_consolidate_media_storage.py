from __future__ import annotations

from hashlib import sha256
from pathlib import Path, PurePosixPath

import django.db.models.deletion
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import migrations, models, transaction

from apps.accounts.media import create_or_get_user_media, process_user_media
from apps.accounts.models import UserMediaAsset


LEGACY_IMAGE_PREFIXES = (
    "manuscripts/covers",
    "manuscripts/series-covers",
    "manuscripts/assets",
    "manuscripts/glossary-assets",
)
LEGACY_ROOT = "manuscripts"
LEGACY_EXPORT_PREFIX = "manuscripts/exports/"
LEGACY_EXPORT_DIRECTORY = "manuscripts/exports"


def _read(field) -> bytes:
    with field.open("rb") as source:
        return source.read()


def _delete_names(files: list[tuple[object, str]]) -> None:
    for storage, name in files:
        if storage.exists(name):
            storage.delete(name)


def _legacy_files(instance, field_names: tuple[str, ...]) -> list[tuple[object, str]]:
    return [
        (field.storage, field.name)
        for field_name in field_names
        if (field := getattr(instance, field_name))
    ]


def _consolidate_image(
    *,
    model,
    instance,
    owner_id: int,
    media_field: str,
    legacy_fields: tuple[str, ...],
    database_alias: str,
) -> tuple[bool, bool, int]:
    original = getattr(instance, legacy_fields[0])
    legacy_files = _legacy_files(instance, legacy_fields)
    legacy_bytes = sum(
        int(field.size or 0)
        for field_name in legacy_fields
        if (field := getattr(instance, field_name))
    )
    media_id = getattr(instance, f"{media_field}_id")

    if not original:
        if legacy_files:
            raise RuntimeError(
                f"{model._meta.label} id={instance.pk} has variants without a legacy original."
            )
        if media_id is None and media_field == "media":
            raise RuntimeError(
                f"{model._meta.label} id={instance.pk} has neither shared nor legacy media."
            )
        return False, False, 0

    original_bytes = _read(original)
    original_digest = sha256(original_bytes).hexdigest()
    created = False
    if media_id is None:
        user = get_user_model().objects.get(pk=owner_id)
        upload = SimpleUploadedFile(
            PurePosixPath(original.name).name,
            original_bytes,
            content_type=instance.content_type,
        )
        processed = process_user_media(upload, max_bytes=max(1, len(original_bytes)))
        media, created = create_or_get_user_media(user=user, processed=processed)
        media_id = media.pk
    else:
        media = UserMediaAsset.objects.get(pk=media_id)

    shared_original = _read(media.original)
    if sha256(shared_original).hexdigest() != original_digest:
        raise RuntimeError(
            f"{model._meta.label} id={instance.pk} legacy and shared originals differ."
        )

    update = {f"{media_field}_id": media_id}
    update.update({field_name: "" for field_name in legacy_fields})
    with transaction.atomic(using=database_alias):
        model.objects.using(database_alias).filter(pk=instance.pk).update(**update)
    _delete_names(legacy_files)
    return True, created, legacy_bytes


def _move_exports(ManuscriptExport, database_alias: str) -> tuple[int, int]:
    moved = 0
    moved_bytes = 0
    for export in ManuscriptExport.objects.using(database_alias).exclude(artifact="").iterator():
        artifact = export.artifact
        if not artifact.name.startswith(LEGACY_EXPORT_PREFIX):
            continue
        data = _read(artifact)
        target = f"exports/{artifact.name.removeprefix(LEGACY_EXPORT_PREFIX)}"
        stored_name = artifact.storage.save(target, ContentFile(data, name=Path(target).name))
        try:
            with artifact.storage.open(stored_name, "rb") as stored:
                copied = stored.read()
            if len(copied) != len(data) or sha256(copied).digest() != sha256(data).digest():
                raise RuntimeError(f"Export copy verification failed for id={export.pk}.")
            with transaction.atomic(using=database_alias):
                ManuscriptExport.objects.using(database_alias).filter(pk=export.pk).update(
                    artifact=stored_name
                )
        except Exception:
            artifact.storage.delete(stored_name)
            raise
        artifact.storage.delete(artifact.name)
        moved += 1
        moved_bytes += len(data)
    return moved, moved_bytes


def _storage_files(prefix: str):
    try:
        directories, files = default_storage.listdir(prefix)
    except OSError:
        return
    for file_name in files:
        yield f"{prefix.rstrip('/')}/{file_name}"
    for directory in directories:
        yield from _storage_files(f"{prefix.rstrip('/')}/{directory}")


def _purge_legacy_root() -> tuple[int, int]:
    deleted = 0
    deleted_bytes = 0
    for prefix in (*LEGACY_IMAGE_PREFIXES, LEGACY_EXPORT_DIRECTORY):
        for name in list(_storage_files(prefix)):
            try:
                deleted_bytes += int(default_storage.size(name))
            except (OSError, ValueError):
                pass
            default_storage.delete(name)
            deleted += 1

    unexpected = list(_storage_files(LEGACY_ROOT))
    if unexpected:
        raise RuntimeError(
            "Unexpected files remain under the legacy manuscripts storage root: "
            + ", ".join(unexpected[:10])
        )

    root = Path(settings.MEDIA_ROOT) / LEGACY_ROOT
    if root.exists():
        for directory in sorted(
            (item for item in root.rglob("*") if item.is_dir()),
            key=lambda item: len(item.parts),
            reverse=True,
        ):
            directory.rmdir()
        root.rmdir()
    return deleted, deleted_bytes


def consolidate_media(apps, schema_editor) -> None:
    database_alias = schema_editor.connection.alias
    if database_alias != "default":
        raise RuntimeError("Media consolidation supports only the configured default database.")

    Manuscript = apps.get_model("manuscripts", "Manuscript")
    Series = apps.get_model("manuscripts", "Series")
    ManuscriptAsset = apps.get_model("manuscripts", "ManuscriptAsset")
    GlossaryAsset = apps.get_model("manuscripts", "GlossaryAsset")
    ManuscriptExport = apps.get_model("manuscripts", "ManuscriptExport")

    migrated = 0
    created = 0
    legacy_bytes = 0
    sources = (
        (
            Manuscript,
            Manuscript.objects.using(database_alias).select_related("workspace"),
            lambda item: item.workspace.owner_id,
            "cover_media",
            ("cover_original", "cover_thumbnail_small", "cover_thumbnail_medium"),
        ),
        (
            Series,
            Series.objects.using(database_alias).select_related("workspace"),
            lambda item: item.workspace.owner_id,
            "cover_media",
            ("cover_original", "cover_thumbnail_small", "cover_thumbnail_medium"),
        ),
        (
            ManuscriptAsset,
            ManuscriptAsset.objects.using(database_alias).select_related("manuscript__workspace"),
            lambda item: item.manuscript.workspace.owner_id,
            "media",
            ("original", "editor_medium", "editor_large"),
        ),
        (
            GlossaryAsset,
            GlossaryAsset.objects.using(database_alias).select_related(
                "article__glossary__manuscript__workspace",
                "article__glossary__series__workspace",
            ),
            lambda item: (
                item.article.glossary.manuscript.workspace.owner_id
                if item.article.glossary.manuscript_id
                else item.article.glossary.series.workspace.owner_id
            ),
            "media",
            ("original", "editor_medium", "editor_large"),
        ),
    )
    for model, queryset, owner_id, media_field, legacy_fields in sources:
        for instance in queryset.iterator():
            did_migrate, did_create, byte_count = _consolidate_image(
                model=model,
                instance=instance,
                owner_id=owner_id(instance),
                media_field=media_field,
                legacy_fields=legacy_fields,
                database_alias=database_alias,
            )
            migrated += int(did_migrate)
            created += int(did_create)
            legacy_bytes += byte_count

    moved_exports, moved_export_bytes = _move_exports(ManuscriptExport, database_alias)
    deleted_files, deleted_bytes = _purge_legacy_root()
    print(
        "Media consolidation complete: "
        f"attachments={migrated}, new_shared_media={created}, "
        f"legacy_attachment_bytes={legacy_bytes}, exports={moved_exports}, "
        f"export_bytes={moved_export_bytes}, purged_files={deleted_files}, "
        f"purged_bytes={deleted_bytes}."
    )


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("accounts", "0023_finalize_plaintext"),
        ("manuscripts", "0034_finalize_plaintext"),
    ]

    operations = [
        migrations.RunPython(consolidate_media, migrations.RunPython.noop),
        migrations.RemoveField(model_name="glossaryasset", name="editor_large"),
        migrations.RemoveField(model_name="glossaryasset", name="editor_medium"),
        migrations.RemoveField(model_name="glossaryasset", name="original"),
        migrations.RemoveField(model_name="manuscript", name="cover_original"),
        migrations.RemoveField(model_name="manuscript", name="cover_thumbnail_medium"),
        migrations.RemoveField(model_name="manuscript", name="cover_thumbnail_small"),
        migrations.RemoveField(model_name="manuscriptasset", name="editor_large"),
        migrations.RemoveField(model_name="manuscriptasset", name="editor_medium"),
        migrations.RemoveField(model_name="manuscriptasset", name="original"),
        migrations.RemoveField(model_name="series", name="cover_original"),
        migrations.RemoveField(model_name="series", name="cover_thumbnail_medium"),
        migrations.RemoveField(model_name="series", name="cover_thumbnail_small"),
        migrations.AlterField(
            model_name="glossaryasset",
            name="media",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="glossary_attachments",
                to="accounts.usermediaasset",
            ),
        ),
        migrations.AlterField(
            model_name="manuscript",
            name="cover_media",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="manuscript_covers",
                to="accounts.usermediaasset",
            ),
        ),
        migrations.AlterField(
            model_name="manuscriptasset",
            name="media",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="manuscript_attachments",
                to="accounts.usermediaasset",
            ),
        ),
        migrations.AlterField(
            model_name="manuscriptexport",
            name="artifact",
            field=models.FileField(blank=True, upload_to="exports/%Y/%m/"),
        ),
        migrations.AlterField(
            model_name="series",
            name="cover_media",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="series_covers",
                to="accounts.usermediaasset",
            ),
        ),
    ]
