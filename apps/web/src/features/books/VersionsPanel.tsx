import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import type { DocumentAnnotation } from './Annotations'
import { DocumentComparison } from './DocumentComparison'
import type { EditorDocument } from './ManuscriptEditorPage'
import type { DocumentVersion, VersionDetail, VersionLimits } from './Versions'
import { VersionViewer } from './VersionViewer'
import type { ManuscriptAccessMode } from './ManuscriptEndpoints'
import { editorAssetUrl } from './ManuscriptEndpoints'

type VersionsPanelProps = {
  manuscriptId: string
  manuscriptKind: 'oneshot' | 'book'
  documentItemId: string | null
  prepareVersionAction: () => Promise<number | null>
  onRestored: (document: EditorDocument, annotations: DocumentAnnotation[]) => void
  onError: (error: string) => void
  mobilePresentation?: boolean
  onClose?: () => void
  accessMode?: ManuscriptAccessMode
  onAccessLost?: () => void
}

type RevisionForm = {
  version: DocumentVersion | null
  name: string
  description: string
}

type ConfirmAction = {
  kind: 'restore' | 'delete'
  version: DocumentVersion
}

const doNothing = () => undefined

export function VersionsPanel({
  manuscriptId,
  manuscriptKind,
  documentItemId,
  prepareVersionAction,
  onRestored,
  onError,
  mobilePresentation = false,
  onClose,
  accessMode = 'owner',
  onAccessLost,
}: VersionsPanelProps) {
  const { t, i18n } = useTranslation()
  const mobileTitleId = useId()
  const mobileBackRef = useRef<HTMLButtonElement>(null)
  const {
    backdropStateClass: mobileBackdropStateClass,
    close: closeMobileView,
    closing: mobileViewClosing,
    setDialogRef: setMobileViewRef,
  } = useMobileDialogTransition({
    onClose: onClose ?? doNothing,
    initialFocusRef: mobileBackRef,
    focusOnDesktop: false,
  })
  const versionsUrl = accessMode === 'editor'
    ? manuscriptKind === 'book' && documentItemId
      ? `/api/editor/manuscripts/${manuscriptId}/documents/${documentItemId}/drafts/`
      : `/api/editor/manuscripts/${manuscriptId}/document/drafts/`
    : manuscriptKind === 'book' && documentItemId
      ? `/api/manuscripts/books/${manuscriptId}/documents/${documentItemId}/versions/`
      : `/api/manuscripts/oneshots/${manuscriptId}/versions/`
  const [items, setItems] = useState<DocumentVersion[]>([])
  const [limits, setLimits] = useState<VersionLimits>({ drafts: 20, revisions: 5 })
  const [section, setSection] = useState<'draft' | 'revision'>('draft')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [form, setForm] = useState<RevisionForm | null>(null)
  const [detail, setDetail] = useState<VersionDetail | null>(null)
  const [detailMode, setDetailMode] = useState<'view' | 'compare'>('view')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [mobileActionVersion, setMobileActionVersion] = useState<DocumentVersion | null>(null)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)

  const locale = i18n.resolvedLanguage ?? 'en'
  const reportFailure = useCallback((error: unknown, fallback: string) => {
    if (accessMode === 'editor' && error instanceof ApiError && error.status === 404) {
      onAccessLost?.()
      return
    }
    onError(error instanceof Error ? error.message : fallback)
  }, [accessMode, onAccessLost, onError])
  const loadVersions = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const payload = await apiRequest<{ items: DocumentVersion[]; limits?: VersionLimits }>(
        versionsUrl,
      )
      setItems(payload.items)
      if (payload.limits) setLimits(payload.limits)
    } catch (error) {
      if (!quiet) reportFailure(error, i18n.t('versions.loadFailed'))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [i18n, reportFailure, versionsUrl])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadVersions(), 0)
    const interval = accessMode === 'owner'
      ? window.setInterval(() => void loadVersions(true), 30_000)
      : null
    return () => {
      window.clearTimeout(initialLoad)
      if (interval !== null) window.clearInterval(interval)
    }
  }, [accessMode, loadVersions])

  useEffect(() => {
    if (!openMenuId) return
    function closeMenu(event: MouseEvent) {
      if (!(event.target as HTMLElement).closest('[data-version-menu]')) setOpenMenuId(null)
    }
    document.addEventListener('mousedown', closeMenu)
    return () => document.removeEventListener('mousedown', closeMenu)
  }, [openMenuId])

  useEffect(() => {
    if (!mobilePresentation) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      previousFocus?.focus({ preventScroll: true })
    }
  }, [mobilePresentation])

  useEffect(() => {
    if (!mobilePresentation || mobileActionVersion || form || confirmAction || detail) return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeMobileView()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeMobileView, confirmAction, detail, form, mobileActionVersion, mobilePresentation])

  const visibleItems = useMemo(
    () => items.filter((item) => item.kind === section),
    [items, section],
  )
  const revisionCount = items.filter((item) => item.kind === 'revision').length

  async function openDetail(version: DocumentVersion, mode: 'view' | 'compare') {
    setBusyId(version.id)
    try {
      if (mode === 'compare' && await prepareVersionAction() === null) return
      const payload = await apiRequest<VersionDetail>(
        accessMode === 'editor'
          ? `/api/editor/manuscripts/${manuscriptId}/drafts/${version.id}/`
          : `/api/manuscripts/versions/${version.id}/`,
      )
      setDetail(payload)
      setDetailMode(mode)
    } catch (error) {
      reportFailure(error, i18n.t('versions.openFailed'))
    } finally {
      setBusyId(null)
    }
  }

  async function saveRevision() {
    if (!form || !form.name.trim()) return false
    setBusyId(form.version?.id ?? 'create')
    try {
      if (form.version) {
        const payload = await apiRequest<{ version: DocumentVersion }>(
          `/api/manuscripts/versions/${form.version.id}/`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              name: form.name,
              description: form.description,
              expectedVersion: form.version.metadataVersion,
            }),
          },
        )
        setItems((current) => current.map((item) => (
          item.id === payload.version.id ? payload.version : item
        )))
      } else {
        const generation = await prepareVersionAction()
        if (generation === null) return false
        const payload = await apiRequest<{ version: DocumentVersion }>(
          versionsUrl,
          {
            method: 'POST',
            body: JSON.stringify({
              name: form.name,
              description: form.description,
              expectedGeneration: generation,
            }),
          },
        )
        setItems((current) => [payload.version, ...current])
      }
      return true
    } catch (error) {
      onError(error instanceof Error ? error.message : i18n.t('versions.saveFailed'))
      return false
    } finally {
      setBusyId(null)
    }
  }

  async function deleteRevision(version: DocumentVersion) {
    setBusyId(version.id)
    try {
      await apiRequest<{ ok: boolean }>(`/api/manuscripts/versions/${version.id}/`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedVersion: version.metadataVersion }),
      })
      setItems((current) => current.filter((item) => item.id !== version.id))
      return true
    } catch (error) {
      onError(error instanceof Error ? error.message : i18n.t('versions.deleteFailed'))
      return false
    } finally {
      setBusyId(null)
    }
  }

  async function restoreVersion(version: DocumentVersion) {
    setBusyId(version.id)
    try {
      const generation = await prepareVersionAction()
      if (generation === null) return false
      const payload = await apiRequest<{
        document: EditorDocument
        annotations: DocumentAnnotation[]
      }>(`/api/manuscripts/versions/${version.id}/restore/`, {
        method: 'POST',
        body: JSON.stringify({ expectedGeneration: generation }),
      })
      setDetail(null)
      onRestored(payload.document, payload.annotations)
      return true
    } catch (error) {
      onError(error instanceof Error ? error.message : i18n.t('versions.restoreFailed'))
      return false
    } finally {
      setBusyId(null)
    }
  }

  const dialogs = (
    <>
      {form && (mobilePresentation ? (
        <MobileRevisionFormSheet
          form={form}
          busy={busyId !== null}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSave={saveRevision}
        />
      ) : (
        <ActionDialog variant="structured" title={t(form.version ? 'versions.editRevision' : 'versions.newRevision')} closeLabel={t('versions.close')} busy={busyId !== null} className="versionActionDialog" onClose={() => busyId === null && setForm(null)}>
          <form className="versionRevisionForm" onSubmit={(event) => {
            event.preventDefault()
            void saveRevision().then((saved) => saved && setForm(null))
          }}>
            <label className="dialogField"><span>{t('versions.name')}</span><input maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} autoFocus /></label>
            <label className="dialogField"><span>{t('versions.description')} <em>{t('versions.optional')}</em></span><textarea maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
            <footer>
              <button type="button" className="dialogCancel spaceButton" disabled={busyId !== null} onClick={() => setForm(null)}>{t('common.cancel')}</button>
              <button type="submit" className="dialogSubmit spaceButton" disabled={!form.name.trim() || busyId !== null}>{t('common.save')}</button>
            </footer>
          </form>
        </ActionDialog>
      ))}

      {confirmAction && (mobilePresentation ? (
        <MobileVersionConfirmationSheet
          action={confirmAction}
          busy={busyId !== null}
          onClose={() => setConfirmAction(null)}
          onConfirm={() => confirmAction.kind === 'delete'
            ? deleteRevision(confirmAction.version)
            : restoreVersion(confirmAction.version)}
        />
      ) : (
        <ActionDialog
          variant="structured"
          role="alertdialog"
          title={t(confirmAction.kind === 'delete' ? 'versions.deleteTitle' : 'versions.restoreTitle')}
          closeLabel={t('versions.close')}
          busy={busyId !== null}
          className="versionActionDialog"
          onClose={() => busyId === null && setConfirmAction(null)}
        >
          <div className="standardDialogSection">
            <p>
              {confirmAction.kind === 'delete'
                ? t('versions.deleteLead', { name: confirmAction.version.name })
                : t('versions.restoreLead')}
            </p>
            <footer className="standardDialogFooter">
              <button type="button" className="dialogCancel spaceButton" disabled={busyId !== null} onClick={() => setConfirmAction(null)}>{t('common.cancel')}</button>
              {confirmAction.kind === 'delete' ? (
                <button type="button" className="dialogSubmit danger spaceButton" disabled={busyId !== null} onClick={() => void deleteRevision(confirmAction.version).then((deleted) => deleted && setConfirmAction(null))}>{t('common.delete')}</button>
              ) : (
                <button type="button" className="dialogSubmit spaceButton" disabled={busyId !== null} onClick={() => void restoreVersion(confirmAction.version).then((restored) => restored && setConfirmAction(null))}>{t('versions.restore')}</button>
              )}
            </footer>
          </div>
        </ActionDialog>
      ))}
    </>
  )

  if (mobilePresentation) {
    const actionVersionTitle = mobileActionVersion
      ? versionTitle(mobileActionVersion, locale)
      : ''
    return (
      <>
        {createPortal(
          <div className={`dialogBackdrop mobileVersionsBackdrop mobileFullViewBackdrop ${mobileBackdropStateClass}`} role="presentation">
            <section className="mobileVersionsView mobileFullView" role="dialog" aria-modal="true" aria-labelledby={mobileTitleId} ref={setMobileViewRef}>
              <header>
                <button ref={mobileBackRef} type="button" className="mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={mobileViewClosing} onClick={closeMobileView}>
                  <Icon name="arrow-left-1" />
                </button>
                <div className="mobileDialogHeaderCopy">
                  <h2 id={mobileTitleId}>{t('editorShell.drafts')}</h2>
                </div>
                {accessMode === 'owner' && section === 'revision' && (
                  <button
                    type="button"
                    className="mobileDialogPrimary spaceButton"
                    aria-label={t('versions.newRevision')}
                    title={t('versions.newRevision')}
                    disabled={revisionCount >= limits.revisions || busyId !== null || mobileViewClosing}
                    onClick={() => setForm({ version: null, name: '', description: '' })}
                  >
                    <Icon name="sign-plus-light" />
                  </button>
                )}
              </header>
              <div className="mobileVersionsBody">
                {loading ? (
                  <TadpoleLoadingState className="versionsMessage" label={t('versions.loading')} />
                ) : visibleItems.length === 0 ? (
                  <div className="versionsMessage">
                    {section === 'draft' ? t('versions.noDrafts') : t('versions.noRevisions')}
                  </div>
                ) : (
                  <ul className="mobileVersionList">
                    {visibleItems.map((version) => (
                      <li key={version.id}>
                        <button
                          type="button"
                          className="mobileVersionRow spaceButton"
                          disabled={busyId !== null}
                          aria-label={t('versions.openActions', { name: versionTitle(version, locale) })}
                          onClick={() => setMobileActionVersion(version)}
                        >
                          <strong>{versionTitle(version, locale)}</strong>
                          <VersionStats version={version} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {accessMode === 'owner' && <nav className="mobileVersionsBottomBar" role="tablist" aria-label={t('versions.documentVersions')}>
                <button type="button" role="tab" className={`spaceButton ${section === 'draft' ? 'active' : ''}`} aria-selected={section === 'draft'} onClick={() => setSection('draft')}>
                  <Icon name="history-light" />
                  <span>{t('versions.drafts')}</span>
                </button>
                <button type="button" role="tab" className={`spaceButton ${section === 'revision' ? 'active' : ''}`} aria-selected={section === 'revision'} onClick={() => setSection('revision')}>
                  <Icon name="documents-light" />
                  <span>{t('versions.revisions')}</span>
                </button>
              </nav>}
            </section>
          </div>,
          document.body,
        )}

        <MobileLibraryActionSheet
          open={mobileActionVersion !== null}
          title={actionVersionTitle}
          dismissOnSelect
          backdropClassName="mobileVersionActionSheetBackdrop"
          onClose={() => setMobileActionVersion(null)}
          topContent={mobileActionVersion?.kind === 'revision' ? (
            <div className="mobileVersionSheetMeta">
              <time dateTime={mobileActionVersion.createdAt}>{formatVersionDate(mobileActionVersion.createdAt, locale)}</time>
              {mobileActionVersion.description && <p>{mobileActionVersion.description}</p>}
            </div>
          ) : undefined}
          actions={mobileActionVersion ? [
            {
              key: 'view',
              label: t('versions.view'),
              icon: <Icon name="eye-light" />,
              disabled: busyId !== null,
              onSelect: () => void openDetail(mobileActionVersion, 'view'),
            },
            {
              key: 'compare',
              label: t('versions.compare'),
              icon: <Icon name="documents-light" />,
              disabled: busyId !== null,
              onSelect: () => void openDetail(mobileActionVersion, 'compare'),
            },
            ...(accessMode === 'owner' ? [{
              key: 'restore',
              label: t('versions.restore'),
              icon: <Icon name="restart-light" />,
              disabled: busyId !== null,
              onSelect: () => setConfirmAction({ kind: 'restore' as const, version: mobileActionVersion }),
            }] : []),
            ...(accessMode === 'owner' && mobileActionVersion.kind === 'revision' ? [
              {
                key: 'edit',
                label: t('versions.editDetails'),
                icon: <Icon name="edit-light" />,
                disabled: busyId !== null,
                onSelect: () => setForm({
                  version: mobileActionVersion,
                  name: mobileActionVersion.name,
                  description: mobileActionVersion.description,
                }),
              },
              {
                key: 'delete',
                label: t('versions.deleteRevision'),
                icon: <Icon name="trash-bin-trash-light" />,
                danger: true,
                disabled: busyId !== null,
                onSelect: () => setConfirmAction({ kind: 'delete', version: mobileActionVersion }),
              },
            ] : []),
          ] : []}
        />

        {detail && (
          <MobileVersionDetail
            detail={detail}
            mode={detailMode}
            busy={busyId !== null}
            locale={locale}
            onClose={() => setDetail(null)}
            onRestore={accessMode === 'owner' ? () => setConfirmAction({ kind: 'restore', version: detail.version }) : undefined}
            assetUrl={accessMode === 'editor'
              ? (assetId) => editorAssetUrl(manuscriptId, assetId)
              : undefined}
          />
        )}
        {accessMode === 'owner' && dialogs}
      </>
    )
  }

  return (
    <div className="versionsPanel">
      {accessMode === 'owner' && <header className="commentsPanelHeader versionsHeader">
        <div className="commentFilters versionsSections" role="tablist" aria-label={t('versions.documentVersions')}>
          <button type="button" className={`spaceButton ${section === 'draft' ? 'active' : ''}`} onClick={() => setSection('draft')}>
            {t('versions.drafts')}
          </button>
          <button type="button" className={`spaceButton ${section === 'revision' ? 'active' : ''}`} onClick={() => setSection('revision')}>
            {t('versions.revisions')}
          </button>
        </div>
        {section === 'revision' && (
          <button
            type="button"
            className="addCommentButton spaceButton versionCreateButton"
            disabled={revisionCount >= limits.revisions || busyId !== null}
            onClick={() => setForm({ version: null, name: '', description: '' })}
          >
            {t('versions.newRevision')}
          </button>
        )}
      </header>}

      {loading ? (
        <TadpoleLoadingState className="versionsMessage" label={t('versions.loading')} />
      ) : visibleItems.length === 0 ? (
        <div className="versionsMessage">
          {section === 'draft' ? t('versions.noDrafts') : t('versions.noRevisions')}
        </div>
      ) : (
        <div className="versionCards">
          {visibleItems.map((version) => (
            <article className="versionCard" key={version.id}>
              <div className="versionCardHeading">
                <div>
                  <strong>{versionTitle(version, locale)}</strong>
                  {version.kind === 'revision' && <time>{formatVersionDate(version.createdAt, locale)}</time>}
                </div>
              </div>
              <VersionStats version={version} />
              {version.description && <p>{version.description}</p>}
              <div className="versionCardMeta">
                <span><Icon name="check-circle-1-light" />{t(version.kind === 'draft' ? 'versions.savedAutomatically' : 'versions.createdManually')}</span>
                {version.kind === 'revision' && (
                  <div className="versionMenu" data-version-menu>
                    <button
                      type="button"
                      className="spaceButton versionMenuButton"
                      aria-label={t('versions.moreActions', { name: version.name })}
                      aria-expanded={openMenuId === version.id}
                      onClick={() => setOpenMenuId((current) => current === version.id ? null : version.id)}
                    >
                      <Icon name="menu-kebab-vertical-light" />
                    </button>
                    {openMenuId === version.id && (
                      <div className="versionMenuPopover" role="menu">
                        <button type="button" className="spaceButton" role="menuitem" onClick={() => { setOpenMenuId(null); setForm({ version, name: version.name, description: version.description }) }}>
                          <Icon name="edit-light" />{t('versions.editDetails')}
                        </button>
                        <button type="button" className="spaceButton dangerText" role="menuitem" onClick={() => { setOpenMenuId(null); setConfirmAction({ kind: 'delete', version }) }}>
                          {t('versions.deleteRevision')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className={`versionActions ${accessMode === 'editor' ? 'editorAccess' : ''}`}>
                <button type="button" className="spaceButton" disabled={busyId !== null} onClick={() => void openDetail(version, 'view')}>{t('versions.view')}</button>
                <button type="button" className="spaceButton" disabled={busyId !== null} onClick={() => void openDetail(version, 'compare')}>{t('versions.compare')}</button>
                {accessMode === 'owner' && <button type="button" className="spaceButton primary" disabled={busyId !== null} onClick={() => setConfirmAction({ kind: 'restore', version })}>{t('versions.restore')}</button>}
              </div>
            </article>
          ))}
          {section === 'draft' && <p className="draftsHelp"><Icon name="cloud-yes" />{t('versions.draftsHelp')}</p>}
        </div>
      )}

      {detail && (
        <div className="modalBackdrop versionDetailBackdrop" role="presentation" onMouseDown={() => setDetail(null)}>
          <section className="versionDetailModal" role="dialog" aria-modal="true" aria-labelledby="version-detail-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2 id="version-detail-title">{versionTitle(detail.version, locale)}</h2>
                {detail.version.name && <time>{formatVersionDate(detail.version.createdAt, locale)}</time>}
              </div>
              <button type="button" className="spaceButton versionDialogClose" aria-label={t('versions.close')} onClick={() => setDetail(null)}><Icon name="close-square-light" /></button>
            </header>
            <VersionDetailContent
              detail={detail}
              mode={detailMode}
              assetUrl={accessMode === 'editor' ? (assetId) => editorAssetUrl(manuscriptId, assetId) : undefined}
            />
            <footer>
              <button type="button" className="spaceButton" onClick={() => setDetail(null)}>{t('versions.close')}</button>
              {accessMode === 'owner' && <button type="button" className="spaceButton versionPrimaryButton" disabled={busyId !== null} onClick={() => setConfirmAction({ kind: 'restore', version: detail.version })}>{t('versions.restore')}</button>}
            </footer>
          </section>
        </div>
      )}
      {accessMode === 'owner' && dialogs}
    </div>
  )
}

function VersionStats({ version }: { version: DocumentVersion }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? 'en'
  return (
    <div className="versionStats">
      <span>{t('versions.words', { count: version.wordCount, formatted: new Intl.NumberFormat(locale).format(version.wordCount) })}</span>
      <span>{t('versions.characters', { formatted: new Intl.NumberFormat(locale).format(version.characterCount) })}</span>
      <span>{t('versions.sheets', { formatted: new Intl.NumberFormat(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(version.authorSheets) })}</span>
    </div>
  )
}

function VersionDetailContent({
  detail,
  mode,
  mobileVersionControls,
  assetUrl,
}: {
  detail: VersionDetail
  mode: 'view' | 'compare'
  mobileVersionControls?: {
    title: string
    onBack: () => void
    backRef: RefObject<HTMLButtonElement | null>
  }
  assetUrl?: (assetId: string) => string
}) {
  const { t } = useTranslation()
  return (
    <div className="versionDetailBody">
      {mode === 'view' ? (
        <VersionViewer content={detail.content} assetUrl={assetUrl} />
      ) : (
        <DocumentComparison
          ariaLabel={t('versions.diff')}
          left={{ content: detail.content, label: t('documentComparison.savedVersion'), updatedAt: detail.version.createdAt }}
          right={{ content: detail.currentContent, label: t('documentComparison.currentDocument') }}
          mobileVersionControls={mobileVersionControls}
          assetUrl={assetUrl}
        />
      )}
    </div>
  )
}

function MobileVersionDetail({
  detail,
  mode,
  busy,
  locale,
  onClose,
  onRestore,
  assetUrl,
}: {
  detail: VersionDetail
  mode: 'view' | 'compare'
  busy: boolean
  locale: string
  onClose: () => void
  onRestore?: () => void
  assetUrl?: (assetId: string) => string
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const backRef = useRef<HTMLButtonElement>(null)
  const {
    backdropStateClass,
    close,
    closing,
    setDialogRef,
  } = useMobileDialogTransition({ onClose, initialFocusRef: backRef, focusOnDesktop: false })
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    return () => previousFocus?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (mode === 'compare') return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [close, mode])
  const title = versionTitle(detail.version, locale)
  return createPortal(
    <div className={`dialogBackdrop mobileVersionDetailBackdrop mobileFullViewBackdrop ${backdropStateClass}`} role="presentation">
      <section
        className={`mobileVersionDetailView mobileFullView ${mode === 'compare' ? 'compare' : 'view'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={mode === 'view' ? titleId : undefined}
        aria-label={mode === 'compare' ? title : undefined}
        ref={setDialogRef}
      >
        {mode === 'view' && (
          <header>
            <button ref={backRef} type="button" className="mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={closing} onClick={close}>
              <Icon name="arrow-left-1" />
            </button>
            <div className="mobileDialogHeaderCopy"><h2 id={titleId}>{title}</h2></div>
            {onRestore && <button type="button" className="mobileDialogPrimary spaceButton" aria-label={t('versions.restore')} title={t('versions.restore')} disabled={busy || closing} onClick={onRestore}>
              <Icon name="restart-light" />
            </button>}
          </header>
        )}
        <VersionDetailContent
          detail={detail}
          mode={mode}
          mobileVersionControls={mode === 'compare' ? { title, onBack: close, backRef } : undefined}
          assetUrl={assetUrl}
        />
      </section>
    </div>,
    document.body,
  )
}

function MobileRevisionFormSheet({
  form,
  busy,
  onChange,
  onClose,
  onSave,
}: {
  form: RevisionForm
  busy: boolean
  onChange: (form: RevisionForm) => void
  onClose: () => void
  onSave: () => Promise<boolean>
}) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={t(form.version ? 'versions.editRevision' : 'versions.newRevision')} busy={busy} onClose={onClose}>
      {(close) => (
        <form className="mobileVersionRevisionForm" onSubmit={(event) => {
          event.preventDefault()
          void onSave().then((saved) => saved && close())
        }}>
          <label className="dialogField"><span>{t('versions.name')}</span><input maxLength={120} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} /></label>
          <label className="dialogField"><span>{t('versions.description')} <em>{t('versions.optional')}</em></span><textarea maxLength={2000} value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} /></label>
          <footer>
            <button type="button" className="dialogCancel spaceButton" disabled={busy} onClick={close}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit spaceButton" disabled={!form.name.trim() || busy}>{t('common.save')}</button>
          </footer>
        </form>
      )}
    </MobileSettingsSheet>
  )
}

function MobileVersionConfirmationSheet({
  action,
  busy,
  onClose,
  onConfirm,
}: {
  action: ConfirmAction
  busy: boolean
  onClose: () => void
  onConfirm: () => Promise<boolean>
}) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={t(action.kind === 'delete' ? 'versions.deleteTitle' : 'versions.restoreTitle')} role="alertdialog" initialFocus="dialog" busy={busy} onClose={onClose}>
      {(close) => (
        <div className="mobileVersionConfirmation">
          <p>{action.kind === 'delete' ? t('versions.deleteLead', { name: action.version.name }) : t('versions.restoreLead')}</p>
          <footer>
            <button type="button" className="dialogCancel spaceButton" disabled={busy} onClick={close}>{t('common.cancel')}</button>
            <button type="button" className={`dialogSubmit spaceButton ${action.kind === 'delete' ? 'danger' : ''}`} disabled={busy} onClick={() => void onConfirm().then((confirmed) => confirmed && close())}>
              {t(action.kind === 'delete' ? 'common.delete' : 'versions.restore')}
            </button>
          </footer>
        </div>
      )}
    </MobileSettingsSheet>
  )
}

function versionTitle(version: DocumentVersion, locale: string) {
  return version.kind === 'revision' ? version.name : formatVersionDate(version.createdAt, locale)
}

function formatVersionDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
