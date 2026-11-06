import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  UIEvent,
} from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, apiQuery, apiRequest } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { User, WorkspaceSearchResult } from '../../types'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileViewport } from '../shared/useMobileViewport'
import { WorkspaceSearch } from './WorkspaceSearch'
import { AUTHOR_WORKSPACE_SEARCH_KINDS } from './workspaceSearchConfig'

type DashboardPageProps = {
  user: User
  onOpenSearchResult: (result: WorkspaceSearchResult) => void
}

type WorkspaceUsefulLink = {
  title: string
  url: string
}

type WorkspaceStats = {
  today: string
  manuscriptsInProgress: number
  totalWords: number
  wordsWrittenThisWeek: number
  wordsWrittenToday: number
  wordsWrittenYesterday: number
  wordsWrittenTodayDelta: number
  nearestDeadline: {
    manuscriptId: string
    title: string
    deadline: string
    deadlineDate: string
    daysRemaining: number
  } | null
}

type AuthorBookmark = {
  key: string
  title: string
  url: string
  faviconSrc?: string
  iconName?: IconName
}

const AUTHOR_BOOKMARK_FIELDS: Array<{ key: string; titleKey: string; userKey: keyof User; faviconSrc?: string; iconName?: IconName }> = [
  { key: 'website', titleKey: 'settings.website', userKey: 'authorWebsite', iconName: 'global-light' },
  { key: 'authorToday', titleKey: 'settings.authorTodayProfile', userKey: 'authorTodayProfile', faviconSrc: '/favicons/author-today.ico' },
  { key: 'litres', titleKey: 'settings.authorLitresProfile', userKey: 'authorLitresProfile', faviconSrc: '/favicons/litres.ico' },
  { key: 'proza', titleKey: 'settings.authorProzaProfile', userKey: 'authorProzaProfile', faviconSrc: '/favicons/proza.ico' },
  { key: 'samizdat', titleKey: 'settings.authorSamizdatProfile', userKey: 'authorSamizdatProfile', faviconSrc: '/favicons/samizdat.ico' },
  { key: 'cellulosa', titleKey: 'settings.authorCellulosaProfile', userKey: 'authorCellulosaProfile', faviconSrc: '/favicons/cellulosa.ico' },
  { key: 'wattpad', titleKey: 'settings.authorWattpadProfile', userKey: 'authorWattpadProfile', faviconSrc: '/favicons/wattpad.ico' },
]

