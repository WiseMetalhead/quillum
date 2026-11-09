import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons/Icon'
import type { AdminStatus } from '../../types'
import { ResponsiveDetailsPanel } from '../shared/ResponsiveDetailsPanel'
import { StatusCard } from './StatusCard'
import { formatBytes } from './utils'

type DesktopServiceId = 'app' | 'database' | 'redis' | 'worker' | 'collaboration' | 'storage'

type DesktopServiceSummary = {
  id: DesktopServiceId
  icon: IconName
  label: string
  metricLabel: string
  metricValue: string
  statusLabel: string
  tone: 'ok' | 'degraded'
  details: Array<{ label: string; value: string }>
}

type DesktopStatusOverviewProps = {
  status: AdminStatus
  locale: string
  numberFormatter: Intl.NumberFormat
  decimalFormatter: Intl.NumberFormat
}

export function DesktopStatusOverview({
  status,
  locale,
  numberFormatter,
  decimalFormatter,
}: DesktopStatusOverviewProps) {
  const { t } = useTranslation()
  const [selectedServiceId, setSelectedServiceId] = useState<DesktopServiceId | null>(null)
  const [scrollEdges, setScrollEdges] = useState({ backward: false, forward: false })
  const serviceScrollerRef = useRef<HTMLDivElement>(null)
  const unknown = t('admin.unknown')
  const database = status.services.database
  const redis = status.services.redis
  const celery = status.services.celery
  const storage = status.services.storage
  const collaboration = status.services.collaboration
  const workerHealthy = celery.ok && (!status.taskActivity.scheduler.configured || status.taskActivity.scheduler.online)
  const redisMemory = redis.usedMemoryBytes == null
    ? unknown
    : redis.maxMemoryBytes
      ? `${formatBytes(redis.usedMemoryBytes, locale)} / ${formatBytes(redis.maxMemoryBytes, locale)}`
      : formatBytes(redis.usedMemoryBytes, locale)
  const collaborationMode = t(`admin.collaborationModes.${collaboration.mode}`)
  const appHealthy = status.status === 'ok'

  const appService: DesktopServiceSummary = {
    id: 'app',
    icon: 'box-light',
    label: t('admin.app'),
    metricLabel: t('admin.version'),
    metricValue: status.app.version,
    statusLabel: appHealthy ? t('admin.healthy') : t('admin.degraded'),
    tone: appHealthy ? 'ok' : 'degraded',
    details: [
      { label: t('admin.version'), value: status.app.version },
      { label: t('admin.environment'), value: status.app.environment },
      { label: t('admin.authentication'), value: status.auth.mode },
      { label: t('admin.debug'), value: status.app.debug ? t('admin.enabled') : t('admin.disabled') },
    ],
  }
  const services: DesktopServiceSummary[] = [
    {
      id: 'database',
      icon: 'database-light',
      label: t('admin.database'),
      metricLabel: t('admin.version'),
      metricValue: database.version ?? unknown,
      statusLabel: database.ok ? t('admin.healthy') : t('admin.degraded'),
      tone: database.ok ? 'ok' : 'degraded',
      details: [
        { label: t('admin.version'), value: database.version ?? unknown },
        {
          label: t('admin.databaseSize'),
          value: database.sizeBytes == null ? unknown : formatBytes(database.sizeBytes, locale),
        },
        {
          label: t('admin.connections'),
          value: database.activeConnections == null ? unknown : numberFormatter.format(database.activeConnections),
        },
        { label: t('admin.responseTime'), value: latencyValue(database.latencyMs, decimalFormatter, unknown, t) },
      ],
    },
    {
      id: 'redis',
      icon: 'layers-minimalistic-light',
      label: t('admin.redis'),
      metricLabel: t('admin.memory'),
      metricValue: redis.usedMemoryBytes == null ? unknown : formatBytes(redis.usedMemoryBytes, locale),
      statusLabel: redis.ok ? t('admin.healthy') : t('admin.degraded'),
      tone: redis.ok ? 'ok' : 'degraded',
      details: [
        { label: t('admin.version'), value: redis.version ?? unknown },
        { label: t('admin.memory'), value: redisMemory },
        { label: t('admin.redisKeys'), value: redis.keys == null ? unknown : numberFormatter.format(redis.keys) },
        { label: t('admin.responseTime'), value: latencyValue(redis.latencyMs, decimalFormatter, unknown, t) },
      ],
    },
    {
      id: 'worker',
      icon: 'server-2-light',
      label: t('admin.worker'),
      metricLabel: t('admin.workers'),
      metricValue: numberFormatter.format(celery.workerCount),
      statusLabel: workerHealthy ? t('admin.healthy') : t('admin.degraded'),
      tone: workerHealthy ? 'ok' : 'degraded',
      details: [
        { label: t('admin.workers'), value: numberFormatter.format(celery.workerCount) },
        { label: t('admin.broker'), value: celery.broker ?? unknown },
        {
          label: t('admin.scheduler'),
          value: status.taskActivity.scheduler.online ? t('admin.online') : t('admin.offline'),
        },
        { label: t('admin.responseTime'), value: latencyValue(celery.latencyMs, decimalFormatter, unknown, t) },
      ],
    },
    {
      id: 'collaboration',
      icon: 'writing-pen-light',
      label: t('admin.collaboration'),
      metricLabel: t('admin.connections'),
      metricValue: collaboration.connections == null ? unknown : numberFormatter.format(collaboration.connections),
      statusLabel: collaboration.ok ? t('admin.healthy') : t('admin.degraded'),
      tone: collaboration.ok ? 'ok' : 'degraded',
      details: [
        { label: t('admin.mode'), value: collaborationMode },
        {
          label: t('admin.activeDocuments'),
          value: collaboration.documents == null ? unknown : numberFormatter.format(collaboration.documents),
        },
        {
          label: t('admin.connections'),
          value: collaboration.connections == null ? unknown : numberFormatter.format(collaboration.connections),
        },
        { label: t('admin.responseTime'), value: latencyValue(collaboration.latencyMs, decimalFormatter, unknown, t) },
      ],
    },
    {
      id: 'storage',
      icon: 'ssd-round-light',
      label: t('admin.storage'),
      metricLabel: t('admin.mediaUsage'),
      metricValue: storage.usedBytes == null ? unknown : formatBytes(storage.usedBytes, locale),
      statusLabel: storage.ok ? t('admin.healthy') : t('admin.degraded'),
      tone: storage.ok ? 'ok' : 'degraded',
      details: [
        { label: t('admin.storageType'), value: t(`admin.storageProviders.${storage.provider ?? 'other'}`) },
        {
          label: t('admin.mediaUsage'),
          value: storage.usedBytes == null ? unknown : formatBytes(storage.usedBytes, locale),
        },
      ],
    },
  ]
  const allServices = [appService, ...services]
  const selectedService = allServices.find((service) => service.id === selectedServiceId) ?? null

  const updateScrollEdges = useCallback(() => {
    const scroller = serviceScrollerRef.current
    if (!scroller) return
    const maximumScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    const nextEdges = {
      backward: scroller.scrollLeft > 2,
      forward: scroller.scrollLeft < maximumScroll - 2,
    }
    setScrollEdges((current) => (
      current.backward === nextEdges.backward && current.forward === nextEdges.forward
        ? current
        : nextEdges
    ))
  }, [])

  useEffect(() => {
    const scroller = serviceScrollerRef.current
    if (!scroller) return
    const frame = window.requestAnimationFrame(updateScrollEdges)
    const resizeObserver = new ResizeObserver(updateScrollEdges)
    resizeObserver.observe(scroller)
    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
    }
  }, [updateScrollEdges])

  function scrollServices(direction: -1 | 1) {
    const scroller = serviceScrollerRef.current
    if (!scroller) return
    scroller.scrollBy({
      left: direction * Math.max(250, scroller.clientWidth * 0.72),
      behavior: 'smooth',
    })
  }

  return (
    <div className="adminStatusDesktopOverview" aria-live="polite">
      <button
        type="button"
        className={`adminApplicationCard ${appService.tone} spaceButton`}
        aria-haspopup="dialog"
        onClick={() => setSelectedServiceId('app')}
      >
        <span className="adminApplicationIdentity">
          <Icon name={appService.icon} />
          <strong>{appService.label}</strong>
          <span className="adminApplicationStatus" title={appService.statusLabel}>
            <span aria-hidden="true" />
            <span className="srOnly">{appService.statusLabel}</span>
          </span>
        </span>
        <span className="adminApplicationVersion">
          <span>{appService.metricLabel}</span>
          <strong title={appService.metricValue}>{appService.metricValue}</strong>
        </span>
        <span className="srOnly">{t('admin.openServiceDetails', { service: appService.label })}</span>
      </button>

      <div className="adminServiceCarouselShell">
        <div
          className="adminServiceCarousel"
          ref={serviceScrollerRef}
          onScroll={updateScrollEdges}
        >
          {services.map((service) => (
            <StatusCard
              key={service.id}
              icon={service.icon}
              label={service.label}
              metricLabel={service.metricLabel}
              metricValue={service.metricValue}
              statusLabel={service.statusLabel}
              openLabel={t('admin.openServiceDetails', { service: service.label })}
              tone={service.tone}
              onClick={() => setSelectedServiceId(service.id)}
            />
          ))}
        </div>
        {scrollEdges.backward && (
          <button
            type="button"
            className="adminServiceCarouselControl backward spaceButton"
            aria-label={t('admin.previousServices')}
            onClick={() => scrollServices(-1)}
          >
            <Icon name="arrow-left-1" />
          </button>
        )}
        {scrollEdges.forward && (
          <button
            type="button"
            className="adminServiceCarouselControl forward spaceButton"
            aria-label={t('admin.nextServices')}
            onClick={() => scrollServices(1)}
          >
            <Icon name="arrow-right-1" />
          </button>
        )}
      </div>

      <ResponsiveDetailsPanel
        open={selectedService !== null}
        title={selectedService?.label ?? ''}
        closeLabel={t('admin.closeServiceDetails', { service: selectedService?.label ?? '' })}
        desktopClassName="adminStatusDetailsDialog"
        desktopDialog
        onClose={() => setSelectedServiceId(null)}
      >
        {selectedService && (
          <div className="adminStatusDialogContent">
            <div className={`adminStatusDialogSummary ${selectedService.tone}`}>
              <Icon name={selectedService.icon} />
              <span className="adminServiceStatus">
                <span aria-hidden="true" />
                {selectedService.statusLabel}
              </span>
            </div>
            <dl className="adminStatusDialogDetails">
              {selectedService.details.map((detail) => (
                <div key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd title={detail.value}>{detail.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </ResponsiveDetailsPanel>
    </div>
  )
}

function latencyValue(
  value: number | null,
  formatter: Intl.NumberFormat,
  fallback: string,
  t: ReturnType<typeof useTranslation>['t'],
) {
  return value == null ? fallback : t('admin.millisecondsValue', { value: formatter.format(value) })
}
