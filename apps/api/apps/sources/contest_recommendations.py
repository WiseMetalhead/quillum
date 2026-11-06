from __future__ import annotations

from dataclasses import dataclass

from django.db.models import Q

from apps.manuscripts.media_cache import cover_cache_version
from apps.manuscripts.models import Document, Manuscript
from apps.manuscripts.versioning import document_statistics

from .models import ContestDetail, ContestItem, ContestParticipation, ContestStatus

RECOMMENDATION_SCORE_THRESHOLD = 35

BOOK_FORM_TERMS = ("роман", "книга", "novel", "book")
ONESHOT_FORM_TERMS = (
    "рассказ",
    "повесть",
    "стих",
    "поэм",
    "новелл",
    "short story",
    "story",
    "poem",
)

GENRE_GROUPS: tuple[tuple[tuple[str, ...], frozenset[str]], ...] = (
    (("романт", "любов", "romance"), frozenset({"romance", "historical_romance"})),
    (
        ("фэнтези", "fantasy"),
        frozenset({"fantasy", "dark_fantasy", "historical_fantasy", "urban_fantasy"}),
    ),
    (
        ("фантаст", "science fiction", "sci-fi"),
        frozenset({"science_fiction", "cyberpunk", "dystopia", "space_opera"}),
    ),
    (("детектив", "detective"), frozenset({"detective", "crime", "mystery"})),
    (("триллер", "thriller"), frozenset({"thriller", "crime", "mystery"})),
    (("приключ", "adventure"), frozenset({"adventure", "historical_adventure"})),
    (("ужас", "хоррор", "horror"), frozenset({"horror", "dark_fantasy"})),
    (
        ("истор", "historical"),
        frozenset(
            {
                "historical_adventure",
                "historical_fantasy",
                "historical_fiction",
                "historical_romance",
            }
        ),
    ),
    (("юмор", "комед", "humor", "comedy"), frozenset({"humor", "satire"})),
    (("поэз", "стих", "poetry"), frozenset({"poetry"})),
    (("рассказ", "short story"), frozenset({"short_story"})),
    (("детск", "children"), frozenset({"children", "fairy_tale", "young_adult"})),
    (("подрост", "young adult"), frozenset({"young_adult", "children"})),
    (("нон-фикшн", "нонфикшн", "nonfiction"), frozenset({"nonfiction"})),
)


@dataclass(frozen=True)
class ContestManuscriptRecommendation:
    manuscript: Manuscript
    character_count: int
    score: int
    participating: bool
    tracking_enabled: bool
    can_participate: bool


def _normalized(value: object) -> str:
    return " ".join(str(value or "").casefold().replace("ё", "е").split())


def _fact_map(contest: ContestItem) -> dict[str, dict[str, object]]:
    try:
        facts = contest.detail.condition_facts
    except ContestDetail.DoesNotExist:
        return {}
    return {
        str(fact.get("kind")): fact
        for fact in facts
        if isinstance(fact, dict) and isinstance(fact.get("kind"), str)
    }


def contest_max_works(contest: ContestItem) -> int | None:
    value = _fact_map(contest).get("max_works", {}).get("value")
    return value if isinstance(value, int) and value > 0 else None


def _accepted_manuscript_kinds(form_value: object) -> set[str]:
    normalized = _normalized(form_value)
    kinds: set[str] = set()
    if any(term in normalized for term in BOOK_FORM_TERMS):
        kinds.add(Manuscript.KIND_BOOK)
    if any(term in normalized for term in ONESHOT_FORM_TERMS):
        kinds.add(Manuscript.KIND_ONESHOT)
    return kinds


def _genre_score(genre_value: object, manuscript_genres: list[str]) -> int:
    normalized = _normalized(genre_value)
    groups = [genres for terms, genres in GENRE_GROUPS if any(term in normalized for term in terms)]
    if not groups:
        return 0
    selected = set(manuscript_genres)
    matched = sum(bool(selected & group) for group in groups)
    if matched == len(groups):
        return 40
    if matched:
        return 18
    return -35 if selected else -10


