import { useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import type { Manuscript } from './ManuscriptTypes'
import type {
  ManuscriptExportFormat,
  ManuscriptExportJob,
  ManuscriptExportPlan,
  ManuscriptExportPlanStatus,
  ManuscriptExportTreeNode,
} from './ManuscriptExports'
import { MANUSCRIPT_LANGUAGES } from './ManuscriptMetadata'
import { ManuscriptExportFormatPickerDialog } from './ManuscriptExportFormatPickerDialog'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'

type Props = {
  manuscript: Manuscript
  onClose: () => void
  onError: (error: string) => void
  onMessage: (message: string) => void
}

export function ManuscriptExportDialog({ manuscript, onClose, onError, onMessage }: Props) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const [plan, setPlan] = useState<ManuscriptExportPlan | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<ManuscriptExportFormat>('markdown')
  const [includeTitlePage, setIncludeTitlePage] = useState(true)
  const [includeAuthorInfoPage, setIncludeAuthorInfoPage] = useState(true)
  const [includeIllustrations, setIncludeIllustrations] = useState(true)
  const [language, setLanguage] = useState(manuscript.language)
  const [formatPickerOpen, setFormatPickerOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [job, setJob] = useState<ManuscriptExportJob | null>(null)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      try {
        const payload = await apiRequest<ManuscriptExportPlan>(
          `/api/manuscripts/${manuscript.id}/export-plan/`,
        )
        if (!active) return
        setPlan(payload)
        setSelectedIds(new Set(payload.defaultSelectedItemIds))
      } catch (err) {
        onError(err instanceof Error ? err.message : t('exports.loadFailed'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [manuscript.id, onError, t])

  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'failed' || job.status === 'expired') {
      return
    }
    const timer = window.setInterval(() => {
      void apiRequest<{ export: ManuscriptExportJob }>(`/api/manuscripts/exports/${job.id}/`)
        .then((payload) => setJob(payload.export))
        .catch((err) => onError(err instanceof Error ? err.message : t('exports.statusFailed')))
    }, 1500)
    return () => window.clearInterval(timer)
  }, [job, onError, t])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting && !formatPickerOpen) closeDialog()
    }
    window.document.addEventListener('keydown', closeOnEscape)
    return () => window.document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, formatPickerOpen, submitting])

  const selectedCount = selectedIds.size
  const totalCount = useMemo(() => plan ? documentIds(plan.tree).length : 0, [plan])
  const statusById = useMemo(
    () => new Map((plan?.statuses ?? []).map((status) => [status.id, status])),
    [plan],
  )
  const busy = submitting || job?.status === 'pending' || job?.status === 'building'
  const languageRequired = format !== 'markdown' && !language

  function toggleNode(node: ManuscriptExportTreeNode, checked: boolean) {
    const ids = documentIds([node])
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function submit() {
    if (!selectedIds.size || submitting || busy) return
    setSubmitting(true)
    setJob(null)
    try {
      const payload = await apiRequest<{ export: ManuscriptExportJob }>(
        `/api/manuscripts/${manuscript.id}/exports/`,
        {
          method: 'POST',
          body: JSON.stringify({
            format,
            selectedItemIds: [...selectedIds],
            includeTitlePage,
            includeAuthorInfoPage,
            includeIllustrations,
            language,
          }),
        },
      )
      setJob(payload.export)
      onMessage(t('exports.started'))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('exports.startFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={`dialogBackdrop mobileFullViewBackdrop exportDialogBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className="createOneShotDialog exportDialog mobileFullView" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title" ref={setDialogRef}>
        <header>
          <button type="button" className="mobileDialogBack booksButton" aria-label={t('common.back')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy">
            <h2 id="export-dialog-title">{t('exports.title')}</h2>
            <p>{t('exports.lead')}</p>
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('exports.close')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="close-square-light" />
          </button>
          {isMobile && (
            <button
              type="button"
              className={`mobileDialogPrimary exportMobilePrimary booksButton ${busy ? 'isBusy' : ''}`}
              aria-label={t('exports.export')}
              title={t('exports.export')}
              disabled={!selectedCount || busy || loading || languageRequired || closing}
              onClick={() => void submit()}
            >
              <Icon name="archive-light" />
            </button>
          )}
        </header>
        <div className="exportDialogBody">
          {loading ? (
            <TadpoleLoadingState className="exportLoadingState" label={t('exports.loading')} />
          ) : plan ? (
            <>
              <section className="exportStructure" aria-labelledby="export-structure-title">
                <header>
                  <div>
                    <h3 id="export-structure-title">{t('exports.structure')}</h3>
                    <span>{t('exports.selectionCount', { selected: selectedCount, total: totalCount })}</span>
                  </div>
                  <button type="button" className="spaceButton exportSelectAllButton" onClick={() => setSelectedIds(new Set(plan.defaultSelectedItemIds))}>
                    {t('exports.selectAll')}
                  </button>
                </header>
                <div className="exportTree">
                  {plan.tree.map((node) => (
                    <ExportTreeRow
                      key={node.id}
                      node={node}
                      depth={0}
                      selectedIds={selectedIds}
                      statusById={statusById}
                      onToggle={toggleNode}
                    />
                  ))}
                </div>
              </section>
              <section className="exportSettings" aria-labelledby="export-settings-title">
                <h3 id="export-settings-title">{t('exports.settings')}</h3>
                <div className="exportFormatField">
                  <span>{t('exports.formatLabel')}</span>
                  <button type="button" className="exportFormatTrigger booksButton" onClick={() => setFormatPickerOpen(true)}>
                    <span>
                      <strong>{t(`exports.formats.${format}.label`)}</strong>
                      <small>{t(`exports.formats.${format}.description`)}</small>
                    </span>
                    <span className="exportFormatChange">{t('exports.changeFormat')}</span>
                  </button>
                </div>
                {format !== 'markdown' && !manuscript.language && (
                  <label className="dialogField">
                    <span>{t('manuscriptMetadata.language')} <strong aria-hidden="true">*</strong></span>
                    <CustomSelect value={language} required onChange={(event) => setLanguage(event.target.value)}>
                      <option value="" disabled>{t('manuscriptMetadata.selectLanguage')}</option>
                      {MANUSCRIPT_LANGUAGES.map((code) => (
                        <option key={code} value={code}>{t(`manuscriptMetadata.languages.${code}`)}</option>
                      ))}
                    </CustomSelect>
                    <small>{t('exports.languageForCurrentExport')}</small>
                  </label>
                )}
                <label className="exportOption">
                  <input type="checkbox" checked={includeTitlePage} onChange={(event) => setIncludeTitlePage(event.target.checked)} />
                  <span>{t('exports.includeTitlePage')}</span>
                </label>
                <label className="exportOption">
                  <input type="checkbox" checked={includeAuthorInfoPage} onChange={(event) => setIncludeAuthorInfoPage(event.target.checked)} />
                  <span>{t('exports.includeAuthorInfoPage')}</span>
                </label>
                <label className="exportOption">
                  <input type="checkbox" checked={includeIllustrations} onChange={(event) => setIncludeIllustrations(event.target.checked)} />
                  <span>{t('exports.includeIllustrations')}</span>
                </label>
              </section>
              {job && (
                <section className={`exportJobStatus ${job.status}`} aria-live="polite">
                  <Icon name={job.status === 'ready' ? 'check-circle-1-light' : 'archive-light'} />
                  <div>
                    <strong>{t(`exports.status.${job.status}`)}</strong>
                    {job.status === 'ready' ? (
                      <span>{t('exports.readyLead', { file: job.fileName, size: formatBytes(job.byteSize, i18n.resolvedLanguage) })}</span>
                    ) : job.status === 'failed' ? (
                      <span>
                        {job.errorCode
                          ? t(`errors.${job.errorCode}`, { defaultValue: t('exports.failedLead') })
                          : t('exports.failedLead')}
                      </span>
                    ) : (
                      <span>{t('exports.buildingLead')}</span>
                    )}
                  </div>
                  {job.status === 'ready' && job.downloadUrl && (
                    <a className="spaceButton exportDownloadButton" href={`${API_BASE}${job.downloadUrl}`}>
                      <Icon name="download-minimalistic-light" /> {t('exports.download')}
                    </a>
                  )}
                </section>
              )}
            </>
          ) : (
            <p className="fieldError">{t('exports.loadFailed')}</p>
          )}
        </div>
        {!isMobile && (
          <footer className="mobileFullViewFooter">
            <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button>
            <button type="button" className={`dialogSubmit exportSubmit booksButton ${busy ? 'isBusy' : ''}`} disabled={!selectedCount || busy || loading || languageRequired} onClick={() => void submit()}>
              <Icon name="archive-light" />
              {busy ? t('exports.exporting') : t('exports.export')}
            </button>
          </footer>
        )}
      </div>
      {formatPickerOpen && (
        <ManuscriptExportFormatPickerDialog
          format={format}
          onClose={() => setFormatPickerOpen(false)}
          onSelect={(selectedFormat) => {
            setFormat(selectedFormat)
            setFormatPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}

function ExportTreeRow({
  node,
  depth,
  selectedIds,
  statusById,
  onToggle,
}: {
  node: ManuscriptExportTreeNode
  depth: number
  selectedIds: Set<string>
  statusById: Map<string, ManuscriptExportPlanStatus>
  onToggle: (node: ManuscriptExportTreeNode, checked: boolean) => void
}) {
  const { t } = useTranslation()
  const checkboxRef = useRef<HTMLInputElement>(null)
  const ids = documentIds([node])
  const selectedCount = ids.filter((id) => selectedIds.has(id)).length
  const checked = ids.length > 0 && selectedCount === ids.length
  const mixed = selectedCount > 0 && selectedCount < ids.length
  const status = node.statusId ? statusById.get(node.statusId) : null

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = mixed
  }, [mixed])

  return (
    <div>
      <label className="exportTreeRow" style={{ '--export-depth': depth } as CSSProperties}>
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={checked}
          disabled={ids.length === 0}
          onChange={(event) => onToggle(node, event.target.checked)}
        />
        <Icon name={node.kind === 'folder' ? 'folder-light' : 'file-document-light'} />
        <span className="exportNodeTitle">{node.title}</span>
        <span className="exportNodeMeta">
          {status ? status.name : t('exports.untyped')}
          {node.kind === 'folder' && ` · ${selectedCount}/${ids.length}`}
        </span>
      </label>
      {node.children.map((child) => (
        <ExportTreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedIds={selectedIds}
          statusById={statusById}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

function documentIds(nodes: ManuscriptExportTreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.kind === 'document' ? [node.id] : []),
    ...documentIds(node.children),
  ])
}

function formatBytes(value: number, locale: string | undefined): string {
  if (value < 1024) return new Intl.NumberFormat(locale).format(value)
  const units = ['KiB', 'MiB', 'GiB']
  let size = value
  let unit = ''
  for (const candidate of units) {
    size /= 1024
    unit = candidate
    if (size < 1024) break
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size)} ${unit}`
}
