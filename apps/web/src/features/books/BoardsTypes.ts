import type { JSONContent } from '@tiptap/core'

export type BoardsView = 'boards' | 'favourites' | 'archive' | 'trash'
export type NoteLayout = 'grid' | 'list'
export type BoardsSaveStatus = 'saved' | 'dirty' | 'saving' | 'error'
export const NOTE_SCHEMA_VERSION = 2

export type Board = {
  id: string
  name: string
  position: number
  createdAt: string
  updatedAt: string
}

export type NoteTag = {
  id: string
  name: string
  color: string
  createdAt: string
  updatedAt: string
}

export type NoteContextItem = {
  id: string
  title: string
  kind: 'folder' | 'document'
  parentId: string | null
}

export type Note = {
  id: string
  kind: 'text' | 'audio'
  title: string
  preview: string
  content: JSONContent
  schemaVersion: number
  saveGeneration: number
  color: string
  pinned: boolean
  favourite: boolean
  archivedAt: string | null
  trashedAt: string | null
  boardId: string | null
  tags: NoteTag[]
  associatedItems: NoteContextItem[]
  assets: string[]
  audio: AudioNoteData | null
  createdAt: string
  updatedAt: string
}

export type AudioNoteData = {
  contentType: string
  codec: 'opus' | 'aac'
  byteSize: number
  durationMs: number
  waveform: number[]
  playbackUrl: string
  downloadUrl: string
}

export type NoteDraft = {
  title: string
  content: JSONContent
  color: string
  boardId: string | null
  tagIds: string[]
  itemIds: string[]
  pinned: boolean
  favourite: boolean
}

export type AudioNoteDraft = Omit<NoteDraft, 'content'>

export const EMPTY_NOTE_CONTENT: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
}

export const NOTE_TAG_COLORS = ['yellow', 'green', 'purple', 'orange', 'pink', 'blue', 'gray'] as const
export const NOTE_TAG_COLOR_VALUES: Record<(typeof NOTE_TAG_COLORS)[number], string> = {
  yellow: '#fde68a',
  green: '#bbf7d0',
  purple: '#ddd6fe',
  orange: '#fed7aa',
  pink: '#fbcfe8',
  blue: '#bfdbfe',
  gray: '#e2e8f0',
}

export function pickNoteTagColor(name: string, existingColors: string[] = []) {
  const normalized = name.trim().toLocaleLowerCase()
  let hash = 0
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0
  }
  const counts = new Map(NOTE_TAG_COLORS.map((color) => [
    color,
    existingColors.filter((item) => item === color).length,
  ]))
  const recent = new Set(existingColors.slice(-3))
  const available = NOTE_TAG_COLORS.filter((color) => !recent.has(color))
  const candidates = available.length ? available : [...NOTE_TAG_COLORS]
  const minimum = Math.min(...candidates.map((color) => counts.get(color) ?? 0))
  const balanced = candidates.filter((color) => counts.get(color) === minimum)
  return balanced[hash % balanced.length]
}

export function noteTagCssColor(color: string) {
  return NOTE_TAG_COLOR_VALUES[color as (typeof NOTE_TAG_COLORS)[number]] ?? color
}
