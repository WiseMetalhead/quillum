import { useCallback, useContext, useEffect, useMemo } from 'react'
import {
  ContextualWorkspaceSearchContext,
  type ActiveContextualWorkspaceSearch,
  type ContextualWorkspaceSearchConfig,
  type ContextualWorkspaceSearchResult,
} from './contextualWorkspaceSearchContext'

function useContextualWorkspaceSearchContext() {
  const value = useContext(ContextualWorkspaceSearchContext)
  if (!value) throw new Error('ContextualWorkspaceSearchProvider is missing')
  return value
}

export function useContextualPageSearch(config: ContextualWorkspaceSearchConfig) {
  const { key, label, placeholder, emptyMessage, onQueryChange } = config
  const {
    active,
    activate,
    updateConfig,
    deactivate,
    setQuery: setContextQuery,
    publishResults: publishContextResults,
  } = useContextualWorkspaceSearchContext()

  useEffect(() => {
    activate(key)
    return () => deactivate(key)
  }, [activate, deactivate, key])

  useEffect(() => {
    updateConfig({
      key,
      label,
      placeholder,
      emptyMessage,
      onQueryChange,
    })
  }, [emptyMessage, key, label, onQueryChange, placeholder, updateConfig])

  const query = active?.key === key ? active.query : ''
  const setQuery = useCallback((nextQuery: string) => {
    onQueryChange?.(nextQuery)
    setContextQuery(key, nextQuery)
  }, [key, onQueryChange, setContextQuery])
  const publishResults = useCallback((
    results: ContextualWorkspaceSearchResult[],
    total: number,
  ) => {
    publishContextResults(key, results, total)
  }, [key, publishContextResults])

  return { query, setQuery, publishResults }
}

export function useActiveContextualWorkspaceSearch(): ActiveContextualWorkspaceSearch | null {
  const { active, setQuery } = useContextualWorkspaceSearchContext()
  return useMemo(() => active ? {
    ...active,
    setQuery: (query: string) => {
      active.onQueryChange?.(query)
      setQuery(active.key, query)
    },
  } : null, [active, setQuery])
}
