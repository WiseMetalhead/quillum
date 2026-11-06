import type { JSONContent } from '@tiptap/core'

export type GlossaryScope = {
  scopeType: 'manuscript' | 'series'
  scopeId: string
  seriesTitle: string
  categories: GlossaryCategory[]
}

export type GlossaryCategory = {
  id: string
  systemKey: SystemGlossaryCategory | null
  name: string
  description: string
  icon: string
  position: number
  hidden: boolean
  articleCount: number
  createdAt: string
  updatedAt: string
}

export type SystemGlossaryCategory =
  | 'characters'
  | 'places'
  | 'races'
  | 'organizations'
  | 'items'
  | 'flora'
  | 'fauna'

export type GlossaryArticleSummary = {
  id: string
  categoryId: string
  title: string
  synopsis: string
  favourite: boolean
  schemaVersion: number
  saveGeneration: number
  thumbnailUrl: string
  coverUrl: string
  createdAt: string
  updatedAt: string
}

export type GlossaryArticle = GlossaryArticleSummary & {
  content: JSONContent
  aliases: GlossaryArticleAlias[]
  mediaCount: number
  links: GlossaryArticleSummary[]
}

export type GlossaryArticleAlias = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type GlossaryAsset = {
  id: string
  kind: 'thumbnail' | 'cover' | 'illustration'
  contentType: string
  width: number
  height: number
  byteSize: number
  alt: string
  caption: string
  mediumUrl: string
  largeUrl: string
}

export type GlossaryView = 'all' | 'favourites' | 'recent' | `category:${string}`
export type GlossaryLayout = 'grid' | 'list'
export type GlossarySort = 'az' | 'za' | 'updated-desc' | 'updated-asc'

export const EMPTY_GLOSSARY_CONTENT: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
}
