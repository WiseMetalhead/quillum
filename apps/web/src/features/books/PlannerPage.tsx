import { useEffect, useRef, useState } from 'react'
import type { FormEvent, UIEvent } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { apiQuery, apiRequest } from '../../api/client'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import { Icon, type IconName } from '../../icons/Icon'
import type { Manuscript } from './ManuscriptTypes'
import { PlannerCalendar } from './PlannerCalendar'
import { PlannerPlan } from './PlannerPlan'
import { PlannerTasks } from './PlannerTasks'
import type { PlannerData, PlannerSettings } from './PlannerTypes'
import './PlannerPage.css'

type Props = {
  manuscript: Manuscript
  onManuscriptChange: (manuscript: Manuscript) => void
  onError: (error: string) => void
  onOpenEditorDocument: (itemId: string | null) => void
}

type PlannerDialogKind = 'deadline' | 'daily' | 'manuscript'
type PlannerSection = 'goals' | 'tasks' | 'calendar'

export function PlannerPage({ manuscript, onManuscriptChange, onError, onOpenEditorDocument }: Props) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage)
  const [planner, setPlanner] = useState<PlannerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [dialogKind, setDialogKind] = useState<PlannerDialogKind | null>(null)
  const [activeSection, setActiveSection] = useState<PlannerSection>('goals')
  const [mobileSectionMenuOpen, setMobileSectionMenuOpen] = useState(false)
  const [mobileActionsHidden, setMobileActionsHidden] = useState(false)
  const mobileSectionMenuRef = useRef<HTMLDivElement>(null)
  const plannerSectionBodyRef = useRef<HTMLElement>(null)
  const mobileScrollAnchorRef = useRef(0)

  useEffect(() => {
    if (!mobileSectionMenuOpen) return
    function closeMenu(event: MouseEvent) {
      if (event.target instanceof Node && !mobileSectionMenuRef.current?.contains(event.target)) {
        setMobileSectionMenuOpen(false)
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileSectionMenuOpen(false)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [mobileSectionMenuOpen])

  useEffect(() => {
    let active = true
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const plannerPath = `/api/manuscripts/${manuscript.id}/planner/?timezone=${encodeURIComponent(timezone)}`
    async function loadPlanner(showLoading: boolean) {
      if (showLoading) setLoading(true)
      try {
        const updatePlanner = (payload: { planner: PlannerData }) => {
          if (active) setPlanner(payload.planner)
        }
        const payload = await apiQuery<{ planner: PlannerData }>(plannerPath, showLoading
          ? { onBackgroundUpdate: updatePlanner }
          : { maxAgeMs: 0, onBackgroundUpdate: updatePlanner })
        if (active) setPlanner(payload.planner)
      } catch (err) {
        if (active) onError(err instanceof Error ? err.message : i18n.t('planner.loadFailed'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadPlanner(true)
    const refreshTimer = window.setTimeout(() => void loadPlanner(false), 1500)
    return () => {
      active = false
      window.clearTimeout(refreshTimer)
    }
  }, [i18n, manuscript.id, onError])

  if (loading) return <TadpoleLoadingState className="manuscriptPageState" label={t('planner.loading')} />
  if (!planner) return <div className="manuscriptPageState">{t('planner.unavailable')}</div>

  function applyPlanner(nextPlanner: PlannerData) {
    setPlanner(nextPlanner)
    if (nextPlanner.manuscriptTitle !== manuscript.title) {
      onManuscriptChange({ ...manuscript, title: nextPlanner.manuscriptTitle })
    }
  }

  function selectSection(section: PlannerSection) {
    setActiveSection(section)
    setMobileActionsHidden(false)
    mobileScrollAnchorRef.current = plannerSectionBodyRef.current?.scrollTop ?? 0
  }

  function handleMobileScroll(event: UIEvent<HTMLElement>) {
    if (!isMobile || activeSection === 'calendar') return
    const scrollTop = event.currentTarget.scrollTop
    if (scrollTop <= 4) {
      mobileScrollAnchorRef.current = scrollTop
      setMobileActionsHidden(false)
      return
    }
    const delta = scrollTop - mobileScrollAnchorRef.current
    if (Math.abs(delta) < 12) return
    mobileScrollAnchorRef.current = scrollTop
    setMobileActionsHidden(delta > 0)
  }

  const deadlineDetail = deadlineStatus(
    planner.settings.deadline,
    planner.statistics.today,
    numberFormatter,
    t,
  )
  const sectionLabelKeys: Record<PlannerSection, string> = {
    goals: 'planner.mobileGoalsAndPlan',
    tasks: 'plannerTasks.tasks',
    calendar: 'planner.calendar',
  }
  const sectionIcons: Record<PlannerSection, IconName> = {
    goals: 'file-document-light',
    tasks: 'check-square-light',
    calendar: 'calendar-minimalistic-light',
  }
  const mobileSectionLabelKeys: Record<PlannerSection, string> = {
    goals: 'planner.mobileGoalsAndPlan',
    tasks: 'plannerTasks.tasks',
    calendar: 'planner.calendar',
  }
  return (
    <div className={`plannerPage sidebarPage plannerSection-${activeSection} mobileSection-${activeSection} ${mobileActionsHidden ? 'mobileActionsHidden' : ''}`}>
      <aside className="sectionSidebar plannerSectionSidebar" aria-label={t('planner.mobileSections')}>
        <nav className="sectionNavigation plannerSectionNavigation" aria-label={t('planner.mobileSections')}>
          {(Object.keys(sectionLabelKeys) as PlannerSection[]).map((section) => (
            <button
              type="button"
              className={`sectionNavigationButton ${activeSection === section ? 'active' : ''}`}
              title={t(sectionLabelKeys[section])}
              aria-current={activeSection === section ? 'page' : undefined}
              key={section}
              onClick={() => selectSection(section)}
            >
              <Icon name={sectionIcons[section]} />
              <span>{t(sectionLabelKeys[section])}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="sectionBody plannerSectionBody" ref={plannerSectionBodyRef} onScroll={handleMobileScroll}>
        <header className="plannerMobileHeader">
          <div className="plannerMobileSectionSelector" ref={mobileSectionMenuRef}>
            <button
              type="button"
              className={`plannerMobileSectionToggle booksButton ${mobileSectionMenuOpen ? 'active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={mobileSectionMenuOpen}
              onClick={() => setMobileSectionMenuOpen((open) => !open)}
            >
              <span>{t(mobileSectionLabelKeys[activeSection])}</span>
              <Icon name="arrow-down-2" />
            </button>
            {mobileSectionMenuOpen && (
              <div className="plannerMobileSectionMenu" role="menu" aria-label={t('planner.mobileSections')}>
                {(Object.keys(mobileSectionLabelKeys) as PlannerSection[]).map((section) => (
                  <button
                    type="button"
                    className={`booksButton ${activeSection === section ? 'active' : ''}`}
                    role="menuitemradio"
                    aria-checked={activeSection === section}
                    key={section}
                    onClick={() => {
                      selectSection(section)
                      setMobileSectionMenuOpen(false)
                    }}
                  >
                    {t(mobileSectionLabelKeys[section])}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>
        <div className="plannerWorkspaceGrid">
          <div className="plannerMainColumn">
            <section className="plannerGoals" aria-label={t('planner.goals')}>
              <GoalCard
                icon="calendar-light"
                tone="blue"
                label={t('planner.manuscriptDeadline')}
                value={planner.settings.deadline
                  ? formatDate(planner.settings.deadline, i18n.resolvedLanguage)
                  : t('planner.setDeadline')}
                detail={deadlineDetail}
                onClick={() => setDialogKind('deadline')}
              />
              <GoalCard
                icon="writing-pen-light"
                tone="blue"
                label={t('planner.dailyGoal')}
                value={goalLabel(planner.settings.dailyWordGoal, numberFormatter, t)}
                detail={planner.settings.dailyWordGoal
                  ? t('planner.todayProgress', {
                      current: numberFormatter.format(planner.statistics.wordsToday),
                      goal: numberFormatter.format(planner.settings.dailyWordGoal),
                    })
                  : t('planner.setDailyTarget')}
                progress={progress(planner.statistics.wordsToday, planner.settings.dailyWordGoal)}
                onClick={() => setDialogKind('daily')}
              />
              <GoalCard
                icon="books-light"
                tone="green"
                label={t('planner.manuscriptGoal')}
                value={goalLabel(planner.settings.manuscriptWordGoal, numberFormatter, t)}
                detail={planner.settings.manuscriptWordGoal
                  ? `${numberFormatter.format(planner.statistics.totalWords)} / ${numberFormatter.format(planner.settings.manuscriptWordGoal)}`
                  : t('planner.wordsWritten', {
                      count: planner.statistics.totalWords,
                      formattedCount: numberFormatter.format(planner.statistics.totalWords),
                    })}
                progress={progress(planner.statistics.totalWords, planner.settings.manuscriptWordGoal)}
                onClick={() => setDialogKind('manuscript')}
              />
            </section>
            <PlannerPlan
              manuscript={manuscript}
              planner={planner}
              onChange={applyPlanner}
              onError={onError}
              onOpenEditorDocument={onOpenEditorDocument}
            />
          </div>
          <aside className="plannerSidebar" aria-label={t('planner.overview')}>
            <PlannerTasks manuscriptId={manuscript.id} tasks={planner.tasks} items={planner.plan.items} onChange={(tasks) => setPlanner((current) => current ? { ...current, tasks } : current)} onError={onError} />
            <PlannerCalendar planner={planner} />
          </aside>
        </div>

        {dialogKind && (
          <PlannerSettingDialog
            kind={dialogKind}
            settings={planner.settings}
            manuscriptId={manuscript.id}
            onClose={() => setDialogKind(null)}
            onSaved={(nextPlanner) => {
              applyPlanner(nextPlanner)
              setDialogKind(null)
            }}
            onError={onError}
          />
        )}
      </main>
    </div>
  )
}

function GoalCard({
  icon,
  tone,
  label,
  value,
  detail,
  progress: progressValue,
  onClick,
}: {
  icon: IconName
  tone: 'blue' | 'green'
  label: string
  value: string
  detail: string
  progress?: number
  onClick: () => void
}) {
  return (
    <button type="button" className={`plannerGoalCard ${tone} booksButton`} onClick={onClick}>
      <span className="plannerGoalIcon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="plannerGoalContent">
        <span className="plannerGoalLabel">{label}</span>
        <strong>{value}</strong>
        <span className="plannerGoalDetail">{detail}</span>
        {progressValue !== undefined && (
          <span className="plannerProgress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressValue}>
            <span style={{ width: `${progressValue}%` }} />
          </span>
        )}
      </span>
    </button>
  )
}

function PlannerSettingDialog({
  kind,
  settings,
  manuscriptId,
  onClose,
  onSaved,
  onError,
}: {
  kind: PlannerDialogKind
  settings: PlannerSettings
  manuscriptId: string
  onClose: () => void
  onSaved: (planner: PlannerData) => void
  onError: (error: string) => void
}) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const [deadline, setDeadline] = useState(settings.deadline ?? '')
  const [wordGoal, setWordGoal] = useState(String(
    (kind === 'daily' ? settings.dailyWordGoal : settings.manuscriptWordGoal) || '',
  ))
  const [submitting, setSubmitting] = useState(false)
  const { backdropStateClass, close: closeMobileDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose, focusOnDesktop: false })
  const closeDialog = isMobile ? closeMobileDialog : onClose

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, submitting])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    onError('')
    try {
      const payload = await apiRequest<{ planner: PlannerData }>(
        `/api/manuscripts/${manuscriptId}/planner/`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            deadline: kind === 'deadline' ? deadline || null : settings.deadline,
            dailyWordGoal: kind === 'daily' ? Number(wordGoal || 0) : settings.dailyWordGoal,
            manuscriptWordGoal: kind === 'manuscript'
              ? Number(wordGoal || 0)
              : settings.manuscriptWordGoal,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }),
        },
      )
      if (isMobile) finishAfterExit(() => onSaved(payload.planner))
      else onSaved(payload.planner)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('planner.saveFailed'))
      setSubmitting(false)
    }
  }

  const dialog = plannerDialogCopy(kind, t)
  const dialogTitleId = `planner-${kind}-title`

  return (
    <div className={`dialogBackdrop ${isMobile ? `mobileBottomSheetBackdrop plannerGoalSettingBackdrop ${backdropStateClass}` : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className={`createOneShotDialog plannerSettingDialog ${isMobile ? 'mobileBottomSheet' : ''}`} role="dialog" aria-modal="true" aria-labelledby={dialogTitleId} ref={isMobile ? setDialogRef : undefined}>
        <header>
          <div>
            <h2 id={dialogTitleId}>{dialog.title}</h2>
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('planner.close')} onClick={closeDialog} disabled={submitting || closing}><Icon name="close-square-light" /></button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          {kind === 'deadline' ? (
            <label className="dialogField">
              <span>{t('planner.deadline')}</span>
              <input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
              <small>{t('planner.removeDeadlineHint')}</small>
            </label>
          ) : (
            <label className="dialogField">
              <span>{t(kind === 'daily' ? 'planner.wordsPerDay' : 'planner.totalWords')}</span>
              <input type="number" min="0" max="100000000" step="1" inputMode="numeric" value={wordGoal} placeholder={kind === 'daily' ? '2000' : '120000'} onChange={(event) => setWordGoal(event.target.value)} />
              <small>{t('planner.removeGoalHint')}</small>
            </label>
          )}
          <footer>
            <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit booksButton" disabled={submitting || closing}>{submitting ? t('common.saving') : dialog.submitLabel}</button>
          </footer>
        </form>
      </div>
    </div>
  )
}

function plannerDialogCopy(kind: PlannerDialogKind, t: TFunction) {
  if (kind === 'deadline') return {
    title: t('planner.setManuscriptDeadline'),
    submitLabel: t('planner.saveDeadline'),
  }
  if (kind === 'daily') return {
    title: t('planner.setDailyGoal'),
    submitLabel: t('planner.saveDailyGoal'),
  }
  return {
    title: t('planner.setManuscriptGoal'),
    submitLabel: t('planner.saveManuscriptGoal'),
  }
}

function progress(current: number, goal: number) {
  return goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0
}

function goalLabel(goal: number, numberFormatter: Intl.NumberFormat, t: TFunction) {
  return goal
    ? t('planner.wordGoal', { count: goal, formattedCount: numberFormatter.format(goal) })
    : t('planner.setGoal')
}

function formatDate(value: string, locale: string | undefined) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`))
}

function deadlineStatus(
  deadline: string | null,
  today: string,
  numberFormatter: Intl.NumberFormat,
  t: TFunction,
) {
  if (!deadline) return t('planner.chooseCompletionDate')
  const difference = Math.round(
    (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  )
  if (difference === 0) return t('planner.dueToday')
  const count = Math.abs(difference)
  return t(difference > 0 ? 'planner.daysLeft' : 'planner.daysOverdue', {
    count,
    formattedCount: numberFormatter.format(count),
  })
}
