from __future__ import annotations

import uuid

from django.db import transaction
from django.db.models import F, Max
from django.utils import timezone

from apps.accounts.models import UserMediaAsset

from .models import (
    Document,
    Manuscript,
    ManuscriptAsset,
    ManuscriptItem,
    Series,
    SeriesMembership,
    Workspace,
)
from .text_import import ImportPlan

MAX_FOLDER_DEPTH = 3


class InvalidStructure(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _clear_cover(entity: Manuscript | Series) -> None:
    entity.cover_content_type = ""
    entity.cover_width = None
    entity.cover_height = None
    entity.cover_media = None
    entity.save(
        update_fields=[
            "cover_content_type",
            "cover_width",
            "cover_height",
            "cover_media",
            "updated_at",
        ]
    )


def _apply_cover(
    entity: Manuscript | Series,
    cover: UserMediaAsset,
) -> None:
    entity.cover_media = cover
    entity.cover_content_type = cover.content_type
    entity.cover_width = cover.width
    entity.cover_height = cover.height
    entity.save(
        update_fields=[
            "cover_media",
            "cover_content_type",
            "cover_width",
            "cover_height",
            "updated_at",
        ]
    )


def create_oneshot(
    *,
    user,
    title: str,
    synopsis: str,
    cover: UserMediaAsset | None,
    language: str = "",
    genres: list[str] | None = None,
) -> Manuscript:
    with transaction.atomic():
        workspace = Workspace.objects.create(owner=user)
        manuscript = Manuscript.objects.create(
            workspace=workspace,
            kind=Manuscript.KIND_ONESHOT,
            title=title,
            synopsis=synopsis,
            language=language,
            genres=genres or [],
        )
        item = ManuscriptItem.objects.create(
            manuscript=manuscript,
            kind=ManuscriptItem.KIND_DOCUMENT,
            title=title,
        )
        Document.objects.create(
            manuscript=manuscript,
            item=item,
            content=Document.EMPTY_DOCUMENT,
        )
        if cover is not None:
            _apply_cover(manuscript, cover)
        return manuscript


def create_imported_oneshot(
    *,
    user,
    title: str,
    synopsis: str,
    cover: UserMediaAsset | None,
    import_plan: ImportPlan,
    language: str = "",
    genres: list[str] | None = None,
) -> Manuscript:
    imported = next(node for node in import_plan.nodes if node.kind == "document")
    with transaction.atomic():
        workspace = Workspace.objects.create(owner=user)
        manuscript = Manuscript.objects.create(
            workspace=workspace,
            kind=Manuscript.KIND_ONESHOT,
            title=title,
            synopsis=synopsis,
            language=language,
            genres=genres or [],
        )
        item = ManuscriptItem.objects.create(
            manuscript=manuscript,
            kind=ManuscriptItem.KIND_DOCUMENT,
            title=title,
        )
        Document.objects.create(
            manuscript=manuscript,
            item=item,
            content=imported.content,
        )
        if cover is not None:
            _apply_cover(manuscript, cover)
        return manuscript


def update_manuscript_metadata(
    *,
    manuscript: Manuscript,
    title: str,
    synopsis: str,
    cover: UserMediaAsset | None,
    remove_cover: bool,
    language: str | None = None,
    genres: list[str] | None = None,
) -> Manuscript:
    with transaction.atomic():
        manuscript.title = title
        manuscript.synopsis = synopsis
        update_fields = ["title", "synopsis", "updated_at"]
        if language is not None:
            manuscript.language = language
            update_fields.append("language")
        if genres is not None:
            manuscript.genres = genres
            update_fields.append("genres")
        manuscript.save(update_fields=update_fields)
        if manuscript.kind == Manuscript.KIND_ONESHOT:
            item = manuscript.documents.select_related("item__manuscript__workspace").get().item
            item.title = title
            item.save(update_fields=["title", "updated_at"])
        if cover is not None:
            _apply_cover(manuscript, cover)
        elif remove_cover:
            _clear_cover(manuscript)
    return manuscript


def delete_manuscript(manuscript: Manuscript) -> None:
    workspace_id = manuscript.workspace_id
    series_id = (
        SeriesMembership.objects.filter(manuscript=manuscript)
        .values_list("series_id", flat=True)
        .first()
    )
    with transaction.atomic():
        manuscript.delete()
        if not Manuscript.objects.filter(workspace_id=workspace_id).exists():
            Workspace.objects.filter(id=workspace_id).delete()
        if series_id is not None:
            Series.objects.filter(id=series_id).update(updated_at=timezone.now())


def create_series(*, user, title: str, synopsis: str, cover: UserMediaAsset | None) -> Series:
    with transaction.atomic():
        workspace = Workspace.objects.create(owner=user)
        series = Series.objects.create(
            workspace=workspace,
            title=title,
            synopsis=synopsis,
        )
        if cover is not None:
            _apply_cover(series, cover)
        return series


def update_series_metadata(
    *,
    series: Series,
    title: str,
    synopsis: str,
    cover: UserMediaAsset | None,
    remove_cover: bool,
) -> Series:
    with transaction.atomic():
        series.title = title
        series.synopsis = synopsis
        series.save(update_fields=["title", "synopsis", "updated_at"])
        if cover is not None:
            _apply_cover(series, cover)
        elif remove_cover:
            _clear_cover(series)
    return series


def delete_series(series: Series) -> None:
    workspace_id = series.workspace_id
    with transaction.atomic():
        if series.drawer_at is not None:
            Manuscript.objects.filter(series_membership__series=series).update(
                drawer_at=series.drawer_at,
            )
        series.delete()
        Workspace.objects.filter(id=workspace_id).delete()


def _next_position(manuscript: Manuscript, parent: ManuscriptItem | None) -> int:
    maximum = ManuscriptItem.objects.filter(
        manuscript=manuscript,
        parent=parent,
        trashed_at__isnull=True,
    ).aggregate(value=Max("position"))["value"]
    return (maximum or 0) + ManuscriptItem.POSITION_STEP


def _create_item(
    *,
    manuscript: Manuscript,
    parent: ManuscriptItem | None,
    kind: str,
    title: str,
    planner_role: str = "untyped",
) -> ManuscriptItem:
    item = ManuscriptItem.objects.create(
        manuscript=manuscript,
        parent=parent,
        kind=kind,
        title=title,
        position=_next_position(manuscript, parent),
    )
    if planner_role != "untyped":
        metadata = item.planner_metadata
        metadata["role"] = planner_role
        item.planner_metadata = metadata
        item.save(update_fields=["planner_metadata"])
    if kind == ManuscriptItem.KIND_DOCUMENT:
        Document.objects.create(
            manuscript=manuscript,
            item=item,
            content=Document.EMPTY_DOCUMENT,
        )
    return item


def create_book(
    *,
    user,
    title: str,
    synopsis: str,
    template: str,
    cover: UserMediaAsset | None,
    language: str = "en",
    manuscript_language: str = "",
    genres: list[str] | None = None,
    series: Series | None = None,
    series_position: int | None = None,
) -> Manuscript:
    chapter_title = "Глава 1" if language == "ru" else "Chapter 1"
    scene_title = "Сцена 1" if language == "ru" else "Scene 1"
    with transaction.atomic():
        workspace = Workspace.objects.create(owner=user)
        manuscript = Manuscript.objects.create(
            workspace=workspace,
            kind=Manuscript.KIND_BOOK,
            title=title,
            synopsis=synopsis,
            language=manuscript_language,
            genres=genres or [],
        )
        if template == "chapters":
            _create_item(
                manuscript=manuscript,
                parent=None,
                kind=ManuscriptItem.KIND_DOCUMENT,
                title=chapter_title,
                planner_role="chapter",
            )
        elif template == "scenes":
            chapter = _create_item(
                manuscript=manuscript,
                parent=None,
                kind=ManuscriptItem.KIND_FOLDER,
                title=chapter_title,
                planner_role="chapter",
            )
            _create_item(
                manuscript=manuscript,
                parent=chapter,
                kind=ManuscriptItem.KIND_DOCUMENT,
                title=scene_title,
                planner_role="scene",
            )
        else:
            raise InvalidStructure("book_template_invalid")
        if series is not None:
            if series_position is not None and series_position < 1:
                raise InvalidStructure("series_position_invalid")
            SeriesMembership.objects.create(
                series=series,
                manuscript=manuscript,
                position=series_position,
            )
        if cover is not None:
            _apply_cover(manuscript, cover)
        return manuscript


def create_imported_book(
    *,
    user,
    title: str,
    synopsis: str,
    cover: UserMediaAsset | None,
    import_plan: ImportPlan,
    language: str = "",
    genres: list[str] | None = None,
    series: Series | None = None,
    series_position: int | None = None,
) -> Manuscript:
    with transaction.atomic():
        workspace = Workspace.objects.create(owner=user)
        manuscript = Manuscript.objects.create(
            workspace=workspace,
            kind=Manuscript.KIND_BOOK,
            title=title,
            synopsis=synopsis,
            language=language,
            genres=genres or [],
        )
        children: dict[str | None, list] = {}
        for node in import_plan.nodes:
            children.setdefault(node.parent_id, []).append(node)
        created: dict[str, ManuscriptItem] = {}

        def create_children(parent_id: str | None, parent: ManuscriptItem | None) -> None:
            for node in sorted(children.get(parent_id, []), key=lambda item: item.order):
                item = ManuscriptItem.objects.create(
                    manuscript=manuscript,
                    parent=parent,
                    kind=(
                        ManuscriptItem.KIND_FOLDER
                        if node.kind == "folder"
                        else ManuscriptItem.KIND_DOCUMENT
                    ),
                    title=node.title,
                    position=(len(created) + 1) * ManuscriptItem.POSITION_STEP,
                )
                created[node.node_id] = item
                if node.kind == "document":
                    Document.objects.create(
                        manuscript=manuscript,
                        item=item,
                        content=node.content,
                    )
                else:
                    create_children(node.node_id, item)

        create_children(None, None)
        if len(created) != len(import_plan.nodes):
            raise InvalidStructure("import_structure_invalid")
        if series is not None:
            if series_position is not None and series_position < 1:
                raise InvalidStructure("series_position_invalid")
            SeriesMembership.objects.create(
                series=series,
                manuscript=manuscript,
                position=series_position,
            )
        if cover is not None:
            _apply_cover(manuscript, cover)
        return manuscript


def _folder_depth(item: ManuscriptItem | None) -> int:
    depth = 0
    current = item
    while current is not None:
        if current.kind == ManuscriptItem.KIND_FOLDER:
            depth += 1
        current = current.parent
    return depth


@transaction.atomic
def create_book_item(
    *,
    manuscript: Manuscript,
    parent: ManuscriptItem | None,
    kind: str,
    title: str,
    planner_role: str = "untyped",
) -> ManuscriptItem:
    if kind not in {ManuscriptItem.KIND_FOLDER, ManuscriptItem.KIND_DOCUMENT}:
        raise InvalidStructure("book_item_kind_invalid")
    if parent is not None:
        if parent.manuscript_id != manuscript.id or parent.trashed_at is not None:
            raise InvalidStructure("book_parent_not_found")
        if parent.kind != ManuscriptItem.KIND_FOLDER:
            raise InvalidStructure("book_parent_invalid")
    if kind == ManuscriptItem.KIND_FOLDER and _folder_depth(parent) >= MAX_FOLDER_DEPTH:
        raise InvalidStructure("book_max_depth_exceeded")
    item = _create_item(
        manuscript=manuscript,
        parent=parent,
        kind=kind,
        title=title,
        planner_role=planner_role,
    )
    Manuscript.objects.filter(id=manuscript.id).update(
        structure_generation=F("structure_generation") + 1,
        updated_at=timezone.now(),
    )
    return item


def _subtree_ids(root: ManuscriptItem) -> list[int]:
    items = list(ManuscriptItem.objects.filter(manuscript_id=root.manuscript_id))
    child_ids: dict[int | None, list[int]] = {}
    for item in items:
        child_ids.setdefault(item.parent_id, []).append(item.id)
    result: list[int] = []
    pending = [root.id]
    while pending:
        item_id = pending.pop()
        result.append(item_id)
        pending.extend(child_ids.get(item_id, []))
    return result


def _subtree_folder_height(root: ManuscriptItem) -> int:
    items = {
        item.id: item for item in ManuscriptItem.objects.filter(manuscript_id=root.manuscript_id)
    }
    children: dict[int, list[int]] = {}
    for item in items.values():
        if item.parent_id is not None:
            children.setdefault(item.parent_id, []).append(item.id)

    def height(item_id: int) -> int:
        own = 1 if items[item_id].kind == ManuscriptItem.KIND_FOLDER else 0
        return own + max((height(child_id) for child_id in children.get(item_id, [])), default=0)

    return height(root.id)


@transaction.atomic
def trash_book_item(item: ManuscriptItem) -> None:
    now = timezone.now()
    batch_id = uuid.uuid4()
    subtree_ids = _subtree_ids(item)
    ManuscriptItem.objects.filter(id__in=subtree_ids).update(
        trashed_at=now,
        trash_batch_id=batch_id,
    )
    ManuscriptItem.objects.filter(id=item.id).update(
        previous_parent_id=item.parent_id,
        previous_position=item.position,
        parent=None,
    )
    Manuscript.objects.filter(id=item.manuscript_id).update(
        structure_generation=F("structure_generation") + 1,
        updated_at=now,
    )


@transaction.atomic
def restore_book_item(item: ManuscriptItem) -> None:
    if item.trashed_at is None or item.trash_batch_id is None:
        raise InvalidStructure("book_item_not_trashed")
    parent = item.previous_parent
    if parent is not None and parent.trashed_at is not None:
        parent = None
    if _folder_depth(parent) + _subtree_folder_height(item) > MAX_FOLDER_DEPTH:
        parent = None
    ManuscriptItem.objects.filter(trash_batch_id=item.trash_batch_id).update(
        trashed_at=None,
        trash_batch_id=None,
    )
    ManuscriptItem.objects.filter(id=item.id).update(
        parent=parent,
        position=item.previous_position or _next_position(item.manuscript, parent),
        previous_parent=None,
        previous_position=None,
    )
    Manuscript.objects.filter(id=item.manuscript_id).update(
        structure_generation=F("structure_generation") + 1,
        updated_at=timezone.now(),
    )


def create_manuscript_asset_from_media(
    *, manuscript: Manuscript, media: UserMediaAsset, alt_text: str, caption: str
) -> ManuscriptAsset:
    asset = ManuscriptAsset(
        manuscript=manuscript,
        media=media,
        content_type=media.content_type,
        width=media.width,
        height=media.height,
        byte_size=media.byte_size,
    )
    asset.alt_text = alt_text
    asset.caption = caption
    asset.save()
    return asset
