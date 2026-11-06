import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { WorkspaceSearchResult } from '../../types'

const SEARCH_ICONS: Record<WorkspaceSearchResult['kind'], IconName> = {
  manuscript: 'books-light',
  document: 'file-document-light',
  note: 'notes-light',
  glossaryArticle: 'notebook-light',
}

type Props = {
  endpoint: string
  kinds: ReadonlyArray<WorkspaceSearchResult['kind']>
  placeholder: string
  emptyMessage: string
  onSelect: (result: WorkspaceSearchResult) => void
  showAuthor?: boolean
  presentation?: 'hero' | 'header' | 'mobileOverlay'
  clearOnSelect?: boolean
  disabled?: boolean
  onEscape?: () => void
}

export function WorkspaceSearch({
  endpoint,
  kinds,
  placeholder,
  emptyMessage,
  onSelect,
  showAuthor = false,
  presentation = 'hero',
  clearOnSelect = false,
  disabled = false,
  onEscape,
}: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [online, setOnline] = useState(() => navigator.onLine)
  const rootRef = useRef<HTMLDivElement>(null)
  const requestVersionRef = useRef(0)
  const resultsId = useId()
  const normalizedQuery = query.trim()

  useEffect(() => {
    function updateOnlineState() {
      requestVersionRef.current += 1
      setOnline(navigator.onLine)
      setActiveIndex(-1)
      setResults([])
      setFailed(false)
      setLoading(false)
    }
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [])

  useEffect(() => {
    if (normalizedQuery.length < 2 || !online || disabled) return
    const controller = new AbortController()
    const requestVersion = requestVersionRef.current
    const timer = window.setTimeout(async () => {
      if (requestVersion !== requestVersionRef.current) return
      setLoading(true)
      try {
        const payload = await apiRequest<{ results: WorkspaceSearchResult[] }>(
          `${endpoint}?q=${encodeURIComponent(normalizedQuery)}`,
          { signal: controller.signal },
        )
        if (requestVersion !== requestVersionRef.current) return
        setResults(payload.results)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (requestVersion !== requestVersionRef.current) return
        setFailed(true)
      } finally {
        if (!controller.signal.aborted && requestVersion === requestVersionRef.current) {
          setLoading(false)
        }
      }
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [disabled, endpoint, normalizedQuery, online])

  useEffect(() => {
    if (!open) return
    function closeSearch(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeSearch)
    return () => document.removeEventListener('pointerdown', closeSearch)
  }, [open])

  useEffect(() => {
    if (activeIndex < 0) return
    document.getElementById(`${resultsId}-option-${activeIndex}`)?.scrollIntoView({
      block: 'nearest',
    })
  }, [activeIndex, resultsId])

  function selectResult(result: WorkspaceSearchResult) {
    setOpen(false)
    if (clearOnSelect) {
      requestVersionRef.current += 1
      setQuery('')
      setResults([])
      setActiveIndex(-1)
      setFailed(false)
      setLoading(false)
    }
    onSelect(result)
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = results[activeIndex] ?? results[0]
    if (result) selectResult(result)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false)
      setActiveIndex(-1)
      onEscape?.()
      return
    }
    if (!results.length || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    setOpen(true)
    const direction = event.key === 'ArrowDown' ? 1 : -1
    setActiveIndex((current) => {
      if (current < 0) return direction > 0 ? 0 : results.length - 1
      return (current + direction + results.length) % results.length
    })
  }

  return (
    <div
      className={`workspaceSearchHost ${presentation !== 'hero' ? `${presentation}WorkspaceSearchHost` : ''} ${disabled ? 'disabled' : ''}`.trim()}
      ref={rootRef}
    >
      <form className="workspaceSearch" role="search" onSubmit={submitSearch}>
        <Icon name="magnifer-outline" className="workspaceMagniferIcon" />
        <input
          type="search"
          role="combobox"
          autoComplete="off"
          disabled={disabled}
          maxLength={120}
          value={query}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={resultsId}
          aria-expanded={!disabled && open && normalizedQuery.length >= 2}
          aria-activedescendant={activeIndex >= 0 ? `${resultsId}-option-${activeIndex}` : undefined}
          placeholder={placeholder}
          onChange={(event) => {
            requestVersionRef.current += 1
            setQuery(event.target.value)
            setActiveIndex(-1)
            setResults([])
            setFailed(false)
            setLoading(false)
            setOpen(true)
          }}
          onFocus={() => {
            if (normalizedQuery.length >= 2) setOpen(true)
          }}
          onKeyDown={handleKeyDown}
        />
      </form>
      {!disabled && open && normalizedQuery.length >= 2 && (
        <div
          id={resultsId}
          className="workspaceSearchResults"
          role="listbox"
          aria-label={t('dashboard.searchResults')}
          aria-busy={loading}
        >
          {!online ? (
            <p className="workspaceSearchState" role="status">{t('dashboard.searchOffline')}</p>
          ) : loading ? (
            <p className="workspaceSearchState" role="status">{t('dashboard.searchLoading')}</p>
          ) : failed ? (
            <p className="workspaceSearchState" role="status">{t('dashboard.searchFailed')}</p>
          ) : results.length === 0 ? (
            <p className="workspaceSearchState" role="status">{emptyMessage}</p>
          ) : kinds.map((kind) => {
            const kindResults = results.filter((result) => result.kind === kind)
            if (!kindResults.length) return null
            return (
              <div className="workspaceSearchGroup" role="group" aria-label={t(`dashboard.searchGroups.${kind}`)} key={kind}>
                <strong className="workspaceSearchGroupTitle">{t(`dashboard.searchGroups.${kind}`)}</strong>
                {kindResults.map((result) => {
                  const index = results.indexOf(result)
                  return (
                    <button
                      id={`${resultsId}-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`workspaceSearchResult spaceButton ${index === activeIndex ? 'active' : ''}`}
                      key={`${result.kind}:${result.id}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectResult(result)}
                    >
                      <span className="workspaceSearchResultIcon" aria-hidden="true"><Icon name={SEARCH_ICONS[result.kind]} /></span>
                      <span className="workspaceSearchResultCopy">
                        <strong>{result.title}</strong>
                        <small>
                          {t(`dashboard.searchKinds.${result.kind}`)}
                          {result.kind !== 'manuscript' && ` · ${result.contextTitle}`}
                          {showAuthor && result.authorName && ` · ${result.authorName}`}
                        </small>
                        {(result.kind === 'manuscript' || result.kind === 'glossaryArticle') && result.synopsis && <span>{result.synopsis}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
