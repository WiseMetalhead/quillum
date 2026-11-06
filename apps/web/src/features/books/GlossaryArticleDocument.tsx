import { forwardRef, type ChangeEvent, type FormEvent, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { TableKit } from '@tiptap/extension-table'
import { TextAlign } from '@tiptap/extension-text-align'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest, apiUpload } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { StorageItem } from '../../types'
import { StorageImagePickerDialog } from '../shared/StorageImagePickerDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import {
  GLOSSARY_CALLOUT_KINDS,
  GlossaryCallout,
  GlossaryIllustrationGallery,
  GlossaryIllustration,
  GlossaryLink,
  GlossaryTableCell,
  GlossaryTableHeader,
  type GlossaryCalloutKind,
} from './GlossaryExtensions'
import {
  GLOSSARY_SCHEMA_VERSION,
  GlossaryGalleryInteractions,
  normalizeGlossaryGalleries,
} from './GlossaryGallery'
import { GlossaryImageLightbox, type GlossaryLightboxImage } from './GlossaryImageLightbox'
import { ImageUploadPlaceholder, removeImageUploadPlaceholder, replaceImageUploadPlaceholder, showImageUploadPlaceholder } from './ImageUploadPlaceholder'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { GlossaryArticle, GlossaryArticleSummary, GlossaryAsset } from './GlossaryTypes'
import {
  createOfflineGlossaryArticle,
  deleteOfflineGlossaryArticle,
  getOfflineGlossaryArticle,
  putOfflineGlossaryArticle,
} from './OfflineGlossaryArticles'

type Draft = {
  title: string
  synopsis: string
  content: JSONContent
  localRevision: number
}

type Props = {
  userId: number
  manuscriptId: string
  article: GlossaryArticle
  articleOptions: GlossaryArticleSummary[]
  editable: boolean
  onChange: (article: GlossaryArticle) => void
  onOpenArticle: (articleId: string) => void
  onOpenTableOfContents?: () => void
  onToggleMode?: () => void
  onOpenDetails?: () => void
  detailsOpen?: boolean
  onError: (error: string) => void
  saveStatusHost?: HTMLElement | null
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict' | 'local-error'
type MobileToolbarLevel = 'main' | 'format'

const mobileArticleQuery = '(max-width: 520px)'

function subscribeToMobileArticle(callback: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(mobileArticleQuery)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

function getMobileArticleSnapshot() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(mobileArticleQuery).matches
    : false
}

const CALLOUT_ICONS: Record<GlossaryCalloutKind, IconName> = {
  info: 'information-circle-light',
  attention: 'siren-rounded-light',
  warning: 'danger-light',
  check: 'check-circle-1-light',
}

export type GlossaryArticleDocumentHandle = {
  updateMetadata: (title: string, synopsis: string) => void
  flush: () => Promise<boolean>
}

function extensions(
  manuscriptId: string,
  onOpenLightbox: (image: GlossaryLightboxImage) => void,
) {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        protocols: ['http', 'https', 'mailto'],
      },
      trailingNode: false,
    }),
    TextAlign.configure({
      types: ['paragraph', 'heading'],
      alignments: ['left', 'center', 'right'],
      defaultAlignment: 'left',
    }),
    TableKit.configure({
      table: { resizable: false },
      tableCell: false,
      tableHeader: false,
    }),
    GlossaryTableCell,
    GlossaryTableHeader,
    GlossaryCallout,
    GlossaryLink,
    GlossaryIllustrationGallery,
    GlossaryIllustration.configure({ manuscriptId, onOpenLightbox }),
    GlossaryGalleryInteractions,
    ImageUploadPlaceholder,
  ]
}

function scheduleCompactTableLayout(editor: Editor) {
  window.requestAnimationFrame(() => {
    if (editor.isDestroyed) return
    editor.view.dom.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
      const firstRow = table.rows.item(0)
      const columnCount = firstRow?.cells.length ?? 0
      const hasContent = Array.from(table.querySelectorAll('th, td'))
        .some((cell) => Boolean(cell.textContent?.trim()))
      table.classList.toggle('glossaryCompactTable', columnCount > 0 && columnCount <= 3 && !hasContent)
    })
  })
}

