export const MANUSCRIPT_LANGUAGES = [
  'ru', 'en', 'uk', 'be', 'pl', 'de', 'fr', 'es', 'it', 'pt', 'cs', 'sk', 'bg', 'sr', 'hr',
  'zh', 'ja', 'ko',
] as const

export const MANUSCRIPT_GENRES = [
  'adventure', 'biography', 'business', 'children', 'crime', 'cyberpunk', 'dark_fantasy',
  'detective', 'drama', 'dystopia', 'erotica', 'essays', 'fairy_tale', 'fanfiction', 'fantasy',
  'historical_adventure', 'historical_fantasy', 'historical_fiction', 'historical_romance',
  'horror', 'humor', 'literary_fiction', 'memoir', 'mystery', 'nonfiction', 'poetry',
  'popular_science', 'religion', 'romance', 'satire', 'science_fiction', 'self_help',
  'short_story', 'space_opera', 'thriller', 'travel', 'urban_fantasy', 'young_adult', 'other',
] as const

export type ManuscriptLanguage = (typeof MANUSCRIPT_LANGUAGES)[number]
export type ManuscriptGenre = (typeof MANUSCRIPT_GENRES)[number]
