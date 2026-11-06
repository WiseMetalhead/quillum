import type { TFunction } from 'i18next'

export type ManuscriptLibrarySection = 'all' | 'oneshot' | 'book' | 'series'

export type ManuscriptLibraryCounts = Record<ManuscriptLibrarySection, number>

export const manuscriptLibrarySections = [
  ['all', 'manuscripts.all'],
  ['oneshot', 'manuscripts.oneShots'],
  ['book', 'manuscripts.books'],
  ['series', 'manuscripts.series'],
] as const

export const editorManuscriptLibrarySections = manuscriptLibrarySections.filter(
  ([section]) => section !== 'series',
)

export function manuscriptLibrarySectionIcon(section: ManuscriptLibrarySection) {
  if (section === 'series') return 'library-light' as const
  if (section === 'book') return 'books-light' as const
  if (section === 'oneshot') return 'file-document-light' as const
  return 'documents-light' as const
}

export function manuscriptLibrarySectionLabel(section: ManuscriptLibrarySection, t: TFunction) {
  return t(
    manuscriptLibrarySections.find(([value]) => value === section)?.[1]
      ?? 'manuscripts.all',
  )
}
