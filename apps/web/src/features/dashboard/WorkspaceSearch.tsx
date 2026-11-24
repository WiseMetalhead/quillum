import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { WorkspaceSearchResult } from '../../types'
import type {
  ActiveContextualWorkspaceSearch,
  ContextualWorkspaceSearchResult,
} from './contextualWorkspaceSearchContext'

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
  contextualSearch?: ActiveContextualWorkspaceSearch | null
  showAuthor?: boolean
  presentation?: 'hero' | 'header' | 'mobileOverlay'
  clearOnSelect?: boolean
  disabled?: boolean
  onEscape?: () => void
}

type SearchOption = {
  key: string
  select: () => void
}

type ResultRowProps = {
  id: string
  active: boolean
  icon: IconName
  title: string
  meta: string
  synopsis?: string
  onMouseEnter: () => void
  onSelect: () => void
}

export function WorkspaceSearch({
  endpoint,
  kinds,
  placeholder,
  emptyMessage,
  onSelect,
  contextualSearch = null,
  showAuthor = false,
  presentation = 'hero',
  clearOnSelect = false,
  disabled = false,
  onEscape,
}: Props) {
  const { t } = useTranslation()
  const [localQuery, setLocalQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [online, setOnline] = useState(() => navigator.onLine)
  const rootRef = useRef<HTMLDivElement>(null)
  const requestVersionRef = useRef(0)
  const resultsId = useId()
  const query = contextualSearch?.query ?? localQuery
  const normalizedQuery = query.trim()
  const minimumQueryLength = contextualSearch ? 1 : 2
  const globalSearchReady = normalizedQuery.length >= 2
  const contextualResults = contextualSearch?.results ?? []
  const contextualGlobalKeys = new Set(
    contextualResults.flatMap((result) => result.globalKey ? [result.globalKey] : []),
  )
  const deduplicatedGlobalResults = results.filter((result) => (
    !contextualGlobalKeys.has(`${result.kind}:${result.id}`)
  ))
  const orderedGlobalResults = kinds.flatMap((kind) => (
    deduplicatedGlobalResults.filter((result) => result.kind === kind)
  ))

  function updateQuery(nextQuery: string) {
    if (contextualSearch) contextualSearch.setQuery(nextQuery)
    else setLocalQuery(nextQuery)
  }

  function selectGlobalResult(result: WorkspaceSearchResult) {
    setOpen(false)
    if (clearOnSelect) {
      requestVersionRef.current += 1
      updateQuery('')
      setResults([])
      setActiveIndex(-1)
      setFailed(false)
      setLoading(false)
    }
    onSelect(result)
  }

  function selectContextualResult(result: ContextualWorkspaceSearchResult) {
    setOpen(false)
    result.onSelect()
  }

  const searchOptions: SearchOption[] = contextualSearch
    ? [
        ...contextualResults.map((result) => ({
          key: `context:${result.key}`,
          select: () => selectContextualResult(result),
        })),
        ...(contextualSearch.total > 0 ? [{
          key: 'context:show-all',
          select: () => setOpen(false),
        }] : []),
        ...orderedGlobalResults.map((result) => ({
          key: `global:${result.kind}:${result.id}`,
          select: () => selectGlobalResult(result),
        })),
      ]
    : orderedGlobalResults.map((result) => ({
        key: `global:${result.kind}:${result.id}`,
        select: () => selectGlobalResult(result),
      }))

  const optionIndexByKey = new Map(searchOptions.map((option, index) => [option.key, index]))

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
    if (!globalSearchReady || !online || disabled) return
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
  }, [disabled, endpoint, globalSearchReady, normalizedQuery, online])

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

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const option = searchOptions[activeIndex] ?? searchOptions[0]
    option?.select()
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false)
      setActiveIndex(-1)
      onEscape?.()
      return
    }
    if (!searchOptions.length || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    setOpen(true)
    const direction = event.key === 'ArrowDown' ? 1 : -1
    setActiveIndex((current) => {
      if (current < 0 || current >= searchOptions.length) {
        return direction > 0 ? 0 : searchOptions.length - 1
      }
      return (current + direction + searchOptions.length) % searchOptions.length
    })
  }

  function globalResultMeta(result: WorkspaceSearchResult) {
    return [
      t(`dashboard.searchKinds.${result.kind}`),
      result.kind !== 'manuscript' ? result.contextTitle : '',
      showAuthor ? result.authorName ?? '' : '',
    ].filter(Boolean).join(' · ')
  }

  function renderGlobalResult(result: WorkspaceSearchResult) {
    const optionIndex = optionIndexByKey.get(`global:${result.kind}:${result.id}`) ?? -1
    return (
      <ResultRow
        id={`${resultsId}-option-${optionIndex}`}
        active={optionIndex === activeIndex}
        icon={SEARCH_ICONS[result.kind]}
        title={result.title}
        meta={globalResultMeta(result)}
        synopsis={(result.kind === 'manuscript' || result.kind === 'glossaryArticle') ? result.synopsis : undefined}
        key={`${result.kind}:${result.id}`}
        onMouseEnter={() => setActiveIndex(optionIndex)}
        onSelect={() => selectGlobalResult(result)}
      />
    )
  }

  const showResults = !disabled && open && normalizedQuery.length >= minimumQueryLength

  return (
    <div
      className={`workspaceSearchHost ${presentation !== 'hero' ? `${presentation}WorkspaceSearchHost` : ''} ${contextualSearch ? 'contextualWorkspaceSearchHost' : ''} ${disabled ? 'disabled' : ''}`.trim()}
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
          aria-label={contextualSearch?.placeholder ?? placeholder}
          aria-autocomplete="list"
          aria-controls={resultsId}
          aria-expanded={showResults}
          aria-activedescendant={activeIndex >= 0 ? `${resultsId}-option-${activeIndex}` : undefined}
          placeholder={contextualSearch?.placeholder ?? placeholder}
          onChange={(event) => {
            requestVersionRef.current += 1
            updateQuery(event.target.value)
            setActiveIndex(-1)
            setResults([])
            setFailed(false)
            setLoading(false)
            setOpen(true)
          }}
          onFocus={() => {
            if (normalizedQuery.length >= minimumQueryLength) setOpen(true)
          }}
          onKeyDown={handleKeyDown}
        />
      </form>
      {showResults && (
        <div
          id={resultsId}
          className="workspaceSearchResults"
          role="listbox"
          aria-label={t('dashboard.searchResults')}
          aria-busy={loading}
        >
          {contextualSearch ? (
            <>
              <div className="workspaceSearchGroup" role="group" aria-label={contextualSearch.label}>
                <strong className="workspaceSearchGroupTitle">{contextualSearch.label}</strong>
                {contextualResults.length ? contextualResults.map((result) => {
                  const optionIndex = optionIndexByKey.get(`context:${result.key}`) ?? -1
                  return (
                    <ResultRow
                      id={`${resultsId}-option-${optionIndex}`}
                      active={optionIndex === activeIndex}
                      icon={result.icon}
                      title={result.title}
                      meta={result.meta}
                      key={result.key}
                      onMouseEnter={() => setActiveIndex(optionIndex)}
                      onSelect={() => selectContextualResult(result)}
                    />
                  )
                }) : (
                  <p className="workspaceSearchState" role="status">{contextualSearch.emptyMessage}</p>
                )}
                {contextualSearch.total > 0 && (
                  <button
                    id={`${resultsId}-option-${optionIndexByKey.get('context:show-all') ?? -1}`}
                    type="button"
                    role="option"
                    aria-selected={optionIndexByKey.get('context:show-all') === activeIndex}
                    className={`workspaceSearchShowContext spaceButton ${optionIndexByKey.get('context:show-all') === activeIndex ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIndex(optionIndexByKey.get('context:show-all') ?? -1)}
                    onClick={() => setOpen(false)}
                  >
                    <span>{t('dashboard.showContextResults', { count: contextualSearch.total })}</span>
                    <Icon name="arrow-right-1" />
                  </button>
                )}
              </div>
              {globalSearchReady && (
                <div className="workspaceSearchGroup" role="group" aria-label={t('dashboard.searchEverywhere')}>
                  <strong className="workspaceSearchGroupTitle">{t('dashboard.searchEverywhere')}</strong>
                  {!online ? (
                    <p className="workspaceSearchState" role="status">{t('dashboard.searchOffline')}</p>
                  ) : loading ? (
                    <p className="workspaceSearchState" role="status">{t('dashboard.searchLoading')}</p>
                  ) : failed ? (
                    <p className="workspaceSearchState" role="status">{t('dashboard.searchFailed')}</p>
                  ) : orderedGlobalResults.length ? (
                    orderedGlobalResults.map(renderGlobalResult)
                  ) : (
                    <p className="workspaceSearchState" role="status">{emptyMessage}</p>
                  )}
                </div>
              )}
            </>
          ) : !online ? (
            <p className="workspaceSearchState" role="status">{t('dashboard.searchOffline')}</p>
          ) : loading ? (
            <p className="workspaceSearchState" role="status">{t('dashboard.searchLoading')}</p>
          ) : failed ? (
            <p className="workspaceSearchState" role="status">{t('dashboard.searchFailed')}</p>
          ) : orderedGlobalResults.length === 0 ? (
            <p className="workspaceSearchState" role="status">{emptyMessage}</p>
          ) : kinds.map((kind) => {
            const kindResults = orderedGlobalResults.filter((result) => result.kind === kind)
            if (!kindResults.length) return null
            return (
              <div className="workspaceSearchGroup" role="group" aria-label={t(`dashboard.searchGroups.${kind}`)} key={kind}>
                <strong className="workspaceSearchGroupTitle">{t(`dashboard.searchGroups.${kind}`)}</strong>
                {kindResults.map(renderGlobalResult)}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ResultRow({
  id,
  active,
  icon,
  title,
  meta,
  synopsis,
  onMouseEnter,
  onSelect,
}: ResultRowProps) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      className={`workspaceSearchResult spaceButton ${active ? 'active' : ''}`}
      onMouseEnter={onMouseEnter}
      onClick={onSelect}
    >
      <span className="workspaceSearchResultIcon" aria-hidden="true"><Icon name={icon} /></span>
      <span className="workspaceSearchResultCopy">
        <strong>{title}</strong>
        <small>{meta}</small>
        {synopsis && <span>{synopsis}</span>}
      </span>
    </button>
  )
}
