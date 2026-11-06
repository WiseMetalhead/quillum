import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, ApiError, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type {
  AccountExportGlossaryFormat,
  AccountExportJob,
  AccountExportManuscriptFormat,
  AccountExportPayload,
  AccountExportStatus,
} from '../../types'
import { ActionDialog } from '../shared/ActionDialog'
import { CustomSelect } from '../shared/CustomSelect'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'

type Props = {
  mobile?: boolean
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
  onMessage: (message: string) => void
  onError: (message: string) => void
}

const ACTIVE_STATUSES = new Set<AccountExportStatus>(['pending', 'building'])

function formatBytes(value: number, language: string) {
  if (!value) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / (1024 ** unitIndex)
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: unitIndex ? 1 : 0 }).format(amount)} ${units[unitIndex]}`
}

export function AccountExportPanel({
  mobile = false,
  onSensitiveAction,
  onMessage,
  onError,
}: Props) {
  const { t, i18n } = useTranslation()
  const [job, setJob] = useState<AccountExportJob | null>(null)
  const [manuscriptFormat, setManuscriptFormat] = useState<AccountExportManuscriptFormat>('markdown')
  const [glossaryFormat, setGlossaryFormat] = useState<AccountExportGlossaryFormat>('markdown')
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [desktopFormatOpen, setDesktopFormatOpen] = useState(false)
  const active = Boolean(job && ACTIVE_STATUSES.has(job.status))

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }), [i18n.language])

  const loadExport = useCallback(async () => {
    try {
      const payload = await apiRequest<AccountExportPayload>('/api/auth/account/export/', {
        invalidateQueryCache: false,
      })
      setJob(payload.export)
      setLoadError('')
      if (payload.export) {
        setManuscriptFormat(payload.export.manuscriptFormat)
        setGlossaryFormat(payload.export.glossaryFormat)
      }
    } catch (error) {
      const message = error instanceof ApiError
        ? t(`errors.${error.code}`, { defaultValue: t('account.exportLoadFailed') })
        : t('account.exportLoadFailed')
      setLoadError(message)
    }
  }, [t])

  useEffect(() => {
    let mounted = true
    void apiRequest<AccountExportPayload>('/api/auth/account/export/', {
      invalidateQueryCache: false,
    }).then((payload) => {
      if (!mounted) return
      setJob(payload.export)
      setLoadError('')
      if (payload.export) {
        setManuscriptFormat(payload.export.manuscriptFormat)
        setGlossaryFormat(payload.export.glossaryFormat)
      }
    }).catch((error) => {
      if (!mounted) return
      const message = error instanceof ApiError
        ? t(`errors.${error.code}`, { defaultValue: t('account.exportLoadFailed') })
        : t('account.exportLoadFailed')
      setLoadError(message)
      onError(message)
    }).finally(() => {
      if (mounted) setLoading(false)
    })
    return () => { mounted = false }
  }, [onError, t])

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    let timer = 0
    const poll = async () => {
      await loadExport()
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1000)
    }
    timer = window.setTimeout(() => void poll(), 1000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, loadExport])

  async function startExport() {
    if (active || starting) return
    onError('')
    setStarting(true)
    try {
      const payload = await onSensitiveAction(() => apiRequest<AccountExportPayload>(
        '/api/auth/account/export/',
        {
          method: 'POST',
          body: JSON.stringify({ manuscriptFormat, glossaryFormat }),
        },
      ))
      setJob(payload.export)
      setLoadError('')
      setDesktopFormatOpen(false)
      onMessage(t('account.exportStarted'))
    } catch (error) {
      const message = error instanceof ApiError
        ? t(`errors.${error.code}`, { defaultValue: t('account.exportStartFailed') })
        : error instanceof Error
          ? error.message
          : t('account.exportStartFailed')
      onError(message)
    } finally {
      setStarting(false)
    }
  }

  function formattedDate(value: string | null) {
    return value ? dateFormatter.format(new Date(value)) : '—'
  }

  const status = job?.status ?? null
  const statusText = loading
    ? t('common.loading')
    : status
      ? t(`account.exportStatuses.${status}`)
      : t('account.exportNotCreated')
  const mobileSubtitle = status === 'ready'
    ? t('account.exportReadyUntil', { date: formattedDate(job?.expiresAt ?? null) })
    : statusText

  const formatSelectors = (
    <div className="accountExportSelectors">
      <label className="dialogField">
        <span>{t('account.exportManuscriptFormat')}</span>
        <CustomSelect
          value={manuscriptFormat}
          disabled={active || starting || loading}
          aria-label={t('account.exportManuscriptFormat')}
          onChange={(event) => setManuscriptFormat(event.currentTarget.value as AccountExportManuscriptFormat)}
        >
          <option value="markdown">{t('account.exportFormats.markdown')}</option>
          <option value="docx">{t('account.exportFormats.docx')}</option>
          <option value="odt">{t('account.exportFormats.odt')}</option>
        </CustomSelect>
      </label>
      <label className="dialogField">
        <span>{t('account.exportGlossaryFormat')}</span>
        <CustomSelect
          value={glossaryFormat}
          disabled={active || starting || loading}
          aria-label={t('account.exportGlossaryFormat')}
          onChange={(event) => setGlossaryFormat(event.currentTarget.value as AccountExportGlossaryFormat)}
        >
          <option value="markdown">{t('account.exportFormats.markdown')}</option>
          <option value="html">{t('account.exportFormats.html')}</option>
        </CustomSelect>
      </label>
    </div>
  )

  const downloadAvailable = status === 'ready' && Boolean(job?.downloadUrl)
  const exportStatus = (
    <div
      className={`accountExportStatus ${active ? 'active' : ''} ${!mobile && downloadAvailable ? 'withAction' : ''}`.trim()}
      role="status"
      aria-live="polite"
    >
      <span className="accountExportStatusIcon" aria-hidden="true">
        <Icon name={status === 'failed' ? 'danger-light' : status === 'ready' ? 'check-circle-1-light' : 'archive-light'} />
      </span>
      <span className="accountExportStatusCopy">
        <strong>{statusText}</strong>
        {status === 'ready' && job && (
          <small>{t('account.exportReadyMeta', {
            size: formatBytes(job.byteSize, i18n.language),
            date: formattedDate(job.expiresAt),
          })}</small>
        )}
        {status === 'failed' && job?.errorCode && (
          <small>{t(`errors.${job.errorCode}`, { defaultValue: t('account.exportBuildFailed') })}</small>
        )}
        {status === 'expired' && <small>{t('account.exportExpiredLead')}</small>}
        {!status && !loading && <small>{t('account.exportStatusLead')}</small>}
        {active && <small>{t('account.exportBuildingLead')}</small>}
      </span>
      {!mobile && downloadAvailable && job?.downloadUrl && (
        <a className="spaceButton accountExportDownload" href={`${API_BASE}${job.downloadUrl}`}>
          <Icon name="download-minimalistic-light" />
          {t('account.exportDownload')}
        </a>
      )}
    </div>
  )

  const mobileForm = (
    <div className="accountExportControls mobile">
      {formatSelectors}
      {exportStatus}
      {loadError && <div className="notice error inline" role="alert">{loadError}</div>}

      <div className="accountExportActions">
        <button
          type="button"
          className={`primary ${active || starting ? 'accountExportBusy' : ''}`}
          disabled={active || starting || loading}
          aria-label={active ? t('account.exportBuilding') : t('account.exportCreate')}
          onClick={() => void startExport()}
        >
          <Icon name="archive-up-light" />
          {active || starting ? t('account.exportBuilding') : t('account.exportCreate')}
        </button>
        {downloadAvailable && job?.downloadUrl && (
          <a className="spaceButton accountExportDownload" href={`${API_BASE}${job.downloadUrl}`}>
            <Icon name="download-minimalistic-light" />
            {t('account.exportDownload')}
          </a>
        )}
      </div>
    </div>
  )

  if (mobile) {
    return (
      <section className="accountMobileExport">
        <h2>{t('account.exportTitle')}</h2>
        <div className="accountMobileSettingsList">
          <button
            type="button"
            className="accountMobileSettingRow spaceButton"
            onClick={() => setMobileOpen(true)}
          >
            <span className="accountMobileSettingIcon"><Icon name="archive-light" /></span>
            <span className="accountMobileSettingCopy">
              <strong>{t('account.exportData')}</strong>
              <small>{mobileSubtitle}</small>
            </span>
            <Icon name="arrow-right-2" />
          </button>
        </div>
        {mobileOpen && (
          <MobileSettingsSheet
            title={t('account.exportTitle')}
            onClose={() => setMobileOpen(false)}
            busy={starting}
          >
            <div className="accountExportMobileSheet">
              <p>{t('account.exportLead')}</p>
              {mobileForm}
            </div>
          </MobileSettingsSheet>
        )}
      </section>
    )
  }

  return (
    <>
      <section className="settingsPanel accountExportCard">
        <div className="accountExportHeading">
          <div className="accountExportHeadingCopy">
            <div className="accountExportTitle">
              <Icon name="archive-light" />
              <h2>{t('account.exportTitle')}</h2>
            </div>
            <p>{t('account.exportLead')}</p>
          </div>
          <button
            type="button"
            className={`primary accountExportCreateButton ${active || starting ? 'accountExportBusy' : ''}`}
            disabled={active || starting || loading}
            aria-label={active ? t('account.exportBuilding') : t('account.exportCreate')}
            onClick={() => setDesktopFormatOpen(true)}
          >
            <Icon name="archive-up-light" />
            {active || starting ? t('account.exportBuilding') : t('account.exportCreate')}
          </button>
        </div>
        {exportStatus}
        {loadError && <div className="notice error inline" role="alert">{loadError}</div>}
      </section>

      {desktopFormatOpen && (
        <ActionDialog
          variant="compact"
          className="accountExportDialog"
          title={t('account.exportCreate')}
          description={t('account.exportFormatLead')}
          closeLabel={t('common.close')}
          busy={starting}
          onClose={() => setDesktopFormatOpen(false)}
        >
          <div className="compactDialogSection accountExportDialogSection">
            {formatSelectors}
          </div>
          <footer className="compactDialogFooter">
            <button
              type="button"
              className={`compactDialogPrimaryAction ${starting ? 'accountExportBusy' : ''}`}
              disabled={starting || loading}
              onClick={() => void startExport()}
            >
              <Icon name="archive-up-light" />
              {starting ? t('account.exportBuilding') : t('account.exportCreate')}
            </button>
          </footer>
        </ActionDialog>
      )}
    </>
  )
}
