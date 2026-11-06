import { Fragment, useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { AuditEventRow, AuditFilters, AuditEventsPayload } from '../../types'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileViewport } from '../shared/useMobileViewport'
import { AuditEventLabel } from './AuditEventLabel'
import { auditEventName, matchingAuditEventCodes } from './auditEvents'

const EMPTY_AUDIT_FILTERS: AuditFilters = {
  event: '',
  actor: '',
  subject: '',
  ip: '',
  dateFrom: '',
  dateTo: '',
}

const AUDIT_PAGE_SIZE = 10

export function AuditLogTab() {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const dateTimeFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const [auditFilters, setAuditFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  const [appliedAuditFilters, setAppliedAuditFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS)
  const [auditEvents, setAuditEvents] = useState<AuditEventsPayload | null>(null)
  const [auditEventsError, setAuditEventsError] = useState('')
  const [auditEventsLoading, setAuditEventsLoading] = useState(true)
  const [expandedAuditId, setExpandedAuditId] = useState<number | null>(null)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [mobileAuditEvent, setMobileAuditEvent] = useState<AuditEventRow | null>(null)

  const loadAuditEvents = useCallback(async (page: number, filters: AuditFilters) => {
    setAuditEventsError('')
    setAuditEventsLoading(true)
    setExpandedAuditId(null)
    setMobileAuditEvent(null)
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(AUDIT_PAGE_SIZE),
    })

    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })

    const matchingEventCodes = matchingAuditEventCodes(t, filters.event)
    if (matchingEventCodes.length > 0) {
      params.set('eventCodes', matchingEventCodes.join(','))
    }

    try {
      const payload = await apiRequest<AuditEventsPayload>(`/api/admin/audit-events/?${params}`)
      setAuditEvents(payload)
    } catch (err) {
      setAuditEventsError(err instanceof Error ? err.message : t('admin.auditLoadFailed'))
    } finally {
      setAuditEventsLoading(false)
    }
  }, [t])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAuditEvents(1, EMPTY_AUDIT_FILTERS)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadAuditEvents])

  function updateAuditFilter(key: keyof AuditFilters, value: string) {
    setAuditFilters((current) => ({ ...current, [key]: value }))
  }

  function handleAuditFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAppliedAuditFilters(auditFilters)
    void loadAuditEvents(1, auditFilters)
  }

  function resetAuditFilters() {
    setAuditFilters(EMPTY_AUDIT_FILTERS)
    setAppliedAuditFilters(EMPTY_AUDIT_FILTERS)
    void loadAuditEvents(1, EMPTY_AUDIT_FILTERS)
  }

  const activeFilterCount = Object.values(appliedAuditFilters).filter(Boolean).length

  function renderAuditPagination() {
    if (!auditEvents) return null
    return (
      <div className="adminUsersTableFooter">
        <span>
          {t('admin.auditPageSummary', {
            from: auditEvents.pagination.totalItems
              ? (auditEvents.pagination.page - 1) * auditEvents.pagination.pageSize + 1
              : 0,
            to: Math.min(
              auditEvents.pagination.page * auditEvents.pagination.pageSize,
              auditEvents.pagination.totalItems,
            ),
            total: auditEvents.pagination.totalItems,
          })}
        </span>
        <div className="adminUsersPagination">
          <button
            type="button"
            className="adminUsersPageButton spaceButton"
            disabled={!auditEvents.pagination.hasPrevious}
            title={t('admin.previous')}
            aria-label={t('admin.previous')}
            onClick={() => void loadAuditEvents(
              auditEvents.pagination.page - 1,
              isMobile ? appliedAuditFilters : auditFilters,
            )}
          >
            <Icon name="arrow-left-1" />
          </button>
          <span>
            {t('admin.pageValue', {
              page: auditEvents.pagination.page,
              total: auditEvents.pagination.totalPages,
            })}
          </span>
          <button
            type="button"
            className="adminUsersPageButton spaceButton"
            disabled={!auditEvents.pagination.hasNext}
            title={t('admin.next')}
            aria-label={t('admin.next')}
            onClick={() => void loadAuditEvents(
              auditEvents.pagination.page + 1,
              isMobile ? appliedAuditFilters : auditFilters,
            )}
          >
            <Icon name="arrow-right-2" />
          </button>
        </div>
      </div>
    )
  }

  if (isMobile) {
    return (
      <div className="adminAuditMobileLayout">
        <button
          type="button"
          className="adminAuditMobileFilterRow spaceButton"
          aria-haspopup="dialog"
          onClick={() => {
            setAuditFilters(appliedAuditFilters)
            setMobileFiltersOpen(true)
          }}
        >
          <span className="adminAuditMobileFilterIcon"><Icon name="filter-linear" /></span>
          <span>
            <strong>{t('admin.auditFilters')}</strong>
            <small>{activeFilterCount
              ? t('admin.auditActiveFilters', { count: activeFilterCount })
              : t('admin.auditNoActiveFilters')}</small>
          </span>
          <Icon name="arrow-right-2" />
        </button>

        {auditEventsError && <div className="notice error inline">{auditEventsError}</div>}

        <section className="adminAuditMobileEvents" aria-busy={auditEventsLoading}>
          {auditEventsLoading && (
            <div className="adminUsersLoading" role="status" aria-label={t('admin.auditLoading')}>
              <TadpoleIcon />
            </div>
          )}
          {!auditEventsLoading && auditEvents && auditEvents.items.length === 0 && (
            <div className="adminUsersEmpty adminAuditEmpty">
              <Icon name="clipboard-list-light" />
              <strong>{t('admin.noAuditEvents')}</strong>
            </div>
          )}
          {!auditEventsLoading && auditEvents && auditEvents.items.length > 0 && (
            <div className="adminAuditMobileList">
              {auditEvents.items.map((item) => (
                <button
                  type="button"
                  className="adminAuditMobileEventRow spaceButton"
                  onClick={() => setMobileAuditEvent(item)}
                  key={item.id}
                >
                  <time dateTime={item.createdAt}>{dateTimeFormatter.format(new Date(item.createdAt))}</time>
                  <strong>{auditEventName(t, item.event)}</strong>
                  <Icon name="arrow-right-2" />
                </button>
              ))}
            </div>
          )}
          {!auditEventsLoading && renderAuditPagination()}
        </section>

        {mobileFiltersOpen && (
          <MobileSettingsSheet
            title={t('admin.auditFilters')}
            onClose={() => {
              setAuditFilters(appliedAuditFilters)
              setMobileFiltersOpen(false)
            }}
          >
            {(close) => (
              <form
                className="adminAuditMobileFilterForm"
                onSubmit={(event) => {
                  handleAuditFilterSubmit(event)
                  close()
                }}
              >
                <label>
                  <span>{t('admin.event')}</span>
                  <input
                    type="search"
                    name="event"
                    value={auditFilters.event}
                    onChange={(event) => updateAuditFilter('event', event.target.value)}
                  />
                </label>
                <label>
                  <span>{t('admin.actor')}</span>
                  <input
                    name="actor"
                    value={auditFilters.actor}
                    onChange={(event) => updateAuditFilter('actor', event.target.value)}
                  />
                </label>
                <label>
                  <span>{t('admin.subject')}</span>
                  <input
                    name="subject"
                    value={auditFilters.subject}
                    onChange={(event) => updateAuditFilter('subject', event.target.value)}
                  />
                </label>
                <label>
                  <span>{t('admin.ip')}</span>
                  <input
                    name="ip"
                    value={auditFilters.ip}
                    onChange={(event) => updateAuditFilter('ip', event.target.value)}
                  />
                </label>
                <div className="adminAuditMobileFilterActions">
                  <button
                    type="button"
                    className="secondary spaceButton"
                    onClick={() => {
                      resetAuditFilters()
                      close()
                    }}
                  >
                    <Icon name="restart-light" />
                    {t('admin.resetFilters')}
                  </button>
                  <button type="submit" className="spaceButton">{t('admin.filterUsers')}</button>
                </div>
              </form>
            )}
          </MobileSettingsSheet>
        )}

        {mobileAuditEvent && (
          <MobileSettingsSheet
            title={t('admin.auditEventDetails')}
            initialFocus="dialog"
            onClose={() => setMobileAuditEvent(null)}
          >
            <div className="adminAuditMobileDetails">
              <dl>
                <div><dt>{t('admin.time')}</dt><dd>{dateTimeFormatter.format(new Date(mobileAuditEvent.createdAt))}</dd></div>
                <div><dt>{t('admin.event')}</dt><dd>{auditEventName(t, mobileAuditEvent.event)}</dd></div>
                <div><dt>{t('admin.auditEventCode')}</dt><dd><code>{mobileAuditEvent.event}</code></dd></div>
                <div><dt>{t('admin.actor')}</dt><dd>{mobileAuditEvent.actor ?? t('admin.system')}</dd></div>
                <div><dt>{t('admin.subject')}</dt><dd>{mobileAuditEvent.subject || t('admin.none')}</dd></div>
                <div><dt>{t('admin.ip')}</dt><dd>{mobileAuditEvent.ipAddress ?? t('admin.unknown')}</dd></div>
                <div><dt>{t('admin.userAgent')}</dt><dd>{mobileAuditEvent.userAgent || t('admin.none')}</dd></div>
              </dl>
              <div className="adminAuditPayload">
                <strong>{t('admin.payload')}</strong>
                <pre className="payloadBlock">{JSON.stringify(mobileAuditEvent.payload, null, 2)}</pre>
              </div>
            </div>
          </MobileSettingsSheet>
        )}
      </div>
    )
  }

  return (
    <div className="adminAuditLayout">
      <form className="panel auditFilters adminUsersFilters adminAuditFilters" onSubmit={handleAuditFilterSubmit}>
        <div className="adminUsersHeader">
          <div className="adminUsersTitle adminAuditTitle">
            <Icon name="clipboard-list-light" />
            <div>
              <h2>{t('admin.auditLog')}</h2>
            </div>
          </div>
        </div>
        <div className="adminUsersFilterRow adminAuditFilterRow">
          <label>
            {t('admin.event')}
            <input
              type="search"
              name="event"
              value={auditFilters.event}
              onChange={(event) => updateAuditFilter('event', event.target.value)}
            />
          </label>
          <label>
            {t('admin.actor')}
            <input
              name="actor"
              value={auditFilters.actor}
              onChange={(event) => updateAuditFilter('actor', event.target.value)}
            />
          </label>
          <label>
            {t('admin.subject')}
            <input
              name="subject"
              value={auditFilters.subject}
              onChange={(event) => updateAuditFilter('subject', event.target.value)}
            />
          </label>
          <label>
            {t('admin.ip')}
            <input
              name="ip"
              value={auditFilters.ip}
              onChange={(event) => updateAuditFilter('ip', event.target.value)}
            />
          </label>
          <div className="adminUsersFilterActions">
            <button type="submit" className="adminUsersApplyButton spaceButton">
              {t('admin.filterUsers')}
            </button>
            <button type="button" className="adminUsersResetButton spaceButton" onClick={resetAuditFilters}>
              <Icon name="restart-light" />
              {t('admin.resetFilters')}
            </button>
          </div>
        </div>
        {auditEventsError && <div className="notice error inline">{auditEventsError}</div>}
      </form>

      <section className="panel adminUsersTablePanel adminAuditTablePanel" aria-busy={auditEventsLoading}>
        <div className="adminUsersTableViewport adminAuditTableViewport">
          {auditEventsLoading && (
            <div className="adminUsersLoading" role="status" aria-label={t('admin.auditLoading')}>
              <TadpoleIcon />
            </div>
          )}
          {!auditEventsLoading && auditEvents && auditEvents.items.length === 0 && (
            <div className="adminUsersEmpty adminAuditEmpty">
              <Icon name="clipboard-list-light" />
              <strong>{t('admin.noAuditEvents')}</strong>
            </div>
          )}
          {auditEvents && auditEvents.items.length > 0 && (
            <table className="auditTable adminAuditTable">
              <thead>
                <tr>
                  <th>{t('admin.time')}</th>
                  <th>{t('admin.event')}</th>
                  <th>{t('admin.actor')}</th>
                  <th>{t('admin.subject')}</th>
                  <th>{t('admin.ip')}</th>
                  <th aria-label={t('admin.details')} />
                </tr>
              </thead>
              <tbody>
                {auditEvents.items.map((item) => {
                  const isExpanded = expandedAuditId === item.id
                  return (
                    <Fragment key={item.id}>
                      <tr
                        className="adminAuditRow"
                        onClick={(event) => {
                          if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea, [tabindex]')) return
                          const selection = window.getSelection()
                          if (selection && !selection.isCollapsed && selection.toString()) return
                          setExpandedAuditId(isExpanded ? null : item.id)
                        }}
                      >
                        <td>{dateTimeFormatter.format(new Date(item.createdAt))}</td>
                        <td className="adminAuditEventCell">
                          <AuditEventLabel event={item.event} />
                        </td>
                        <td>{item.actor ?? t('admin.system')}</td>
                        <td>{item.subject || t('admin.none')}</td>
                        <td>{item.ipAddress ?? t('admin.unknown')}</td>
                        <td className="adminAuditDetailsAction">
                          <button
                            type="button"
                            className="adminAuditDetailsButton spaceButton"
                            title={t(isExpanded ? 'admin.hideDetails' : 'admin.details')}
                            aria-label={t(isExpanded ? 'admin.hideDetails' : 'admin.details')}
                            aria-expanded={isExpanded}
                            onClick={() => setExpandedAuditId(isExpanded ? null : item.id)}
                          >
                            <Icon name={isExpanded ? 'arrow-up-2' : 'arrow-down-2'} />
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="adminAuditDetailsRow">
                          <td colSpan={6} className="adminAuditDetailsCell">
                            <div className="adminAuditDetails">
                              <dl className="adminAuditMeta">
                                <div>
                                  <dt>{t('admin.userAgent')}</dt>
                                  <dd>{item.userAgent || t('admin.none')}</dd>
                                </div>
                              </dl>
                              <div className="adminAuditPayload">
                                <strong>{t('admin.payload')}</strong>
                                <pre className="payloadBlock">{JSON.stringify(item.payload, null, 2)}</pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        {renderAuditPagination()}
      </section>
    </div>
  )
}
