import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, UIEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { API_BASE, ApiError, apiQuery, apiRequest, apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { IdeaAttachResult, IdeaItem, IdeaKind, IdeasPayload, IdeaTarget } from '../../types'
import { BoardsSaveStatusIndicator } from '../books/BoardsSaveStatusIndicator'
import { AudioWaveform } from '../shared/AudioNotePlayer'
import { CustomSelect } from '../shared/CustomSelect'
import { PrivateImage } from '../shared/PrivateImage'
import { ResponsiveConfirmationDialog } from '../shared/ResponsiveConfirmationDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import type { AudioRecordingResult } from '../shared/useAudioRecorder'
import { IdeaAudioEditor } from './IdeaAudioEditor'
import { IdeaTextEditor } from './IdeaTextEditor'
import type { IdeaTextDraft } from './IdeaTextEditor'
import './IdeasPage.css'

type Props = {
  initialItemId: string | null
  onError: (message: string) => void
  onMessage: (message: string) => void
  onActionMessage: (message: string, label: string, path: string) => void
}

type IdeaFilter = 'all' | IdeaKind

const filters: IdeaFilter[] = ['all', 'image', 'text', 'audio']
const COLUMN_WIDTH = 268
const COLUMN_GAP = 16

export function IdeasPage({ initialItemId, onError, onMessage, onActionMessage }: Props) {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState<IdeaFilter>('all')
  const [items, setItems] = useState<IdeaItem[]>([])
  const [counts, setCounts] = useState<IdeasPayload['counts']>({ all: 0, image: 0, text: 0, audio: 0 })
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [importingAudio, setImportingAudio] = useState(false)
  const [selected, setSelected] = useState<IdeaItem | null>(null)
  const [openingItemId, setOpeningItemId] = useState<string | null>(null)
  const [newTextOpen, setNewTextOpen] = useState(false)
  const [newAudioOpen, setNewAudioOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [mobileActionsHidden, setMobileActionsHidden] = useState(false)
  const [columnCount, setColumnCount] = useState(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const scrollAnchorRef = useRef(0)
  const queryRef = useRef('')
  const locale = i18n.resolvedLanguage ?? 'en'

  const loadFirstPage = useCallback(async (nextFilter: IdeaFilter) => {
    const path = `/api/ideas/?kind=${nextFilter}`
    queryRef.current = path
    setLoading(true)
    try {
      const payload = await apiQuery<IdeasPayload>(path, {
        onBackgroundUpdate: (next) => {
          if (queryRef.current !== path) return
          setItems(next.items)
          setCounts(next.counts)
          setNextCursor(next.nextCursor)
        },
      })
      if (queryRef.current !== path) return
      setItems(payload.items)
      setCounts(payload.counts)
      setNextCursor(payload.nextCursor)
    } catch (error) {
      if (queryRef.current === path) {
        setItems([])
        setNextCursor(null)
        onError(error instanceof Error ? error.message : t('ideas.loadFailed'))
      }
    } finally {
      if (queryRef.current === path) setLoading(false)
    }
  }, [onError, t])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFirstPage(filter), 0)
    return () => window.clearTimeout(timer)
  }, [filter, loadFirstPage])

  useLayoutEffect(() => {
    const target = gridRef.current
    if (!target) return
    const grid = target
    function updateColumns() {
      const width = grid.clientWidth
      const mobile = window.matchMedia('(max-width: 520px)').matches
      setColumnCount(mobile ? 2 : Math.max(1, Math.floor((width + COLUMN_GAP) / (COLUMN_WIDTH + COLUMN_GAP))))
    }
    updateColumns()
    const observer = new ResizeObserver(updateColumns)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [items.length, loading])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const payload = await apiRequest<IdeasPayload>(
        `/api/ideas/?kind=${filter}&cursor=${encodeURIComponent(nextCursor)}`,
        { invalidateQueryCache: false },
      )
      setItems((current) => {
        const known = new Set(current.map((item) => item.id))
        return [...current, ...payload.items.filter((item) => !known.has(item.id))]
      })
      setCounts(payload.counts)
      setNextCursor(payload.nextCursor)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('ideas.loadMoreFailed'))
    } finally {
      setLoadingMore(false)
    }
  }, [filter, loadingMore, nextCursor, onError, t])

  useEffect(() => {
    const target = loadMoreRef.current
    if (!target || !nextCursor || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void loadMore()
    }, { rootMargin: '280px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [loadMore, nextCursor])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      if (!initialItemId) {
        setSelected(null)
        setOpeningItemId(null)
        setDeleteConfirmOpen(false)
        return
      }
      if (loading) return
      const available = items.find((item) => item.id === initialItemId)
      if (available && (available.kind !== 'text' || available.text !== undefined)) {
        setSelected(available)
        setOpeningItemId(null)
        return
      }
      setOpeningItemId(initialItemId)
      void apiRequest<{ item: IdeaItem }>(`/api/ideas/${initialItemId}/`, {
        invalidateQueryCache: false,
      }).then((payload) => {
        if (active) {
          setSelected(payload.item)
          setOpeningItemId(null)
        }
      }).catch((error) => {
        if (!active) return
        setOpeningItemId(null)
        onError(error instanceof Error ? error.message : t('ideas.openFailed'))
        window.history.replaceState({}, '', '/ideas')
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [initialItemId, items, loading, onError, t])

  const columns = useMemo(() => {
    const next = Array.from({ length: columnCount }, () => [] as IdeaItem[])
    items.forEach((item, index) => next[index % columnCount].push(item))
    return next
  }, [columnCount, items])

  function openIdea(item: IdeaItem) {
    setSelected(item.kind === 'text' && item.text === undefined ? null : item)
    setOpeningItemId(item.kind === 'text' && item.text === undefined ? item.id : null)
    setNewTextOpen(false)
    setNewAudioOpen(false)
    setDeleteConfirmOpen(false)
    window.history.pushState({}, '', `/ideas?item=${encodeURIComponent(item.id)}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  function closeIdea() {
    setSelected(null)
    setOpeningItemId(null)
    setNewTextOpen(false)
    setNewAudioOpen(false)
    setDeleteConfirmOpen(false)
    window.history.replaceState({}, '', '/ideas')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  function openNewText() {
    setSelected(null)
    setOpeningItemId(null)
    setDeleteConfirmOpen(false)
    setNewTextOpen(true)
    setNewAudioOpen(false)
    window.history.replaceState({}, '', '/ideas')
  }

  function openNewAudio() {
    setSelected(null)
    setOpeningItemId(null)
    setDeleteConfirmOpen(false)
    setNewTextOpen(false)
    setNewAudioOpen(true)
    window.history.replaceState({}, '', '/ideas')
  }

  async function saveTextIdea(draft: IdeaTextDraft, item: IdeaItem | null) {
    const payload = item
      ? await apiRequest<{ item: IdeaItem }>(`/api/ideas/${item.id}/`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: draft.title,
            text: draft.text,
            expectedGeneration: item.saveGeneration,
          }),
        })
      : await apiRequest<{ item: IdeaItem }>('/api/ideas/text/', {
          method: 'POST',
          body: JSON.stringify(draft),
        })
    const saved = payload.item
    setItems((current) => {
      const remaining = current.filter((candidate) => candidate.id !== saved.id)
      return filter === 'all' || filter === 'text' ? [saved, ...remaining] : remaining
    })
    if (!item) {
      setCounts((current) => ({ ...current, all: current.all + 1, text: current.text + 1 }))
      window.history.replaceState({}, '', `/ideas?item=${encodeURIComponent(saved.id)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
    setSelected(saved)
    setNewTextOpen(false)
    return saved
  }

  async function attachIdea(item: IdeaItem, target: IdeaTarget) {
    const payload = await apiRequest<IdeaAttachResult>(`/api/ideas/${item.id}/attach/`, {
      method: 'POST',
      body: JSON.stringify({ manuscriptId: target.id }),
    })
    setItems((current) => current.filter((candidate) => candidate.id !== item.id))
    setCounts((current) => ({
      ...current,
      all: Math.max(0, current.all - 1),
      [item.kind]: Math.max(0, current[item.kind] - 1),
    }))
    closeIdea()
    onActionMessage(
      t(item.kind === 'audio' ? 'ideas.audioAttached' : 'ideas.textAttached'),
      t('ideas.openInBoards'),
      `/manuscripts/${payload.note.manuscriptId}/boards?note=${payload.note.id}`,
    )
  }

  async function createAudioIdea(result: AudioRecordingResult, title: string) {
    const body = new FormData()
    body.set('audio', result.blob, result.blob.type.startsWith('audio/mp4') ? 'audio-note.m4a' : result.blob.type.startsWith('audio/ogg') ? 'audio-note.ogg' : 'audio-note.webm')
    body.set('metadata', JSON.stringify({ title, durationMs: result.durationMs, waveform: result.waveform }))
    const payload = await apiUpload<{ item: IdeaItem }>('/api/ideas/audio/', body)
    setItems((current) => filter === 'all' || filter === 'audio' ? [payload.item, ...current] : current)
    setCounts((current) => ({ ...current, all: current.all + 1, audio: current.audio + 1 }))
    setSelected(payload.item)
    setNewAudioOpen(false)
    window.history.replaceState({}, '', `/ideas?item=${encodeURIComponent(payload.item.id)}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    return payload.item
  }

  async function saveIdeaTitle(title: string, item: IdeaItem, expectedGeneration = item.saveGeneration) {
    const payload = await apiRequest<{ item: IdeaItem }>(`/api/ideas/${item.id}/`, {
      method: 'PATCH',
      body: JSON.stringify({ title, expectedGeneration }),
    })
    setItems((current) => {
      const remaining = current.filter((candidate) => candidate.id !== payload.item.id)
      return filter === 'all' || filter === payload.item.kind ? [payload.item, ...remaining] : remaining
    })
    setSelected(payload.item)
    return payload.item
  }

  async function uploadImage(file: File | undefined) {
    if (!file || uploadingImage) return
    setUploadingImage(true)
    try {
      const body = new FormData()
      body.set('image', file)
      const payload = await apiUpload<{ item: IdeaItem; created: boolean }>('/api/ideas/images/', body)
      setItems((current) => {
        const remaining = current.filter((item) => item.id !== payload.item.id)
        return filter === 'all' || filter === 'image' ? [payload.item, ...remaining] : remaining
      })
      if (payload.created) {
        setCounts((current) => ({ ...current, all: current.all + 1, image: current.image + 1 }))
      }
      onMessage(t('ideas.imageAdded'))
    } catch (error) {
      onError(error instanceof Error ? error.message : t('ideas.uploadFailed'))
    } finally {
      setUploadingImage(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function importAudio(file: File | undefined) {
    if (!file || importingAudio) return
    setImportingAudio(true)
    try {
      const body = new FormData()
      body.set('audio', file)
      const payload = await apiUpload<{ item: IdeaItem }>('/api/ideas/audio/import/', body)
      setItems((current) => filter === 'all' || filter === 'audio' ? [payload.item, ...current] : current)
      setCounts((current) => ({ ...current, all: current.all + 1, audio: current.audio + 1 }))
      setSelected(payload.item)
      setNewAudioOpen(false)
      window.history.replaceState({}, '', `/ideas?item=${encodeURIComponent(payload.item.id)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
      onMessage(t('ideas.audioImported'))
    } catch (error) {
      onError(error instanceof Error ? error.message : t('ideas.audioImportFailed'))
    } finally {
      setImportingAudio(false)
      if (audioInputRef.current) audioInputRef.current.value = ''
    }
  }

  async function deleteIdea(): Promise<boolean> {
    if (!selected || deleting) return false
    const deletedKind = selected.kind
    setDeleting(true)
    try {
      await apiRequest(`/api/ideas/${selected.id}/`, { method: 'DELETE' })
      setItems((current) => current.filter((item) => item.id !== selected.id))
      setCounts((current) => ({
        ...current,
        all: Math.max(0, current.all - 1),
        [deletedKind]: Math.max(0, current[deletedKind] - 1),
      }))
      onMessage(t(deletedKind === 'text' ? 'ideas.textDeleted' : deletedKind === 'audio' ? 'ideas.audioDeleted' : 'ideas.imageDeleted'))
      return true
    } catch (error) {
      onError(error instanceof Error
        ? error.message
        : t(deletedKind === 'text' ? 'ideas.deleteTextFailed' : deletedKind === 'audio' ? 'ideas.deleteAudioFailed' : 'ideas.deleteFailed'))
      return false
    } finally {
      setDeleting(false)
    }
  }

  const editorOpen = newTextOpen || newAudioOpen || selected !== null || openingItemId !== null

  function handleScroll(event: UIEvent<HTMLElement>) {
    const scrollTop = event.currentTarget.scrollTop
    if (scrollTop <= 4) {
      scrollAnchorRef.current = scrollTop
      setMobileActionsHidden(false)
      return
    }
    const delta = scrollTop - scrollAnchorRef.current
    if (Math.abs(delta) < 12) return
    scrollAnchorRef.current = scrollTop
    setMobileActionsHidden(delta > 0)
  }

  return (
    <main className={`ideasPage ${mobileActionsHidden ? 'mobileActionsHidden' : ''}`} aria-labelledby="ideas-heading">
      <header className="ideasToolbar">
        <h1 id="ideas-heading">{t('ideas.title')}</h1>
        <div className="ideasToolbarActions">
          <label className="ideasFilter">
            <span className="srOnly">{t('ideas.filters')}</span>
            <CustomSelect
              value={filter}
              aria-label={t('ideas.filters')}
              onChange={(event) => setFilter(event.currentTarget.value as IdeaFilter)}
            >
              {filters.map((item) => (
                <option value={item} key={item}>
                  {t('ideas.filterWithCount', {
                    label: t(`ideas.filter.${item}`),
                    count: new Intl.NumberFormat(locale).format(counts[item]),
                  })}
                </option>
              ))}
            </CustomSelect>
          </label>
          <button type="button" className="ideasCreateButton spaceButton" disabled={uploadingImage} onClick={() => fileInputRef.current?.click()}>
            <Icon name={uploadingImage ? 'cloud-upload' : 'gallery-light'} />
            <span>{t(uploadingImage ? 'ideas.uploading' : 'ideas.addImage')}</span>
          </button>
          <button type="button" className="ideasCreateButton spaceButton" onClick={openNewText}>
            <Icon name="notes-light" />
            <span>{t('ideas.addText')}</span>
          </button>
          <button type="button" className="ideasCreateButton spaceButton" onClick={openNewAudio}>
            <Icon name="microphone-3-linear" />
            <span>{t('ideas.addAudio')}</span>
          </button>
          <button type="button" className="ideasCreateButton secondary iconOnly spaceButton" disabled={importingAudio} aria-label={t('ideas.importAudio')} title={t('ideas.importAudio')} onClick={() => audioInputRef.current?.click()}>
            <Icon name={importingAudio ? 'cloud-upload' : 'upload-track-linear'} />
          </button>
        </div>
      </header>

      <section className="ideasFeed" aria-label={t('ideas.feed')} onScroll={handleScroll}>
        <div className="ideasFeedInner">
          {loading ? (
            <TadpoleLoadingState className="ideasLoading" label={t('ideas.loading')} />
          ) : items.length > 0 ? (
            <>
              <div className="ideasMasonry" ref={gridRef} style={{ '--ideas-column-count': columnCount } as CSSProperties}>
                {columns.map((column, columnIndex) => (
                  <div className="ideasColumn" key={columnIndex}>
                    {column.map((item) => item.kind === 'image' ? (
                      <button type="button" className="ideaCard image spaceButton" key={item.id} onClick={() => openIdea(item)} aria-label={t('ideas.openImage')}>
                        <strong className="ideaCardTitle">{item.title || t('ideas.untitled')}</strong>
                        {item.image && <PrivateImage src={`${API_BASE}${item.image.previewUrl}`} alt="" loading="lazy" decoding="async" />}
                        <span className="ideaCardMeta"><Icon name="gallery-light" /><time dateTime={item.updatedAt}>{formatDate(item.updatedAt, locale)}</time></span>
                      </button>
                    ) : item.kind === 'audio' ? (
                      <button type="button" className="ideaCard audio spaceButton" key={item.id} onClick={() => openIdea(item)} aria-label={t('ideas.openAudio')}>
                        <strong className="ideaCardTitle">{item.title || t('ideas.untitled')}</strong>
                        <span className="ideaAudioCardContent">
                          <Icon name="microphone-3-linear" />
                          {item.audio && <AudioWaveform values={item.audio.waveform} compact />}
                        </span>
                        <span className="ideaCardMeta"><Icon name="microphone-3-linear" /><time dateTime={item.updatedAt}>{formatDate(item.updatedAt, locale)}</time></span>
                      </button>
                    ) : (
                      <button type="button" className="ideaCard text spaceButton" key={item.id} onClick={() => openIdea(item)} aria-label={t('ideas.openText')}>
                        <strong className="ideaCardTitle">{item.title || t('ideas.untitled')}</strong>
                        {item.preview && <span className="ideaTextCardContent"><span>{item.preview}</span></span>}
                        <span className="ideaCardMeta"><Icon name="notes-light" /><time dateTime={item.updatedAt}>{formatDate(item.updatedAt, locale)}</time></span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              {nextCursor && (
                <div className="ideasLoadMore" ref={loadMoreRef}>
                  <button type="button" className="spaceButton" disabled={loadingMore} onClick={() => void loadMore()}>
                    {t(loadingMore ? 'ideas.loadingMore' : 'ideas.loadMore')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="ideasEmpty">
              <span><Icon name={filter === 'text' ? 'notes-light' : filter === 'audio' ? 'microphone-3-linear' : 'gallery-light'} /></span>
              <h2>{t('ideas.emptyTitle')}</h2>
              <p>{t('ideas.emptyLead')}</p>
            </div>
          )}
        </div>
      </section>

      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => void uploadImage(event.target.files?.[0])} />
      <input ref={audioInputRef} type="file" accept=".m4a,audio/mp4,audio/m4a,audio/x-m4a" hidden onChange={(event) => void importAudio(event.target.files?.[0])} />

      {!editorOpen && (
        <button type="button" className="ideasMobileCreate image spaceButton" disabled={uploadingImage} aria-label={t('ideas.addImage')} title={t('ideas.addImage')} onClick={() => fileInputRef.current?.click()}>
          <Icon name={uploadingImage ? 'cloud-upload' : 'gallery-light'} />
        </button>
      )}

      {!editorOpen && (
        <button type="button" className="ideasMobileCreate audio spaceButton" aria-label={t('ideas.addAudio')} title={t('ideas.addAudio')} onClick={openNewAudio}>
          <Icon name="microphone-3-linear" />
        </button>
      )}

      {!editorOpen && (
        <button type="button" className="ideasMobileCreate text spaceButton" aria-label={t('ideas.addText')} title={t('ideas.addText')} onClick={openNewText}>
          <Icon name="notes-light" />
        </button>
      )}

      {!editorOpen && (
        <button type="button" className="ideasMobileCreate audioImport spaceButton" disabled={importingAudio} aria-label={t('ideas.importAudio')} title={t('ideas.importAudio')} onClick={() => audioInputRef.current?.click()}>
          <Icon name={importingAudio ? 'cloud-upload' : 'upload-track-linear'} />
        </button>
      )}

      {selected?.image && (
        <IdeaImageViewer
          item={selected}
          busy={deleting}
          onClose={closeIdea}
          onSave={saveIdeaTitle}
          onDelete={(item) => {
            setSelected(item)
            setDeleteConfirmOpen(true)
          }}
          onError={onError}
          suspended={deleteConfirmOpen}
        />
      )}

      {(newTextOpen || selected?.kind === 'text') && (
        <IdeaTextEditor
          item={selected?.kind === 'text' ? selected : null}
          onClose={closeIdea}
          onSave={saveTextIdea}
          onDelete={(item) => {
            setSelected(item)
            setNewTextOpen(false)
            setDeleteConfirmOpen(true)
          }}
          onAttach={attachIdea}
          onError={onError}
          suspended={deleteConfirmOpen}
        />
      )}

      {(newAudioOpen || selected?.kind === 'audio') && (
        <IdeaAudioEditor
          item={selected?.kind === 'audio' ? selected : null}
          onClose={closeIdea}
          onCreate={createAudioIdea}
          onSave={saveIdeaTitle}
          onDelete={(item) => {
            setSelected(item)
            setNewAudioOpen(false)
            setDeleteConfirmOpen(true)
          }}
          onAttach={attachIdea}
          onError={onError}
          suspended={deleteConfirmOpen}
        />
      )}

      {deleteConfirmOpen && selected && (
        <ResponsiveConfirmationDialog
          title={t(selected.kind === 'text' ? 'ideas.deleteTextTitle' : selected.kind === 'audio' ? 'ideas.deleteAudioTitle' : 'ideas.deleteImageTitle')}
          description={selected.kind === 'text'
            ? <p>{t('ideas.deleteTextLead')}</p>
            : selected.kind === 'audio'
              ? <p>{t('ideas.deleteAudioLead')}</p>
              : <><p>{t('ideas.deleteImageLead')}</p><p>{t('ideas.deleteImageExplanation')}</p></>}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('ideas.delete')}
          busyLabel={t('ideas.deleting')}
          closeLabel={t('common.close')}
          busy={deleting}
          onClose={() => setDeleteConfirmOpen(false)}
          onConfirm={deleteIdea}
          onConfirmed={closeIdea}
        />
      )}
    </main>
  )
}

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))
}

type IdeaImageViewerProps = {
  item: IdeaItem
  busy: boolean
  onClose: () => void
  onSave: (title: string, item: IdeaItem, expectedGeneration?: number) => Promise<IdeaItem>
  onDelete: (item: IdeaItem) => void
  onError: (message: string) => void
  suspended?: boolean
}

function IdeaImageViewer({ item, busy, onClose, onSave, onDelete, onError, suspended = false }: IdeaImageViewerProps) {
  const { t } = useTranslation()
  const backRef = useRef<HTMLButtonElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const [title, setTitle] = useState(item.title)
  const [savedTitle, setSavedTitle] = useState(item.title)
  const [currentItem, setCurrentItem] = useState(item)
  const [editingTitle, setEditingTitle] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [conflictGeneration, setConflictGeneration] = useState<number | null>(null)
  const titleRef = useRef(title)
  const savedTitleRef = useRef(savedTitle)
  const currentItemRef = useRef(currentItem)
  const saveTimerRef = useRef<number | null>(null)
  const savePromiseRef = useRef<Promise<IdeaItem> | null>(null)
  const { backdropStateClass, close, closing, setDialogRef } = useMobileDialogTransition({
    onClose,
    initialFocusRef: backRef,
    focusOnDesktop: false,
  })

  useEffect(() => {
    titleRef.current = title
    savedTitleRef.current = savedTitle
    currentItemRef.current = currentItem
  }, [currentItem, savedTitle, title])

  const saveTitle = useCallback(async (expectedGeneration?: number) => {
    if (savePromiseRef.current) return savePromiseRef.current
    const nextTitle = titleRef.current.trim()
    if (nextTitle === savedTitleRef.current) return currentItemRef.current
    setSaving(true)
    setSaveFailed(false)
    setConflictGeneration(null)
    const pending = onSave(nextTitle, currentItemRef.current, expectedGeneration)
    savePromiseRef.current = pending
    try {
      const saved = await pending
      currentItemRef.current = saved
      savedTitleRef.current = saved.title
      setCurrentItem(saved)
      setSavedTitle(saved.title)
      return saved
    } catch (error) {
      if (error instanceof ApiError && error.code === 'idea_update_conflict' && typeof error.details.saveGeneration === 'number') {
        setConflictGeneration(error.details.saveGeneration)
      }
      setSaveFailed(true)
      onError(error instanceof Error ? error.message : t('ideas.imageSaveFailed'))
      throw error
    } finally {
      if (savePromiseRef.current === pending) savePromiseRef.current = null
      setSaving(false)
    }
  }, [onError, onSave, t])

  useEffect(() => {
    if (title.trim() === savedTitle || saveFailed) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void saveTitle(conflictGeneration ?? undefined).catch(() => undefined)
    }, 800)
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [conflictGeneration, saveFailed, saveTitle, savedTitle, title])

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select()
  }, [editingTitle])

  const blocked = busy || saving || closing || suspended
  const dirty = title.trim() !== savedTitle
  const saveStatus = saveFailed ? 'error' : saving ? 'saving' : dirty ? 'dirty' : 'saved'
  const displayedTitle = title.trim() || t('ideas.imageViewer')

  async function flushTitle(expectedGeneration?: number) {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    return saveTitle(expectedGeneration)
  }

  async function requestClose() {
    if (blocked) return
    try {
      await flushTitle(conflictGeneration ?? undefined)
      close()
    } catch {
      // The localized save error is already visible and the viewer remains open.
    }
  }

  async function requestDelete() {
    if (blocked) return
    try {
      const saved = await flushTitle(conflictGeneration ?? undefined)
      onDelete(saved)
    } catch {
      // Deletion must not discard a pending title change.
    }
  }

  useEffect(() => {
    const previousFocus = previousFocusRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      previousFocus?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !blocked) void requestClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  return createPortal(
    <div
      className={`standardDialogBackdrop ideasViewerBackdrop mobileFullViewBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !blocked) void requestClose()
      }}
    >
      <section
        className="standardActionDialog ideasViewer mobileFullView"
        role="dialog"
        aria-modal="true"
        aria-label={t('ideas.imageViewer')}
        ref={setDialogRef}
      >
        <header>
          <button ref={backRef} type="button" className="standardDialogMobileBack mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={blocked} onClick={() => void requestClose()}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="ideasImageTitleLine">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className="ideasImageTitleInput"
                value={title}
                maxLength={240}
                placeholder={t('ideas.imageTitlePlaceholder')}
                aria-label={t('ideas.imageTitle')}
                onChange={(event) => { setSaveFailed(false); setTitle(event.currentTarget.value) }}
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'Escape') {
                    if (event.key === 'Escape') event.stopPropagation()
                    event.currentTarget.blur()
                  }
                }}
              />
            ) : (
              <button type="button" className="ideasImageTitleButton spaceButton" title={t('ideas.imageTitle')} onClick={() => setEditingTitle(true)}>{displayedTitle}</button>
            )}
          </div>
          <button type="button" className="standardDialogClose spaceButton" aria-label={t('common.close')} disabled={blocked} onClick={() => void requestClose()}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="standardDialogContent ideasViewerContent">
          <div className="ideasViewerImage">
            {currentItem.image && <PrivateImage src={`${API_BASE}${currentItem.image.displayUrl}`} alt="" />}
          </div>
          <footer className="ideasViewerActions standardDialogFooter mobileFullViewFooter">
            <BoardsSaveStatusIndicator status={saveStatus} className="ideasImageSaveStatus" retryLabel={t('ideas.retrySave')} onRetry={saveStatus === 'error' ? () => void flushTitle(conflictGeneration ?? undefined).catch(() => undefined) : undefined} />
            <button type="button" className="dialogSubmit danger spaceButton" disabled={blocked} onClick={() => void requestDelete()}><Icon name="trash-bin-trash-light" /><span>{t('ideas.delete')}</span></button>
          </footer>
        </div>
      </section>
    </div>,
    document.body,
  )
}
