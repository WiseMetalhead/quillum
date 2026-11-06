from __future__ import annotations

from pathlib import PurePosixPath

from django.apps import apps
from django.core.files.storage import default_storage
from django.core.management.base import BaseCommand, CommandError
from django.db.models import FileField

CONFIRMATION = "DELETE-UNREFERENCED-MEDIA"


def _storage_files(prefix: str = ""):
    try:
        directories, files = default_storage.listdir(prefix)
    except OSError:
        return
    for file_name in files:
        yield f"{prefix.rstrip('/')}/{file_name}".lstrip("/")
    for directory in directories:
        child = f"{prefix.rstrip('/')}/{directory}".lstrip("/")
        yield from _storage_files(child)


def _referenced_names() -> set[str]:
    names: set[str] = set()
    for model in apps.get_models():
        for field in model._meta.fields:
            if not isinstance(field, FileField):
                continue
            names.update(
                str(name)
                for name in model.objects.exclude(**{field.name: ""}).values_list(
                    field.name, flat=True
                )
                if name
            )
    return names


def _validate_name(name: str) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise CommandError(f"Unsafe storage object name: {name}")


class Command(BaseCommand):
    help = "Audit MEDIA_ROOT objects against every database FileField reference."

    def add_arguments(self, parser):
        parser.add_argument("--delete", action="store_true")
        parser.add_argument("--confirm", default="")
        parser.add_argument("--show", type=int, default=20)

    def handle(self, *args, **options):
        delete = options["delete"]
        confirmation = options["confirm"]
        show = options["show"]
        if show < 0:
            raise CommandError("--show must be zero or greater.")
        if delete and confirmation != CONFIRMATION:
            raise CommandError(f"Deletion requires --confirm {CONFIRMATION}")

        referenced = _referenced_names()
        stored = set(_storage_files())
        missing = sorted(referenced - stored)
        unreferenced = sorted(stored - referenced)
        unreferenced_bytes = 0
        for name in unreferenced:
            _validate_name(name)
            try:
                unreferenced_bytes += int(default_storage.size(name))
            except (OSError, ValueError):
                pass

        self.stdout.write(
            f"Media audit: referenced={len(referenced)}, stored={len(stored)}, "
            f"missing={len(missing)}, unreferenced={len(unreferenced)}, "
            f"unreferenced_bytes={unreferenced_bytes}."
        )
        for name in missing[:show]:
            self.stdout.write(f"MISSING {name}")
        for name in unreferenced[:show]:
            self.stdout.write(f"UNREFERENCED {name}")

        if missing:
            raise CommandError("Referenced media objects are missing; refusing cleanup.")
        if not delete:
            self.stdout.write("Dry run only; no objects were deleted.")
            return

        for name in unreferenced:
            default_storage.delete(name)
        remaining = set(_storage_files()) - referenced
        if remaining:
            raise CommandError(
                f"Cleanup incomplete; {len(remaining)} unreferenced objects remain."
            )
        self.stdout.write(self.style.SUCCESS(f"Deleted {len(unreferenced)} objects."))
