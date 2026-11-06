from __future__ import annotations

import json

SUPPORTED_MANUSCRIPT_LANGUAGES = {
    "be",
    "bg",
    "cs",
    "de",
    "en",
    "es",
    "fr",
    "hr",
    "it",
    "ja",
    "ko",
    "pl",
    "pt",
    "ru",
    "sk",
    "sr",
    "uk",
    "zh",
}

# Product-facing identifiers stay independent from the FictionBook taxonomy.
MANUSCRIPT_GENRE_TO_FB2 = {
    "adventure": "adventure",
    "biography": "nonf_biography",
    "business": "popular_business",
    "children": "children",
    "crime": "det_crime",
    "cyberpunk": "sf_cyberpunk",
    "dark_fantasy": "sf_horror",
    "detective": "detective",
    "drama": "dramaturgy",
    "dystopia": "sf_social",
    "erotica": "love_erotica",
    "essays": "essays",
    "fairy_tale": "child_tale",
    "fanfiction": "unrecognised",
    "fantasy": "sf_fantasy",
    "historical_adventure": "adv_history",
    "historical_fantasy": "historical_fantasy",
    "historical_fiction": "prose_history",
    "historical_romance": "love_history",
    "horror": "sf_horror",
    "humor": "humor_prose",
    "literary_fiction": "unrecognised",
    "memoir": "nonf_biography",
    "mystery": "det_classic",
    "nonfiction": "nonfiction",
    "poetry": "poetry",
    "popular_science": "science",
    "religion": "religion",
    "romance": "love_contemporary",
    "satire": "humor",
    "science_fiction": "sf",
    "self_help": "psy_personal",
    "short_story": "short_story",
    "space_opera": "sf_space",
    "thriller": "thriller",
    "travel": "geo_guides",
    "urban_fantasy": "city_fantasy",
    "young_adult": "child_prose",
    "other": "unrecognised",
}

MAX_MANUSCRIPT_GENRES = 5


class InvalidManuscriptMetadata(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def normalize_manuscript_language(value: object) -> str:
    language = str(value or "").strip().lower()
    if language and language not in SUPPORTED_MANUSCRIPT_LANGUAGES:
        raise InvalidManuscriptMetadata("manuscript_language_unsupported")
    return language


def normalize_manuscript_genres(value: object) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise InvalidManuscriptMetadata("manuscript_genres_invalid") from exc
    if not isinstance(value, list):
        raise InvalidManuscriptMetadata("manuscript_genres_invalid")
    genres: list[str] = []
    for item in value:
        genre = str(item or "").strip()
        if genre not in MANUSCRIPT_GENRE_TO_FB2:
            raise InvalidManuscriptMetadata("manuscript_genre_unsupported")
        if genre not in genres:
            genres.append(genre)
    if len(genres) > MAX_MANUSCRIPT_GENRES:
        raise InvalidManuscriptMetadata("manuscript_genres_too_many")
    return genres
