import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { API_BASE, ApiError, apiQuery, apiRequest } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { StorageGroupKey, StorageItem, StoragePayload } from '../../types'
import { formatBytes } from '../admin/utils'
import { ActionDialog } from '../shared/ActionDialog'
import { AudioNotePlayer, AudioWaveform } from '../shared/AudioNotePlayer'
import { AudioTranscriptionPanel } from '../shared/AudioTranscriptionPanel'
import { formatAudioDuration } from '../books/audioNoteRecording'
import { MobileLibraryActionSheet, type LibraryAction } from '../shared/MobileLibraryActionSheet'
import { PrivateImage } from '../shared/PrivateImage'
import { ResponsiveConfirmationDialog } from '../shared/ResponsiveConfirmationDialog'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'

const defaultPageSize = 18
const maximumPageSize = 48
const desktopGalleryRows = 3
const desktopTileMinimumWidth = 128
const desktopGalleryGap = 14
const groups: StorageGroupKey[] = ['all', 'covers', 'illustrations', 'ideas', 'notes', 'audioNotes', 'glossary', 'other']

const groupIcons: Record<StorageGroupKey, IconName> = {
  all: 'box-light',
  covers: 'books-light',
  illustrations: 'gallery-light',
  ideas: 'lightbulb-light',
  notes: 'notes-light',
  audioNotes: 'microphone-3-linear',
  glossary: 'notebook-light',
  other: 'user-light',
}

const mediaIcons: Record<string, IconName> = {
  avatar: 'user-light',
  manuscript_cover: 'books-light',
  series_cover: 'library-light',
  manuscript_asset: 'gallery-light',
  glossary_thumbnail: 'notebook-light',
  glossary_cover: 'notebook-bookmark-light',
  glossary_illustration: 'gallery-light',
  idea_image: 'lightbulb-light',
  audio_note: 'microphone-3-linear',
}

type StorageTabProps = {
  onError: (message: string) => void
  onMessage: (message: string) => void
}

type StorageImageState = 'loading' | 'ready' | 'fallback' | 'error'

type StorageImageProps = {
  src: string
  icon: IconName
  lazy?: boolean
  onStateChange?: (state: StorageImageState) => void
}

function StorageImage({ src, icon, lazy = false, onStateChange }: StorageImageProps) {
  const [state, setState] = useState<StorageImageState>(src ? 'loading' : 'fallback')

  function updateState(nextState: StorageImageState) {
    setState(nextState)
    onStateChange?.(nextState)
  }

  return (
    <>
      {src && state !== 'error' && (
        <PrivateImage
          className={`storageImage ${state === 'ready' ? 'ready' : ''}`}
          src={src}
          alt=""
          loading={lazy ? 'lazy' : undefined}
          decoding="async"
          onLoad={() => updateState('ready')}
          onError={() => updateState('error')}
        />
      )}
      {(state === 'fallback' || state === 'error') && <Icon name={icon} />}
    </>
  )
}

type StorageGalleryTileProps = {
  item: StorageItem
  active: boolean
  dialog: boolean
  onSelect: () => void
}

function StorageGalleryTile({ item, active, dialog, onSelect }: StorageGalleryTileProps) {
  const { t } = useTranslation()
  const isAudio = item.mediaType === 'audio_note' && item.audio
  const title = item.title || t(`storage.mediaTypes.${item.mediaType}`, { defaultValue: item.mediaType })
  const previewUrl = item.previewUrl ? `${API_BASE}${item.previewUrl}` : ''
  const [imageStatus, setImageStatus] = useState<{
    source: string
    state: StorageImageState
  }>({
    source: previewUrl,
    state: previewUrl ? 'loading' : 'fallback',
  })
  const imageState = imageStatus.source === previewUrl
    ? imageStatus.state
    : previewUrl ? 'loading' : 'fallback'

  return (
    <button
      type="button"
      className={`storageTile ${isAudio ? 'audio' : imageState} ${active ? 'active' : ''}`}
      aria-label={title}
      aria-haspopup={dialog ? 'dialog' : undefined}
      title={title}
      onClick={onSelect}
    >
      <span className={`storageThumb ${isAudio ? 'audio' : imageState}`}>
        {isAudio ? <span className="storageAudioThumb"><Icon name="microphone-3-linear" /><AudioWaveform values={item.audio?.waveform ?? []} compact /></span> : <StorageImage
          key={previewUrl}
          src={previewUrl}
          icon={mediaIcons[item.mediaType] ?? 'gallery-light'}
          lazy
          onStateChange={(state) => setImageStatus({ source: previewUrl, state })}
        />}
      </span>
    </button>
  )
}

