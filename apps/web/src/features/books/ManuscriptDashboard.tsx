import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { API_BASE, ApiError, apiQuery, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { PrivateImage } from '../shared/PrivateImage'
import type { Manuscript } from './ManuscriptTypes'
import { EditManuscriptDialog } from './EditManuscriptDialog'
import type { PlannerData, PlannerItem, PlannerStatus } from './PlannerTypes'
import { ManuscriptStatusChip } from './ManuscriptStatusChip'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'

type Props = {
  manuscript: Manuscript
  onManuscriptChange: (manuscript: Manuscript) => void
  onError: (error: string) => void
  onOpenEditorDocument: (itemId: string | null) => void
}

type RecentDocument = {
  id: string
  itemId: string | null
  title: string
  wordCount: number
  characterCount: number
  updatedAt: string
}

type WritingActivityDay = {
  date: string
  words: number
}

type DashboardWidgetId = 'recentSessions' | 'statusProgress' | 'writingActivity' | 'dailyGoals' | 'memo'

type DashboardSettings = {
  widgetOrder: DashboardWidgetId[]
  hiddenWidgets: DashboardWidgetId[]
}

const DASHBOARD_MEMO_MAX_LENGTH = 5_000
const DASHBOARD_WIDGET_ORDER: DashboardWidgetId[] = ['recentSessions', 'statusProgress', 'writingActivity', 'dailyGoals', 'memo']
const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  widgetOrder: [...DASHBOARD_WIDGET_ORDER],
  hiddenWidgets: [],
}

const presetStatusColors = {
  gray: '#64748b',
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#d97706',
  purple: '#7c3aed',
  red: '#dc2626',
  teal: '#0d9488',
}

