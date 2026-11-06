import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import type { NewsItem, NewsPagePayload, NewsSource, NewsSourcesPayload } from '../../types'
import { CustomSelect } from '../shared/CustomSelect'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import './NewsPage.css'

type NewsFeedProps = {
  onError: (message: string) => void
}

export function NewsFeed({ onError }: NewsFeedProps) {
  const { t, i18n } = useTranslation()
  const [sources, setSources] = useState<NewsSource[]>([])
  const [selectedSource, setSelectedSource] = useState('')
  const [items, setItems] = useState<NewsItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const pollAttemptsRef = useRef(0)
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.resolvedLanguage, {
      dateStyle: 'long',
      timeStyle: 'short',
    }),
    [i18n.resolvedLanguage],
  )

  const loadPage = useCallback(async (sourceKey: string, cursor = '') => {
    const query = new URLSearchParams()
    if (sourceKey) query.set('source', sourceKey)
    if (cursor) query.set('cursor', cursor)
    return apiRequest<NewsPagePayload>(`/api/news/${query.size ? `?${query}` : ''}`)
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([
      apiRequest<NewsSourcesPayload>('/api/news/sources/'),
      loadPage(selectedSource),
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
        onError(error instanceof Error ? error.message : i18n.t('news.loadFailed'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [i18n, loadPage, onError, selectedSource])

  useEffect(() => {
    const waitingForFirstSync = items.length === 0
      && sources.some((source) => source.lastSuccessfulSyncAt === null)
      && pollAttemptsRef.current < 10
    if (!waitingForFirstSync || loading || loadFailed) return
    const timer = window.setTimeout(() => {
      pollAttemptsRef.current += 1
      void Promise.all([
        apiRequest<NewsSourcesPayload>('/api/news/sources/'),
        loadPage(selectedSource),
      ]).then(([sourcePayload, page]) => {
        setSources(sourcePayload.items.filter((source) => source.enabled))
        setItems(page.items)
        setNextCursor(page.nextCursor)
      }).catch(() => undefined)
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [items.length, loadFailed, loadPage, loading, selectedSource, sources])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await loadPage(selectedSource, nextCursor)
      setItems((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('news.loadFailed'))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section className="feedSection newsSection" aria-labelledby="feed-news-heading">
      <header className="feedContentHeader">
        <h1 id="feed-news-heading">{t('news.title')}</h1>
        <div className="feedFilters">
          <label className="feedFilter">
            <span className="srOnly">{t('news.sourceFilter')}</span>
            <CustomSelect
              value={selectedSource}
              aria-label={t('news.sourceFilter')}
              onChange={(event) => {
                pollAttemptsRef.current = 0
                setLoading(true)
                setSelectedSource(event.currentTarget.value)
              }}
            >
              <option value="">{t('news.allSources')}</option>
              {sources.map((source) => (
                <option value={source.key} key={source.key}>{source.name}</option>
              ))}
            </CustomSelect>
          </label>
        </div>
      </header>

      <div className="feedSectionContent">
        {loading && (
          <TadpoleLoadingState className="newsLoadingState" label={t('news.loading')} />
        )}

        {!loading && loadFailed && (
          <div className="newsEmptyState" role="status">
            <h2>{t('news.unavailable')}</h2>
            <p>{t('news.unavailableLead')}</p>
          </div>
        )}

        {!loading && !loadFailed && items.length === 0 && (
          <div className="newsEmptyState" role="status">
            <h2>{t('news.empty')}</h2>
            <p>{t('news.emptyLead')}</p>
          </div>
        )}

        {!loading && !loadFailed && items.length > 0 && (
          <div className="newsFeed">
            {items.map((item) => (
              <article className="newsCard" key={item.id}>
                <div className="newsCardMeta">
                  <span className="newsSourceName">{item.source.name}</span>
                  <time dateTime={item.publishedAt}>{dateFormatter.format(new Date(item.publishedAt))}</time>
                </div>
                <h2>{item.title}</h2>
                <p className="newsAuthor">{t('news.author', { author: item.authorName })}</p>
                <p className="newsSummary">{item.summary}</p>
                <a
                  className="newsSourceLink"
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('news.readAtSource')}
                </a>
              </article>
            ))}
          </div>
        )}

        {nextCursor && (
          <div className="newsLoadMore">
            <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {t(loadingMore ? 'news.loadingMore' : 'news.loadMore')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
