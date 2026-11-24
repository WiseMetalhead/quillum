import { createContext } from 'react'
import type { IconName } from '../../icons/Icon'

export type ContextualWorkspaceSearchResult = {
  key: string
  globalKey?: string
  title: string
  meta: string
  icon: IconName
  onSelect: () => void
}

export type ContextualWorkspaceSearchConfig = {
  key: string
  label: string
  placeholder: string
  emptyMessage: string
  onQueryChange?: (query: string) => void
}

export type ActiveContextualWorkspaceSearchState = ContextualWorkspaceSearchConfig & {
  query: string
  results: ContextualWorkspaceSearchResult[]
  total: number
}

export type ActiveContextualWorkspaceSearch = ActiveContextualWorkspaceSearchState & {
  setQuery: (query: string) => void
}

export type ContextualWorkspaceSearchContextValue = {
  active: ActiveContextualWorkspaceSearchState | null
  activate: (key: string) => void
  updateConfig: (config: ContextualWorkspaceSearchConfig) => void
  deactivate: (key: string) => void
  setQuery: (key: string, query: string) => void
  publishResults: (
    key: string,
    results: ContextualWorkspaceSearchResult[],
    total: number,
  ) => void
}

export const ContextualWorkspaceSearchContext = createContext<ContextualWorkspaceSearchContextValue | null>(null)