export function ManuscriptDashboard({ manuscript, onManuscriptChange, onError, onOpenEditorDocument }: Props) {
  const { t, i18n } = useTranslation()
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage)
  const [planner, setPlanner] = useState<PlannerData | null>(null)
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>([])
  const [writingActivity, setWritingActivity] = useState<WritingActivityDay[]>([])
  const [dashboardMemo, setDashboardMemo] = useState('')
  const [dashboardSettings, setDashboardSettings] = useState<DashboardSettings>(DEFAULT_DASHBOARD_SETTINGS)
  const [editing, setEditing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    let active = true
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    async function loadDashboardData() {
      try {
        const [plannerPayload, recentPayload, activityPayload, memoPayload, settingsPayload] = await Promise.all([
          apiQuery<{ planner: PlannerData }>(
            `/api/manuscripts/${manuscript.id}/planner/?timezone=${encodeURIComponent(timezone)}`,
            {
              maxAgeMs: 0,
              onBackgroundUpdate: (next) => {
                if (active) setPlanner(next.planner)
              },
            },
          ),
          apiQuery<{ items: RecentDocument[] }>(
            `/api/manuscripts/${manuscript.id}/dashboard/recent-documents/`,
            {
              maxAgeMs: 0,
              onBackgroundUpdate: (next) => {
                if (active) setRecentDocuments(next.items)
              },
            },
          ),
          apiQuery<{ days: WritingActivityDay[] }>(
            `/api/manuscripts/${manuscript.id}/dashboard/writing-activity/?timezone=${encodeURIComponent(timezone)}`,
            {
              maxAgeMs: 0,
              onBackgroundUpdate: (next) => {
                if (active) setWritingActivity(next.days)
              },
            },
          ),
          apiQuery<{ memo: string }>(`/api/manuscripts/${manuscript.id}/dashboard/memo/`, {
            onBackgroundUpdate: (next) => {
              if (active) setDashboardMemo(next.memo)
            },
          }),
          apiQuery<{ settings: unknown }>(`/api/manuscripts/${manuscript.id}/dashboard/settings/`, {
            onBackgroundUpdate: (next) => {
              if (active) setDashboardSettings(normalizeDashboardSettings(next.settings))
            },
          }),
        ])
        if (active) {
          setPlanner(plannerPayload.planner)
          setRecentDocuments(recentPayload.items)
          setWritingActivity(activityPayload.days)
          setDashboardMemo(memoPayload.memo)
          setDashboardSettings(normalizeDashboardSettings(settingsPayload.settings))
        }
      } catch (err) {
        if (active) {
          onError(err instanceof Error ? err.message : i18n.t('manuscriptDashboard.loadFailed'))
        }
      }
    }
    void loadDashboardData()
    return () => {
      active = false
    }
  }, [i18n, manuscript.id, onError])

  const totalWords = planner?.statistics.totalWords ?? 0
  const wordGoal = planner?.settings.manuscriptWordGoal ?? 0
  const hasGoal = wordGoal > 0
  const progressValue = hasGoal ? Math.min(100, Math.round((totalWords / wordGoal) * 100)) : 0
  const statusProgress = planner ? aggregateStatusProgress(planner, t) : null
  const statusLookup = planner ? recentStatusLookup(planner) : new Map<string, RecentStatusChip>()
  const visibleWidgetIds = dashboardSettings.widgetOrder.filter((widgetId) => !dashboardSettings.hiddenWidgets.includes(widgetId))

  function renderDashboardWidget(widgetId: DashboardWidgetId) {
    switch (widgetId) {
      case 'recentSessions':
        return (
          <RecentSessionsWidget
            key={widgetId}
            manuscript={manuscript}
            recentDocuments={recentDocuments}
            statusLookup={statusLookup}
            numberFormatter={numberFormatter}
            onOpenEditorDocument={onOpenEditorDocument}
          />
        )
      case 'statusProgress':
        return (
          <StatusProgressWidget
            key={widgetId}
            statusProgress={statusProgress}
            numberFormatter={numberFormatter}
          />
        )
      case 'writingActivity':
        return (
          <WritingActivityWidget
            key={widgetId}
            days={writingActivity}
            dailyGoal={planner?.settings.dailyWordGoal ?? 0}
          />
        )
      case 'dailyGoals':
        return (
          <DailyGoalsWidget
            key={widgetId}
            days={writingActivity}
            dailyGoal={planner?.settings.dailyWordGoal ?? 0}
          />
        )
      case 'memo':
        return (
          <DashboardMemoWidget
            key={widgetId}
            manuscriptId={manuscript.id}
            memo={dashboardMemo}
            onMemoChange={setDashboardMemo}
            onError={onError}
          />
        )
    }
  }

  return (
    <div className="manuscriptDashboard">
      <div className="manuscriptDashboardLayout">
        <section className="manuscriptOverviewWidget dashboardWidget">
          {manuscript.coverThumbnailMediumUrl && (
            <div className="dashboardOverviewBackdrop" aria-hidden="true">
              <PrivateImage src={`${API_BASE}${manuscript.coverThumbnailMediumUrl}?v=${manuscript.coverVersion}`} alt="" decoding="async" />
            </div>
          )}
          <div className="dashboardWidgetActions">
            <button type="button" className="dashboardIconButton booksButton" aria-label={t('manuscriptDashboard.editDetails')} onClick={() => setEditing(true)}>
              <Icon name="pen-light" />
            </button>
            <button type="button" className="dashboardIconButton booksButton" aria-label={t('manuscriptDashboard.dashboardSettings')} title={t('manuscriptDashboard.dashboardSettings')} onClick={() => setSettingsOpen(true)}>
              <Icon name="widget-light" />
            </button>
          </div>
          <div className="dashboardCover">
            {manuscript.coverThumbnailMediumUrl ? (
              <PrivateImage src={`${API_BASE}${manuscript.coverThumbnailMediumUrl}?v=${manuscript.coverVersion}`} alt="" decoding="async" />
            ) : (
              <Icon name={manuscript.kind === 'book' ? 'books-light' : 'file-document-light'} />
            )}
          </div>
          <div className="dashboardBookDetails">
            <div className="dashboardBookCopy">
              <ManuscriptStatusChip status={manuscript.status} />
              <h1>{manuscript.title}</h1>
              <p>{manuscript.synopsis || t('manuscriptDashboard.noSynopsis')}</p>
            </div>
            <div className="dashboardProgressBlock">
              <div className="dashboardProgressHeader">
                <span>{t('manuscriptDashboard.manuscriptProgress')}</span>
                <strong>{hasGoal ? `${progressValue}%` : '\u221e'}</strong>
              </div>
              <div className="dashboardProgressTrack" role="progressbar" aria-label={t('manuscriptDashboard.manuscriptProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressValue}>
                <span style={{ width: `${progressValue}%` }} />
              </div>
              <p>{hasGoal
                ? t('manuscriptDashboard.wordProgress', {
                    current: numberFormatter.format(totalWords),
                    goal: numberFormatter.format(wordGoal),
                  })
                : t('manuscriptDashboard.setWordGoal')}</p>
            </div>
          </div>
        </section>

        <div className="manuscriptDashboardWidgets">
          {visibleWidgetIds.map((widgetId) => renderDashboardWidget(widgetId))}
        </div>
      </div>

      {editing && (
        <EditManuscriptDialog
          manuscript={manuscript}
          onClose={() => setEditing(false)}
          onSaved={(nextManuscript) => {
            onManuscriptChange(nextManuscript)
            setEditing(false)
          }}
          onError={onError}
        />
      )}
      {settingsOpen && (
        <DashboardSettingsDialog
          manuscriptId={manuscript.id}
          settings={dashboardSettings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(nextSettings) => {
            setDashboardSettings(nextSettings)
            setSettingsOpen(false)
          }}
          onError={onError}
        />
      )}
    </div>
  )
}

function RecentSessionsWidget({
  manuscript,
  recentDocuments,
  statusLookup,
  numberFormatter,
  onOpenEditorDocument,
}: {
  manuscript: Manuscript
  recentDocuments: RecentDocument[]
  statusLookup: Map<string, RecentStatusChip>
  numberFormatter: Intl.NumberFormat
  onOpenEditorDocument: (itemId: string | null) => void
}) {
  const { t, i18n } = useTranslation()

  return (
    <section className="recentSessionsWidget dashboardWidget" aria-labelledby="recent-sessions-title">
      <h2 id="recent-sessions-title">{t('manuscriptDashboard.recentSessions')}</h2>
      {recentDocuments.length ? (
        <div className="recentSessionList">
          {recentDocuments.map((item) => (
            <button
              type="button"
              className="recentSessionItem booksButton"
              key={item.id}
              onClick={() => onOpenEditorDocument(manuscript.kind === 'book' ? item.itemId : null)}
            >
              <span className="recentSessionIcon" aria-hidden="true">
                <Icon name="file-document-light" />
              </span>
              <span className="recentSessionText">
                <strong>{item.title}</strong>
                <span className="recentSessionMeta">
                  <span>
                    {t('manuscriptDashboard.wordCount', {
                      count: item.wordCount,
                      formattedCount: numberFormatter.format(item.wordCount),
                    })}
                  </span>
                  <i aria-hidden="true" />
                  <span>{formatRelativeDate(item.updatedAt, i18n.resolvedLanguage, t)}</span>
                  {item.itemId && statusLookup.has(item.itemId) && (
                    <span
                      className="recentStatusChip"
                      style={statusChipStyle(statusLookup.get(item.itemId))}
                    >
                      {statusLookup.get(item.itemId)?.name}
                    </span>
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="recentSessionsEmpty">{t('manuscriptDashboard.noRecentSessions')}</p>
      )}
    </section>
  )
}

function StatusProgressWidget({
  statusProgress,
  numberFormatter,
}: {
  statusProgress: ReturnType<typeof aggregateStatusProgress> | null
  numberFormatter: Intl.NumberFormat
}) {
  const { t } = useTranslation()

  return (
    <section className="statusProgressWidget dashboardWidget" aria-labelledby="status-progress-title">
      <div className="statusProgressHeader">
        <div>
          <h2 id="status-progress-title">{t('manuscriptDashboard.statusProgress')}</h2>
          <p>{statusProgress
            ? t('manuscriptDashboard.completed', {
                completed: numberFormatter.format(statusProgress.completedCount),
                total: numberFormatter.format(statusProgress.totalCount),
              })
            : t('manuscriptDashboard.loadingStatus')}</p>
        </div>
        <strong>{statusProgress ? `${statusProgress.readiness}%` : '--'}</strong>
      </div>
      <div className="statusProgressTrack" role="progressbar" aria-label={t('manuscriptDashboard.statusProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={statusProgress?.readiness ?? 0}>
        <span style={{ width: `${statusProgress?.readiness ?? 0}%` }} />
      </div>
      {statusProgress && statusProgress.totalCount > 0 ? (
        <div className="statusProgressRows">
          {statusProgress.rows.map((row) => (
            <div className="statusProgressRow" key={row.id}>
              <span className="statusProgressDot" style={{ background: row.color }} aria-hidden="true" />
              <span className="statusProgressName">{row.name}</span>
              <span className="statusProgressMiniTrack" aria-hidden="true">
                <span style={{ width: `${row.percent}%`, background: row.color }} />
              </span>
              <span className="statusProgressValue">{numberFormatter.format(row.count)} ({row.percent}%)</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="statusProgressEmpty">{t('manuscriptDashboard.statusProgressEmpty')}</p>
      )}
    </section>
  )
}

function DashboardSettingsDialog({
  manuscriptId,
  settings,
  onClose,
  onSaved,
  onError,
}: {
  manuscriptId: string
  settings: DashboardSettings
  onClose: () => void
  onSaved: (settings: DashboardSettings) => void
  onError: (error: string) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() => normalizeDashboardSettings(settings))
  const [saving, setSaving] = useState(false)
  const onSavedRef = useRef(onSaved)
  const {
    backdropStateClass,
    close: closeDialog,
    closing,
    finishAfterExit,
  } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    onSavedRef.current = onSaved
  }, [onSaved])

  function moveWidget(widgetId: DashboardWidgetId, direction: -1 | 1) {
    setDraft((current) => {
      const order = [...current.widgetOrder]
      const index = order.indexOf(widgetId)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return current
      const [item] = order.splice(index, 1)
      order.splice(nextIndex, 0, item)
      return { ...current, widgetOrder: order }
    })
  }

  function toggleWidget(widgetId: DashboardWidgetId) {
    setDraft((current) => {
      const hidden = current.hiddenWidgets.includes(widgetId)
        ? current.hiddenWidgets.filter((item) => item !== widgetId)
        : [...current.hiddenWidgets, widgetId]
      return { ...current, hiddenWidgets: hidden }
    })
  }

  async function saveSettings() {
    if (saving) return
    setSaving(true)
    try {
      const payload = await apiRequest<{ settings: unknown }>(
        `/api/manuscripts/${manuscriptId}/dashboard/settings/`,
        {
          method: 'PATCH',
          body: JSON.stringify({ settings: draft }),
        },
      )
      finishAfterExit(() => onSavedRef.current(normalizeDashboardSettings(payload.settings)))
    } catch (err) {
      onError(err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('manuscriptDashboard.dashboardSettingsSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ActionDialog
      variant="structured"
      title={t('manuscriptDashboard.dashboardSettings')}
      closeLabel={t('common.close')}
      mobileBackLabel={t('common.back')}
      mobilePrimaryAction={{
        label: t(saving ? 'common.saving' : 'common.save'),
        icon: <Icon name="diskette-light" />,
        disabled: saving || closing,
        onClick: () => void saveSettings(),
      }}
      busy={saving}
      className="dashboardSettingsDialog dashboardSettingsView"
      backdropClassName={`dashboardMobileViewBackdrop ${backdropStateClass}`}
      onClose={closeDialog}
    >
      <div className="standardDialogSection dashboardWidgetManager">
        {draft.widgetOrder.map((widgetId, index) => {
          const hidden = draft.hiddenWidgets.includes(widgetId)
          return (
            <div className="dashboardWidgetManagerRow" key={widgetId}>
              <label>
                <input type="checkbox" checked={!hidden} onChange={() => toggleWidget(widgetId)} />
                <span>
                  <strong>{t(`manuscriptDashboard.widgets.${widgetId}`)}</strong>
                  <small>{hidden ? t('manuscriptDashboard.widgetHidden') : t('manuscriptDashboard.widgetVisible')}</small>
                </span>
              </label>
              <div className="dashboardWidgetOrderActions">
                <button type="button" className="spaceButton" aria-label={t('manuscriptDashboard.moveWidgetUp', { name: t(`manuscriptDashboard.widgets.${widgetId}`) })} disabled={index === 0} onClick={() => moveWidget(widgetId, -1)}>
                  <Icon name="arrow-up-2" />
                </button>
                <button type="button" className="spaceButton" aria-label={t('manuscriptDashboard.moveWidgetDown', { name: t(`manuscriptDashboard.widgets.${widgetId}`) })} disabled={index === draft.widgetOrder.length - 1} onClick={() => moveWidget(widgetId, 1)}>
                  <Icon name="arrow-down-2" />
                </button>
              </div>
            </div>
          )
        })}
        <footer className="standardDialogFooter">
          <button type="button" className="dialogCancel spaceButton" disabled={saving} onClick={closeDialog}>{t('common.cancel')}</button>
          <button type="button" className="dialogSubmit spaceButton" disabled={saving} onClick={() => void saveSettings()}>{t(saving ? 'common.saving' : 'common.save')}</button>
        </footer>
      </div>
    </ActionDialog>
  )
}

function DashboardMemoWidget({
  manuscriptId,
  memo,
  onMemoChange,
  onError,
}: {
  manuscriptId: string
  memo: string
  onMemoChange: (memo: string) => void
  onError: (error: string) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [mobileFlowHeight, setMobileFlowHeight] = useState<number | null>(null)
  const widgetRef = useRef<HTMLElement>(null)
  const trimmedMemo = memo.trim()

  function startEditing() {
    if (window.matchMedia('(max-width: 520px)').matches) {
      setMobileFlowHeight(widgetRef.current?.getBoundingClientRect().height ?? null)
    }
    setEditing(true)
  }

  function stopEditing() {
    setEditing(false)
    setMobileFlowHeight(null)
  }

  return (
    <section
      className="dashboardMemoWidget dashboardWidget"
      aria-labelledby="dashboard-memo-title"
      ref={widgetRef}
      style={mobileFlowHeight === null ? undefined : { minHeight: mobileFlowHeight }}
    >
      <header>
        <div>
          <h2 id="dashboard-memo-title">{t('manuscriptDashboard.memoTitle')}</h2>
        </div>
        {!editing && (
          <button type="button" className="dashboardMemoEdit booksButton" onClick={startEditing}>
            <Icon name={trimmedMemo ? 'edit-light' : 'sign-plus-light'} />
            {t(trimmedMemo ? 'manuscriptDashboard.memoEdit' : 'manuscriptDashboard.memoAdd')}
          </button>
        )}
      </header>
      {editing ? (
        <DashboardMemoEditor
          manuscriptId={manuscriptId}
          memo={memo}
          onClose={stopEditing}
          onSaved={(nextMemo) => {
            onMemoChange(nextMemo)
            stopEditing()
          }}
          onError={onError}
        />
      ) : trimmedMemo ? (
        <div className="dashboardMemoContent">
          {renderMemoMarkdown(trimmedMemo)}
        </div>
      ) : (
        <div className="dashboardMemoEmpty">
          <Icon name="clipboard-light" />
          <strong>{t('manuscriptDashboard.memoEmptyTitle')}</strong>
          <p>{t('manuscriptDashboard.memoEmptyLead')}</p>
        </div>
      )}
    </section>
  )
}

function DashboardMemoEditor({
  manuscriptId,
  memo,
  onClose,
  onSaved,
  onError,
}: {
  manuscriptId: string
  memo: string
  onClose: () => void
  onSaved: (memo: string) => void
  onError: (error: string) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(memo)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const onSavedRef = useRef(onSaved)
  const {
    backdropStateClass,
    close: closeEditor,
    closing,
    setDialogRef,
    finishAfterExit,
  } = useMobileDialogTransition({ onClose, initialFocusRef: textareaRef, focusOnDesktop: false })

  const isMobileView = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 520px)').matches

  useEffect(() => {
    onSavedRef.current = onSaved
  }, [onSaved])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (
        event.key === 'Escape'
        && !saving
        && window.matchMedia('(max-width: 520px)').matches
      ) closeEditor()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeEditor, saving])

  async function saveMemo() {
    if (saving || draft.length > DASHBOARD_MEMO_MAX_LENGTH) return
    setSaving(true)
    try {
      const payload = await apiRequest<{ memo: string }>(
        `/api/manuscripts/${manuscriptId}/dashboard/memo/`,
        {
          method: 'PATCH',
          body: JSON.stringify({ memo: draft }),
        },
      )
      finishAfterExit(() => onSavedRef.current(payload.memo))
    } catch (err) {
      onError(err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('manuscriptDashboard.memoSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={`dashboardMemoEditor dashboardMemoMobileView ${backdropStateClass}`}
      role={isMobileView ? 'dialog' : undefined}
      aria-modal={isMobileView || undefined}
      aria-labelledby={isMobileView ? 'dashboard-memo-editor-title' : undefined}
      ref={setDialogRef}
    >
      <header className="dashboardMemoMobileHeader">
        <button type="button" className="dashboardMemoMobileBack booksButton" aria-label={t('common.back')} disabled={saving || closing} onClick={closeEditor}>
          <Icon name="arrow-left-1" />
        </button>
        <h2 id="dashboard-memo-editor-title">{t('manuscriptDashboard.memoTitle')}</h2>
        <button type="button" className="dashboardMemoMobileSave booksButton" aria-label={t(saving ? 'common.saving' : 'common.save')} title={t(saving ? 'common.saving' : 'common.save')} disabled={saving || closing || draft.length > DASHBOARD_MEMO_MAX_LENGTH} onClick={() => void saveMemo()}>
          <Icon name="diskette-light" />
        </button>
      </header>
      <textarea
        ref={textareaRef}
        value={draft}
        maxLength={DASHBOARD_MEMO_MAX_LENGTH}
        aria-label={t('manuscriptDashboard.memoTitle')}
        placeholder={t('manuscriptDashboard.memoPlaceholder')}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="dashboardMemoFooter">
        <span>{t('manuscriptDashboard.memoCharacters', {
          count: draft.length,
          limit: DASHBOARD_MEMO_MAX_LENGTH,
        })}</span>
        <div>
          <button type="button" className="booksButton dashboardMemoSecondary" onClick={closeEditor} disabled={saving || closing}>
            {t('common.cancel')}
          </button>
          <button type="button" className="booksButton dashboardMemoPrimary" onClick={() => void saveMemo()} disabled={saving || closing || draft.length > DASHBOARD_MEMO_MAX_LENGTH}>
            {t(saving ? 'common.saving' : 'common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function DailyGoalsWidget({ days, dailyGoal }: { days: WritingActivityDay[]; dailyGoal: number }) {
  const { t, i18n } = useTranslation()
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage)
  const orderedDays = [...days].reverse()
  const todayWords = orderedDays[0]?.words ?? 0
  const hasGoal = dailyGoal > 0
  const progressValue = hasGoal ? Math.min(100, Math.round((todayWords / dailyGoal) * 100)) : 0
  const completedDays = hasGoal
    ? orderedDays.filter((day) => day.words >= dailyGoal).length
    : 0
  const messageKey = !hasGoal
    ? 'dailyGoalsSetGoal'
    : completedDays >= 6
      ? 'dailyGoalsPraise'
      : completedDays >= 3
        ? 'dailyGoalsEncourage'
        : 'dailyGoalsStart'

  return (
    <section className="dailyGoalsWidget dashboardWidget" aria-labelledby="daily-goals-title">
      <header>
        <h2 id="daily-goals-title">{t('manuscriptDashboard.dailyGoals')}</h2>
      </header>
      <div className="dailyGoalMeter" style={{ '--daily-goal-progress': `${progressValue}%` } as CSSProperties}>
        <div
          className="dailyGoalRing"
          role="progressbar"
          aria-label={t('manuscriptDashboard.dailyGoalProgress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressValue}
        >
          {hasGoal && progressValue >= 100 ? (
            <Icon name="check-circle-1-light" />
          ) : (
            <strong>{hasGoal ? `${progressValue}%` : '--'}</strong>
          )}
        </div>
        <p>{hasGoal
          ? t('manuscriptDashboard.dailyGoalWords', {
              current: numberFormatter.format(todayWords),
              goal: numberFormatter.format(dailyGoal),
            })
          : t('manuscriptDashboard.dailyGoalSetHint')}</p>
      </div>
      <div className="dailyGoalDays" aria-label={t('manuscriptDashboard.dailyGoalLastDays')}>
        {orderedDays.map((day, index) => {
          const complete = hasGoal && day.words >= dailyGoal
          const label = formatWeekday(day.date, i18n.resolvedLanguage)
          return (
            <div className="dailyGoalDay" key={day.date}>
              <span>{index === 0 ? t('manuscriptDashboard.todayShort') : label}</span>
              <span
                className={`dailyGoalDayMark ${complete ? 'complete' : ''}`}
                title={t('manuscriptDashboard.dailyGoalDayLabel', {
                  day: label,
                  count: numberFormatter.format(day.words),
                })}
                aria-label={t('manuscriptDashboard.dailyGoalDayLabel', {
                  day: label,
                  count: numberFormatter.format(day.words),
                })}
              >
                {complete && <Icon name="check-read-light" />}
              </span>
            </div>
          )
        })}
      </div>
      <p className="dailyGoalMessage">{t(`manuscriptDashboard.${messageKey}`, { count: completedDays })}</p>
    </section>
  )
}

function WritingActivityWidget({ days, dailyGoal }: { days: WritingActivityDay[]; dailyGoal: number }) {
  const { t, i18n } = useTranslation()
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage)
  const plotHeight = 230
  const plotTop = 18
  const plotBottom = 50
  const plotAreaHeight = plotHeight - plotTop - plotBottom
  const maxWords = Math.max(dailyGoal, ...days.map((day) => day.words), 0)
  const chartMax = activityChartMax(maxWords)
  const ticks = Array.from({ length: Math.floor(chartMax / 1000) + 1 }, (_, index) => index * 1000)
  const goalRatio = dailyGoal > 0 ? Math.max(0, Math.min(1, dailyGoal / chartMax)) : 0
  const goalTop = plotTop + ((1 - goalRatio) * plotAreaHeight)

  return (
    <section className="writingActivityWidget dashboardWidget" aria-labelledby="writing-activity-title">
      <header>
        <h2 id="writing-activity-title">{t('manuscriptDashboard.writingActivity')}</h2>
      </header>
      <div className="writingActivityChart">
        <div className="writingActivityPlot">
          <div className="writingActivityAxis" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick} style={{ bottom: `${(tick / chartMax) * 100}%` }}>
                {formatAxisTick(tick, i18n.resolvedLanguage)}
              </span>
            ))}
          </div>
          <div className="writingActivityGrid" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick} style={{ bottom: `${(tick / chartMax) * 100}%` }} />
            ))}
          </div>
          {dailyGoal > 0 && (
            <span className="writingActivityGoalLine" style={{ top: `${goalTop}px` }}>
              <span>{t('manuscriptDashboard.goal', {
                count: numberFormatter.format(dailyGoal),
              })}</span>
            </span>
          )}
          {days.map((day) => {
            const barHeight = day.words ? Math.max(3, (day.words / chartMax) * plotAreaHeight) : 0
            return (
              <div
                className="writingActivityDay"
                key={day.date}
                style={{
                  '--bar-height': `${barHeight}px`,
                  '--bar-value-bottom': `${22 + barHeight + 6}px`,
                } as CSSProperties}
              >
                <span className="writingActivityValue">{day.words ? numberFormatter.format(day.words) : ''}</span>
                <span
                  className={`writingActivityBar ${dailyGoal > 0 && day.words >= dailyGoal ? 'metGoal' : ''}`}
                />
                <time dateTime={day.date}>
                  {formatShortDate(day.date, i18n.resolvedLanguage)}
                </time>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function renderMemoMarkdown(value: string): ReactNode[] {
  const result: ReactNode[] = []
  const lines = value.split(/\r?\n/)
  let bulletItems: ReactNode[] = []

  function flushBullets() {
    if (!bulletItems.length) return
    result.push(<ul key={`ul-${result.length}`}>{bulletItems}</ul>)
    bulletItems = []
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      flushBullets()
      result.push(<span className="dashboardMemoBreak" key={`break-${index}`} />)
      return
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      bulletItems.push(<li key={`li-${index}`}>{renderInlineMarkdown(bullet[1], `li-${index}`)}</li>)
      return
    }
    flushBullets()
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const HeadingTag = (`h${heading[1].length + 2}`) as 'h3' | 'h4' | 'h5'
      result.push(<HeadingTag key={`heading-${index}`}>{renderInlineMarkdown(heading[2], `heading-${index}`)}</HeadingTag>)
      return
    }
    result.push(<p key={`p-${index}`}>{renderInlineMarkdown(line, `p-${index}`)}</p>)
  })
  flushBullets()
  return result
}

function renderInlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-strong-${index}`}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={`${keyPrefix}-em-${index}`}>{part.slice(1, -1)}</em>
    }
    return <span key={`${keyPrefix}-text-${index}`}>{part}</span>
  })
}

function normalizeDashboardSettings(value: unknown): DashboardSettings {
  const known = new Set(DASHBOARD_WIDGET_ORDER)
  if (!value || typeof value !== 'object') return DEFAULT_DASHBOARD_SETTINGS
  const candidate = value as Partial<Record<keyof DashboardSettings, unknown>>
  const order = Array.isArray(candidate.widgetOrder)
    ? candidate.widgetOrder.filter((widgetId): widgetId is DashboardWidgetId => typeof widgetId === 'string' && known.has(widgetId as DashboardWidgetId))
    : []
  for (const widgetId of DASHBOARD_WIDGET_ORDER) {
    if (!order.includes(widgetId)) order.push(widgetId)
  }
  const hiddenWidgets = Array.isArray(candidate.hiddenWidgets)
    ? candidate.hiddenWidgets.filter((widgetId): widgetId is DashboardWidgetId => typeof widgetId === 'string' && known.has(widgetId as DashboardWidgetId))
    : []
  return {
    widgetOrder: order,
    hiddenWidgets: [...new Set(hiddenWidgets)],
  }
}

function activityChartMax(maxWords: number) {
  if (maxWords <= 0) return 1000
  const rounded = Math.ceil(maxWords / 1000) * 1000
  return rounded === maxWords ? rounded + 1000 : rounded
}

type RecentStatusChip = {
  name: string
  color: string
}

function recentStatusLookup(planner: PlannerData) {
  const statusById = new Map(planner.plan.statuses.map((status) => [
    status.id,
    { name: status.name, color: statusColorValue(status.color) },
  ]))
  const result = new Map<string, RecentStatusChip>()
  for (const item of planner.plan.items) {
    const status = item.statusId ? statusById.get(item.statusId) : null
    if (status) result.set(item.id, status)
  }
  return result
}

function statusChipStyle(status?: RecentStatusChip) {
  if (!status) return undefined
  const rgb = hexToRgb(status.color)
  return {
    '--status-color': status.color,
    '--status-bg': rgb ? `rgba(${rgb}, 0.12)` : '#f1f5f9',
    '--status-border': rgb ? `rgba(${rgb}, 0.34)` : '#cbd5e1',
  } as CSSProperties
}

function hexToRgb(color: string) {
  if (!color.startsWith('#') || color.length !== 7) return null
  const value = Number.parseInt(color.slice(1), 16)
  if (Number.isNaN(value)) return null
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`
}

function aggregateStatusProgress(planner: PlannerData, t: TFunction) {
  const items = dashboardProgressItems(planner.plan.items)
  const totalCount = items.length
  const statuses = [...planner.plan.statuses].sort((left, right) => left.position - right.position)
  const statusById = new Map(statuses.map((status, index) => [status.id, { status, index }]))
  const completeStatusIds = new Set(statuses.filter((status) => status.countsAsComplete).map((status) => status.id))
  const denominator = Math.max(1, statuses.length - 1)
  let readinessTotal = 0
  let completedCount = 0
  const counts = new Map<string, number>()
  let noStatusCount = 0

  for (const item of items) {
    if (!item.statusId) {
      noStatusCount += 1
      continue
    }
    const entry = statusById.get(item.statusId)
    if (!entry) {
      noStatusCount += 1
      continue
    }
    counts.set(entry.status.id, (counts.get(entry.status.id) ?? 0) + 1)
    readinessTotal += statuses.length === 1
      ? entry.status.countsAsComplete ? 100 : 0
      : (entry.index / denominator) * 100
    if (completeStatusIds.has(entry.status.id)) completedCount += 1
  }

  const rows = statuses.map((status) => {
    const count = counts.get(status.id) ?? 0
    const percent = totalCount ? Math.round((count / totalCount) * 100) : 0
    return { id: status.id, name: status.name, color: statusColorValue(status.color), count, percent }
  })
  if (noStatusCount) {
    rows.unshift({
      id: 'none',
      name: t('manuscriptDashboard.noStatus'),
      color: '#94a3b8',
      count: noStatusCount,
      percent: totalCount ? Math.round((noStatusCount / totalCount) * 100) : 0,
    })
  }

  return {
    totalCount,
    completedCount,
    readiness: totalCount ? Math.round(readinessTotal / totalCount) : 0,
    rows,
  }
}

function dashboardProgressItems(items: PlannerItem[]) {
  const activeItems = items.filter((item) => item.role !== 'act')
  const chapters = activeItems.filter((item) => item.role === 'chapter')
  if (chapters.length) return chapters
  const scenes = activeItems.filter((item) => item.role === 'scene')
  if (scenes.length) return scenes
  const documents = activeItems.filter((item) => item.kind === 'document')
  return documents.length ? documents : activeItems
}

function statusColorValue(color: PlannerStatus['color']) {
  return presetStatusColors[color as keyof typeof presetStatusColors] ?? color
}

function formatRelativeDate(value: string, locale: string | undefined, t: TFunction) {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return t('manuscriptDashboard.recently')
  const now = Date.now()
  const difference = now - timestamp
  if (difference < 60_000) return t('manuscriptDashboard.justNow')
  if (difference < 3_600_000) {
    const minutes = Math.max(1, Math.floor(difference / 60_000))
    return t('manuscriptDashboard.minutesAgo', { count: minutes })
  }
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return t('manuscriptDashboard.today')
  if (date.toDateString() === yesterday.toDateString()) return t('manuscriptDashboard.yesterday')
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)
}

function formatShortDate(value: string, locale: string | undefined) {
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`))
}

function formatWeekday(value: string, locale: string | undefined) {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`))
}

function formatAxisTick(value: number, locale: string | undefined) {
  return new Intl.NumberFormat(locale, {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 0,
  }).format(value)
}
