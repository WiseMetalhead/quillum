import type { JSONContent } from '@tiptap/core'

export type DocumentVersion = {
  id: string
  kind: 'draft' | 'revision'
  name: string
  description: string
  schemaVersion: number
  wordCount: number
  characterCount: number
  authorSheets: number
  metadataVersion: number
  createdAt: string
  updatedAt: string
}

export type VersionLimits = {
  drafts: number
  revisions: number
}

export type VersionDetail = {
  version: DocumentVersion
  content: JSONContent
  currentContent: JSONContent
  annotations: unknown[]
}
