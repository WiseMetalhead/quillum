import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useMobileViewport } from '../shared/useMobileViewport'
import type {
  PlannerContestDeadline,
  PlannerContestPhase,
  PlannerData,
  PlannerStatus,
} from './PlannerTypes'

type CalendarEvent = {
  id: string
  date: string
  title: string
  detail: string
  color: string
  kind: 'deadline' | 'task' | 'contest'
  rangeSegment?: {
    starts: boolean
    ends: boolean
    showTitle: boolean
  }
}

type CalendarRange = {
  id: string
  startsOn: string
  endsOn: string
  title: string
  detail: string
  color: string
}

type ContestAgendaGroup = {
  contestId: string
  contestTitle: string
  color: string
  phases: Array<{ phase: PlannerContestPhase; period: string }>
}

const knownContestPhaseKinds = new Set([
  'submission', 'longlist', 'shortlist', 'judging', 'judging_shortlist',
  'results', 'synopsis', 'manuscript_completion',
])

const contestColors = ['#0d9488', '#7c3aed', '#d97706', '#2563eb', '#dc2626', '#16a34a']

const contestPhaseOrder: Record<string, number> = {
  submission: 10,
  synopsis: 20,
  manuscript_completion: 30,
  longlist: 40,
  judging_shortlist: 50,
  shortlist: 60,
  judging: 70,
  results: 80,
  other: 90,
}

