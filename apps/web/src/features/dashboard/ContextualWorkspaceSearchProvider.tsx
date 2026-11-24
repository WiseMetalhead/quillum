import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ContextualWorkspaceSearchContext,
  type ActiveContextualWorkspaceSearchState,
  type ContextualWorkspaceSearchConfig,
  type ContextualWorkspaceSearchContextValue,
  type ContextualWorkspaceSearchResult,
} from './contextualWorkspaceSearchContext'

export function ContextualWorkspaceSearchProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveContextualWorkspaceSearchState | null>(null)

  const activate = useCallback((key: string) => {
    setActive((current) => current?.key === key
      ? current
      : { key, label: '', placeholder: '', emptyMessage: '', query: '', results: [], total: 0 })
  }, [])

  const updateConfig = useCallback((config: ContextualWorkspaceSearchConfig) => {
    setActive((current) => current?.key === config.key
      ? { ...current, ...config }
      : current)
  }, [])

  const deactivate = useCallback((key: string) => {
    setActive((current) => current?.key === key ? null : current)
  }, [])

  const setQuery = useCallback((key: string, query: string) => {
    setActive((current) => current?.key === key ? { ...current, query } : current)
  }, [])

  const publishResults = useCallback((
    key: string,
    results: ContextualWorkspaceSearchResult[],
    total: number,
  ) => {
    setActive((current) => current?.key === key ? { ...current, results, total } : current)
  }, [])

  const value = useMemo<ContextualWorkspaceSearchContextValue>(() => ({
    active,
    activate,
    updateConfig,
    deactivate,
    setQuery,
    publishResults,
  }), [active, activate, updateConfig, deactivate, setQuery, publishResults])

  return (
    <ContextualWorkspaceSearchContext.Provider value={value}>
      {children}
    </ContextualWorkspaceSearchContext.Provider>
  )
}
