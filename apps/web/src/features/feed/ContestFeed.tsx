import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import type {
  ContestItem,
  ContestPagePayload,
  ContestSource,
  ContestSourcesPayload,
  ContestStatus,
} from '../../types'
import { CustomSelect } from '../shared/CustomSelect'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { ContestDetailsPanel } from './ContestDetailsPanel'

type ContestFeedProps = {
  onError: (message: string) => void
}

const contestStatuses: ContestStatus[] = [
  'accepting',
  'preparation',
  'in_progress',
  'finished',
]

export function ContestFeed({ onError }: ContestFeedProps) {
  const { t, i18n } = useTranslation()
  const [sources, setSources] = useState<ContestSource[]>([])
  const [selectedSource, setSelectedSource] = useState('')
  const [selectedStatus, setSelectedStatus] = useState('')
  const [items, setItems] = useState<ContestItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [selectedContest, setSelectedContest] = useState<ContestItem | null>(null)
  const pollAttemptsRef = useRef(0)

  const loadPage = useCallback(async (sourceKey: string, status: string, cursor = '') => {
    const query = new URLSearchParams()
    if (sourceKey) query.set('source', sourceKey)
    if (status) query.set('status', status)
    if (cursor) query.set('cursor', cursor)
    return apiRequest<ContestPagePayload>(`/api/contests/${query.size ? `?${query}` : ''}`)
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([
      apiRequest<ContestSourcesPayload>('/api/contests/sources/'),
      loadPage(selectedSource, selectedStatus),
    ])
      .then(([sourcePayload, page]) => {
        if (!active) return
        setSources(sourcePayload.items.filter((source) => source.enabled))
        setItems(page.items)
        setNextCursor(page.nextCursor)
        setLoadFailed(false)
      })
      .catch((error: unknown) => {
        if (!active) return
        setLoadFailed(true)
        onError(error instanceof Error ? error.message : i18n.t('contests.loadFailed'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [i18n, loadPage, onError, selectedSource, selectedStatus])

  useEffect(() => {
    const waitingForFirstSync = items.length === 0
      && sources.some((source) => source.lastSuccessfulSyncAt === null)
      && pollAttemptsRef.current < 10
    if (!waitingForFirstSync || loading || loadFailed) return
    const timer = window.setTimeout(() => {
      pollAttemptsRef.current += 1
      void Promise.all([
        apiRequest<ContestSourcesPayload>('/api/contests/sources/'),
        loadPage(selectedSource, selectedStatus),
      ]).then(([sourcePayload, page]) => {
        setSources(sourcePayload.items.filter((source) => source.enabled))
        setItems(page.items)
        setNextCursor(page.nextCursor)
      }).catch(() => undefined)
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [items.length, loadFailed, loadPage, loading, selectedSource, selectedStatus, sources])

  function updateFilters(nextSource: string, nextStatus: string) {
    pollAttemptsRef.current = 0
    setLoading(true)
    setSelectedSource(nextSource)
    setSelectedStatus(nextStatus)
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await loadPage(selectedSource, selectedStatus, nextCursor)
      setItems((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('contests.loadFailed'))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section className="feedSection contestSection" aria-labelledby="feed-contests-heading">
      <header className="feedContentHeader">
        <h1 id="feed-contests-heading">{t('contests.title')}</h1>
        <div className="feedFilters contestFilters">
          <label className="feedFilter">
            <span className="srOnly">{t('contests.sourceFilter')}</span>
            <CustomSelect
              value={selectedSource}
              aria-label={t('contests.sourceFilter')}
              onChange={(event) => updateFilters(event.currentTarget.value, selectedStatus)}
            >
              <option value="">{t('contests.allSources')}</option>
              {sources.map((source) => (
                <option value={source.key} key={source.key}>{source.name}</option>
              ))}
            </CustomSelect>
          </label>
          <label className="feedFilter">
            <span className="srOnly">{t('contests.stageFilter')}</span>
            <CustomSelect
              value={selectedStatus}
              aria-label={t('contests.stageFilter')}
              onChange={(event) => updateFilters(selectedSource, event.currentTarget.value)}
            >
              <option value="">{t('contests.allStages')}</option>
              {contestStatuses.map((status) => (
                <option value={status} key={status}>{t(`contests.statuses.${status}`)}</option>
              ))}
            </CustomSelect>
          </label>
        </div>
      </header>

      <div className="feedSectionContent">
        {loading && (
          <TadpoleLoadingState className="feedLoadingState" label={t('contests.loading')} />
        )}

        {!loading && loadFailed && (
          <div className="feedEmptyState" role="status">
            <h2>{t('contests.unavailable')}</h2>
            <p>{t('contests.unavailableLead')}</p>
          </div>
        )}

        {!loading && !loadFailed && items.length === 0 && (
          <div className="feedEmptyState" role="status">
            <h2>{t('contests.empty')}</h2>
            <p>{t('contests.emptyLead')}</p>
          </div>
        )}

        {!loading && !loadFailed && items.length > 0 && (
          <div className="contestFeed">
            {items.map((item) => (
              <article className="contestCard" key={item.id}>
                <div className="contestCardMeta">
                  <span className="newsSourceName">{item.source.name}</span>
                  <span className={`contestStatus contestStatus-${item.status}`}>
                    {t(`contests.statuses.${item.status}`)}
                  </span>
                </div>
                <h2>{item.title}</h2>
                <p className="contestDescription">{item.description}</p>
                <div className="contestActionsRow">
                  <div className="contestActions">
                    <a href={item.descriptionUrl} target="_blank" rel="noopener noreferrer">
                      {t('contests.descriptionAction')}
                    </a>
                    {item.discussionUrl && (
                      <a href={item.discussionUrl} target="_blank" rel="noopener noreferrer">
                        {t('contests.discussionAction')}
                      </a>
                    )}
                    {item.terminalAction && (
                      <a href={item.terminalAction.url} target="_blank" rel="noopener noreferrer">
                        {t(`contests.actions.${item.terminalAction.kind}`)}
                      </a>
                    )}
                  </div>
                  <button
                    type="button"
                    className="contestDetailsAction"
                    onClick={() => setSelectedContest(item)}
                  >
                    {t('contests.detailsAction')}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        {nextCursor && (
          <div className="feedLoadMore">
            <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {t(loadingMore ? 'contests.loadingMore' : 'contests.loadMore')}
            </button>
          </div>
        )}
      </div>
      <ContestDetailsPanel contest={selectedContest} onClose={() => setSelectedContest(null)} />
    </section>
  )
}