const presetColors: Record<string, string> = {
  gray: '#64748b', blue: '#2563eb', green: '#16a34a', amber: '#d97706',
  purple: '#7c3aed', red: '#dc2626', teal: '#0d9488',
}
export function PlannerCalendar({ planner }: { planner: PlannerData }) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const monthFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const shortDateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  const weekdayFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    weekday: 'short',
    timeZone: 'UTC',
  })
  const longDateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })
  const localDateTimeFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const [month, setMonth] = useState(() => monthStart(planner.statistics.today))
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [view, setView] = useState<'deadlines' | 'tasks'>('deadlines')
  const activeDayRef = useRef<HTMLDivElement>(null)
  const events = useMemo(() => calendarEvents(planner, t), [planner, t])
  const ranges = useMemo(() => calendarRanges(planner, t), [planner, t])
  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>()
    for (const event of events) grouped.set(event.date, [...(grouped.get(event.date) ?? []), event])
    return grouped
  }, [events])
  const days = useMemo(() => calendarDays(month), [month])
  const selectedEvents = selectedDate
    ? [...rangeEventsForDate(ranges, selectedDate), ...(eventsByDate.get(selectedDate) ?? [])]
    : []
  const upcomingDeadlines = events.filter((event) => event.kind === 'deadline' && event.date >= planner.statistics.today)
    .sort((left, right) => left.date.localeCompare(right.date))
  const upcoming = upcomingDeadlines
  const datedTasks = events.filter((event) => event.kind === 'task')
    .sort((left, right) => left.date.localeCompare(right.date))
  const upcomingTasks = datedTasks
  const contestAgenda = contestAgendaGroups(
    planner.contestDeadlines,
    planner.statistics.today,
    t,
    monthFormatter,
    longDateFormatter,
    localDateTimeFormatter,
  )

  function changeMonth(offset: number) {
    setMonth(shiftMonth(month, offset))
    setSelectedDate(null)
  }

  useEffect(() => {
    if (!selectedDate) return
    function closeOutsideActiveDay(event: MouseEvent) {
      if (event.target instanceof Node && !activeDayRef.current?.contains(event.target)) {
        setSelectedDate(null)
      }
    }
    document.addEventListener('mousedown', closeOutsideActiveDay)
    return () => document.removeEventListener('mousedown', closeOutsideActiveDay)
  }, [selectedDate])

  return (
    <section className="plannerCalendarWidget">
      <div className="plannerCalendarBody">
        <div className="plannerCalendarMain">
          <header className="plannerCalendarHeader">
            <h2>{t('planner.calendar')}</h2>
            <span className="plannerCalendarHeaderDivider" aria-hidden="true" />
            <div className="plannerMonthNavigation">
              <button type="button" className="booksButton" aria-label={t('planner.previousMonth')} onClick={() => changeMonth(-1)}><ChevronIcon direction="left" /></button>
              <strong>{monthFormatter.format(month)}</strong>
              <button type="button" className="booksButton" aria-label={t('planner.nextMonth')} onClick={() => changeMonth(1)}><ChevronIcon direction="right" /></button>
            </div>
          </header>
          <div className="plannerCalendarMonth">
            <div className="plannerMonthNavigation plannerMonthNavigationMobile">
              <button type="button" className="booksButton" aria-label={t('planner.previousMonth')} onClick={() => changeMonth(-1)}><ChevronIcon direction="left" /></button>
              <strong>{monthFormatter.format(month)}</strong>
              <button type="button" className="booksButton" aria-label={t('planner.nextMonth')} onClick={() => changeMonth(1)}><ChevronIcon direction="right" /></button>
            </div>
            <div className="plannerWeekdays" aria-hidden="true">
              {Array.from({ length: 7 }, (_value, index) => {
                const date = new Date(Date.UTC(2024, 0, 7 + index))
                return <span key={index}>{weekdayFormatter.format(date)}</span>
              })}
            </div>
            <div className="plannerCalendarGrid">
              {days.map((day, index) => {
                const dateEvents = [
                  ...rangeEventsForDate(ranges, day.date),
                  ...(eventsByDate.get(day.date) ?? []),
                ]
                const selected = selectedDate === day.date
                const edgeClass = index % 7 <= 1 ? 'edgeLeft' : index % 7 >= 5 ? 'edgeRight' : ''
                return <div className={`plannerCalendarDay ${edgeClass}`} key={day.date} ref={selected ? activeDayRef : null}>
                  <button type="button" className={`booksButton ${dateEvents.length ? 'hasEvents' : ''} ${day.currentMonth ? '' : 'outside'} ${day.date === planner.statistics.today ? 'today' : ''} ${selected ? 'selected' : ''}`} aria-label={dateEvents.length ? t('planner.dayWithEvents', { date: formatShortDate(day.date, shortDateFormatter), events: t('planner.eventCount', { count: dateEvents.length }) }) : formatShortDate(day.date, shortDateFormatter)} onClick={() => dateEvents.length && setSelectedDate(selected ? null : day.date)}>
                    <span className="plannerCalendarDayNumber">{day.day}</span>
                    {isMobile ? <i className="plannerCalendarDayDots">{dateEvents.slice(0, 3).map((event) => <b key={event.id} style={{ background: event.color }} />)}</i> : <span className="plannerCalendarDayEvents">
                      {dateEvents.slice(0, 2).map((event) => <span
                        className={`plannerCalendarEventChip ${event.rangeSegment ? `contestCalendarRange ${event.rangeSegment.starts ? 'rangeStarts' : ''} ${event.rangeSegment.ends ? 'rangeEnds' : ''}` : ''}`}
                        key={event.id}
                        style={{ '--planner-calendar-event-color': event.color } as CSSProperties}
                      >
                        {!event.rangeSegment && <i />}
                        <b>{event.rangeSegment && !event.rangeSegment.showTitle ? '' : event.title}</b>
                      </span>)}
                      {dateEvents.length > 2 && <small>+{dateEvents.length - 2}</small>}
                    </span>}
                  </button>
                  {selected && selectedEvents.length > 0 && <div className="plannerDayPopover" role="dialog" aria-label={t('planner.eventsFor', { date: formatShortDate(day.date, shortDateFormatter) })}>
                    <strong>{formatShortDate(day.date, shortDateFormatter)}</strong>
                    {selectedEvents.map((event) => <span key={event.id}><i style={{ background: event.color }} /><span><b>{event.title}</b><small>{event.detail}</small></span></span>)}
                  </div>}
                </div>
              })}
            </div>
          </div>
        </div>

        <div className="plannerCalendarAgenda">
          <header className="plannerCalendarAgendaHeader">
            <div className="plannerCalendarTabs" role="tablist" aria-label={t('planner.agenda')}>
              <button type="button" className={`booksButton ${view === 'deadlines' ? 'active' : ''}`} role="tab" aria-selected={view === 'deadlines'} onClick={() => setView('deadlines')}>{t('planner.deadlines')}</button>
              <button type="button" className={`booksButton ${view === 'tasks' ? 'active' : ''}`} role="tab" aria-selected={view === 'tasks'} onClick={() => setView('tasks')}>{t('planner.tasks')}</button>
            </div>
          </header>
          {view === 'deadlines' ? <div className="plannerAgendaList">
            {upcoming.length > 0 && (
              <section className="plannerAgendaGroup">
                {contestAgenda.length > 0 && <h3>{t('planner.manuscriptDeadlines')}</h3>}
                {upcoming.map((event) => <article key={event.id}><i style={{ background: event.color }} /><time dateTime={event.date}>{formatShortDate(event.date, shortDateFormatter)}</time><span><strong>{event.title}</strong><small>{event.detail}</small></span></article>)}
              </section>
            )}
            {contestAgenda.length > 0 && (
              <section className="plannerAgendaGroup plannerContestAgendaGroup">
                <h3>{t('planner.contestDeadlines')}</h3>
                {contestAgenda.map((group) => (
                  <div className="plannerContestAgenda" key={group.contestId}>
                    <h4><i style={{ background: group.color }} />{group.contestTitle}</h4>
                    {group.phases.map(({ phase, period }) => (
                      <article key={phase.key}>
                        <i style={{ background: group.color }} />
                        <span><strong>{contestPhaseLabel(phase, t)}</strong><small>{period}</small></span>
                      </article>
                    ))}
                  </div>
                ))}
              </section>
            )}
            {upcoming.length === 0 && contestAgenda.length === 0 && <p>{t('planner.noUpcomingDeadlines')}</p>}
          </div> : upcomingTasks.length ? <div className="plannerAgendaList">
            {upcomingTasks.map((event) => <article key={event.id} className={event.date < planner.statistics.today ? 'overdue' : ''}><i style={{ background: event.color }} /><time dateTime={event.date}>{event.date < planner.statistics.today ? t('planner.overdue') : formatShortDate(event.date, shortDateFormatter)}</time><span><strong>{event.title}</strong><small>{event.detail}</small></span></article>)}
          </div> : <div className="plannerCalendarEmpty"><strong>{t('planner.noUpcomingTasks')}</strong><span>{t('planner.upcomingTasksLead')}</span></div>}
        </div>
      </div>
    </section>
  )
}