function StoragePreview({ item }: { item: StorageItem }) {
  const source = item.displayUrl || item.previewUrl
  const previewUrl = source ? `${API_BASE}${source}` : ''
  const [imageStatus, setImageStatus] = useState<{
    source: string
    state: StorageImageState
  }>({
    source: previewUrl,
    state: previewUrl ? 'loading' : 'fallback',
  })
  const imageState = imageStatus.source === previewUrl
    ? imageStatus.state
    : previewUrl ? 'loading' : 'fallback'

  if (item.audio) {
    return <div className="storagePreview storageAudioPreview"><AudioNotePlayer audio={item.audio} /></div>
  }

  return (
    <div className={`storagePreview ${imageState}`}>
      <StorageImage
        key={previewUrl}
        src={previewUrl}
        icon={mediaIcons[item.mediaType] ?? 'gallery-light'}
        onStateChange={(state) => setImageStatus({ source: previewUrl, state })}
      />
    </div>
  )
}

function navigateToUrl(url: string) {
  if (!url) return
  const target = new URL(url, window.location.origin)
  window.history.pushState({}, '', `${target.pathname}${target.search}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function StorageTitle({ title }: { title: string }) {
  return (
    <h2 className="storageTitle">
      <Icon name="ssd-round-light" />
      <span>{title}</span>
    </h2>
  )
}

type StorageMobileMediaViewProps = {
  actions: LibraryAction[]
  children: ReactNode
  onClose: () => void
  onActionSelect: (action: LibraryAction) => void
}

function StorageMobileMediaView({
  actions,
  children,
  onClose,
  onActionSelect,
}: StorageMobileMediaViewProps) {
  const { t } = useTranslation()
  const [actionsOpen, setActionsOpen] = useState(false)
  const { backdropStateClass, close, closing, setDialogRef } = useMobileDialogTransition({ onClose })

  return (
    <section className={`storageMobileMediaView ${backdropStateClass}`} ref={setDialogRef}>
      <header className="storageMobileMediaHeader">
        <button
          type="button"
          className="spaceButton"
          title={t('common.back')}
          aria-label={t('common.back')}
          disabled={closing}
          onClick={close}
        >
          <Icon name="arrow-left-1" />
        </button>
        <h1>{t('storage.mediaViewer')}</h1>
        <button
          type="button"
          className={`spaceButton ${actionsOpen ? 'active' : ''}`}
          title={t('storage.mediaActions')}
          aria-label={t('storage.mediaActions')}
          aria-haspopup="dialog"
          aria-expanded={actionsOpen}
          disabled={closing}
          onClick={() => setActionsOpen(true)}
        >
          <Icon name="menu-dots-light" />
        </button>
      </header>
      <div className="storageMobileMediaContent">{children}</div>
      <MobileLibraryActionSheet
        open={actionsOpen}
        title={t('storage.mediaViewer')}
        actions={actions}
        dismissOnSelect
        onClose={() => setActionsOpen(false)}
        onActionSelect={onActionSelect}
      />
    </section>
  )
}

export function StorageTab({ onError, onMessage }: StorageTabProps) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const [payload, setPayload] = useState<StoragePayload | null>(null)
  const [group, setGroup] = useState<StorageGroupKey>('all')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<StorageItem | null>(null)
  const [downloadingId, setDownloadingId] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [desktopPageSize, setDesktopPageSize] = useState(0)
  const desktopPageSizeRef = useRef(0)
  const storageMainRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const previousMobileModeRef = useRef(isMobile)
  const locale = i18n.resolvedLanguage ?? 'en'
  const pageSize = isMobile ? defaultPageSize : desktopPageSize
  const storageReady = payload !== null

  useLayoutEffect(() => {
    if (isMobile) return
    const target = storageMainRef.current
    if (!target) return

    function updatePageSize(container: HTMLDivElement) {
      const styles = window.getComputedStyle(container)
      const contentWidth = container.clientWidth
        - Number.parseFloat(styles.paddingLeft)
        - Number.parseFloat(styles.paddingRight)
      const columns = Math.max(1, Math.floor(
        (contentWidth + desktopGalleryGap) / (desktopTileMinimumWidth + desktopGalleryGap),
      ))
      const nextPageSize = Math.min(
        maximumPageSize,
        Math.max(defaultPageSize, columns * desktopGalleryRows),
      )
      if (desktopPageSizeRef.current === nextPageSize) return
      if (desktopPageSizeRef.current !== 0) {
        setPage(1)
        setSelectedId('')
      }
      desktopPageSizeRef.current = nextPageSize
      setDesktopPageSize((current) => current === nextPageSize ? current : nextPageSize)
    }

    updatePageSize(target)
    const observer = new ResizeObserver(() => updatePageSize(target))
    observer.observe(target)
    return () => observer.disconnect()
  }, [isMobile, storageReady])

  useEffect(() => {
    if (pageSize === 0) return
    let active = true
    async function loadStorage() {
      setLoading(true)
      try {
        const enteringMobileMode = isMobile && !previousMobileModeRef.current
        const requestedPage = enteringMobileMode ? 1 : page
        previousMobileModeRef.current = isMobile
        const params = new URLSearchParams({
          group,
          page: String(requestedPage),
          pageSize: String(pageSize),
        })
        const path = `/api/auth/storage/?${params}`
        function applyPayload(next: StoragePayload) {
          setPayload((current) => {
            if (!isMobile || requestedPage === 1 || !current) return next
            const knownIds = new Set(current.items.map((item) => item.id))
            const updatedItems = new Map(next.items.map((item) => [item.id, item]))
            return {
              ...next,
              items: [
                ...current.items.map((item) => updatedItems.get(item.id) ?? item),
                ...next.items.filter((item) => !knownIds.has(item.id)),
              ],
            }
          })
          setSelectedId((current) => {
            if (!current) return ''
            if (isMobile && requestedPage > 1) return current
            return next.items.some((item) => item.id === current) ? current : ''
          })
        }

        const next = await apiQuery<StoragePayload>(path, {
          onBackgroundUpdate: (updated) => {
            if (!active) return
            applyPayload(updated)
          },
        })
        if (!active) return
        applyPayload(next)
        if (enteringMobileMode) setPage(1)
      } catch (error) {
        if (active) onError(error instanceof Error ? error.message : t('storage.loadFailed'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadStorage()
    return () => {
      active = false
    }
  }, [group, isMobile, page, pageSize, onError, t])

  useEffect(() => {
    const target = loadMoreRef.current
    if (!isMobile || !target || loading || !payload?.pagination.hasNext || selectedId) return
    const scrollRoot = storageMainRef.current?.closest<HTMLElement>('.settingsBody') ?? null
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      observer.disconnect()
      setPage((current) => current + 1)
    }, { root: scrollRoot, rootMargin: '180px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [isMobile, loading, payload?.pagination.hasNext, payload?.pagination.page, selectedId])

  const selected = useMemo(
    () => payload?.items.find((item) => item.id === selectedId) ?? null,
    [payload, selectedId],
  )
  const usageRatio = payload?.summary.limitBytes
    ? quotaFillPercent(payload.summary.usedBytes, payload.summary.limitBytes)
    : 0
  const selectedGroupSummary = payload?.groups.find((candidate) => candidate.key === group)

  async function deleteItem(item: StorageItem): Promise<boolean> {
    if (!item.deletable || deletingId) return false
    setDeletingId(item.id)
    try {
      await apiRequest(`/api/auth/storage/${encodeURIComponent(item.id)}/`, { method: 'DELETE' })
      onMessage(t('storage.deleted'))
      setSelectedId('')
      if (isMobile && page > 1) {
        setPage(1)
      } else {
        const nextPage = !isMobile && payload && payload.items.length === 1 && page > 1
          ? page - 1
          : page
        setPage(nextPage)
        const params = new URLSearchParams({
          group,
          page: String(nextPage),
          pageSize: String(pageSize),
        })
        const next = await apiRequest<StoragePayload>(`/api/auth/storage/?${params}`)
        setPayload(next)
      }
      return true
    } catch (error) {
      if (error instanceof ApiError && error.code === 'storage_item_in_use') {
        onError(t('storage.errors.inUse'))
      } else {
        onError(error instanceof Error ? error.message : t('storage.deleteFailed'))
      }
      return false
    } finally {
      setDeletingId('')
    }
  }

  async function downloadItem(item: StorageItem) {
    if (!item.downloadUrl || downloadingId) return
    setDownloadingId(item.id)
    try {
      const response = await fetch(`${API_BASE}${item.downloadUrl}`, { credentials: 'include' })
      if (!response.ok) throw new Error(t('storage.downloadFailed'))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = downloadFileName(item)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('storage.downloadFailed'))
    } finally {
      setDownloadingId('')
    }
  }

  function renderMediaDetails(item: StorageItem, withActions: boolean) {
    return (
      <>
        <StoragePreview item={item} />
        {item.audio && <AudioTranscriptionPanel endpoint={item.audio.transcriptionUrl} onError={onError} />}
        <dl>
          <div>
            <dt>{t('storage.type')}</dt>
            <dd>{t(`storage.mediaTypes.${item.mediaType}`, { defaultValue: item.mediaType })}</dd>
          </div>
          <div>
            <dt>{t('storage.totalSize')}</dt>
            <dd>{formatBytes(item.totalBytes, locale)}</dd>
          </div>
          {!item.audio && <div>
            <dt>{t('storage.originalSize')}</dt>
            <dd>{formatBytes(item.originalBytes, locale)}</dd>
          </div>}
          {!item.audio && <div>
            <dt>{t('storage.variantsSize')}</dt>
            <dd>{formatBytes(item.variantBytes, locale)}</dd>
          </div>}
          {!item.audio && <div>
            <dt>{t('storage.dimensions')}</dt>
            <dd>
              {item.width && item.height
                ? t('storage.dimensionsValue', { width: item.width, height: item.height })
                : t('storage.unknown')}
            </dd>
          </div>}
          {item.audio && <>
            <div><dt>{t('storage.format')}</dt><dd>{item.contentType === 'audio/mp4' ? 'MP4' : item.contentType === 'audio/ogg' ? 'Ogg' : 'WebM'}</dd></div>
            <div><dt>{t('storage.codec')}</dt><dd>{item.audio.codec === 'aac' ? 'AAC' : 'Opus'}</dd></div>
            <div><dt>{t('storage.duration')}</dt><dd>{formatAudioDuration(item.audio.durationMs)}</dd></div>
            <div><dt>{item.usages[0]?.kind === 'idea' ? t('ideas.title') : t('storage.manuscript')}</dt><dd>{item.usages[0]?.kind === 'idea' ? t('ideas.title') : item.subtitle || t('storage.unknown')}</dd></div>
          </>}
          <div>
            <dt>{t('storage.usedIn')}</dt>
            <dd className="storageUsageValues">
              {item.usages.length > 0
                ? item.usages.map((usage, index) => (
                  <span key={`${usage.kind}:${usage.url}:${index}`}>
                    <b>{usage.label || (usage.kind === 'idea'
                      ? t(item.audio ? 'ideas.untitled' : 'storage.mediaTypes.idea_image')
                      : t(`storage.mediaTypes.${item.mediaType}`, { defaultValue: item.mediaType }))}</b>
                    <small>{t(`storage.usageKinds.${usage.kind}`, { defaultValue: usage.detail })}</small>
                  </span>
                ))
                : t('storage.notUsed')}
            </dd>
          </div>
        </dl>

        {withActions && (
          <div className="storageActions">
            {item.usages[0]?.url && (
              <button
                type="button"
                className="storageActionButton spaceButton"
                onClick={() => navigateToUrl(item.usages[0].url)}
              >
                <Icon name="link-minimalistic-light" />
                {t('storage.openLocation')}
              </button>
            )}
            {item.downloadUrl && (
              <button
                type="button"
                className="storageActionButton storageDownloadButton spaceButton"
                disabled={downloadingId === item.id}
                onClick={() => void downloadItem(item)}
              >
                <Icon name="download-minimalistic-light" />
                {t('storage.download')}
              </button>
            )}
            <button
              type="button"
              className="storageActionButton storageDeleteButton spaceButton"
              disabled={!item.deletable || deletingId === item.id}
              title={!item.deletable ? t(`storage.deleteReasons.${item.deleteReason}`, { defaultValue: t('storage.deleteReasons.referenced') }) : undefined}
              onClick={() => setDeleteTarget(item)}
            >
              <Icon name="trash-bin-trash-light" />
              {deletingId === item.id ? t('storage.deleting') : t('storage.delete')}
            </button>
          </div>
        )}
      </>
    )
  }

  if (!payload && loading) {
    return (
      <section className="settingsPanel storagePanel">
        <div className="storageContent">
          <div className="storageMain storageInitialMain" aria-busy="true" ref={storageMainRef}>
            <StorageTitle title={t('storage.title')} />
            <div className="settingsLoadingState" role="status" aria-label={t('storage.loading')}>
              <TadpoleIcon />
            </div>
          </div>
        </div>
      </section>
    )
  }

  if (!payload) {
    return (
      <section className="settingsPanel storagePanel">
        <StorageTitle title={t('storage.title')} />
        <div className="notice error">{t('storage.loadFailed')}</div>
      </section>
    )
  }

  const mobileMediaActions: LibraryAction[] = selected ? [
    ...(selected.usages[0]?.url ? [{
      key: 'open-location',
      label: t('storage.openLocation'),
      icon: <Icon name="link-minimalistic-light" />,
    }] : []),
    ...(selected.downloadUrl ? [{
      key: 'download',
      label: downloadingId === selected.id ? t('storage.downloading') : t('storage.download'),
      icon: <Icon name="download-minimalistic-light" />,
      disabled: downloadingId === selected.id,
    }] : []),
    {
      key: 'delete',
      label: deletingId === selected.id ? t('storage.deleting') : t('storage.delete'),
      icon: <Icon name="trash-bin-trash-light" />,
      danger: true,
      disabled: !selected.deletable || deletingId === selected.id,
    },
  ] : []

  return (
    <>
      <section className="settingsPanel storagePanel">
        <div className="storageContent">
        <div className="storageMain" ref={storageMainRef}>
          {!isMobile && <StorageTitle title={t('storage.title')} />}

          {isMobile ? (
            <section className="storageMobileUsageSummary">
              <div
                className="storageMobileUsageRing"
                role="progressbar"
                aria-label={t('storage.used')}
                aria-valuemin={0}
                aria-valuemax={payload.summary.limitBytes}
                aria-valuenow={Math.min(payload.summary.usedBytes, payload.summary.limitBytes)}
                style={{ '--storage-usage-angle': `${usageRatio * 3.6}deg` } as CSSProperties}
              >
                <span><Icon name="ssd-round-light" /></span>
              </div>
              <strong>
                {t('tiers.usageValue', {
                  used: formatBytes(payload.summary.usedBytes, locale),
                  limit: formatBytes(payload.summary.limitBytes, locale),
                })}
              </strong>
            </section>
          ) : (
            <div className="storageUsageCard">
              <div>
                <span>{t('storage.used')}</span>
                <strong>
                  {t('tiers.usageValue', {
                    used: formatBytes(payload.summary.usedBytes, locale),
                    limit: formatBytes(payload.summary.limitBytes, locale),
                  })}
                </strong>
              </div>
              <i className="quotaTrack" aria-hidden="true">
                <b style={{ width: `${usageRatio}%` }} />
              </i>
            </div>
          )}

          {isMobile ? (
            <button
              type="button"
              className="accountMobileSettingRow storageMobileFilterRow spaceButton"
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen(true)}
            >
              <span className="accountMobileSettingIcon"><Icon name="filter-linear" /></span>
              <span className="accountMobileSettingCopy">
                <strong>{t('storage.groups')}</strong>
                <small>
                  {t(`storage.groupsMap.${group}`)} · {new Intl.NumberFormat(locale).format(selectedGroupSummary?.count ?? 0)}
                </small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
          ) : (
            <div className="storageGroups" role="tablist" aria-label={t('storage.groups')}>
              {groups.map((item) => {
                const summary = payload.groups.find((candidate) => candidate.key === item)
                return (
                  <button
                    key={item}
                    type="button"
                    className={`storageGroupButton storagePickerSecondaryAction spaceButton ${group === item ? 'active' : ''}`}
                    role="tab"
                    aria-selected={group === item}
                    onClick={() => {
                      setGroup(item)
                      setPage(1)
                    }}
                  >
                    <Icon name={groupIcons[item]} />
                    <span>{t(`storage.groupsMap.${item}`)}</span>
                    <small>{new Intl.NumberFormat(locale).format(summary?.count ?? 0)}</small>
                  </button>
                )
              })}
            </div>
          )}

          <div className="storageGalleryPane" aria-busy={loading}>
            {loading && (!isMobile || page === 1) && (
              <div className="storageLoading" role="status" aria-label={t('storage.loading')}>
                <TadpoleIcon />
              </div>
            )}
            {!loading && payload.items.length === 0 && (
              <div className="storageEmpty">
                <Icon name="gallery-light" />
                <strong>{t('storage.emptyTitle')}</strong>
                <span>{t('storage.emptyLead')}</span>
              </div>
            )}
            {payload.items.length > 0 && (
              <div className="storageGallery">
                {payload.items.map((item) => (
                  <StorageGalleryTile
                    key={item.id}
                    item={item}
                    active={selected?.id === item.id}
                    dialog={!isMobile}
                    onSelect={() => setSelectedId(item.id)}
                  />
                ))}
              </div>
            )}
            {!isMobile && <div className="storagePagination">
              <button
                type="button"
                className="storagePageButton spaceButton"
                disabled={payload.pagination.page <= 1}
                title={t('storage.previousPage')}
                aria-label={t('storage.previousPage')}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <Icon name="arrow-left-1" />
              </button>
              <span>
                {t('storage.pageValue', {
                  page: payload.pagination.page,
                  total: payload.pagination.totalPages,
                })}
              </span>
              <button
                type="button"
                className="storagePageButton spaceButton"
                disabled={payload.pagination.page >= payload.pagination.totalPages}
                title={t('storage.nextPage')}
                aria-label={t('storage.nextPage')}
                onClick={() => setPage((current) => current + 1)}
              >
                <Icon name="arrow-right-2" />
              </button>
            </div>}
            {isMobile && (
              <div
                className="storageMobileLoadMore"
                ref={loadMoreRef}
                role={loading && page > 1 ? 'status' : undefined}
                aria-label={loading && page > 1 ? t('storage.loading') : undefined}
              >
                {loading && page > 1 && <TadpoleIcon />}
              </div>
            )}
          </div>
        </div>

      </div>

        <MobileLibraryActionSheet
          open={filterOpen}
          title={t('storage.groups')}
          actions={groups.map((item) => ({
            key: item,
            label: t(`storage.groupsMap.${item}`),
            icon: <Icon name={groupIcons[item]} />,
            selected: group === item,
            onSelect: () => {
              setGroup(item)
              setPage(1)
              setSelectedId('')
            },
          }))}
          dismissOnSelect
          onClose={() => setFilterOpen(false)}
        />
      </section>

      {!isMobile && selected && (
        <ActionDialog
          variant="structured"
          title={t('storage.mediaViewer')}
          closeLabel={t('common.close')}
          busy={deletingId === selected.id}
          className="storageMediaDialog"
          titleClassName="storageMediaDialogTitle"
          onClose={() => setSelectedId('')}
        >
          <div className="storageMediaDialogLayout">
            {renderMediaDetails(selected, true)}
          </div>
        </ActionDialog>
      )}

      {isMobile && selected && (
        <StorageMobileMediaView
          key={selected.id}
          actions={mobileMediaActions}
          onClose={() => setSelectedId('')}
          onActionSelect={(action) => {
            if (action.key === 'open-location' && selected.usages[0]?.url) {
              navigateToUrl(selected.usages[0].url)
            } else if (action.key === 'download') {
              void downloadItem(selected)
            } else if (action.key === 'delete') {
              setDeleteTarget(selected)
            }
          }}
        >
          {renderMediaDetails(selected, false)}
        </StorageMobileMediaView>
      )}

      {deleteTarget && (
        <ResponsiveConfirmationDialog
          title={t('storage.confirmDelete', {
            title: deleteTarget.title || t(`storage.mediaTypes.${deleteTarget.mediaType}`, { defaultValue: deleteTarget.mediaType }),
          })}
          description={t('storage.confirmDeleteLead')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('storage.delete')}
          busyLabel={t('storage.deleting')}
          closeLabel={t('common.close')}
          busy={deletingId === deleteTarget.id}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => deleteItem(deleteTarget)}
          onConfirmed={() => setDeleteTarget(null)}
        />
      )}
    </>
  )
}

function quotaFillPercent(used: number, limit: number) {
  if (used <= 0) return 0
  if (limit <= 0) return 100
  return Math.min(100, Math.max(2, (used / limit) * 100))
}

function downloadFileName(item: StorageItem) {
  const safeTitle = item.title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'media-file'
  const extension = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
  }[item.contentType] ?? 'bin'
  return `${safeTitle}.${extension}`
}
