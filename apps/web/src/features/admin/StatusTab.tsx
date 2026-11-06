import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { apiRequest } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { AdminStatus } from '../../types'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileViewport } from '../shared/useMobileViewport'
import { AuditEventLabel } from './AuditEventLabel'
import { StatusCard } from './StatusCard'
import { formatBytes } from './utils'

const STATUS_REFRESH_INTERVAL_MS = 30_000

type StatusTabProps = {
  onOpenAudit: () => void
}

export function StatusTab({ onOpenAudit }: StatusTabProps) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const locale = i18n.resolvedLanguage ?? 'en'
  const numberFormatter = new Intl.NumberFormat(locale)
  const decimalFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null)
  const [adminStatusError, setAdminStatusError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [mobileSheet, setMobileSheet] = useState<'tasks' | 'audit' | null>(null)
  const mountedRef = useRef(true)
  const requestInFlightRef = useRef(false)

  const loadStatus = useCallback(async (initial = false) => {
    if (requestInFlightRef.current) return
    requestInFlightRef.current = true
    if (initial) setLoading(true)
    else setRefreshing(true)
    setAdminStatusError('')
    try {
      const payload = await apiRequest<AdminStatus>('/api/admin/status/')
      if (mountedRef.current) setAdminStatus(payload)
    } catch (err) {
      if (mountedRef.current) {
        setAdminStatusError(err instanceof Error ? err.message : t('admin.statusLoadFailed'))
      }
    } finally {
      requestInFlightRef.current = false
      if (mountedRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [t])

  useEffect(() => {
    mountedRef.current = true
    const initialTimer = window.setTimeout(() => void loadStatus(true), 0)
    const refreshTimer = window.setInterval(() => {
      if (!document.hidden) void loadStatus(false)
    }, STATUS_REFRESH_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      window.clearTimeout(initialTimer)
      window.clearInterval(refreshTimer)
    }
  }, [loadStatus])

  const unknown = t('admin.unknown')
  const database = adminStatus?.services.database
  const redis = adminStatus?.services.redis
  const celery = adminStatus?.services.celery
  const storage = adminStatus?.services.storage
  const collaboration = adminStatus?.services.collaboration
  const workerHealthy = Boolean(
    celery?.ok
    && (
      !adminStatus?.taskActivity.scheduler.configured
      || adminStatus.taskActivity.scheduler.online
    ),
  )

  return (
    <div className="adminStatusLayout">
      {!isMobile && (
        <section className="panel adminStatusHeader">
          <div className="adminSettingsSectionHeader">
            <Icon name="pulse-light" />
            <h2>{t('admin.serviceStatus')}</h2>
          </div>
          <div className="adminStatusRefreshControls">
            <button
              type="button"
              className="adminUsersResetButton spaceButton"
              disabled={loading || refreshing}
              onClick={() => void loadStatus(false)}
            >
              <Icon name="restart-light" />
              {refreshing ? t('admin.refreshing') : t('admin.refresh')}
            </button>
          </div>
        </section>
      )}

      {adminStatusError && <div className="notice error adminStatusNotice">{adminStatusError}</div>}

      {loading && !adminStatus ? (
        <section className="panel adminStatusLoading" role="status" aria-label={t('admin.statusLoading')}>
          <TadpoleIcon />
        </section>
      ) : adminStatus ? (
        <>
          <div className={`adminStatusServiceGrid ${isMobile ? 'mobile' : ''}`} aria-live="polite">
            {isMobile ? (
              <>
                <MobileVersionCard
                  label={t('admin.quillumVersion')}
                  value={adminStatus.app.version}
                />
                <MobileStatusCard
                  label={t('admin.database')}
                  metricLabel={t('admin.databaseSize')}
                  metricValue={database?.sizeBytes == null ? unknown : formatBytes(database.sizeBytes, locale)}
                  statusLabel={database?.ok ? t('admin.healthy') : t('admin.degraded')}
                  tone={database?.ok ? 'ok' : 'degraded'}
                />
                <MobileStatusCard
                  label={t('admin.redis')}
                  metricLabel={t('admin.memory')}
                  metricValue={redis?.usedMemoryBytes == null ? unknown : formatBytes(redis.usedMemoryBytes, locale)}
                  statusLabel={redis?.ok ? t('admin.healthy') : t('admin.degraded')}
                  tone={redis?.ok ? 'ok' : 'degraded'}
                />
                <MobileStatusCard
                  label={t('admin.worker')}
                  metricLabel={t('admin.responseTime')}
                  metricValue={latencyValue(celery?.latencyMs, decimalFormatter, unknown, t)}
                  statusLabel={workerHealthy ? t('admin.healthy') : t('admin.degraded')}
                  tone={workerHealthy ? 'ok' : 'degraded'}
                />
                <MobileStatusCard
                  label={t('admin.collaboration')}
                  metricLabel={t('admin.connections')}
                  metricValue={collaboration?.connections == null ? unknown : numberFormatter.format(collaboration.connections)}
                  statusLabel={collaboration?.ok ? t('admin.healthy') : t('admin.degraded')}
                  tone={collaboration?.ok ? 'ok' : 'degraded'}
                />
                <MobileStatusCard
                  label={t('admin.storage')}
                  metricLabel={t('admin.mediaUsage')}
                  metricValue={storage?.usedBytes == null ? unknown : formatBytes(storage.usedBytes, locale)}
                  statusLabel={storage?.ok ? t('admin.healthy') : t('admin.degraded')}
                  tone={storage?.ok ? 'ok' : 'degraded'}
                />
              </>
            ) : (
              <>
                <StatusCard
                  icon="database-light"
                  label={t('admin.database')}
                  value={database?.ok ? t('admin.working') : t('admin.unavailable')}
                  statusLabel={database?.ok ? t('admin.healthy') : t('admin.degraded')}
                  tone={database?.ok ? 'ok' : 'degraded'}
                  details={[
                    { label: t('admin.version'), value: database?.version ?? unknown },
                    {
                      label: t('admin.databaseSize'),
                      value: database?.sizeBytes == null ? unknown : formatBytes(database.sizeBytes, locale),
                    },
                    {
                      label: t('admin.connections'),
                      value: database?.activeConnections == null
                        ? unknown
                        : numberFormatter.format(database.activeConnections),
                    },
                    { label: t('admin.responseTime'), value: latencyValue(database?.latencyMs, decimalFormatter, unknown, t) },
                  ]}
                />
                <StatusCard
                  icon="layers-minimalistic-light"
                  label={t('admin.redis')}
                  value={redis?.ok ? t('admin.working') : t('admin.unavailable')}
                  statusLabel={redis?.ok ? t('admin.healthy') : t('admin.degraded')}
                  tone={redis?.ok ? 'ok' : 'degraded'}
                  details={[
                    { label: t('admin.version'), value: redis?.version ?? unknown },
                    {
                      label: t('admin.memory'),
                      value: redis?.usedMemoryBytes == null
                        ? unknown
                        : redis.maxMemoryBytes
                          ? `${formatBytes(redis.usedMemoryBytes, locale)} / ${formatBytes(redis.maxMemoryBytes, locale)}`
                          : formatBytes(redis.usedMemoryBytes, locale),
                    },
                    {
                      label: t('admin.redisKeys'),
                      value: redis?.keys == null ? unknown : numberFormatter.format(redis.keys),
                    },
                    { label: t('admin.responseTime'), value: latencyValue(redis?.latencyMs, decimalFormatter, unknown, t) },
                  ]}
                />
                <StatusCard
                  icon="box-light"
                  label={t('admin.app')}
                  value={t('admin.working')}
                  statusLabel={t('admin.available')}
                  tone="ok"
                  details={[
                    { label: t('admin.version'), value: adminStatus.app.version },
                    { label: t('admin.environment'), value: adminStatus.app.environment },
                    { label: t('admin.authentication'), value: adminStatus.auth.mode },
                    { label: t('admin.debug'), value: adminStatus.app.debug ? t('admin.enabled') : t('admin.disabled') },
                  ]}
                />
                <StatusCard
                  icon="server-2-light"
                  label={t('admin.worker')}
                  value={celery?.ok ? t('admin.working') : t('admin.unavailable')}
                  statusLabel={workerHealthy ? t('admin.healthy') : t('admin.degraded')}
                  tone={workerHealthy ? 'ok' : 'degraded'}
                  details={[
                    {
                      label: t('admin.workers'),
                      value: celery ? numberFormatter.format(celery.workerCount) : unknown,
                    },
                    { label: t('admin.broker'), value: celery?.broker ?? unknown },
                    {
                      label: t('admin.scheduler'),
                      value: adminStatus.taskActivity.scheduler.online
                        ? t('admin.online')
                        : t('admin.offline'),
                    },
                    { label: t('admin.responseTime'), value: latencyValue(celery?.latencyMs, decimalFormatter, unknown, t) },
                  ]}
                />
                <StatusCard
                  icon="writing-pen-light"
                  label={t('admin.collaboration')}
                  value={collaboration?.ok ? t('admin.working') : t('admin.unavailable')}
                  statusLabel={collaboration?.ok ? t('admin.healthy') : t('admin.degraded')}
                  tone={collaboration?.ok ? 'ok' : 'degraded'}
                  details={[
                    { label: t('admin.mode'), value: collaboration?.mode ?? unknown },
                    {
                      label: t('admin.activeDocuments'),
                      value: collaboration?.documents == null ? unknown : numberFormatter.format(collaboration.documents),
                    },
                    {
                      label: t('admin.connections'),
                      value: collaboration?.connections == null ? unknown : numberFormatter.format(collaboration.connections),
                    },
                    { label: t('admin.responseTime'), value: latencyValue(collaboration?.latencyMs, decimalFormatter, unknown, t) },
                  ]}
                />
                <StatusCard
                  icon="ssd-round-light"
                  label={t('admin.storage')}
                  value={storage?.ok ? t('admin.available') : t('admin.unavailable')}
                  statusLabel={storage?.ok ? t('admin.healthy') : t('admin.degraded')}
                  tone={storage?.ok ? 'ok' : 'degraded'}
                  details={[
                    {
                      label: t('admin.storageType'),
                      value: t(`admin.storageProviders.${storage?.provider ?? 'other'}`),
                    },
                    {
                      label: t('admin.mediaUsage'),
                      value: storage?.usedBytes == null ? unknown : formatBytes(storage.usedBytes, locale),
                    },
                  ]}
                />
              </>
            )}
          </div>

          {isMobile ? (
            <section className="adminStatusMobileMenu">
              <MobileStatusMenuRow
                icon="clock-circle-light"
                title={t('admin.backgroundActivity')}
                onClick={() => setMobileSheet('tasks')}
              />
              <MobileStatusMenuRow
                icon="clipboard-list-light"
                title={t('admin.latestAuditEvent')}
                onClick={() => setMobileSheet('audit')}
              />
            </section>
          ) : (
            <div className="adminStatusDetailGrid">
              <TaskActivityPanel
                status={adminStatus}
                locale={locale}
                numberFormatter={numberFormatter}
                dateTimeFormatter={dateTimeFormatter}
              />
              <AuditSummaryPanel
                status={adminStatus}
                dateTimeFormatter={dateTimeFormatter}
                onOpenAudit={onOpenAudit}
              />
            </div>
          )}

          {isMobile && mobileSheet === 'tasks' && (
            <MobileSettingsSheet
              title={t('admin.backgroundActivity')}
              onClose={() => setMobileSheet(null)}
            >
              <div className="adminStatusMobileSheetContent">
                <TaskActivityPanel
                  status={adminStatus}
                  locale={locale}
                  numberFormatter={numberFormatter}
                  dateTimeFormatter={dateTimeFormatter}
                  mobile
                />
              </div>
            </MobileSettingsSheet>
          )}

          {isMobile && mobileSheet === 'audit' && (
            <MobileSettingsSheet
              title={t('admin.latestAuditEvent')}
              onClose={() => setMobileSheet(null)}
            >
              {(close) => (
                <div className="adminStatusMobileSheetContent">
                  <AuditSummaryPanel
                    status={adminStatus}
                    dateTimeFormatter={dateTimeFormatter}
                    mobile
                    onOpenAudit={() => {
                      close()
                      onOpenAudit()
                    }}
                  />
                </div>
              )}
            </MobileSettingsSheet>
          )}
        </>
      ) : (
        <section className="panel adminStatusLoading">
          <button type="button" onClick={() => void loadStatus(true)}>{t('admin.loadStatus')}</button>
        </section>
      )}
    </div>
  )
}

function MobileVersionCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="adminMobileVersionCard">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </article>
  )
}

function MobileStatusCard({
  label,
  metricLabel,
  metricValue,
  statusLabel,
  tone,
}: {
  label: string
  metricLabel: string
  metricValue: string
  statusLabel: string
  tone: 'ok' | 'degraded'
}) {
  return (
    <article className={`adminMobileServiceCard ${tone}`}>
      <header>
        <strong>{label}</strong>
        <span
          className="adminMobileServiceStatus"
          role="img"
          aria-label={statusLabel}
          title={statusLabel}
        />
      </header>
      <span>{metricLabel}</span>
      <b title={metricValue}>{metricValue}</b>
    </article>
  )
}

function MobileStatusMenuRow({
  icon,
  title,
  onClick,
}: {
  icon: IconName
  title: string
  onClick: () => void
}) {
  return (
    <button type="button" className="adminStatusMobileMenuRow spaceButton" onClick={onClick}>
      <span><Icon name={icon} /></span>
      <strong>{title}</strong>
      <Icon name="arrow-right-2" />
    </button>
  )
}

function TaskActivityPanel({
  status,
  locale,
  numberFormatter,
  dateTimeFormatter,
  mobile = false,
}: {
  status: AdminStatus
  locale: string
  numberFormatter: Intl.NumberFormat
  dateTimeFormatter: Intl.DateTimeFormat
  mobile?: boolean
}) {
  const { t } = useTranslation()
  const activity = status.taskActivity
  const lastTask = activity.lastTask
  const taskName = lastTask
    ? lastTask.name.split('.').at(-1) ?? lastTask.name
    : ''
  const taskLabel = lastTask
    ? t(`admin.taskNames.${taskName}`, { defaultValue: taskName })
    : ''
  return (
    <section className={mobile
      ? 'adminStatusSheetPanel adminTaskActivityPanel'
      : 'panel adminStatusDetailPanel adminTaskActivityPanel'}>
      {!mobile && (
        <div className="adminStatusPanelHeader">
          <Icon name="clock-circle-light" />
          <h3>{t('admin.backgroundActivity')}</h3>
        </div>
      )}
      <dl className="adminStatusDetailsList compact">
        <div>
          <dt>{t('admin.queueState')}</dt>
          <dd className={`adminInlineStatus ${activity.queueState}`}>
            <span aria-hidden="true" />
            {t(`admin.queueStates.${activity.queueState}`)}
          </dd>
        </div>
        <div><dt>{t('admin.failedLast24Hours')}</dt><dd>{numberFormatter.format(activity.failedLast24Hours)}</dd></div>
      </dl>
      <div className="adminLastTask">
        <span>{t('admin.lastTask')}</span>
        {lastTask ? (
          <>
            <div className="adminLastTaskHeading">
              <strong title={taskLabel}>{taskLabel}</strong>
              <span className={`adminTaskStatus ${lastTask.status}`}>
                {t(`admin.taskStatuses.${lastTask.status}`)}
              </span>
            </div>
            <dl className="adminStatusDetailsList compact">
              <div>
                <dt>{t('admin.completedAt')}</dt>
                <dd title={lastTask.finishedAt ? dateTimeFormatter.format(new Date(lastTask.finishedAt)) : undefined}>
                  {lastTask.finishedAt ? relativeTime(lastTask.finishedAt, locale) : t('admin.unknown')}
                </dd>
              </div>
              <div><dt>{t('admin.duration')}</dt><dd>{durationValue(lastTask.durationMs, locale, t)}</dd></div>
              {lastTask.worker && <div><dt>{t('admin.worker')}</dt><dd>{lastTask.worker}</dd></div>}
              {lastTask.errorType && <div><dt>{t('admin.errorType')}</dt><dd>{lastTask.errorType}</dd></div>}
            </dl>
          </>
        ) : (
          <div className="adminStatusEmpty">{t('admin.noBackgroundTasks')}</div>
        )}
      </div>
    </section>
  )
}

function AuditSummaryPanel({
  status,
  dateTimeFormatter,
  onOpenAudit,
  mobile = false,
}: {
  status: AdminStatus
  dateTimeFormatter: Intl.DateTimeFormat
  onOpenAudit: () => void
  mobile?: boolean
}) {
  const { t } = useTranslation()
  return (
    <section className={mobile
      ? 'adminStatusSheetPanel adminAuditSummaryPanel'
      : 'panel adminStatusDetailPanel adminAuditSummaryPanel'}>
      {!mobile && (
        <div className="adminStatusPanelHeader">
          <Icon name="clipboard-list-light" />
          <h3>{t('admin.latestAuditEvent')}</h3>
        </div>
      )}
      {status.latestAuditEvent ? (
        <dl className="adminStatusDetailsList">
          <div>
            <dt>{t('admin.event')}</dt>
            <dd className="adminStatusEventValue">
              <AuditEventLabel event={status.latestAuditEvent.event} />
            </dd>
          </div>
          <div><dt>{t('admin.actor')}</dt><dd>{status.latestAuditEvent.actor ?? t('admin.system')}</dd></div>
          <div><dt>{t('admin.subject')}</dt><dd>{status.latestAuditEvent.subject || t('admin.none')}</dd></div>
          <div><dt>{t('admin.time')}</dt><dd>{dateTimeFormatter.format(new Date(status.latestAuditEvent.createdAt))}</dd></div>
        </dl>
      ) : (
        <div className="adminStatusEmpty">{t('admin.noAuditEvents')}</div>
      )}
      <button type="button" className="adminStatusPanelAction spaceButton" onClick={onOpenAudit}>
        {t('admin.openAuditLog')}
        <Icon name="arrow-right-2" />
      </button>
    </section>
  )
}

function latencyValue(
  value: number | null | undefined,
  formatter: Intl.NumberFormat,
  fallback: string,
  t: ReturnType<typeof useTranslation>['t'],
) {
  return value == null ? fallback : t('admin.millisecondsValue', { value: formatter.format(value) })
}

function durationValue(
  value: number | null,
  locale: string,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (value == null) return t('admin.unknown')
  if (value < 1000) return t('admin.millisecondsValue', { value })
  return t('admin.secondsValue', {
    value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1000),
  })
}

function relativeTime(value: string, locale: string) {
  const differenceSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const absoluteSeconds = Math.abs(differenceSeconds)
  if (absoluteSeconds < 60) return formatter.format(differenceSeconds, 'second')
  const differenceMinutes = Math.round(differenceSeconds / 60)
  if (Math.abs(differenceMinutes) < 60) return formatter.format(differenceMinutes, 'minute')
  const differenceHours = Math.round(differenceMinutes / 60)
  if (Math.abs(differenceHours) < 24) return formatter.format(differenceHours, 'hour')
  return formatter.format(Math.round(differenceHours / 24), 'day')
}