function calendarEvents(planner: PlannerData, t: TFunction): CalendarEvent[] {
  const statusById = new Map(planner.plan.statuses.map((status) => [status.id, status]))
  const events: CalendarEvent[] = []
  if (planner.settings.deadline) events.push({ id: 'manuscript-deadline', date: planner.settings.deadline, title: t('planner.manuscriptDeadline'), detail: t('planner.manuscript'), color: '#2563eb', kind: 'deadline' })
  for (const item of planner.plan.items) {
    if (!item.deadline) continue
    const status = item.statusId ? statusById.get(item.statusId) : undefined
    events.push({ id: `item-${item.id}`, date: item.deadline, title: item.title, detail: t('planner.itemDeadline', { role: roleLabel(item.role, t) }), color: statusColor(status), kind: 'deadline' })
  }
  const itemById = new Map(planner.plan.items.map((item) => [item.id, item]))
  const taskColors = { high: '#d97706', medium: '#7c3aed', low: '#2563eb' }
  for (const task of planner.tasks) {
    if (!task.deadline || task.completed) continue
    const item = task.associatedItemId ? itemById.get(task.associatedItemId) : undefined
    events.push({ id: `task-${task.id}`, date: task.deadline, title: task.title, detail: item?.title || t('planner.priority', { priority: t(`planner.priorities.${task.priority}`) }), color: taskColors[task.priority], kind: 'task' })
  }
  for (const contest of planner.contestDeadlines) {
    const color = contestColor(contest.contestId)
    for (const phase of contest.phases) {
      if (phase.precision !== 'exact') continue
      const title = contestPhaseLabel(phase, t)
      if (
        phase.startsOn
        && phase.endsOn
        && phase.startsOn !== phase.endsOn
      ) {
        continue
      }
      if (phase.deadlineAt) {
        const deadlineDate = localCalendarDate(phase.deadlineAt)
        if (deadlineDate) events.push({
          id: `contest-${contest.contestId}-${phase.key}-deadline`,
          date: deadlineDate,
          title,
          detail: contest.contestTitle,
          color,
          kind: 'contest',
        })
        continue
      }
      const date = phase.endsOn ?? phase.startsOn
      if (date) events.push({
        id: `contest-${contest.contestId}-${phase.key}`,
        date,
        title,
        detail: contest.contestTitle,
        color,
        kind: 'contest',
      })
    }
  }
  return events
}