export function DashboardPage({ user, onOpenSearchResult }: DashboardPageProps) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const [stats, setStats] = useState<WorkspaceStats | null>(null)
  const [statsLoaded, setStatsLoaded] = useState(false)
  const [usefulLinks, setUsefulLinks] = useState<WorkspaceUsefulLink[]>([])
  const [usefulLinksLoaded, setUsefulLinksLoaded] = useState(false)
  const [usefulLinkFormOpen, setUsefulLinkFormOpen] = useState(false)
  const [mobileLinkSheetOpen, setMobileLinkSheetOpen] = useState(false)
  const [mobileActionLinkIndex, setMobileActionLinkIndex] = useState<number | null>(null)
  const [usefulLinkSaving, setUsefulLinkSaving] = useState(false)
  const [usefulLinkError, setUsefulLinkError] = useState('')
  const linkLongPressTimerRef = useRef<number | null>(null)
  const linkLongPressStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressLinkClickRef = useRef(false)
  const displayName = user.authorName.trim() || user.displayName.trim() || user.username
  const greetingKey = greetingPeriodKey(new Date().getHours())
  const promptIndex = writingPromptIndex(new Date())
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const authorBookmarks = useMemo<AuthorBookmark[]>(
    () => AUTHOR_BOOKMARK_FIELDS
      .map((item) => ({
        key: item.key,
        title: t(item.titleKey),
        url: String(user[item.userKey] || '').trim(),
        faviconSrc: item.faviconSrc,
        iconName: item.iconName,
      }))
      .filter((item) => item.url),
    [t, user],
  )
  const mobileActionLink = mobileActionLinkIndex === null ? null : usefulLinks[mobileActionLinkIndex] ?? null

  useEffect(() => {
    let active = true
    async function loadStats() {
      try {
        const payload = await apiQuery<{ stats: WorkspaceStats }>(
          `/api/manuscripts/dashboard/stats/?timezone=${encodeURIComponent(timezone)}`,
          {
            onBackgroundUpdate: (next) => {
              if (active) setStats(next.stats)
            },
          },
        )
        if (active) {
          setStats(payload.stats)
        }
      } catch {
        if (active) {
          setStats(null)
        }
      } finally {
        if (active) {
          setStatsLoaded(true)
        }
      }
    }
    void loadStats()
    return () => {
      active = false
    }
  }, [timezone])

  useEffect(() => {
    let active = true
    async function loadUsefulLinks() {
      try {
        const payload = await apiQuery<{ links: WorkspaceUsefulLink[] }>(
          '/api/manuscripts/dashboard/useful-links/',
          {
            onBackgroundUpdate: (next) => {
              if (active) setUsefulLinks(next.links)
            },
          },
        )
        if (active) {
          setUsefulLinks(payload.links)
        }
      } catch {
        if (active) {
          setUsefulLinkError(t('dashboard.usefulLinksLoadFailed'))
        }
      } finally {
        if (active) {
          setUsefulLinksLoaded(true)
        }
      }
    }
    void loadUsefulLinks()
    return () => {
      active = false
    }
  }, [t])

  useEffect(() => () => {
    if (linkLongPressTimerRef.current !== null) {
      window.clearTimeout(linkLongPressTimerRef.current)
    }
  }, [])

  async function saveUsefulLinks(nextLinks: WorkspaceUsefulLink[]) {
    setUsefulLinkSaving(true)
    setUsefulLinkError('')
    try {
      const payload = await apiRequest<{ links: WorkspaceUsefulLink[] }>(
        '/api/manuscripts/dashboard/useful-links/',
        {
          method: 'PATCH',
          body: JSON.stringify({ links: nextLinks }),
        },
      )
      setUsefulLinks(payload.links)
      return true
    } catch (err) {
      setUsefulLinkError(err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('dashboard.usefulLinksSaveFailed'))
      return false
    } finally {
      setUsefulLinkSaving(false)
    }
  }

  async function addUsefulLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (usefulLinkSaving) return
    const formElement = event.currentTarget
    const formData = new FormData(formElement)
    const title = String(formData.get('title') || '').trim()
    const url = String(formData.get('url') || '').trim()
    if (!title || !url) {
      setUsefulLinkError(t('dashboard.usefulLinksRequired'))
      return
    }
    const saved = await saveUsefulLinks([...usefulLinks, { title, url }])
    if (saved) {
      formElement.reset()
      setUsefulLinkFormOpen(false)
      setMobileLinkSheetOpen(false)
    }
  }

  async function deleteUsefulLink(index: number) {
    if (usefulLinkSaving) return
    await saveUsefulLinks(usefulLinks.filter((_item, itemIndex) => itemIndex !== index))
  }

  function cancelLinkLongPress() {
    if (linkLongPressTimerRef.current !== null) {
      window.clearTimeout(linkLongPressTimerRef.current)
      linkLongPressTimerRef.current = null
    }
    linkLongPressStartRef.current = null
  }

  function startLinkLongPress(index: number, event: ReactPointerEvent<HTMLElement>) {
    if (!isMobile || event.pointerType === 'mouse' || event.button !== 0) return
    cancelLinkLongPress()
    linkLongPressStartRef.current = { x: event.clientX, y: event.clientY }
    linkLongPressTimerRef.current = window.setTimeout(() => {
      linkLongPressTimerRef.current = null
      linkLongPressStartRef.current = null
      suppressLinkClickRef.current = true
      setMobileActionLinkIndex(index)
    }, 540)
  }

  function moveLinkLongPress(event: ReactPointerEvent<HTMLElement>) {
    const start = linkLongPressStartRef.current
    if (!start) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      cancelLinkLongPress()
    }
  }

  function suppressClickAfterLinkLongPress(event: ReactMouseEvent<HTMLElement>) {
    if (!suppressLinkClickRef.current) return
    suppressLinkClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  function openLinkActions(index: number, event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>) {
    if (!isMobile) return
    const fromKeyboard = 'key' in event
    if (fromKeyboard && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    cancelLinkLongPress()
    if (!fromKeyboard) suppressLinkClickRef.current = true
    setMobileActionLinkIndex(index)
  }

  return (
    <div className="workspaceHomeGrid">
      <section className="workspaceGreeting" aria-labelledby="workspace-greeting-title">
        <div className="workspaceGreetingCopy">
          <h2 id="workspace-greeting-title">{t(`dashboard.greetings.${greetingKey}`, { name: displayName })}</h2>
          <p>{t(`dashboard.prompts.prompt${promptIndex}`)}</p>
          <WorkspaceSearch
            endpoint="/api/manuscripts/dashboard/search/"
            kinds={AUTHOR_WORKSPACE_SEARCH_KINDS}
            placeholder={t('dashboard.searchPlaceholder')}
            emptyMessage={t('dashboard.searchEmpty')}
            onSelect={onOpenSearchResult}
          />
        </div>
      </section>

      <section className="workspaceUsefulLinksCard" aria-label={t('dashboard.usefulLinks')}>
        <div className="workspaceUsefulLinksBody">
          <section className="workspaceBookmarkSection" aria-labelledby="workspace-author-bookmarks-title">
            <h3 id="workspace-author-bookmarks-title">{t('dashboard.authorBookmarks')}</h3>
            {authorBookmarks.length ? (
              <WorkspaceLinkShelf
                itemCount={authorBookmarks.length}
                paginationLabel={t('dashboard.linksPagination')}
                pageLabel={(page, total) => t('dashboard.linksPage', { page, total })}
              >
                {authorBookmarks.map((bookmark) => (
                  <a className="workspaceBookmarkTile" key={bookmark.key} href={withUrlScheme(bookmark.url)} target="_blank" rel="noreferrer">
                    <span className="workspaceLinkTileIcon" aria-hidden="true">
                      {bookmark.iconName ? <Icon name={bookmark.iconName} /> : <img src={bookmark.faviconSrc} alt="" />}
                    </span>
                    <strong>{bookmark.title}</strong>
                  </a>
                ))}
              </WorkspaceLinkShelf>
            ) : (
              <div className="workspaceUsefulLinksEmpty compact">
                <Icon name="bookmark-light" />
                <strong>{t('dashboard.noAuthorBookmarks')}</strong>
                <p>{t('dashboard.noAuthorBookmarksLead')}</p>
              </div>
            )}
          </section>
          <section className="workspaceBookmarkSection" aria-labelledby="workspace-custom-links-title">
            <h3 id="workspace-custom-links-title">{t('dashboard.customLinks')}</h3>
            {usefulLinkError
              && ((!isMobile && !usefulLinkFormOpen) || (isMobile && !mobileLinkSheetOpen)) && (
              <p className="workspaceUsefulLinksError">{usefulLinkError}</p>
            )}
            <WorkspaceLinkShelf
              itemCount={usefulLinks.length + 1}
              paginationLabel={t('dashboard.linksPagination')}
              pageLabel={(page, total) => t('dashboard.linksPage', { page, total })}
            >
                {usefulLinks.map((link, index) => (
                  <div className="workspaceCustomLinkTile" key={`${link.url}-${index}`}>
                    <a
                      href={withUrlScheme(link.url)}
                      target="_blank"
                      rel="noreferrer"
                      aria-haspopup={isMobile ? 'dialog' : undefined}
                      onPointerDown={(event) => startLinkLongPress(index, event)}
                      onPointerMove={moveLinkLongPress}
                      onPointerUp={cancelLinkLongPress}
                      onPointerCancel={cancelLinkLongPress}
                      onPointerLeave={cancelLinkLongPress}
                      onClick={suppressClickAfterLinkLongPress}
                      onContextMenu={(event) => openLinkActions(index, event)}
                      onKeyDown={(event) => openLinkActions(index, event)}
                    >
                      <span className="workspaceLinkTileIcon" aria-hidden="true"><Icon name="link-minimalistic-light" /></span>
                      <strong>{link.title}</strong>
                    </a>
                    {!isMobile && <button
                      type="button"
                      className="workspaceIconButton danger"
                      aria-label={t('dashboard.deleteUsefulLink', { title: link.title })}
                      title={t('common.delete')}
                      disabled={usefulLinkSaving}
                      onClick={() => void deleteUsefulLink(index)}
                    >
                      <Icon name="trash-bin-trash-light" />
                    </button>}
                  </div>
                ))}
                <button
                  type="button"
                  className="workspaceBookmarkTile workspaceAddLinkTile"
                  disabled={!usefulLinksLoaded}
                  onClick={() => {
                    setUsefulLinkError('')
                    if (isMobile) {
                      setMobileLinkSheetOpen(true)
                    } else {
                      setUsefulLinkFormOpen(true)
                    }
                  }}
                >
                  <span className="workspaceLinkTileIcon" aria-hidden="true"><Icon name="sign-plus-light" /></span>
                  <strong>{t('dashboard.addUsefulLink')}</strong>
                </button>
            </WorkspaceLinkShelf>
          </section>
        </div>
      </section>

      <section className="workspaceStatsGrid" aria-label={t('dashboard.workspaceStats')}>
        <WorkspaceStatCard
          icon="file-document-light"
          label={t('dashboard.manuscriptsInProgress')}
          value={statsLoaded && stats ? numberFormatter.format(stats.manuscriptsInProgress) : '...'}
          detail={t('dashboard.manuscriptsInProgressLead')}
        />
        <WorkspaceStatCard
          icon="writing-pen-light"
          label={t('dashboard.totalWords')}
          value={statsLoaded && stats ? numberFormatter.format(stats.totalWords) : '...'}
          detail={statsLoaded && stats
            ? t('dashboard.wordsThisWeek', {
              count: stats.wordsWrittenThisWeek,
              formattedCount: formatSignedNumber(stats.wordsWrittenThisWeek, numberFormatter),
            })
            : t('dashboard.statsLoading')}
          tone="blue"
        />
        <WorkspaceStatCard
          icon="pulse-light"
          label={t('dashboard.wordsToday')}
          value={statsLoaded && stats ? numberFormatter.format(stats.wordsWrittenToday) : '...'}
          detail={statsLoaded && stats
            ? t('dashboard.wordsComparedYesterday', {
              count: stats.wordsWrittenTodayDelta,
              formattedCount: formatSignedNumber(stats.wordsWrittenTodayDelta, numberFormatter),
            })
            : t('dashboard.statsLoading')}
          tone="green"
        />
        <WorkspaceStatCard
          icon="calendar-light"
          label={t('dashboard.nearestDeadline')}
          value={statsLoaded && stats?.nearestDeadline ? stats.nearestDeadline.title : t(statsLoaded ? 'dashboard.noNearestDeadline' : 'dashboard.statsLoading')}
          detail={statsLoaded && stats?.nearestDeadline
            ? t('dashboard.deadlineInDays', {
              count: stats.nearestDeadline.daysRemaining,
              formattedCount: numberFormatter.format(stats.nearestDeadline.daysRemaining),
              date: formatDate(stats.nearestDeadline.deadline, i18n.resolvedLanguage),
            })
            : t(statsLoaded ? 'dashboard.noNearestDeadlineLead' : 'dashboard.statsLoading')}
          tone="amber"
        />
      </section>

      {!isMobile && usefulLinkFormOpen && (
        <ActionDialog
          variant="structured"
          title={t('dashboard.addUsefulLink')}
          closeLabel={t('common.close')}
          busy={usefulLinkSaving}
          className="workspaceLinkDialog"
          onClose={() => setUsefulLinkFormOpen(false)}
        >
          <form className="workspaceDesktopLinkDialogForm" onSubmit={(event) => void addUsefulLink(event)}>
            <label className="dialogField">
              <span>{t('dashboard.usefulLinkTitle')}</span>
              <input name="title" maxLength={80} autoComplete="off" />
            </label>
            <label className="dialogField">
              <span>{t('dashboard.usefulLinkUrl')}</span>
              <input name="url" inputMode="url" maxLength={500} placeholder="https://" autoComplete="url" />
            </label>
            {usefulLinkError && <p className="workspaceUsefulLinksError">{usefulLinkError}</p>}
            <footer className="standardDialogFooter">
              <button type="button" className="dialogCancel" disabled={usefulLinkSaving} onClick={() => setUsefulLinkFormOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="dialogSubmit" disabled={usefulLinkSaving}>
                {t(usefulLinkSaving ? 'common.saving' : 'common.save')}
              </button>
            </footer>
          </form>
        </ActionDialog>
      )}

      {isMobile && mobileLinkSheetOpen && (
        <MobileSettingsSheet
          title={t('dashboard.addUsefulLink')}
          busy={usefulLinkSaving}
          onClose={() => setMobileLinkSheetOpen(false)}
        >
          <form className="workspaceMobileLinkSheetForm" onSubmit={(event) => void addUsefulLink(event)}>
            <label>
              <span>{t('dashboard.usefulLinkTitle')}</span>
              <input name="title" maxLength={80} autoComplete="off" />
            </label>
            <label>
              <span>{t('dashboard.usefulLinkUrl')}</span>
              <input name="url" inputMode="url" maxLength={500} placeholder="https://" autoComplete="url" />
            </label>
            {usefulLinkError && <p className="workspaceUsefulLinksError">{usefulLinkError}</p>}
            <button type="submit" className="workspaceMobileLinkSave" disabled={usefulLinkSaving}>
              {t(usefulLinkSaving ? 'common.saving' : 'common.save')}
            </button>
          </form>
        </MobileSettingsSheet>
      )}

      <MobileLibraryActionSheet
        open={mobileActionLink !== null}
        title={mobileActionLink?.title ?? t('dashboard.customLinks')}
        dismissOnSelect
        actions={mobileActionLink ? [{
          key: 'delete',
          label: t('common.delete'),
          icon: <Icon name="trash-bin-trash-light" />,
          danger: true,
          disabled: usefulLinkSaving,
          onSelect: () => {
            if (mobileActionLinkIndex !== null) void deleteUsefulLink(mobileActionLinkIndex)
          },
        }] : []}
        onClose={() => setMobileActionLinkIndex(null)}
      />
    </div>
  )
}

function WorkspaceLinkShelf({
  children,
  itemCount,
  paginationLabel,
  pageLabel,
}: {
  children: ReactNode
  itemCount: number
  paginationLabel: string
  pageLabel: (page: number, total: number) => string
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [pageCount, setPageCount] = useState(1)
  const [currentPage, setCurrentPage] = useState(0)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    function measure() {
      const element = viewportRef.current
      if (!element) return
      const width = element.clientWidth
      const nextPageCount = width > 0 ? Math.max(1, Math.ceil(element.scrollWidth / width)) : 1
      setPageCount(nextPageCount)
      setCurrentPage((page) => Math.min(page, nextPageCount - 1))
    }

    measure()
    if (!('ResizeObserver' in window)) return
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [itemCount])

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const viewport = event.currentTarget
    const maxScroll = viewport.scrollWidth - viewport.clientWidth
    if (maxScroll <= 0 || pageCount <= 1) {
      setCurrentPage(0)
      return
    }
    setCurrentPage(Math.round((viewport.scrollLeft / maxScroll) * (pageCount - 1)))
  }

  function openPage(page: number) {
    const viewport = viewportRef.current
    if (!viewport) return
    const maxScroll = viewport.scrollWidth - viewport.clientWidth
    const left = pageCount > 1 ? maxScroll * (page / (pageCount - 1)) : 0
    viewport.scrollTo({ left, behavior: 'smooth' })
  }

  return (
    <div className="workspaceLinkShelf">
      <div className="workspaceLinkShelfViewport" ref={viewportRef} onScroll={handleScroll}>
        <div className="workspaceLinkShelfTrack">{children}</div>
      </div>
      {pageCount > 1 && (
        <div className="workspaceLinkPagination" role="group" aria-label={paginationLabel}>
          {Array.from({ length: pageCount }, (_value, page) => (
            <button
              type="button"
              key={page}
              className={`workspaceLinkPageButton ${page === currentPage ? 'active' : ''}`}
              aria-current={page === currentPage ? 'page' : undefined}
              aria-label={pageLabel(page + 1, pageCount)}
              onClick={() => openPage(page)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function WorkspaceStatCard({
  icon,
  label,
  value,
  detail,
  tone = 'purple',
}: {
  icon: IconName
  label: string
  value: string
  detail: string
  tone?: 'purple' | 'blue' | 'green' | 'amber'
}) {
  return (
    <article className="workspaceStatCard" data-tone={tone}>
      <span className="workspaceStatIcon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  )
}

function withUrlScheme(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

function formatSignedNumber(value: number, formatter: Intl.NumberFormat) {
  const formatted = formatter.format(Math.abs(value))
  if (value > 0) return `+${formatted}`
  if (value < 0) return `-${formatted}`
  return formatted
}

function formatDate(value: string, locale: string | undefined) {
  const timestamp = new Date(`${value}T00:00:00`).getTime()
  if (Number.isNaN(timestamp)) return value
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(timestamp)
}

function greetingPeriodKey(hour: number) {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'day'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

function writingPromptIndex(date: Date) {
  const start = new Date(date.getFullYear(), 0, 0)
  const day = Math.floor((date.getTime() - start.getTime()) / 86_400_000)
  return day % 7
}
