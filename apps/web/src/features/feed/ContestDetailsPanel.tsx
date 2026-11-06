import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type {
  ContestConditionBlock,
  ContestConditionFact,
  ContestDetailPayload,
  ContestItem,
  ContestParticipationPayload,
  ContestPhase,
  ContestRecommendedManuscript,
} from '../../types'
import { ContestTrackingDialog } from './ContestTrackingDialog'
import { PrivateImage } from '../shared/PrivateImage'
import { ResponsiveDetailsPanel } from '../shared/ResponsiveDetailsPanel'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'

type ContestDetailsPanelProps = {
  contest: ContestItem | null
  onClose: () => void
}

const knownPhaseKinds = new Set([
  'submission',
  'longlist',
  'shortlist',
  'judging',
  'judging_shortlist',
  'results',
  'synopsis',
  'manuscript_completion',
])

function parseCalendarDate(value: string) {
  return new Date(`${value}T00:00:00Z`)
}

function fallbackBlocks(text: string): ContestConditionBlock[] {
  return text.split('\n').filter(Boolean).map((line) => ({ type: 'paragraph', text: line }))
}

export function ContestDetailsPanel({ contest, onClose }: ContestDetailsPanelProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? 'en'
  const [requestState, setRequestState] = useState<{
    contestId: string
    details: ContestDetailPayload | null
    failed: boolean
  }>({ contestId: '', details: null, failed: false })
  const [updatingManuscriptId, setUpdatingManuscriptId] = useState('')
  const [trackingManuscript, setTrackingManuscript] = useState<ContestRecommendedManuscript | null>(null)
  const [participationError, setParticipationError] = useState('')
  const details = requestState.contestId === contest?.id ? requestState.details : null
  const failed = requestState.contestId === contest?.id && requestState.failed
  const loading = Boolean(contest) && requestState.contestId !== contest?.id
  const formatters = useMemo(() => ({
    date: new Intl.DateTimeFormat(locale, {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }),
    month: new Intl.DateTimeFormat(locale, {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }),
    qualifierMonth: new Intl.DateTimeFormat(locale, {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }),
    deadline: new Intl.DateTimeFormat(locale, {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: 'Europe/Moscow',
    }),
    number: new Intl.NumberFormat(locale),
  }), [locale])

  useEffect(() => {
    if (!contest) return
    let active = true
    apiRequest<ContestDetailPayload>(`/api/contests/${contest.id}/details/`)
      .then((payload) => {
        if (active) {
          setRequestState({ contestId: contest.id, details: payload, failed: false })
        }
      })
      .catch(() => {
        if (active) {
          setRequestState({ contestId: contest.id, details: null, failed: true })
        }
      })
    return () => {
      active = false
    }
  }, [contest])

  async function toggleParticipation(manuscriptId: string, participating: boolean) {
    if (!contest || updatingManuscriptId) return
    setUpdatingManuscriptId(manuscriptId)
    setParticipationError('')
    try {
      const payload = await apiRequest<ContestParticipationPayload>(
        `/api/contests/${contest.id}/participation/${manuscriptId}/`,
        { method: participating ? 'DELETE' : 'PUT' },
      )
      setRequestState((current) => current.contestId === contest.id && current.details
        ? {
            ...current,
            details: {
              ...current.details,
              recommendedManuscripts: payload.recommendedManuscripts,
            },
          }
        : current)
      if (participating && trackingManuscript?.id === manuscriptId) setTrackingManuscript(null)
    } catch {
      setParticipationError(t('contests.details.participationUpdateFailed'))
    } finally {
      setUpdatingManuscriptId('')
    }
  }

  function applyParticipationPayload(payload: ContestParticipationPayload) {
    if (!contest) return
    setRequestState((current) => current.contestId === contest.id && current.details
      ? {
          ...current,
          details: {
            ...current.details,
            recommendedManuscripts: payload.recommendedManuscripts,
          },
        }
      : current)
  }

  function phaseLabel(phase: ContestPhase) {
    return knownPhaseKinds.has(phase.kind)
      ? t(`contests.details.phases.${phase.kind}`)
      : phase.label
  }

  function phasePeriod(phase: ContestPhase) {
    if (phase.deadlineAt) {
      return t('contests.details.untilDateTime', {
        dateTime: formatters.deadline.format(new Date(phase.deadlineAt)),
      })
    }
    if (!phase.startsOn && !phase.endsOn) {
      return phase.rawText.includes(':')
        ? phase.rawText.split(':', 2)[1].trim()
        : phase.rawText
    }
    const startDate = phase.startsOn ? parseCalendarDate(phase.startsOn) : null
    const endDate = phase.endsOn ? parseCalendarDate(phase.endsOn) : null
    if (phase.precision === 'month' && endDate) return formatters.month.format(endDate)
    if (phase.precision === 'month_range' && startDate && endDate) {
      return t('contests.details.dateRange', {
        start: formatters.month.format(startDate),
        end: formatters.month.format(endDate),
      })
    }
    if (
      phase.precision === 'approximate'
      && startDate
      && endDate
      && startDate.getUTCFullYear() === endDate.getUTCFullYear()
      && startDate.getUTCMonth() === endDate.getUTCMonth()
    ) {
      const month = formatters.qualifierMonth.formatToParts(startDate)
        .filter((part) => part.type === 'month' || part.type === 'year')
        .map((part) => part.value)
        .join(' ')
      if (startDate.getUTCDate() === 1 && endDate.getUTCDate() <= 10) {
        return t('contests.details.beginningOfMonth', { month })
      }
      if (startDate.getUTCDate() >= 11 && endDate.getUTCDate() <= 20) {
        return t('contests.details.middleOfMonth', { month })
      }
      return t('contests.details.endOfMonth', { month })
    }
    const start = startDate ? formatters.date.format(startDate) : null
    const end = endDate ? formatters.date.format(endDate) : null
    if (start && end) {
      return phase.startsOn === phase.endsOn
        ? end
        : t('contests.details.dateRange', { start, end })
    }
    return t('contests.details.untilDate', { date: end ?? start })
  }

  function factValue(fact: ContestConditionFact) {
    if (fact.kind === 'length' && fact.min !== undefined && fact.max !== undefined) {
      return t('contests.details.factValues.length', {
        min: formatters.number.format(fact.min),
        max: formatters.number.format(fact.max),
      })
    }
    if (fact.kind === 'submission_length' && fact.min !== undefined) {
      return t('contests.details.factValues.submissionLength', {
        min: formatters.number.format(fact.min),
      })
    }
    if (fact.kind === 'max_works' && typeof fact.value === 'number') {
      return t('contests.details.factValues.maxWorks', { count: fact.value })
    }
    return String(fact.value ?? '')
  }

  function conditionBlock(block: ContestConditionBlock, index: number) {
    if (block.type === 'list') {
      const List = block.ordered ? 'ol' : 'ul'
      return (
        <List key={index}>
          {block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
        </List>
      )
    }
    return <p key={index}>{block.text}</p>
  }

  return (
    <ResponsiveDetailsPanel
      open={Boolean(contest)}
      title={contest?.title ?? t('contests.details.title')}
      closeLabel={t('common.close')}
      desktopClassName="contestDetailsDialog"
      mobileClassName="contestDetailsMobile"
      backdropClassName="contestDetailsBackdrop"
      desktopDialog
      mobileBackLabel={t('common.back')}
      mobileFullViewTransition
      onClose={onClose}
    >
      {loading && (
        <TadpoleLoadingState className="contestDetailsLoading" label={t('contests.details.loading')} />
      )}
      {!loading && (failed || details?.state === 'unavailable') && (
        <div className="contestDetailsState" role="status">
          <h3>{t('contests.details.unavailable')}</h3>
          <p>{t('contests.details.unavailableLead')}</p>
        </div>
      )}
      {!loading && !failed && details?.state === 'pending' && (
        <div className="contestDetailsState" role="status">
          <h3>{t('contests.details.pending')}</h3>
          <p>{t('contests.details.pendingLead')}</p>
        </div>
      )}
      {!loading && !failed && details?.state === 'ready' && (
        <div className="contestDetailsBody">
          {details.isStale && <p className="contestDetailsStale">{t('contests.details.stale')}</p>}
          <section className="contestDetailsSection" aria-labelledby="contest-details-timeline">
            <h3 id="contest-details-timeline">{t('contests.details.timeline')}</h3>
            <div className="contestTimeline">
              {details.phases.map((phase) => (
                <div className="contestTimelineItem" key={phase.key}>
                  <strong>{phaseLabel(phase)}</strong>
                  <span>{phasePeriod(phase)}</span>
                </div>
              ))}
            </div>
          </section>
          {details.conditionFacts.length > 0 && (
            <section className="contestDetailsSection" aria-labelledby="contest-details-summary">
              <h3 id="contest-details-summary">{t('contests.details.summary')}</h3>
              <dl className="contestFacts">
                {details.conditionFacts.map((fact) => (
                  <div key={fact.kind}>
                    <dt>{t(`contests.details.facts.${fact.kind}`)}</dt>
                    <dd>{factValue(fact)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {details.conditionsSections.length > 0 && (
            <section className="contestDetailsSection" aria-labelledby="contest-details-conditions">
              <h3 id="contest-details-conditions">{t('contests.details.conditions')}</h3>
              <div className="contestConditions">
                {details.conditionsSections.map((section, index) => (
                  <details key={`${section.kind}-${index}`}>
                    <summary>{section.title}</summary>
                    <div className="contestConditionContent">
                      {(section.blocks ?? fallbackBlocks(section.text)).map(conditionBlock)}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}
          {(contest?.status === 'accepting' || details.recommendedManuscripts.length > 0) && (
            <section className="contestDetailsSection" aria-labelledby="contest-details-recommendations">
              <h3 id="contest-details-recommendations">
                {t('contests.details.recommendedManuscripts')}
              </h3>
              <p className="contestRecommendationsLead">
                {t('contests.details.recommendedManuscriptsLead')}
              </p>
              {participationError && (
                <p className="contestParticipationError" role="alert">{participationError}</p>
              )}
              {details.recommendedManuscripts.length === 0 ? (
                <p className="contestRecommendationsEmpty">
                  {t('contests.details.recommendedManuscriptsEmpty')}
                </p>
              ) : (
                <div
                  className="contestRecommendationsViewport"
                  role="region"
                  aria-labelledby="contest-details-recommendations"
                  tabIndex={0}
                >
                  <div className="contestRecommendations">
                    {details.recommendedManuscripts.map((manuscript) => {
                      const updating = updatingManuscriptId === manuscript.id
                      return (
                        <article className="contestRecommendation" key={manuscript.id}>
                          <div className="contestRecommendationCover">
                            {manuscript.coverThumbnailSmallUrl ? (
                              <PrivateImage
                                src={`${API_BASE}${manuscript.coverThumbnailSmallUrl}?v=${manuscript.coverVersion}`}
                                alt=""
                                loading="lazy"
                                decoding="async"
                              />
                            ) : (
                              <Icon name={manuscript.kind === 'book' ? 'books-light' : 'file-document-light'} />
                            )}
                          </div>
                          <h4>{manuscript.title}</h4>
                          <div className="contestRecommendationActions">
                            <button
                              type="button"
                              className={manuscript.participating ? 'isParticipating' : ''}
                              disabled={Boolean(updatingManuscriptId) || (
                                !manuscript.participating && !manuscript.canParticipate
                              )}
                              onClick={() => void toggleParticipation(
                                manuscript.id,
                                manuscript.participating,
                              )}
                            >
                              {t(
                                updating
                                  ? 'contests.details.participationUpdating'
                                  : manuscript.participating
                                    ? 'contests.details.removeParticipation'
                                    : manuscript.canParticipate
                                      ? 'contests.details.markParticipation'
                                      : 'contests.details.participationLimitReached',
                              )}
                            </button>
                            {manuscript.participating && (
                              <button
                                type="button"
                                className={`contestTrackingAction ${manuscript.trackingEnabled ? 'active' : ''}`}
                                aria-label={t('contests.details.trackingSettingsFor', {
                                  title: manuscript.title,
                                })}
                                disabled={Boolean(updatingManuscriptId)}
                                onClick={() => setTrackingManuscript(manuscript)}
                              >
                                <Icon name="settings-light" />
                              </button>
                            )}
                          </div>
                        </article>
                      )
                    })}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {contest && trackingManuscript && (
        <ContestTrackingDialog
          contestId={contest.id}
          manuscript={trackingManuscript}
          onClose={() => setTrackingManuscript(null)}
          onSaved={applyParticipationPayload}
        />
      )}
    </ResponsiveDetailsPanel>
  )
}