function calendarRanges(planner: PlannerData, t: TFunction): CalendarRange[] {
  return planner.contestDeadlines.flatMap((contest) => {
    const color = contestColor(contest.contestId)
    return contest.phases.flatMap((phase) => (
      phase.precision === 'exact'
      && phase.startsOn
      && phase.endsOn
      && phase.startsOn !== phase.endsOn
        ? [{
            id: `contest-${contest.contestId}-${phase.key}-range`,
            startsOn: phase.startsOn,
            endsOn: phase.endsOn,
            title: contestPhaseLabel(phase, t),
            detail: contest.contestTitle,
            color,
          }]
        : []
    ))
  })
}

function rangeEventsForDate(ranges: CalendarRange[], date: string): CalendarEvent[] {
  const dayOfWeek = parseCalendarDate(date).getUTCDay()
  return ranges
    .filter((range) => range.startsOn <= date && date <= range.endsOn)
    .map((range) => {
      const starts = date === range.startsOn || dayOfWeek === 0
      const ends = date === range.endsOn || dayOfWeek === 6
      return {
        id: `${range.id}-${date}`,
        date,
        title: range.title,
        detail: range.detail,
        color: range.color,
        kind: 'contest',
        rangeSegment: { starts, ends, showTitle: starts },
      }
    })
}

function contestAgendaGroups(
  contests: PlannerContestDeadline[],
  today: string,
  t: TFunction,
  monthFormatter: Intl.DateTimeFormat,
  dateFormatter: Intl.DateTimeFormat,
  dateTimeFormatter: Intl.DateTimeFormat,
): ContestAgendaGroup[] {
  return contests.flatMap((contest) => {
    const phases = contest.phases
      .filter((phase) => contestPhaseLastDate(phase) >= today)
      .map((phase) => ({
        phase,
        period: contestPhasePeriod(phase, t, monthFormatter, dateFormatter, dateTimeFormatter),
      }))
      .sort((left, right) => compareContestPhases(left.phase, right.phase))
    return phases.length > 0 ? [{
      contestId: contest.contestId,
      contestTitle: contest.contestTitle,
      color: contestColor(contest.contestId),
      phases,
    }] : []
  })
}

function compareContestPhases(left: PlannerContestPhase, right: PlannerContestPhase) {
  const byEnd = contestPhaseLastDate(left).localeCompare(contestPhaseLastDate(right))
  if (byEnd !== 0) return byEnd
  const byKind = (contestPhaseOrder[left.kind] ?? 90) - (contestPhaseOrder[right.kind] ?? 90)
  if (byKind !== 0) return byKind
  const byStart = (left.startsOn ?? '').localeCompare(right.startsOn ?? '')
  return byStart || left.key.localeCompare(right.key)
}