export const GlossaryArticleDocument = forwardRef<GlossaryArticleDocumentHandle, Props>(function GlossaryArticleDocument({
  userId,
  manuscriptId,
  article,
  articleOptions,
  editable,
  onChange,
  onOpenArticle,
  onOpenTableOfContents,
  onToggleMode,
  onOpenDetails,
  detailsOpen,
  onError,
  saveStatusHost,
}, ref) {
  const { t } = useTranslation()
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [linkDialog, setLinkDialog] = useState<'external' | 'internal' | null>(null)
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [imageUploading, setImageUploading] = useState(false)
  const [lightboxImage, setLightboxImage] = useState<GlossaryLightboxImage | null>(null)
  const [linkValue, setLinkValue] = useState('')
  const [linkSearch, setLinkSearch] = useState('')
  const [offlineConflict, setOfflineConflict] = useState<Draft | null>(null)
  const [formatMenuOpen, setFormatMenuOpen] = useState(false)
  const [savePopoverOpen, setSavePopoverOpen] = useState(false)
  const [mobileToolbarLevel, setMobileToolbarLevel] = useState<MobileToolbarLevel>('main')
  const [mobileFormatSheetOpen, setMobileFormatSheetOpen] = useState(false)
  const [, setToolbarRevision] = useState(0)
  const isMobile = useSyncExternalStore(
    subscribeToMobileArticle,
    getMobileArticleSnapshot,
    () => false,
  )
  const imageInputRef = useRef<HTMLInputElement>(null)
  const formatMenuRef = useRef<HTMLDivElement>(null)
  const saveStatusRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  const titleRef = useRef(article.title)
  const synopsisRef = useRef(article.synopsis)
  const generationRef = useRef(article.saveGeneration)
  const serverArticleRef = useRef(article)
  const localRevisionRef = useRef(0)
  const pendingRef = useRef<Draft | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const localTimerRef = useRef<number | null>(null)
  const recoveryAttemptedRef = useRef(false)
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  const savingPromiseRef = useRef<Promise<boolean> | null>(null)
  const queueDraftRef = useRef<(title: string, synopsis: string, content?: JSONContent) => void>(
    () => {},
  )
  const openLightbox = useCallback((image: GlossaryLightboxImage) => {
    setLightboxImage(image)
  }, [])
  const closeLightbox = useCallback(() => setLightboxImage(null), [])
  const extensionSet = useMemo(
    () => extensions(manuscriptId, openLightbox),
    [manuscriptId, openLightbox],
  )
  const normalizedArticleContent = useMemo(
    () => normalizeGlossaryGalleries(article.content),
    [article.content],
  )

  const editor = useEditor({
    injectCSS: false,
    extensions: extensionSet,
    content: normalizedArticleContent,
    editable,
    editorProps: {
      attributes: {
        class: 'glossaryTiptap',
        'aria-label': editable ? t('glossary.articleContent') : t('glossary.articleReader'),
      },
    },
    onCreate: ({ editor: currentEditor }) => scheduleCompactTableLayout(currentEditor),
    onUpdate: ({ editor: currentEditor, transaction, appendedTransactions }) => {
      scheduleCompactTableLayout(currentEditor)
      if (!editable || (!transaction.docChanged && !appendedTransactions.some((candidate) => candidate.docChanged))) return
      setToolbarRevision((value) => value + 1)
      queueDraftRef.current(titleRef.current, synopsisRef.current, currentEditor.getJSON())
    },
    onSelectionUpdate: () => setToolbarRevision((value) => value + 1),
  }, [article.id, editable, extensionSet])

  const persistDraft = useCallback(async (draft: Draft) => {
    try {
      await putOfflineGlossaryArticle(createOfflineGlossaryArticle(
        userId,
        manuscriptId,
        article.id,
        GLOSSARY_SCHEMA_VERSION,
        draft.title,
        draft.synopsis,
        draft.content,
        draft.localRevision,
        generationRef.current,
      ))
    } catch {
      setSaveState('local-error')
      onError('offline_storage_failed')
    }
  }, [article.id, manuscriptId, onError, userId])

  const queueDraft = useCallback((nextTitle: string, nextSynopsis: string, content?: JSONContent) => {
    if (!editable) return
    localRevisionRef.current += 1
    const draft = {
      title: nextTitle,
      synopsis: nextSynopsis,
      content: content ?? editor?.getJSON() ?? normalizedArticleContent,
      localRevision: localRevisionRef.current,
    }
    pendingRef.current = draft
    setSaveState(navigator.onLine ? 'dirty' : 'offline')
    if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current)
    localTimerRef.current = window.setTimeout(() => void persistDraft(draft), 120)
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => void flushRef.current(), 1000)
  }, [editable, editor, normalizedArticleContent, persistDraft])

  useEffect(() => {
    queueDraftRef.current = queueDraft
  }, [queueDraft])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useImperativeHandle(ref, () => ({
    updateMetadata(nextTitle, nextSynopsis) {
      titleRef.current = nextTitle
      synopsisRef.current = nextSynopsis
      queueDraftRef.current(nextTitle, nextSynopsis)
    },
    flush: () => flushRef.current(),
  }), [])

  useEffect(() => {
    if (!formatMenuOpen && !savePopoverOpen) return
    function closePopovers(event: MouseEvent) {
      if (!(event.target instanceof Node)) return
      if (formatMenuOpen && !formatMenuRef.current?.contains(event.target)) setFormatMenuOpen(false)
      if (savePopoverOpen && !saveStatusRef.current?.contains(event.target)) setSavePopoverOpen(false)
    }
    document.addEventListener('mousedown', closePopovers)
    return () => document.removeEventListener('mousedown', closePopovers)
  }, [formatMenuOpen, savePopoverOpen])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(editable, false)
  }, [editable, editor])

  useEffect(() => {
    if (!editor || !editable || recoveryAttemptedRef.current) return
    recoveryAttemptedRef.current = true
    let active = true
    void getOfflineGlossaryArticle(userId, manuscriptId, article.id)
      .then((stored) => {
        if (!active || !stored || ![1, GLOSSARY_SCHEMA_VERSION].includes(stored.schemaVersion)) return
        const draft: Draft = {
          title: stored.title,
          synopsis: stored.synopsis,
          content: normalizeGlossaryGalleries(stored.content),
          localRevision: stored.localRevision,
        }
        localRevisionRef.current = stored.localRevision
        if (stored.confirmedGeneration !== generationRef.current) {
          setOfflineConflict(draft)
          setSaveState('conflict')
          return
        }
        titleRef.current = draft.title
        synopsisRef.current = draft.synopsis
        editor.commands.setContent(draft.content)
        onChangeRef.current({
          ...serverArticleRef.current,
          title: draft.title,
          synopsis: draft.synopsis,
          content: draft.content,
        })
        pendingRef.current = draft
        setSaveState(navigator.onLine ? 'dirty' : 'offline')
        if (navigator.onLine) window.setTimeout(() => void flushRef.current(), 0)
      })
      .catch(() => {
        if (active) {
          setSaveState('local-error')
          onError('offline_storage_failed')
        }
      })
    return () => {
      active = false
    }
  }, [article.id, editable, editor, manuscriptId, onError, userId])

  const flush = useCallback(async () => {
    if (!editable) return true
    if (offlineConflict) return false
    if (savingPromiseRef.current) {
      const saved = await savingPromiseRef.current
      if (!saved) return false
      return pendingRef.current ? flushRef.current() : true
    }
    const draft = pendingRef.current
    if (!draft) return true
    if (!navigator.onLine) {
      setSaveState('offline')
      await persistDraft(draft)
      return false
    }
    const savingPromise = (async () => {
      setSaveState('saving')
      try {
        const contentPayload = await apiRequest<{ article: GlossaryArticle }>(
          `/api/manuscripts/${manuscriptId}/glossary/articles/${article.id}/content/`,
          {
            method: 'PUT',
            body: JSON.stringify({
              content: draft.content,
              schemaVersion: GLOSSARY_SCHEMA_VERSION,
              expectedGeneration: generationRef.current,
            }),
          },
        )
        generationRef.current = contentPayload.article.saveGeneration
        const metadataPayload = await apiRequest<{ article: GlossaryArticle }>(
          `/api/manuscripts/${manuscriptId}/glossary/articles/${article.id}/`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title: draft.title, synopsis: draft.synopsis }),
          },
        )
        if (pendingRef.current?.localRevision === draft.localRevision) {
          pendingRef.current = null
          await deleteOfflineGlossaryArticle(userId, manuscriptId, article.id)
          setSaveState('saved')
        } else {
          setSaveState('dirty')
        }
        const savedArticle = {
          ...metadataPayload.article,
          ...contentPayload.article,
          title: draft.title,
          synopsis: draft.synopsis,
        }
        serverArticleRef.current = savedArticle
        onChange(savedArticle)
        return true
      } catch (error) {
        await persistDraft(draft)
        if (error instanceof ApiError && error.code === 'glossary_save_conflict') {
          setOfflineConflict(draft)
          setSaveState('conflict')
        } else {
          setSaveState(navigator.onLine ? 'dirty' : 'offline')
          onError(error instanceof Error ? error.message : 'request_failed')
        }
        return false
      }
    })()
    savingPromiseRef.current = savingPromise
    const saved = await savingPromise
    savingPromiseRef.current = null
    if (saved && pendingRef.current) return flushRef.current()
    return saved
  }, [article.id, editable, manuscriptId, offlineConflict, onChange, onError, persistDraft, userId])

  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  useEffect(() => {
    function online() {
      if (pendingRef.current && !offlineConflict) {
        setSaveState('dirty')
        void flushRef.current()
      }
    }
    function offline() {
      if (pendingRef.current) setSaveState('offline')
    }
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [offlineConflict])

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current)
    const draft = pendingRef.current
    if (draft) {
      void persistDraft(draft)
      if (navigator.onLine) void flushRef.current()
    }
  }, [persistDraft])

  async function uploadImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !editor || !navigator.onLine || imageUploading) return
    const form = new FormData()
    form.append('image', file)
    form.append('alt', '')
    form.append('caption', '')
    const placeholderId = showImageUploadPlaceholder(editor, t('uploads.processingImage'))
    setImageUploading(true)
    try {
      const payload = await apiUpload<{ asset: GlossaryAsset }>(
        `/api/manuscripts/${manuscriptId}/glossary/articles/${article.id}/assets/`,
        form,
      )
      replaceImageUploadPlaceholder(editor, placeholderId, {
        type: 'illustration',
        attrs: {
          assetId: payload.asset.id,
          alt: payload.asset.alt,
          caption: payload.asset.caption,
          alignment: 'center',
          displayWidth: 100,
        },
      })
    } catch (error) {
      if (!editor.isDestroyed) removeImageUploadPlaceholder(editor, placeholderId)
      onError(error instanceof Error ? error.message : t('glossary.uploadFailed'))
    } finally {
      setImageUploading(false)
    }
  }

  async function selectStoredImage(item: StorageItem) {
    if (!editor || !navigator.onLine || imageUploading) return
    const form = new FormData()
    form.append('mediaId', item.id.replace(/^media:/, ''))
    form.append('alt', '')
    form.append('caption', '')
    const placeholderId = showImageUploadPlaceholder(editor, t('uploads.processingImage'))
    setImageUploading(true)
    try {
      const payload = await apiUpload<{ asset: GlossaryAsset }>(`/api/manuscripts/${manuscriptId}/glossary/articles/${article.id}/assets/`, form)
      replaceImageUploadPlaceholder(editor, placeholderId, { type: 'illustration', attrs: { assetId: payload.asset.id, alt: payload.asset.alt, caption: payload.asset.caption, alignment: 'center', displayWidth: 100 } })
      setImagePickerOpen(false)
    } catch (error) {
      if (!editor.isDestroyed) removeImageUploadPlaceholder(editor, placeholderId)
      onError(error instanceof Error ? error.message : t('glossary.uploadFailed'))
    } finally {
      setImageUploading(false)
    }
  }

  function applyLink(event: FormEvent) {
    event.preventDefault()
    if (!editor || !linkValue) return
    if (linkDialog === 'external') {
      editor.chain().focus().setLink({ href: linkValue }).run()
    } else {
      editor.chain().focus().setMark('glossaryLink', { articleId: linkValue }).run()
    }
    setLinkDialog(null)
    setLinkValue('')
    setLinkSearch('')
  }

  function updateIllustration(attributes: Partial<{ alt: string; caption: string; alignment: 'left' | 'center' | 'right'; displayWidth: number }>) {
    editor?.commands.updateAttributes('illustration', attributes)
  }

  async function saveIllustrationMetadata() {
    const attributes = editor?.getAttributes('illustration') as { assetId?: string; alt?: string; caption?: string } | undefined
    if (!attributes?.assetId || !navigator.onLine) return
    try {
      await apiRequest(`/api/manuscripts/${manuscriptId}/glossary/assets/${attributes.assetId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ alt: attributes.alt ?? '', caption: attributes.caption ?? '' }),
      })
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.saveIllustrationFailed'))
    }
  }

  function useServerVersion() {
    const serverArticle = serverArticleRef.current
    pendingRef.current = null
    setOfflineConflict(null)
    titleRef.current = serverArticle.title
    synopsisRef.current = serverArticle.synopsis
    editor?.commands.setContent(normalizeGlossaryGalleries(serverArticle.content))
    onChangeRef.current(serverArticle)
    void deleteOfflineGlossaryArticle(userId, manuscriptId, article.id)
    setSaveState('saved')
  }

  function useLocalVersion() {
    if (!offlineConflict) return
    generationRef.current = article.saveGeneration
    titleRef.current = offlineConflict.title
    synopsisRef.current = offlineConflict.synopsis
    editor?.commands.setContent(normalizeGlossaryGalleries(offlineConflict.content))
    onChangeRef.current({
      ...article,
      title: offlineConflict.title,
      synopsis: offlineConflict.synopsis,
      content: offlineConflict.content,
    })
    pendingRef.current = offlineConflict
    setOfflineConflict(null)
    setSaveState(navigator.onLine ? 'dirty' : 'offline')
    window.setTimeout(() => void flushRef.current(), 0)
  }

  if (!editor) return <TadpoleLoadingState className="glossaryDocumentState" label={t('glossary.loadingEditor')} />
  const activeHeading = [1, 2, 3, 4, 5].find((level) => editor.isActive('heading', { level }))
  const activeBlockLabel = activeHeading ? t('documentEditor.heading', { level: activeHeading }) : t('glossary.paragraph')
  const activeTable = editor.isActive('table')
  const activeIllustration = editor.isActive('illustration')
    ? (() => {
        const attributes = editor.getAttributes('illustration') as { assetId: string; alt: string; caption: string; alignment: 'left' | 'center' | 'right'; displayWidth?: number }
        return { ...attributes, displayWidth: attributes.displayWidth ?? 100 }
      })()
    : null
  const rawCalloutKind = editor.isActive('callout')
    ? editor.getAttributes('callout').kind as string
    : null
  const activeCalloutKind: GlossaryCalloutKind | null = rawCalloutKind === 'note'
    ? 'attention'
    : rawCalloutKind === 'tip'
      ? 'check'
      : GLOSSARY_CALLOUT_KINDS.includes(rawCalloutKind as GlossaryCalloutKind)
        ? rawCalloutKind as GlossaryCalloutKind
        : null
  const normalizedLinkSearch = linkSearch.trim().toLocaleLowerCase()
  const matchingArticles = articleOptions
    .filter((item) => item.id !== article.id && item.title.toLocaleLowerCase().includes(normalizedLinkSearch))
    .slice(0, 8)
  const saveIcon: IconName = saveState === 'saved'
    ? 'cloud-yes'
    : saveState === 'offline' || saveState === 'local-error' || saveState === 'conflict'
      ? 'cloud-no'
      : 'cloud-upload'
  function toggleSavePopover() {
    setSavePopoverOpen((open) => !open)
  }
  const savePopoverNode = savePopoverOpen && (
    <div className="glossarySavePopover" role="status">
      <Icon name={saveIcon} />
      <div>
        <strong>{t(`glossary.saveState.${saveState}`)}</strong>
        <span>{t(`glossary.saveStateDetails.${saveState}`)}</span>
      </div>
    </div>
  )
  const saveStatusNode = (
    <div className="glossarySaveStatus" ref={saveStatusRef}>
      <button type="button" className={`glossarySaveStatusButton spaceButton ${saveState}`} aria-label={t(`glossary.saveState.${saveState}`)} aria-haspopup="dialog" aria-expanded={savePopoverOpen} title={t(`glossary.saveState.${saveState}`)} onClick={toggleSavePopover}>
        <Icon name={saveIcon} />
      </button>
      {savePopoverNode}
    </div>
  )
  const contextKey = editable && linkDialog
    ? `link-${linkDialog}`
    : editable && activeCalloutKind
      ? 'callout'
      : editable && activeIllustration
        ? 'illustration'
        : editable && activeTable
          ? 'table'
          : null

  return (
    <div
      className={`glossaryDocument ${editable ? 'editable' : 'readonly'}`}
      onClick={(event) => {
        if (editable) return
        const link = (event.target as HTMLElement).closest<HTMLElement>('[data-glossary-article-id]')
        if (!link) return
        event.preventDefault()
        onOpenArticle(link.dataset.glossaryArticleId ?? '')
      }}
    >
      {editable && saveStatusHost && !isMobile && createPortal(saveStatusNode, saveStatusHost)}
      {editable && (
        <div className="glossaryToolbar" aria-label={t('glossary.formattingToolbar')}>
          <div className="glossaryFormatSelector" ref={formatMenuRef}>
            <button type="button" className="glossaryFormatSelectorButton spaceButton" aria-haspopup="menu" aria-expanded={formatMenuOpen} onClick={() => setFormatMenuOpen((open) => !open)}>
              {activeBlockLabel}<Icon name={formatMenuOpen ? 'arrow-up-2' : 'arrow-down-2'} />
            </button>
            {formatMenuOpen && (
              <div className="glossaryFormatDropdown" role="menu">
                <button type="button" className={`spaceButton ${editor.isActive('paragraph') ? 'active' : ''}`} role="menuitem" onClick={() => { editor.chain().focus().setParagraph().run(); setFormatMenuOpen(false) }}>{t('glossary.paragraph')}</button>
                {[1, 2, 3, 4, 5].map((level) => (
                  <button key={level} type="button" className={`spaceButton headingOption heading${level} ${editor.isActive('heading', { level }) ? 'active' : ''}`} role="menuitem" onClick={() => { editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 }).run(); setFormatMenuOpen(false) }}>{t('documentEditor.heading', { level })}</button>
                ))}
              </div>
            )}
          </div>
          <span className="glossaryToolbarDivider" />
            <button type="button" className={`spaceButton ${editor.isActive('bold') ? 'active' : ''}`} aria-label={t('glossary.bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Icon name="text-bold-light" /></button>
            <button type="button" className={`spaceButton ${editor.isActive('italic') ? 'active' : ''}`} aria-label={t('glossary.italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Icon name="text-italic-light" /></button>
            <button type="button" className={`spaceButton ${editor.isActive('strike') ? 'active' : ''}`} aria-label={t('glossary.strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Icon name="text-cross-light" /></button>
            <button type="button" className={`spaceButton ${editor.isActive('underline') ? 'active' : ''}`} aria-label={t('glossary.underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><Icon name="text-underline-light" /></button>
          <span className="glossaryToolbarDivider" />
            <button type="button" className={`spaceButton ${editor.isActive({ textAlign: 'left' }) ? 'active' : ''}`} aria-label={t('glossary.alignLeft')} onClick={() => editor.chain().focus().setTextAlign('left').run()}><Icon name="mingcute-align-left-line" /></button>
            <button type="button" className={`spaceButton ${editor.isActive({ textAlign: 'center' }) ? 'active' : ''}`} aria-label={t('glossary.alignCenter')} onClick={() => editor.chain().focus().setTextAlign('center').run()}><Icon name="mingcute-align-center-line" /></button>
            <button type="button" className={`spaceButton ${editor.isActive({ textAlign: 'right' }) ? 'active' : ''}`} aria-label={t('glossary.alignRight')} onClick={() => editor.chain().focus().setTextAlign('right').run()}><Icon name="mingcute-align-right-line" /></button>
          <span className="glossaryToolbarDivider" />
            <button type="button" className={`spaceButton ${editor.isActive('bulletList') ? 'active' : ''}`} aria-label={t('glossary.bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><Icon name="mingcute-list-check-line" className="mingcuteToolbarIcon" /></button>
            <button type="button" className={`spaceButton ${editor.isActive('orderedList') ? 'active' : ''}`} aria-label={t('glossary.orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><Icon name="mingcute-list-ordered-line" className="mingcuteToolbarIcon" /></button>
            <button type="button" className={`spaceButton ${editor.isActive('blockquote') ? 'active' : ''}`} aria-label={t('glossary.blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Icon name="mingcute-blockquote-line" className="mingcuteToolbarIcon" /></button>
            <button type="button" className={`spaceButton ${editor.isActive('callout') ? 'active' : ''}`} aria-label={t('glossary.callout')} onClick={() => editor.chain().focus().toggleWrap('callout').run()}><Icon name="information-circle-light" /></button>
            <button type="button" className="spaceButton" aria-label={t('glossary.horizontalRule')} onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</button>
          <span className="glossaryToolbarDivider" />
            <button type="button" className="spaceButton" aria-label={t('glossary.externalLink')} onClick={() => { setLinkDialog('external'); setLinkValue(''); setLinkSearch('') }}><Icon name="link-minimalistic-light" /></button>
            <button type="button" className="spaceButton" aria-label={t('glossary.internalLink')} onClick={() => { setLinkDialog('internal'); setLinkValue(''); setLinkSearch('') }}><Icon name="notebook-bookmark-light" /></button>
            <button type="button" className="spaceButton" disabled={activeTable} aria-label={t('glossary.insertTable')} title={activeTable ? t('glossary.insertTableUnavailable') : undefined} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Icon name="mingcute-table-line" className="mingcuteToolbarIcon" /></button>
            <button type="button" className="spaceButton" disabled={!navigator.onLine || imageUploading} aria-label={t('glossary.insertImage')} onClick={() => setImagePickerOpen(true)}><Icon name="gallery-light" /></button>
          <span className="glossaryToolbarDivider" />
            <button type="button" className="spaceButton" disabled={!editor.can().chain().focus().undo().run()} aria-label={t('glossary.undo')} onClick={() => editor.chain().focus().undo().run()}><Icon name="mingcute-back-2-line" /></button>
            <button type="button" className="spaceButton" disabled={!editor.can().chain().focus().redo().run()} aria-label={t('glossary.redo')} onClick={() => editor.chain().focus().redo().run()}><Icon name="mingcute-forward-2-line" /></button>
          <span className="glossaryToolbarSpacer" />
          {!saveStatusHost && saveStatusNode}
            <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/webp" disabled={imageUploading} hidden onChange={(event) => void uploadImage(event)} />
            <StorageImagePickerDialog open={imagePickerOpen} onClose={() => setImagePickerOpen(false)} onSelect={(item) => void selectStoredImage(item)} onUpload={() => { setImagePickerOpen(false); imageInputRef.current?.click() }} />
        </div>
      )}

      <div className={`glossaryMobileContextTray ${contextKey ? 'open' : ''}`} aria-hidden={!contextKey}>
      {editable && linkDialog ? (
        <form className="glossaryContextToolbar glossaryLinkToolbar" onSubmit={applyLink}>
          {linkDialog === 'external' ? (
            <input autoFocus type="url" value={linkValue} placeholder="https://" aria-label={t('glossary.externalLink')} onChange={(event) => setLinkValue(event.target.value)} />
          ) : (
            <div className="glossaryArticleSearch">
              <input autoFocus type="search" value={linkSearch} placeholder={t('glossary.searchArticle')} aria-label={t('glossary.internalLink')} onChange={(event) => { setLinkSearch(event.target.value); setLinkValue('') }} />
              {normalizedLinkSearch && !linkValue && (
                <div className="glossaryArticleSearchResults" role="listbox" aria-label={t('glossary.articleSearchResults')}>
                  {matchingArticles.length ? matchingArticles.map((item) => (
                    <button key={item.id} type="button" role="option" aria-selected={false} className="spaceButton" onClick={() => { setLinkValue(item.id); setLinkSearch(item.title) }}>{item.title}</button>
                  )) : <span>{t('glossary.noArticlesFound')}</span>}
                </div>
              )}
            </div>
          )}
          <button type="submit" className="spaceButton" disabled={!linkValue}>{t('common.confirm')}</button>
          <button type="button" className="spaceButton" onClick={() => { setLinkDialog(null); setLinkValue(''); setLinkSearch('') }}>{t('common.cancel')}</button>
        </form>
      ) : editable && activeCalloutKind ? (
        <div className="glossaryContextToolbar glossaryCalloutToolbar" aria-label={t('glossary.calloutTools')}>
          <div className="glossaryContextButtons glossaryCalloutOptions">
            {GLOSSARY_CALLOUT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`spaceButton glossaryCalloutOption ${kind} ${activeCalloutKind === kind ? 'active' : ''}`}
                aria-label={t(`glossary.callout${kind[0].toUpperCase()}${kind.slice(1)}`)}
                onClick={() => editor.chain().focus().updateAttributes('callout', { kind }).run()}
              >
                <Icon name={CALLOUT_ICONS[kind]} />
                <span>{t(`glossary.callout${kind[0].toUpperCase()}${kind.slice(1)}`)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : editable && activeIllustration ? (
        <div className="glossaryContextToolbar glossaryIllustrationToolbar" aria-label={t('glossary.illustrationSettings')}>
          <label><span>{t('glossary.imageAltPrompt')}</span><input value={activeIllustration.alt} maxLength={500} onChange={(event) => updateIllustration({ alt: event.target.value })} onBlur={() => void saveIllustrationMetadata()} /></label>
          <label><span>{t('glossary.imageCaptionPrompt')}</span><input value={activeIllustration.caption} maxLength={2000} onChange={(event) => updateIllustration({ caption: event.target.value })} onBlur={() => void saveIllustrationMetadata()} /></label>
          <div className="glossaryContextButtons" aria-label={t('glossary.illustrationAlignment')}>
            {(['left', 'center', 'right'] as const).map((alignment) => <button key={alignment} type="button" className={`spaceButton ${activeIllustration.alignment === alignment ? 'active' : ''}`} aria-label={t(`glossary.imageAlign${alignment[0].toUpperCase()}${alignment.slice(1)}`)} onClick={() => updateIllustration({ alignment })}>{alignment === 'left' ? <Icon name="mingcute-align-left-line" /> : alignment === 'center' ? <Icon name="mingcute-align-center-line" /> : <Icon name="mingcute-align-right-line" />}</button>)}
          </div>
        </div>
      ) : editable && activeTable ? (
        <div className="glossaryContextToolbar glossaryTableToolbar" aria-label={t('glossary.tableTools')}>
          <div className="glossaryContextButtons">
            <button type="button" className="spaceButton" aria-label={t('glossary.addTableRow')} onClick={() => editor.chain().focus().addRowAfter().run()}>+↕</button>
            <button type="button" className="spaceButton" aria-label={t('glossary.deleteTableRow')} onClick={() => editor.chain().focus().deleteRow().run()}>−↕</button>
            <button type="button" className="spaceButton" aria-label={t('glossary.addTableColumn')} onClick={() => editor.chain().focus().addColumnAfter().run()}>+↔</button>
            <button type="button" className="spaceButton" aria-label={t('glossary.deleteTableColumn')} onClick={() => editor.chain().focus().deleteColumn().run()}>−↔</button>
            <button type="button" className="spaceButton" aria-label={t('glossary.deleteTable')} onClick={() => editor.chain().focus().deleteTable().run()}>×▦</button>
          </div>
        </div>
      ) : null}
      </div>

      {offlineConflict && (
        <div className="glossaryConflict" role="alert">
          <strong>{t('glossary.conflictTitle')}</strong>
          <p>{t('glossary.conflictLead')}</p>
          <button type="button" className="spaceButton" onClick={useServerVersion}>{t('glossary.useServerCopy')}</button>
          <button type="button" className="spaceButton" onClick={useLocalVersion}>{t('glossary.useLocalCopy')}</button>
        </div>
      )}

      <EditorContent className="glossaryEditorContent" editor={editor} />
      {isMobile && onOpenTableOfContents && onToggleMode && onOpenDetails && <>
      <div className={`glossaryArticleMobileToolbar level-${editable ? mobileToolbarLevel : 'main'}`} aria-label={t('glossary.formattingToolbar')}>
        <div className="glossaryArticleMobileToolbarLevel">
          <div className="glossaryArticleMobileToolbarLeading">
            {mobileToolbarLevel === 'main' ? (
              <>
                <button type="button" className="spaceButton" aria-label={t('glossary.tableOfContents')} onClick={onOpenTableOfContents}><Icon name="sort-by-alphabet-light" /></button>
                <button type="button" className={`spaceButton ${editable ? 'active' : ''}`} aria-label={t(editable ? 'glossary.view' : 'glossary.edit')} onClick={() => { if (editable) { setMobileToolbarLevel('main'); setMobileFormatSheetOpen(false); setLinkDialog(null) } onToggleMode() }}><Icon name={editable ? 'eye-light' : 'edit-light'} /></button>
                {editable && <button type="button" className="spaceButton" aria-label={t('glossary.formattingToolbar')} onClick={() => setMobileToolbarLevel('format')}><Icon name="mynaui-type-text" className="mynauiToolbarIcon" /></button>}
              </>
            ) : (
              <>
                <button type="button" className="spaceButton glossaryArticleMobileToolbarBack" aria-label={t('common.back')} onClick={() => setMobileToolbarLevel('main')}><Icon name="arrow-left-1" /></button>
                <span className="glossaryArticleMobileToolbarDivider" />
                <div className="glossaryArticleMobileFormatScroll">
                  <button type="button" className={`spaceButton glossaryArticleMobileBlockStyle ${mobileFormatSheetOpen ? 'active' : ''}`} aria-label={activeBlockLabel} onClick={() => setMobileFormatSheetOpen(true)}><Icon name={activeHeading ? `mynaui-heading-${activeHeading}` as IconName : 'mynaui-type-text'} className="mynauiToolbarIcon" /></button>
                  <span />
                  <button type="button" className={`spaceButton ${editor.isActive('bold') ? 'active' : ''}`} aria-label={t('glossary.bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Icon name="text-bold-light" /></button>
                  <button type="button" className={`spaceButton ${editor.isActive('italic') ? 'active' : ''}`} aria-label={t('glossary.italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Icon name="text-italic-light" /></button>
                  <button type="button" className={`spaceButton ${editor.isActive('strike') ? 'active' : ''}`} aria-label={t('glossary.strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Icon name="text-cross-light" /></button>
                  <button type="button" className={`spaceButton ${editor.isActive('underline') ? 'active' : ''}`} aria-label={t('glossary.underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><Icon name="text-underline-light" /></button>
                  <span />
                  <button type="button" className={`spaceButton ${editor.isActive({ textAlign: 'left' }) ? 'active' : ''}`} aria-label={t('glossary.alignLeft')} onClick={() => editor.chain().focus().setTextAlign('left').run()}><Icon name="mingcute-align-left-line" /></button>
                  <button type="button" className={`spaceButton ${editor.isActive({ textAlign: 'center' }) ? 'active' : ''}`} aria-label={t('glossary.alignCenter')} onClick={() => editor.chain().focus().setTextAlign('center').run()}><Icon name="mingcute-align-center-line" /></button>
                  <button type="button" className={`spaceButton ${editor.isActive({ textAlign: 'right' }) ? 'active' : ''}`} aria-label={t('glossary.alignRight')} onClick={() => editor.chain().focus().setTextAlign('right').run()}><Icon name="mingcute-align-right-line" /></button>
                  <span />
                  <button type="button" className={`spaceButton ${editor.isActive('bulletList') ? 'active' : ''}`} aria-label={t('glossary.bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><Icon name="mingcute-list-check-line" className="mingcuteToolbarIcon" /></button>
                  <button type="button" className={`spaceButton ${editor.isActive('orderedList') ? 'active' : ''}`} aria-label={t('glossary.orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><Icon name="mingcute-list-ordered-line" className="mingcuteToolbarIcon" /></button>
                  <button type="button" className={`spaceButton ${editor.isActive('blockquote') ? 'active' : ''}`} aria-label={t('glossary.blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Icon name="mingcute-blockquote-line" className="mingcuteToolbarIcon" /></button>
                  <button type="button" className={`spaceButton ${editor.isActive('callout') ? 'active' : ''}`} aria-label={t('glossary.callout')} onClick={() => editor.chain().focus().toggleWrap('callout').run()}><Icon name="information-circle-light" /></button>
                  <button type="button" className="spaceButton glossaryArticleMobileRule" aria-label={t('glossary.horizontalRule')} onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</button>
                  <span />
                  <button type="button" className="spaceButton" aria-label={t('glossary.externalLink')} onClick={() => { setLinkDialog('external'); setLinkValue(''); setLinkSearch('') }}><Icon name="link-minimalistic-light" /></button>
                  <button type="button" className="spaceButton" aria-label={t('glossary.internalLink')} onClick={() => { setLinkDialog('internal'); setLinkValue(''); setLinkSearch('') }}><Icon name="notebook-bookmark-light" /></button>
                  <button type="button" className="spaceButton" disabled={activeTable} aria-label={t('glossary.insertTable')} title={activeTable ? t('glossary.insertTableUnavailable') : undefined} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Icon name="mingcute-table-line" className="mingcuteToolbarIcon" /></button>
                  <button type="button" className="spaceButton" disabled={!navigator.onLine || imageUploading} aria-label={t('glossary.insertImage')} onClick={() => setImagePickerOpen(true)}><Icon name="gallery-light" /></button>
                  <span />
                  <button type="button" className="spaceButton" disabled={!editor.can().chain().focus().undo().run()} aria-label={t('glossary.undo')} onClick={() => editor.chain().focus().undo().run()}><Icon name="mingcute-back-2-line" /></button>
                  <button type="button" className="spaceButton" disabled={!editor.can().chain().focus().redo().run()} aria-label={t('glossary.redo')} onClick={() => editor.chain().focus().redo().run()}><Icon name="mingcute-forward-2-line" /></button>
                </div>
              </>
            )}
          </div>
          <div className="glossaryArticleMobileToolbarTrailing">
            {saveStatusNode}
            <span className="glossaryArticleMobileToolbarDivider" />
            <button type="button" className={`spaceButton ${detailsOpen ? 'active' : ''}`} aria-label={t('glossary.openArticleDetails')} aria-expanded={detailsOpen} onClick={onOpenDetails}><Icon name="sidebar-minimalistic-light" /></button>
          </div>
        </div>
      </div>
      <MobileLibraryActionSheet
        open={editable && mobileFormatSheetOpen}
        title={t('glossary.textStyle')}
        dismissOnSelect
        onClose={() => setMobileFormatSheetOpen(false)}
        actions={[
          { key: 'paragraph', label: t('glossary.paragraph'), icon: <Icon name="mynaui-type-text" className="mynauiToolbarIcon" />, onSelect: () => editor.chain().focus().setParagraph().run() },
          ...([1, 2, 3, 4, 5] as const).map((level) => ({ key: `heading-${level}`, label: t('documentEditor.heading', { level }), icon: <Icon name={`mynaui-heading-${level}` as IconName} className="mynauiToolbarIcon" />, onSelect: () => editor.chain().focus().toggleHeading({ level }).run() })),
        ]}
      />
      </>}
      {lightboxImage && (
        <GlossaryImageLightbox
          image={lightboxImage}
          manuscriptId={manuscriptId}
          onClose={closeLightbox}
        />
      )}
    </div>
  )
})
