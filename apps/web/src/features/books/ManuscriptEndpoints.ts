import { API_BASE } from '../../api/client'
import type { Manuscript } from './ManuscriptTypes'

export type ManuscriptAccessMode = 'owner' | 'editor'

export function documentEndpoint(manuscript: Pick<Manuscript, 'id' | 'kind'>, itemId: string | null, accessMode: ManuscriptAccessMode = 'owner') {
  if (accessMode === 'editor') {
    return manuscript.kind === 'book' && itemId
      ? `/api/editor/manuscripts/${manuscript.id}/documents/${itemId}/`
      : `/api/editor/manuscripts/${manuscript.id}/document/`
  }
  return manuscript.kind === 'book' && itemId
    ? `/api/manuscripts/books/${manuscript.id}/documents/${itemId}/`
    : `/api/manuscripts/oneshots/${manuscript.id}/document/`
}

export function annotationsEndpoint(manuscript: Pick<Manuscript, 'id' | 'kind'>, itemId: string | null, accessMode: ManuscriptAccessMode = 'owner') {
  if (accessMode === 'editor') {
    return manuscript.kind === 'book' && itemId
      ? `/api/editor/manuscripts/${manuscript.id}/documents/${itemId}/annotations/`
      : `/api/editor/manuscripts/${manuscript.id}/document/annotations/`
  }
  return manuscript.kind === 'book' && itemId
    ? `/api/manuscripts/books/${manuscript.id}/documents/${itemId}/annotations/`
    : `/api/manuscripts/oneshots/${manuscript.id}/annotations/`
}

export function collaborationTicketEndpoint(
  manuscript: Pick<Manuscript, 'id' | 'kind'>,
  itemId: string | null,
  accessMode: ManuscriptAccessMode = 'owner',
) {
  return `${documentEndpoint(manuscript, itemId, accessMode)}collaboration-ticket/`
}

export function collaborationFlushEndpoint(
  manuscript: Pick<Manuscript, 'id' | 'kind'>,
  itemId: string | null,
  accessMode: ManuscriptAccessMode = 'owner',
) {
  return `${documentEndpoint(manuscript, itemId, accessMode)}collaboration-flush/`
}

export function collaborationReplaceEndpoint(
  manuscript: Pick<Manuscript, 'id' | 'kind'>,
  itemId: string | null,
) {
  return `${documentEndpoint(manuscript, itemId, 'owner')}collaboration-replace/`
}

export function versionsEndpoint(manuscript: Manuscript, itemId: string | null) {
  return manuscript.kind === 'book' && itemId
    ? `/api/manuscripts/books/${manuscript.id}/documents/${itemId}/versions/`
    : `/api/manuscripts/oneshots/${manuscript.id}/versions/`
}

export function manuscriptDetailEndpoint(manuscriptId: string, accessMode: ManuscriptAccessMode) {
  return accessMode === 'editor'
    ? `/api/editor/manuscripts/${manuscriptId}/`
    : `/api/manuscripts/${manuscriptId}/`
}

export function manuscriptTreeEndpoint(manuscriptId: string, accessMode: ManuscriptAccessMode) {
  return accessMode === 'editor'
    ? `/api/editor/manuscripts/${manuscriptId}/tree/`
    : `/api/manuscripts/books/${manuscriptId}/tree/`
}

export function editorAssetUrl(manuscriptId: string, assetId: string, variant: 'medium' | 'large' = 'large') {
  return `${API_BASE}/api/editor/manuscripts/${manuscriptId}/assets/${assetId}/${variant}/`
}
