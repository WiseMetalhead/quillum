import type { WorkspaceSearchResult } from '../../types'

export const AUTHOR_WORKSPACE_SEARCH_KINDS: ReadonlyArray<WorkspaceSearchResult['kind']> = [
  'manuscript',
  'document',
  'note',
  'glossaryArticle',
]

export const EDITOR_WORKSPACE_SEARCH_KINDS: ReadonlyArray<WorkspaceSearchResult['kind']> = [
  'manuscript',
  'document',
]