def _length_score(facts: dict[str, dict[str, object]], character_count: int) -> int:
    submission_minimum = facts.get("submission_length", {}).get("min")
    final_minimum = facts.get("length", {}).get("min")
    final_maximum = facts.get("length", {}).get("max")
    if isinstance(submission_minimum, int) and submission_minimum > 0:
        if character_count >= submission_minimum:
            score = 25
        elif character_count >= submission_minimum * 0.8:
            score = 5
        else:
            score = -20
        if isinstance(final_maximum, int) and final_maximum > 0 and character_count > final_maximum:
            return -30
        return score
    if isinstance(final_minimum, int) and isinstance(final_maximum, int):
        if final_minimum <= character_count <= final_maximum:
            return 25
        if character_count < final_minimum:
            return 5
        return -30
    return 0


def _recommendation_score(
    manuscript: Manuscript,
    character_count: int,
    facts: dict[str, dict[str, object]],
) -> int | None:
    accepted_kinds = _accepted_manuscript_kinds(facts.get("form", {}).get("value"))
    if accepted_kinds and manuscript.kind not in accepted_kinds:
        return None
    score = 40 if accepted_kinds else 0
    score += _genre_score(facts.get("genre", {}).get("value"), manuscript.genres)
    score += _length_score(facts, character_count)
    return score


def contest_manuscript_recommendations(
    contest: ContestItem,
    user,
) -> list[ContestManuscriptRecommendation]:
    participation_by_manuscript = dict(
        ContestParticipation.objects.filter(
            contest=contest,
            manuscript__workspace__owner=user,
        ).values_list("manuscript_id", "track_deadlines")
    )
    participating_ids = set(participation_by_manuscript)
    manuscripts = list(
        Manuscript.objects.filter(workspace__owner=user)
        .filter(Q(drawer_at__isnull=True) | Q(id__in=participating_ids))
        .select_related("cover_media")
    )
    character_counts = {manuscript.id: 0 for manuscript in manuscripts}
    documents = Document.objects.filter(
        manuscript_id__in=character_counts,
    ).filter(Q(item__isnull=True) | Q(item__trashed_at__isnull=True))
    for document in documents:
        character_counts[document.manuscript_id] += document_statistics(document.content)[1]

    facts = _fact_map(contest)
    participation_count = len(participating_ids)
    maximum = contest_max_works(contest)
    can_add = contest.status == ContestStatus.ACCEPTING and (
        maximum is None or participation_count < maximum
    )
    recommendations: list[ContestManuscriptRecommendation] = []
    for manuscript in manuscripts:
        participating = manuscript.id in participating_ids
        score = _recommendation_score(manuscript, character_counts[manuscript.id], facts)
        if not participating and (
            contest.status != ContestStatus.ACCEPTING
            or score is None
            or score < RECOMMENDATION_SCORE_THRESHOLD
        ):
            continue
        recommendations.append(
            ContestManuscriptRecommendation(
                manuscript=manuscript,
                character_count=character_counts[manuscript.id],
                score=score or 0,
                participating=participating,
                tracking_enabled=participation_by_manuscript.get(manuscript.id, False),
                can_participate=participating or can_add,
            )
        )
    return sorted(
        recommendations,
        key=lambda item: (
            not item.participating,
            -item.score,
            item.manuscript.title.casefold(),
            item.manuscript.id,
        ),
    )


def contest_manuscript_payload(item: ContestManuscriptRecommendation) -> dict[str, object]:
    manuscript = item.manuscript
    return {
        "id": str(manuscript.public_id),
        "kind": manuscript.kind,
        "title": manuscript.title,
        "characterCount": item.character_count,
        "coverThumbnailSmallUrl": (
            f"/api/manuscripts/{manuscript.public_id}/cover/small/"
            if manuscript.cover_media_id
            else ""
        ),
        "coverVersion": cover_cache_version(manuscript),
        "participating": item.participating,
        "trackingEnabled": item.tracking_enabled,
        "canParticipate": item.can_participate,
    }
