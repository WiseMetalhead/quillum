export type AnnotationAuthor = {
  id: number | string
  kind?: 'user' | 'guest'
  username: string
  displayName: string
  avatarUrl: string
} | null

export type AnnotationReply = {
  id: string
  author: AnnotationAuthor
  body: string
  version: number
  canEdit: boolean
  canDelete: boolean
  createdAt: string
  updatedAt: string
}

export type DocumentAnnotation = {
  id: string
  documentId?: string
  quote: string
  comment: string
  author: AnnotationAuthor
  status: 'open' | 'resolved'
  detached: boolean
  version: number
  canEdit: boolean
  canDelete: boolean
  canResolve: boolean
  resolvedBy: AnnotationAuthor
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  replies: AnnotationReply[]
}

export type AnnotationDraft = {
  quote: string
}