function contestPhaseLastDate(phase: PlannerContestPhase) {
  if (phase.deadlineAt) return localCalendarDate(phase.deadlineAt)
  return phase.endsOn ?? phase.startsOn ?? ''
}

function contestPhasePeriod(
  phase: PlannerContestPhase,
  t: TFunction,
  monthFormatter: Intl.DateTimeFormat,
  dateFormatter: Intl.DateTimeFormat,
  dateTimeFormatter: Intl.DateTimeFormat,
) {
  if (phase.deadlineAt) {
    return t('planner.contestUntilDateTime', {
      dateTime: dateTimeFormatter.format(new Date(phase.deadlineAt)),
    })
  }
  const startDate = phase.startsOn ? parseCalendarDate(phase.startsOn) : null
  const endDate = phase.endsOn ? parseCalendarDate(phase.endsOn) : null
  const monthDate = endDate ?? startDate
  if (phase.precision === 'month' && monthDate) {
    return monthFormatter.format(monthDate)
  }
  if (phase.precision === 'month_range' && startDate && endDate) {
    return t('contests.details.dateRange', {
      start: monthFormatter.format(startDate),
      end: monthFormatter.format(endDate),
    })
  }
  if (
    phase.precision === 'approximate'
    && startDate
    && endDate
    && startDate.getUTCFullYear() === endDate.getUTCFullYear()
    && startDate.getUTCMonth() === endDate.getUTCMonth()
  ) {
    const month = monthFormatter.format(startDate)
    if (startDate.getUTCDate() === 1 && endDate.getUTCDate() <= 10) {
      return t('contests.details.beginningOfMonth', { month })
    }
    if (startDate.getUTCDate() >= 11 && endDate.getUTCDate() <= 20) {
      return t('contests.details.middleOfMonth', { month })
    }
    return t('contests.details.endOfMonth', { month })
  }
  const start = startDate ? dateFormatter.format(startDate) : null
  const end = endDate ? dateFormatter.format(endDate) : null
  if (start && end) {
    return phase.startsOn === phase.endsOn
      ? end
      : t('contests.details.dateRange', { start, end })
  }
  return t('contests.details.untilDate', { date: end ?? start })
}

function contestPhaseLabel(phase: PlannerContestPhase, t: TFunction) {
  return knownContestPhaseKinds.has(phase.kind)
    ? t(`contests.details.phases.${phase.kind}`)
    : phase.label
}

function contestColor(contestId: string) {
  let hash = 0
  for (const character of contestId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return contestColors[hash % contestColors.length]
}

function localCalendarDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function statusColor(status?: PlannerStatus) { return status ? presetColors[status.color] ?? status.color : '#64748b' }
function monthStart(value: string) { const date = new Date(`${value}T00:00:00Z`); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)) }
function shiftMonth(month: Date, offset: number) { return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + offset, 1)) }
function calendarDays(month: Date) { const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)); const start = new Date(first); start.setUTCDate(1 - first.getUTCDay()); return Array.from({ length: 42 }, (_value, index) => { const date = new Date(start); date.setUTCDate(start.getUTCDate() + index); return { date: date.toISOString().slice(0, 10), day: date.getUTCDate(), currentMonth: date.getUTCMonth() === month.getUTCMonth() } }) }
function formatShortDate(value: string, formatter: Intl.DateTimeFormat) { return formatter.format(new Date(`${value}T00:00:00Z`)) }
function parseCalendarDate(value: string) { return new Date(`${value}T00:00:00Z`) }
function roleLabel(role: string, t: TFunction) { return t(`planner.roles.${role}`, { defaultValue: role }) }
function ChevronIcon({ direction }: { direction: 'left' | 'right' }) { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={direction === 'left' ? 'm14 7-5 5 5 5' : 'm10 7 5 5-5 5'} /></svg> }
