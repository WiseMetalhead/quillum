import { type FormEvent, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { API_BASE, ApiError, apiDownload, apiRequest, apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { StorageItem } from '../../types'
import { ActionDialog } from '../shared/ActionDialog'
import { PrivateImage } from '../shared/PrivateImage'
import { StorageImagePickerDialog } from '../shared/StorageImagePickerDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { GlossaryArticleDocument, type GlossaryArticleDocumentHandle } from './GlossaryArticleDocument'
import {
  GlossaryArticleExportDialog,
  type GlossaryArticleExportFormat,
} from './GlossaryArticleExportDialog'
import { GlossaryArticleImportStep } from './GlossaryArticleImportStep'
import { GlossaryArticleSidebar } from './GlossaryArticleSidebar'
import { GlossaryCategoryIcon, glossaryGameIcons } from './GlossaryCategoryIcon'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type {
  GlossaryArticle,
  GlossaryArticleSummary,
  GlossaryCategory,
  GlossaryLayout,
  GlossaryScope,
  GlossarySort,
  GlossaryView,
} from './GlossaryTypes'
import type { Manuscript } from './ManuscriptTypes'
import './GlossaryPage.css'

type Props = {
  userId: number
  manuscript: Manuscript
  initialArticleId: string | null
  onError: (error: string) => void
}

type ArticlePage = {
  items: GlossaryArticleSummary[]
  total: number
  page: number
  pageSize: number
  initials: string[]
}

const ICON_PAGE_SIZE = 48
const ACCEPTED_GLOSSARY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MOBILE_ALPHABETS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
]

function groupAlphabetInitials(initials: string[]) {
  const ranges: string[][] = []
  let currentAlphabet = -1
  let rangeStart = -1
  for (const initial of initials) {
    const normalized = initial.toLocaleUpperCase()
    const alphabet = MOBILE_ALPHABETS.findIndex((candidate) => candidate.includes(normalized))
    const position = alphabet >= 0 ? MOBILE_ALPHABETS[alphabet].indexOf(normalized) : -1
    const currentRange = ranges.at(-1)
    if (!currentRange || alphabet < 0 || currentAlphabet !== alphabet || position < rangeStart || position - rangeStart > 4) {
      ranges.push([initial])
      currentAlphabet = alphabet
      rangeStart = position
    } else {
      currentRange.push(initial)
    }
  }
  return ranges
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}

type GlossaryCategoryDialogFrameProps = {
  title: string
  description?: string
  busy: boolean
  primaryAction?: {
    label: string
    icon: ReactNode
    disabled?: boolean
    onClick: () => void
  }
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
  onClose: () => void
  children: (closeDialog: () => void) => ReactNode
}

function GlossaryCategoryDialogFrame({
  title,
  description,
  busy,
  primaryAction,
  initialFocusRef,
  className = '',
  onClose,
  children,
}: GlossaryCategoryDialogFrameProps) {
  const { t } = useTranslation()
  const { backdropStateClass, close: closeDialog, closing } = useMobileDialogTransition({ onClose, initialFocusRef })
  return (
    <ActionDialog
      variant="structured"
      title={title}
      description={description}
      closeLabel={t('common.close')}
      mobileBackLabel={t('common.back')}
      mobilePrimaryAction={primaryAction ? { ...primaryAction, disabled: closing || primaryAction.disabled } : undefined}
      busy={busy}
      className={`glossaryCategoryDialog glossaryCategoryView ${className}`.trim()}
      backdropClassName={`glossaryCategoryBackdrop ${backdropStateClass}`}
      onClose={closeDialog}
    >
      {children(closeDialog)}
    </ActionDialog>
  )
}

type GlossaryArticleCreateDialogFrameProps = {
  title: string
  description: string
  busy: boolean
  importing: boolean
  creationChoiceOpen: boolean
  stepDirection: 'forward' | 'back' | null
  primaryLabel: string
  primaryDisabled: boolean
  initialFocusRef: RefObject<HTMLElement | null>
  onImportBack: () => void
  onContinue: () => void
  onClose: () => void
  children: (closeDialog: () => void) => ReactNode
}

function GlossaryArticleCreateDialogFrame({
  title,
  description,
  busy,
  importing,
  creationChoiceOpen,
  stepDirection,
  primaryLabel,
  primaryDisabled,
  initialFocusRef,
  onImportBack,
  onContinue,
  onClose,
  children,
}: GlossaryArticleCreateDialogFrameProps) {
  const { t } = useTranslation()
  const { backdropStateClass, close: closeDialog, closing } = useMobileDialogTransition({ onClose, initialFocusRef })
  return (
    <ActionDialog
      variant="structured"
      title={title}
      description={description}
      closeLabel={t('common.close')}
      mobileBackLabel={t('common.back')}
      mobileBackAction={importing ? onImportBack : closeDialog}
      titleClassName={stepDirection ? `glossaryCreationTitle ${stepDirection}` : undefined}
      escapeAction={() => {
        if (creationChoiceOpen) return
        if (importing && window.matchMedia('(max-width: 520px)').matches) onImportBack()
        else closeDialog()
      }}
      mobilePrimaryAction={{
        label: primaryLabel,
        icon: <Icon name={importing ? 'check-circle-1-light' : 'arrow-right-1'} />,
        disabled: closing || primaryDisabled,
        onClick: importing
          ? () => document.querySelector<HTMLFormElement>('#glossary-article-create-form')?.requestSubmit()
          : onContinue,
      }}
      busy={busy}
      className={`glossaryFormDialog glossaryArticleCreateDialog glossaryCategoryView ${importing ? 'glossaryImportDialog' : ''}`}
      backdropClassName={`glossaryCategoryBackdrop ${backdropStateClass}`}
      onClose={closeDialog}
    >
      {children(closeDialog)}
    </ActionDialog>
  )
}

type GlossaryArticleBottomSheetFrameProps = {
  title: string
  description?: string
  busy: boolean
  role?: 'dialog' | 'alertdialog'
  className?: string
  onClose: () => void
  children: (controls: { close: () => void; closing: boolean; finishAfterExit: (complete: () => void) => void }) => ReactNode
}

function GlossaryArticleBottomSheetFrame({
  title,
  description,
  busy,
  role = 'dialog',
  className = '',
  onClose,
  children,
}: GlossaryArticleBottomSheetFrameProps) {
  const { t } = useTranslation()
  const { backdropStateClass, close, closing, finishAfterExit } = useMobileDialogTransition({ onClose })
  return (
    <ActionDialog
      variant="structured"
      role={role}
      title={title}
      description={description}
      closeLabel={t('common.close')}
      busy={busy || closing}
      className={`glossaryArticleBottomSheet ${className}`.trim()}
      backdropClassName={`glossaryArticleBottomSheetBackdrop ${backdropStateClass}`}
      onClose={close}
    >
      {children({ close, closing, finishAfterExit })}
    </ActionDialog>
  )
}

function relativeTime(value: string, locale: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return formatter.format(days, 'day')
  const months = Math.round(days / 30)
  if (Math.abs(months) < 12) return formatter.format(months, 'month')
  return formatter.format(Math.round(months / 12), 'year')
}

function headingText(node: Record<string, unknown>) {
  const content = Array.isArray(node.content) ? node.content : []
  return content.map((child) => (
    typeof child === 'object' && child && 'text' in child ? String(child.text ?? '') : ''
  )).join('')
}

type GlossaryImagePickerProps = {
  label: string
  mode: 'thumbnail' | 'cover'
  file: File | null
  onChange: (file: File | null) => void
  media?: StorageItem | null
  onMediaChange?: (media: StorageItem | null) => void
  existingUrl?: string
  removeExisting?: boolean
  onRemoveExistingChange?: (removed: boolean) => void
  busy?: boolean
}

function GlossaryImagePicker({
  label,
  mode,
  file,
  onChange,
  media = null,
  onMediaChange,
  existingUrl = '',
  removeExisting = false,
  onRemoveExistingChange,
  busy = false,
}: GlossaryImagePickerProps) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const previewUrlRef = useRef('')

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  function select(fileCandidate: File | undefined) {
    setError('')
    if (!fileCandidate) return
    if (!ACCEPTED_GLOSSARY_IMAGE_TYPES.has(fileCandidate.type)) {
      setError(t('glossary.imageInvalidType'))
      return
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = URL.createObjectURL(fileCandidate)
    setPreview(previewUrlRef.current)
    onRemoveExistingChange?.(false)
    onMediaChange?.(null)
    onChange(fileCandidate)
  }

  function remove() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = ''
    setPreview('')
    setError('')
    onChange(null)
    onMediaChange?.(null)
    if (existingUrl) onRemoveExistingChange?.(true)
  }

  const displayedPreview = preview || (media ? `${API_BASE}${media.previewUrl}` : '') || (!removeExisting ? existingUrl : '')
  const hasImage = Boolean(file || media || displayedPreview)

  return (
    <div className="dialogField">
      <span>{label} <em>{t('manuscripts.optional')}</em></span>
      <div className={`glossaryImagePicker ${mode} ${displayedPreview ? 'hasPreview' : ''}`} aria-busy={busy}>
        {displayedPreview ? <img src={displayedPreview} alt={t(mode === 'cover' ? 'glossary.coverPreview' : 'glossary.thumbnailPreview')} /> : (
          <span className="glossaryImagePickerIcon" aria-hidden="true">
            <Icon name={mode === 'cover' ? 'gallery-light' : 'notebook-light'} />
          </span>
        )}
        <div>
          <strong>{file ? file.name : media ? media.title : hasImage ? t(mode === 'cover' ? 'glossary.currentCover' : 'glossary.currentThumbnail') : t(mode === 'cover' ? 'glossary.uploadCover' : 'glossary.uploadThumbnail')}</strong>
          <small>{t('glossary.imageRequirements')}</small>
          <div className="glossaryImagePickerActions">
            <label className="glossaryImageFileButton">
              {t('cover.uploadFile')}
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => select(event.target.files?.[0])} />
            </label>
            <button type="button" className="glossaryImageFileButton spaceButton" disabled={busy} onClick={() => setPickerOpen(true)}>{t('mediaPicker.select')}</button>
            {hasImage && <button type="button" className="glossaryImageRemoveButton booksButton" disabled={busy} onClick={remove}>{t('cover.remove')}</button>}
          </div>
        </div>
        {busy && (
          <div className="imageUploadOverlay" role="status" aria-live="polite">
            <TadpoleIcon />
            <span>{t(mode === 'cover' ? 'uploads.processingCover' : 'uploads.processingImage')}</span>
          </div>
        )}
      </div>
      {error && <small className="fieldError">{error}</small>}
      <StorageImagePickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={(item) => {
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = ''
        setPreview('')
        onChange(null)
        onMediaChange?.(item)
        onRemoveExistingChange?.(false)
        setPickerOpen(false)
      }} />
    </div>
  )
}

export function GlossaryPage({ userId, manuscript, initialArticleId, onError }: Props) {
  const { t, i18n } = useTranslation()
  const [scope, setScope] = useState<GlossaryScope | null>(null)
  const [view, setView] = useState<GlossaryView>('all')
  const [layout, setLayout] = useState<GlossaryLayout>('grid')
  const [sort, setSort] = useState<GlossarySort>('az')
  const [search, setSearch] = useState('')
  const [initial, setInitial] = useState('')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'alphabet' | 'search' | 'sort' | null>(null)
  const [articlePage, setArticlePage] = useState<ArticlePage>({
    items: [], total: 0, page: 1, pageSize: 48, initials: [],
  })
  const [articleOptions, setArticleOptions] = useState<GlossaryArticleSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [activeArticle, setActiveArticle] = useState<GlossaryArticle | null>(null)
  const [articleEditing, setArticleEditing] = useState(false)
  const [articleLoading, setArticleLoading] = useState(false)
  const [createArticleOpen, setCreateArticleOpen] = useState(false)
  const [articleSubmitting, setArticleSubmitting] = useState(false)
  const [articleImporting, setArticleImporting] = useState(false)
  const [articleCreationChoiceOpen, setArticleCreationChoiceOpen] = useState(false)
  const [articleStepDirection, setArticleStepDirection] = useState<'forward' | 'back' | null>(null)
  const [articleImportFile, setArticleImportFile] = useState<File | null>(null)
  const [articleTitle, setArticleTitle] = useState('')
  const [articleSynopsis, setArticleSynopsis] = useState('')
  const [articleCategoryId, setArticleCategoryId] = useState('')
  const [articleThumbnail, setArticleThumbnail] = useState<File | null>(null)
  const [articleCover, setArticleCover] = useState<File | null>(null)
  const [articleThumbnailMedia, setArticleThumbnailMedia] = useState<StorageItem | null>(null)
  const [articleCoverMedia, setArticleCoverMedia] = useState<StorageItem | null>(null)
  const [categoryDialog, setCategoryDialog] = useState<'create' | 'manage' | null>(null)
  const [editingCategory, setEditingCategory] = useState<GlossaryCategory | null>(null)
  const [categoryName, setCategoryName] = useState('')
  const [categoryDescription, setCategoryDescription] = useState('')
  const [categoryIcon, setCategoryIcon] = useState(Object.keys(glossaryGameIcons)[0])
  const [iconSearch, setIconSearch] = useState('')
  const [iconLimit, setIconLimit] = useState(ICON_PAGE_SIZE)
  const [categorySubmitting, setCategorySubmitting] = useState(false)
  const [deletingCategory, setDeletingCategory] = useState<GlossaryCategory | null>(null)
  const [deleteArticleOpen, setDeleteArticleOpen] = useState(false)
  const [exportArticleOpen, setExportArticleOpen] = useState(false)
  const [articleExporting, setArticleExporting] = useState(false)
  const [articleExportError, setArticleExportError] = useState('')
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)
  const [metadataDialogOpen, setMetadataDialogOpen] = useState(false)
  const [metadataTitle, setMetadataTitle] = useState('')
  const [metadataSynopsis, setMetadataSynopsis] = useState('')
  const [metadataThumbnail, setMetadataThumbnail] = useState<File | null>(null)
  const [metadataCover, setMetadataCover] = useState<File | null>(null)
  const [metadataThumbnailMedia, setMetadataThumbnailMedia] = useState<StorageItem | null>(null)
  const [metadataCoverMedia, setMetadataCoverMedia] = useState<StorageItem | null>(null)
  const [metadataRemoveThumbnail, setMetadataRemoveThumbnail] = useState(false)
  const [metadataRemoveCover, setMetadataRemoveCover] = useState(false)
  const [metadataSubmitting, setMetadataSubmitting] = useState(false)
  const [categoryDraftId, setCategoryDraftId] = useState('')
  const [categoryChanging, setCategoryChanging] = useState(false)
  const [articleMenuOpen, setArticleMenuOpen] = useState(false)
  const [mobileArticleTocOpen, setMobileArticleTocOpen] = useState(false)
  const [mobileArticleInfoOpen, setMobileArticleInfoOpen] = useState(false)
  const [mobileArticleInfoClosing, setMobileArticleInfoClosing] = useState(false)
  const [saveStatusHost, setSaveStatusHost] = useState<HTMLSpanElement | null>(null)
  const articleDocumentRef = useRef<GlossaryArticleDocumentHandle>(null)
  const articleTitleInputRef = useRef<HTMLInputElement>(null)
  const metadataTitleInputRef = useRef<HTMLInputElement>(null)
  const articleCreateFormRef = useRef<HTMLFormElement>(null)
  const createArticleWithoutImportRef = useRef(false)
  const createdArticleRef = useRef<GlossaryArticle | null>(null)
  const categoryNameInputRef = useRef<HTMLInputElement>(null)
  const articleMenuRef = useRef<HTMLDivElement>(null)
  const mainScrollRef = useRef<HTMLElement>(null)
  const mobileBottomBarRef = useRef<HTMLElement>(null)
  const mobileSearchInputRef = useRef<HTMLInputElement>(null)
  const mobileArticleInfoTimerRef = useRef<number | null>(null)
  const mobileArticleInfoDrawerRef = useRef<HTMLElement>(null)
  const mobileArticleInfoCloseRef = useRef<HTMLButtonElement>(null)
  const mobileArticleInfoReturnFocusRef = useRef<HTMLElement | null>(null)
  const routeArticleRef = useRef<string | null>(null)
  const viewStateRef = useRef({ view, search, sort, initial, page: 1, scrollY: 0 })

  const categoryById = useMemo(
    () => new Map(scope?.categories.map((category) => [category.id, category]) ?? []),
    [scope],
  )
  const filteredCategoryIcons = useMemo(() => {
    const query = iconSearch.trim().toLowerCase()
    return Object.entries(glossaryGameIcons).filter(([id]) => id.includes(query))
  }, [iconSearch])

  const categoryLabel = useCallback((category: GlossaryCategory) => (
    category.systemKey
      ? t(`glossary.systemCategories.${category.systemKey}.name`)
      : category.name
  ), [t])

  const categoryDescriptionFor = useCallback((category: GlossaryCategory) => (
    category.systemKey
      ? t(`glossary.systemCategories.${category.systemKey}.description`)
      : category.description
  ), [t])

  const closeMobileArticleInfo = useCallback(() => {
    if (!mobileArticleInfoOpen || mobileArticleInfoClosing) return
    setMobileArticleInfoClosing(true)
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180
    mobileArticleInfoTimerRef.current = window.setTimeout(() => {
      mobileArticleInfoTimerRef.current = null
      setMobileArticleInfoOpen(false)
      setMobileArticleInfoClosing(false)
    }, delay)
  }, [mobileArticleInfoClosing, mobileArticleInfoOpen])

  const selectedCategory = view.startsWith('category:')
    ? categoryById.get(view.slice('category:'.length)) ?? null
    : null

  const loadScope = useCallback(async () => {
    const payload = await apiRequest<{ glossary: GlossaryScope }>(
      `/api/manuscripts/${manuscript.id}/glossary/`,
    )
    setScope(payload.glossary)
    return payload.glossary
  }, [manuscript.id])

  const loadArticles = useCallback(async (page = 1) => {
    const params = new URLSearchParams({
      view: view.startsWith('category:') ? 'all' : view,
      sort,
      page: String(page),
      pageSize: '48',
    })
    if (view.startsWith('category:')) params.set('categoryId', view.slice('category:'.length))
    if (search.trim()) params.set('search', search.trim())
    if (initial) params.set('initial', initial)
    const payload = await apiRequest<ArticlePage>(
      `/api/manuscripts/${manuscript.id}/glossary/articles/?${params}`,
    )
    setArticlePage(payload)
  }, [initial, manuscript.id, search, sort, view])

  const loadArticleOptions = useCallback(async () => {
    const first = await apiRequest<ArticlePage>(
      `/api/manuscripts/${manuscript.id}/glossary/articles/?pageSize=100&sort=az`,
    )
    const pageCount = Math.ceil(first.total / first.pageSize)
    const remaining = pageCount > 1
      ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => (
        apiRequest<ArticlePage>(
          `/api/manuscripts/${manuscript.id}/glossary/articles/?pageSize=100&sort=az&page=${index + 2}`,
        )
      )))
      : []
    setArticleOptions([first, ...remaining].flatMap((payload) => payload.items))
  }, [manuscript.id])

  useEffect(() => {
    let active = true
    async function initializeGlossary() {
      try {
        const [scopePayload, firstOptions] = await Promise.all([
          apiRequest<{ glossary: GlossaryScope }>(
            `/api/manuscripts/${manuscript.id}/glossary/`,
          ),
          apiRequest<ArticlePage>(
            `/api/manuscripts/${manuscript.id}/glossary/articles/?pageSize=100&sort=az`,
          ),
        ])
        const pageCount = Math.ceil(firstOptions.total / firstOptions.pageSize)
        const remaining = pageCount > 1
          ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => (
            apiRequest<ArticlePage>(
              `/api/manuscripts/${manuscript.id}/glossary/articles/?pageSize=100&sort=az&page=${index + 2}`,
            )
          )))
          : []
        if (!active) return
        setScope(scopePayload.glossary)
        setArticleOptions([firstOptions, ...remaining].flatMap((payload) => payload.items))
      } catch (error) {
        if (active) {
          onError(error instanceof Error ? error.message : i18n.t('glossary.loadFailed'))
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void initializeGlossary()
    return () => {
      active = false
    }
  }, [i18n, manuscript.id, onError])

  useEffect(() => {
    let active = true
    async function refreshArticleList() {
      const params = new URLSearchParams({
        view: view.startsWith('category:') ? 'all' : view,
        sort,
        page: '1',
        pageSize: '48',
      })
      if (view.startsWith('category:')) params.set('categoryId', view.slice('category:'.length))
      if (search.trim()) params.set('search', search.trim())
      if (initial) params.set('initial', initial)
      try {
        const payload = await apiRequest<ArticlePage>(
          `/api/manuscripts/${manuscript.id}/glossary/articles/?${params}`,
        )
        if (active) setArticlePage(payload)
      } catch (error) {
        if (active) {
          onError(error instanceof Error ? error.message : i18n.t('glossary.loadFailed'))
        }
      }
    }
    void refreshArticleList()
    return () => {
      active = false
    }
  }, [i18n, initial, manuscript.id, onError, search, sort, view])

  useEffect(() => {
    if (!articleMenuOpen) return
    if (window.matchMedia('(max-width: 520px)').matches) return
    function closeArticleMenu(event: MouseEvent) {
      if (!articleMenuRef.current?.contains(event.target as Node)) setArticleMenuOpen(false)
    }
    function closeArticleMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setArticleMenuOpen(false)
    }
    document.addEventListener('mousedown', closeArticleMenu)
    document.addEventListener('keydown', closeArticleMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeArticleMenu)
      document.removeEventListener('keydown', closeArticleMenuOnEscape)
    }
  }, [articleMenuOpen])

  useEffect(() => {
    if (!mobileSidebarOpen && !mobilePanel && !mobileArticleInfoOpen) return
    function closeMobileControlsOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setMobileSidebarOpen(false)
      setMobilePanel(null)
      closeMobileArticleInfo()
    }
    document.addEventListener('keydown', closeMobileControlsOnEscape)
    return () => document.removeEventListener('keydown', closeMobileControlsOnEscape)
  }, [closeMobileArticleInfo, mobileArticleInfoOpen, mobilePanel, mobileSidebarOpen])

  useEffect(() => () => {
    if (mobileArticleInfoTimerRef.current !== null) window.clearTimeout(mobileArticleInfoTimerRef.current)
  }, [])

  useEffect(() => {
    if (!mobileArticleInfoOpen) return
    const focusFrame = window.requestAnimationFrame(() => mobileArticleInfoCloseRef.current?.focus({ preventScroll: true }))
    function trapArticleInfoFocus(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !mobileArticleInfoDrawerRef.current) return
      const focusable = Array.from(mobileArticleInfoDrawerRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trapArticleInfoFocus)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', trapArticleInfoFocus)
      mobileArticleInfoReturnFocusRef.current?.focus({ preventScroll: true })
      mobileArticleInfoReturnFocusRef.current = null
    }
  }, [mobileArticleInfoOpen])

  useEffect(() => {
    if (!mobilePanel) return
    if (mobilePanel === 'search') mobileSearchInputRef.current?.focus()
    function closeMobilePanel(event: MouseEvent) {
      if (mobileBottomBarRef.current?.contains(event.target as Node)) return
      setMobilePanel(null)
    }
    document.addEventListener('mousedown', closeMobilePanel)
    return () => document.removeEventListener('mousedown', closeMobilePanel)
  }, [mobilePanel])

  function selectView(nextView: GlossaryView) {
    setView(nextView)
    setInitial('')
    setMobileSidebarOpen(false)
    setMobilePanel(null)
    if (nextView === 'recent') setSort('updated-desc')
  }

  function toggleMobilePanel(panel: 'alphabet' | 'search' | 'sort') {
    setMobilePanel((current) => current === panel ? null : panel)
    setMobileSidebarOpen(false)
  }

  const openArticle = useCallback(async (articleId: string) => {
    if (!articleId) return
    setArticleMenuOpen(false)
    setMobileArticleTocOpen(false)
    setMobileArticleInfoOpen(false)
    setMobileArticleInfoClosing(false)
    setArticleLoading(true)
    try {
      const payload = await apiRequest<{ article: GlossaryArticle }>(
        `/api/manuscripts/${manuscript.id}/glossary/articles/${articleId}/`,
      )
      setActiveArticle(payload.article)
      setArticleEditing(false)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.openFailed'))
    } finally {
      setArticleLoading(false)
    }
  }, [manuscript.id, onError, t])

  useEffect(() => {
    if (!initialArticleId || routeArticleRef.current === initialArticleId) return
    routeArticleRef.current = initialArticleId
    void openArticle(initialArticleId)
  }, [initialArticleId, openArticle])

  function openArticleFromList(articleId: string) {
    viewStateRef.current = {
      view,
      search,
      sort,
      initial,
      page: articlePage.page,
      scrollY: mainScrollRef.current?.scrollTop ?? 0,
    }
    void openArticle(articleId)
  }

  function articleChanged(article: GlossaryArticle) {
    setActiveArticle(article)
    setArticlePage((current) => ({
      ...current,
      items: current.items.map((item) => item.id === article.id ? article : item),
    }))
    setArticleOptions((current) => (
      current.map((item) => item.id === article.id ? article : item)
    ))
  }

  function applyArticleMetadataUpdate(article: GlossaryArticle) {
    setActiveArticle((current) => (
      current?.id === article.id && articleEditing
        ? { ...article, title: current.title, synopsis: current.synopsis, content: current.content }
        : article
    ))
  }

  function closeArticle() {
    setArticleMenuOpen(false)
    setMobileArticleTocOpen(false)
    setMobileArticleInfoOpen(false)
    setMobileArticleInfoClosing(false)
    setActiveArticle(null)
    setArticleEditing(false)
    const previous = viewStateRef.current
    setView(previous.view)
    setSearch(previous.search)
    setSort(previous.sort)
    setInitial(previous.initial)
    window.setTimeout(() => {
      if (mainScrollRef.current) mainScrollRef.current.scrollTop = previous.scrollY
    }, 0)
  }

  async function toggleArticleMode() {
    if (!articleEditing) {
      setArticleEditing(true)
      return
    }
    const saved = await articleDocumentRef.current?.flush()
    if (saved !== false) setArticleEditing(false)
  }

  function toggleMobileArticleInfo() {
    if (mobileArticleInfoOpen) {
      closeMobileArticleInfo()
      return
    }
    setMobileArticleInfoClosing(false)
    mobileArticleInfoReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setMobileArticleInfoOpen(true)
  }

  function startArticleCreation() {
    const categoryId = selectedCategory?.id
      ?? scope?.categories.find((category) => !category.hidden)?.id
      ?? ''
    setArticleTitle('')
    setArticleSynopsis('')
    setArticleCategoryId(categoryId)
    setArticleThumbnail(null)
    setArticleCover(null)
    setArticleThumbnailMedia(null)
    setArticleCoverMedia(null)
    setArticleImporting(false)
    setArticleCreationChoiceOpen(false)
    setArticleStepDirection(null)
    setArticleImportFile(null)
    createdArticleRef.current = null
    setCreateArticleOpen(true)
  }

  function resetArticleCreationScroll() {
    if (!window.matchMedia('(max-width: 520px)').matches) return
    window.requestAnimationFrame(() => {
      articleCreateFormRef.current?.closest<HTMLElement>('.standardDialogContent')?.scrollTo({ top: 0 })
    })
  }

  function showArticleImportStep() {
    setArticleStepDirection('forward')
    setArticleImporting(true)
    resetArticleCreationScroll()
  }

  function showArticleDetailsStep() {
    setArticleStepDirection('back')
    setArticleImporting(false)
    resetArticleCreationScroll()
  }

  async function createArticle(event: FormEvent, closeDialog: () => void) {
    event.preventDefault()
    if (
      !articleTitle.trim()
      || !articleCategoryId
      || articleSubmitting
      || (articleImporting && !articleImportFile)
    ) {
      createArticleWithoutImportRef.current = false
      return
    }
    if (!articleImporting && window.matchMedia('(max-width: 520px)').matches && !createArticleWithoutImportRef.current) {
      setArticleCreationChoiceOpen(true)
      return
    }
    createArticleWithoutImportRef.current = false
    setArticleSubmitting(true)
    const form = new FormData()
    form.append('title', articleTitle.trim())
    form.append('synopsis', articleSynopsis.trim())
    form.append('categoryId', articleCategoryId)
    if (articleThumbnail) form.append('thumbnail', articleThumbnail)
    if (articleCover) form.append('cover', articleCover)
    if (articleThumbnailMedia) form.append('thumbnailMediaId', articleThumbnailMedia.id.replace(/^media:/, ''))
    if (articleCoverMedia) form.append('coverMediaId', articleCoverMedia.id.replace(/^media:/, ''))
    if (articleImporting && articleImportFile) form.append('importFile', articleImportFile)
    try {
      const payload = await apiUpload<{ article: GlossaryArticle }>(
        `/api/manuscripts/${manuscript.id}/glossary/articles/`,
        form,
      )
      await Promise.all([loadScope(), loadArticles(), loadArticleOptions()])
      createdArticleRef.current = payload.article
      closeDialog()
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.createFailed'))
    } finally {
      setArticleSubmitting(false)
    }
  }

  function openCreateCategory() {
    setEditingCategory(null)
    setCategoryName('')
    setCategoryDescription('')
    setCategoryIcon(Object.keys(glossaryGameIcons)[0])
    setIconSearch('')
    setIconLimit(ICON_PAGE_SIZE)
    setCategoryDialog('create')
  }

  function openEditCategory(category: GlossaryCategory) {
    setEditingCategory(category)
    setCategoryName(category.name)
    setCategoryDescription(category.description)
    setCategoryIcon(category.icon)
    setIconSearch('')
    const iconIndex = Object.keys(glossaryGameIcons).indexOf(category.icon)
    setIconLimit(Math.max(ICON_PAGE_SIZE, Math.ceil((iconIndex + 1) / ICON_PAGE_SIZE) * ICON_PAGE_SIZE))
    setCategoryDialog('manage')
  }

  async function saveCategory(event: FormEvent, closeDialog: () => void) {
    event.preventDefault()
    if (!categoryName.trim() || categorySubmitting) return
    setCategorySubmitting(true)
    try {
      const path = editingCategory
        ? `/api/manuscripts/${manuscript.id}/glossary/categories/${editingCategory.id}/`
        : `/api/manuscripts/${manuscript.id}/glossary/categories/`
      await apiRequest(path, {
        method: editingCategory ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name: categoryName.trim(),
          description: categoryDescription.trim(),
          icon: categoryIcon,
        }),
      })
      await loadScope()
      closeDialog()
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.categorySaveFailed'))
    } finally {
      setCategorySubmitting(false)
    }
  }

  async function toggleSystemCategory(category: GlossaryCategory) {
    try {
      await apiRequest(
        `/api/manuscripts/${manuscript.id}/glossary/categories/${category.id}/`,
        { method: 'PATCH', body: JSON.stringify({ hidden: !category.hidden }) },
      )
      await loadScope()
      if (!category.hidden && view === `category:${category.id}`) setView('all')
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.categorySaveFailed'))
    }
  }

  async function deleteCategory(category: GlossaryCategory) {
    if (categorySubmitting) return
    setCategorySubmitting(true)
    try {
      await apiRequest(
        `/api/manuscripts/${manuscript.id}/glossary/categories/${category.id}/`,
        { method: 'DELETE' },
      )
      await loadScope()
      if (view === `category:${category.id}`) setView('all')
      setCategoryDialog(null)
      setEditingCategory(null)
      setDeletingCategory(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.categoryDeleteFailed'))
    } finally {
      setCategorySubmitting(false)
    }
  }

  async function toggleFavourite(article: GlossaryArticleSummary) {
    try {
      const payload = await apiRequest<{ article: GlossaryArticle }>(
        `/api/manuscripts/${manuscript.id}/glossary/articles/${article.id}/`,
        { method: 'PATCH', body: JSON.stringify({ favourite: !article.favourite }) },
      )
      if (activeArticle?.id === article.id) applyArticleMetadataUpdate(payload.article)
      await loadArticles(articlePage.page)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.updateFailed'))
    }
  }

  async function changeArticleCategory(categoryId: string) {
    if (!activeArticle) return false
    try {
      const payload = await apiRequest<{ article: GlossaryArticle }>(
        `/api/manuscripts/${manuscript.id}/glossary/articles/${activeArticle.id}/`,
        { method: 'PATCH', body: JSON.stringify({ categoryId }) },
      )
      applyArticleMetadataUpdate(payload.article)
      await Promise.all([loadScope(), loadArticles(articlePage.page), loadArticleOptions()])
      return true
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.updateFailed'))
      return false
    }
  }

  async function submitArticleCategory(event: FormEvent, closeDialog: () => void) {
    event.preventDefault()
    if (!categoryDraftId || categoryChanging) return
    setCategoryChanging(true)
    const changed = await changeArticleCategory(categoryDraftId)
    if (changed) closeDialog()
    setCategoryChanging(false)
  }

  async function deleteArticle(afterDelete: () => void) {
    if (!activeArticle) return
    setArticleSubmitting(true)
    try {
      await apiRequest(
        `/api/manuscripts/${manuscript.id}/glossary/articles/${activeArticle.id}/`,
        { method: 'DELETE' },
      )
      await Promise.all([loadScope(), loadArticles(), loadArticleOptions()])
      afterDelete()
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.deleteFailed'))
    } finally {
      setArticleSubmitting(false)
    }
  }

  async function exportArticle(format: GlossaryArticleExportFormat) {
    if (!activeArticle || articleExporting) return false
    setArticleExporting(true)
    setArticleExportError('')
    try {
      const saved = await articleDocumentRef.current?.flush()
      if (saved === false) {
        setArticleExportError(t('glossary.exportSaveRequired'))
        return false
      }
      const download = await apiDownload(
        `/api/manuscripts/${manuscript.id}/glossary/articles/${activeArticle.id}/export/`,
        { format },
      )
      const url = URL.createObjectURL(download.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = download.fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      return true
    } catch (error) {
      setArticleExportError(
        error instanceof ApiError
          ? t(`errors.${error.code}`, { defaultValue: t('glossary.exportFailed') })
          : t('glossary.exportFailed'),
      )
      return false
    } finally {
      setArticleExporting(false)
    }
  }

  function openMetadataDialog() {
    if (!activeArticle) return
    setArticleMenuOpen(false)
    setMetadataTitle(activeArticle.title)
    setMetadataSynopsis(activeArticle.synopsis)
    setMetadataThumbnail(null)
    setMetadataCover(null)
    setMetadataThumbnailMedia(null)
    setMetadataCoverMedia(null)
    setMetadataRemoveThumbnail(false)
    setMetadataRemoveCover(false)
    setMetadataDialogOpen(true)
  }

  async function saveArticleMetadata(event: FormEvent, closeDialog: () => void) {
    event.preventDefault()
    if (!activeArticle || !metadataTitle.trim() || metadataSubmitting) return
    setMetadataSubmitting(true)
    try {
      let currentArticle = activeArticle
      if (
        metadataTitle.trim() !== activeArticle.title
        || metadataSynopsis.trim() !== activeArticle.synopsis
      ) {
        const payload = await apiRequest<{ article: GlossaryArticle }>(
          `/api/manuscripts/${manuscript.id}/glossary/articles/${activeArticle.id}/`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              title: metadataTitle.trim(),
              synopsis: metadataSynopsis.trim(),
            }),
          },
        )
        currentArticle = payload.article
        articleDocumentRef.current?.updateMetadata(currentArticle.title, currentArticle.synopsis)
      }
      if (metadataRemoveThumbnail && !metadataThumbnail && !metadataThumbnailMedia) {
        const payload = await apiRequest<{ article: GlossaryArticle }>(
          `/api/manuscripts/${manuscript.id}/glossary/articles/${activeArticle.id}/thumbnail/`,
          { method: 'DELETE' },
        )
        currentArticle = payload.article
      }
      if (metadataThumbnail || metadataThumbnailMedia) {
        const form = new FormData()
        if (metadataThumbnail) form.append('thumbnail', metadataThumbnail)
        if (metadataThumbnailMedia) form.append('mediaId', metadataThumbnailMedia.id.replace(/^media:/, ''))
        const payload = await apiUpload<{ article: GlossaryArticle }>(
          `/api/manuscripts/${manuscript.id}/glossary/articles/${activeArticle.id}/thumbnail/`,
          form,
        )
        currentArticle = payload.article
      }
      if (metadataRemoveCover && !metadataCover && !metadataCoverMedia) {
        const payload = await apiRequest<{ article: GlossaryArticle }>(
          `/api/manuscripts/${manuscript.id}/glossary/articles/${activeArticle.id}/cover/`,
          { method: 'DELETE' },
        )
        currentArticle = payload.article
      }
      if (metadataCover || metadataCoverMedia) {
        const form = new FormData()
        if (metadataCover) form.append('cover', metadataCover)
        if (metadataCoverMedia) form.append('mediaId', metadataCoverMedia.id.replace(/^media:/, ''))
        const payload = await apiUpload<{ article: GlossaryArticle }>(
          `/api/manuscripts/${manuscript.id}/glossary/articles/${activeArticle.id}/cover/`,
          form,
        )
        currentArticle = payload.article
      }
      articleChanged(currentArticle)
      closeDialog()
      await loadArticles(articlePage.page)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.updateFailed'))
    } finally {
      setMetadataSubmitting(false)
    }
  }

  const title = selectedCategory
    ? categoryLabel(selectedCategory)
    : t(view === 'favourites'
      ? 'glossary.favourites'
      : view === 'recent'
        ? 'glossary.recentlyEdited'
        : 'glossary.mainPage')
  const description = selectedCategory
    ? categoryDescriptionFor(selectedCategory)
    : t(view === 'favourites'
      ? 'glossary.favouritesDescription'
      : view === 'recent'
        ? 'glossary.recentDescription'
        : 'glossary.mainDescription')
  const mobileAlphabetRanges = groupAlphabetInitials(articlePage.initials)

  if (loading && !scope) return <TadpoleLoadingState className="manuscriptPageState" label={t('glossary.loading')} />
  if (!scope) return <div className="manuscriptPageState">{t('glossary.loadFailed')}</div>

  if (articleLoading) return <TadpoleLoadingState className="manuscriptPageState" label={t('glossary.loadingArticle')} />

  if (activeArticle) {
    const headings = (activeArticle.content.content ?? [])
      .filter((node) => node.type === 'heading')
      .map((node, index) => ({
        id: `glossary-heading-${index}`,
        level: Number(node.attrs?.level ?? 1),
        text: headingText(node as Record<string, unknown>),
      }))
    function scrollToArticleHeading(headingIndex: number) {
      document.querySelectorAll('.glossaryDocument .glossaryTiptap h1, .glossaryDocument .glossaryTiptap h2, .glossaryDocument .glossaryTiptap h3, .glossaryDocument .glossaryTiptap h4, .glossaryDocument .glossaryTiptap h5')[headingIndex]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    return (
      <section className="glossaryArticlePage">
        <header className="glossaryArticleMobileHeader">
          <button type="button" className="spaceButton" title={t('glossary.backToList')} aria-label={t('glossary.backToList')} onClick={closeArticle}><Icon name="arrow-left-1" /></button>
          <h1>{activeArticle.title}</h1>
          <button type="button" className={`spaceButton ${articleMenuOpen ? 'active' : ''}`} title={t('glossary.articleActions')} aria-label={t('glossary.articleActions')} aria-haspopup="dialog" aria-expanded={articleMenuOpen} onClick={() => setArticleMenuOpen(true)}><Icon name="menu-dots-light" /></button>
        </header>
        <div className="glossaryArticleColumns">
          <aside className="glossaryArticleContents">
            <header>
              <button
                type="button"
                className="glossaryBack spaceButton"
                title={t('glossary.backToList')}
                aria-label={t('glossary.backToList')}
                onClick={closeArticle}
              >
                <Icon name="arrow-left-1" />
              </button>
              <h2>{t('glossary.tableOfContents')}</h2>
            </header>
            {headings.length > 0 && (
              <nav className="glossaryToc" aria-label={t('glossary.tableOfContents')}>
                {headings.map((heading, headingIndex) => (
                  <button
                    key={heading.id}
                    type="button"
                    className="spaceButton"
                    style={{ paddingLeft: `${12 + (heading.level - 1) * 12}px` }}
                    onClick={() => {
                      scrollToArticleHeading(headingIndex)
                    }}
                  >
                    {heading.text}
                  </button>
                ))}
              </nav>
            )}
          </aside>
          <main className="glossaryArticleMain">
            <header className="glossaryArticleIntro">
              {activeArticle.thumbnailUrl ? (
                <PrivateImage src={`${API_BASE}${activeArticle.thumbnailUrl}`} alt="" decoding="async" />
              ) : <div className="glossaryThumbnailPlaceholder"><Icon name="notebook-light" /></div>}
              <div className="glossaryArticleIdentity">
                <div className="glossaryArticleTitleRow">
                  <h1>{activeArticle.title}</h1>
                  {articleEditing && (
                    <>
                      <span className="glossaryTitleDivider" aria-hidden="true" />
                      <span className="glossaryHeaderSaveStatus" ref={setSaveStatusHost} />
                    </>
                  )}
                </div>
              </div>
              <div className="glossaryArticleActions">
                <button type="button" title={t('glossary.favourite')} aria-label={t('glossary.favourite')} className={`spaceButton ${activeArticle.favourite ? 'active' : ''}`} onClick={() => void toggleFavourite(activeArticle)}><Icon name="star-light" /></button>
                <button type="button" className="spaceButton" title={t(articleEditing ? 'glossary.view' : 'glossary.edit')} aria-label={t(articleEditing ? 'glossary.view' : 'glossary.edit')} onClick={() => void toggleArticleMode()}><Icon name={articleEditing ? 'eye-light' : 'edit-light'} /></button>
                <div className="glossaryArticleActionMenu" ref={articleMenuRef}>
                  <button type="button" className="spaceButton" title={t('glossary.articleActions')} aria-label={t('glossary.articleActions')} aria-haspopup="menu" aria-expanded={articleMenuOpen} onClick={() => setArticleMenuOpen((open) => !open)}><Icon name="menu-dots-light" /></button>
                  {articleMenuOpen && (
                    <div className="glossaryArticleActionPopover" role="menu">
                      <button type="button" className="spaceButton" role="menuitem" onClick={openMetadataDialog}><Icon name="edit-light" />{t('glossary.editArticleData')}</button>
                      <button type="button" className="spaceButton" role="menuitem" disabled={!navigator.onLine} onClick={() => { setArticleMenuOpen(false); setCategoryDraftId(activeArticle.categoryId); setCategoryPickerOpen(true) }}><Icon name="notebook-bookmark-light" />{t('glossary.changeCategory')}</button>
                      <button type="button" className="spaceButton" role="menuitem" disabled={!navigator.onLine} onClick={() => { setArticleMenuOpen(false); setArticleExportError(''); setExportArticleOpen(true) }}><Icon name="download-minimalistic-light" />{t('glossary.exportAction')}</button>
                      <button type="button" className="danger spaceButton" role="menuitem" onClick={() => { setArticleMenuOpen(false); setDeleteArticleOpen(true) }}><Icon name="trash-bin-trash-light" />{t('common.delete')}</button>
                    </div>
                  )}
                </div>
              </div>
            </header>
            <GlossaryArticleDocument
              ref={articleDocumentRef}
              key={activeArticle.id}
              userId={userId}
              manuscriptId={manuscript.id}
              article={activeArticle}
              articleOptions={articleOptions}
              editable={articleEditing}
              onChange={articleChanged}
              onOpenArticle={(id) => void openArticle(id)}
              onOpenTableOfContents={() => setMobileArticleTocOpen(true)}
              onToggleMode={() => void toggleArticleMode()}
              onOpenDetails={toggleMobileArticleInfo}
              detailsOpen={mobileArticleInfoOpen}
              onError={onError}
              saveStatusHost={saveStatusHost}
            />
          </main>
          <aside className="glossaryLinkedPanel">
            <GlossaryArticleSidebar
              key={`desktop:${activeArticle.id}`}
              article={activeArticle}
              manuscriptId={manuscript.id}
              categories={scope.categories}
              categoryLabel={categoryLabel}
              onArticleChange={articleChanged}
              onOpenArticle={(articleId) => void openArticle(articleId)}
              onError={onError}
            />
          </aside>
        </div>
        {mobileArticleInfoOpen && <div className={`glossaryArticleMobileInfoBackdrop ${mobileArticleInfoClosing ? 'closing' : ''}`} role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeMobileArticleInfo() }}>
          <aside className={`glossaryArticleMobileInfoDrawer ${mobileArticleInfoClosing ? 'closing' : ''}`} role="dialog" aria-modal="true" aria-label={t('glossary.articleDetails')} ref={mobileArticleInfoDrawerRef}>
            <div className="glossaryArticleMobileInfoContent">
              <GlossaryArticleSidebar
                key={`mobile:${activeArticle.id}`}
                article={activeArticle}
                manuscriptId={manuscript.id}
                categories={scope.categories}
                categoryLabel={categoryLabel}
                onArticleChange={articleChanged}
                onOpenArticle={(articleId) => void openArticle(articleId)}
                onError={onError}
              />
            </div>
            <button type="button" className="glossaryArticleMobileInfoClose spaceButton" aria-label={t('glossary.closeArticleDetails')} ref={mobileArticleInfoCloseRef} onClick={closeMobileArticleInfo}><Icon name="arrow-right-1" /> <span>{t('glossary.collapseSidebar')}</span></button>
          </aside>
        </div>}
        <MobileLibraryActionSheet
          open={mobileArticleTocOpen}
          title={t('glossary.tableOfContents')}
          dismissOnSelect
          onClose={() => setMobileArticleTocOpen(false)}
          topContent={headings.length === 0 ? <p className="glossaryMobileTocEmpty">{t('glossary.noHeadings')}</p> : undefined}
          actions={headings.map((heading, headingIndex) => ({
            key: heading.id,
            label: heading.text,
            icon: <Icon name="sort-by-alphabet-light" />,
            onSelect: () => scrollToArticleHeading(headingIndex),
          }))}
        />
        <MobileLibraryActionSheet
          open={articleMenuOpen}
          title={activeArticle.title}
          dismissOnSelect
          onClose={() => setArticleMenuOpen(false)}
          topContent={<div className="glossaryArticleMobileQuickActions"><button type="button" className={`spaceButton ${activeArticle.favourite ? 'active' : ''}`} aria-pressed={activeArticle.favourite} disabled={!navigator.onLine} onClick={() => void toggleFavourite(activeArticle)}><Icon name="star-light" /><span>{t(activeArticle.favourite ? 'glossary.removeFromFavourites' : 'glossary.addToFavourites')}</span></button></div>}
          actions={[
            { key: 'metadata', label: t('glossary.editArticleData'), icon: <Icon name="edit-light" />, disabled: !navigator.onLine, onSelect: openMetadataDialog },
            { key: 'category', label: t('glossary.changeCategory'), icon: <Icon name="notebook-bookmark-light" />, disabled: !navigator.onLine, onSelect: () => { setCategoryDraftId(activeArticle.categoryId); setCategoryPickerOpen(true) } },
            { key: 'export', label: t('glossary.exportAction'), icon: <Icon name="download-minimalistic-light" />, disabled: !navigator.onLine, onSelect: () => { setArticleExportError(''); setExportArticleOpen(true) } },
            { key: 'delete', label: t('common.delete'), icon: <Icon name="trash-bin-trash-light" />, danger: true, disabled: !navigator.onLine, onSelect: () => setDeleteArticleOpen(true) },
          ]}
        />
        {exportArticleOpen && (
          <GlossaryArticleExportDialog
            busy={articleExporting}
            error={articleExportError}
            onClose={() => setExportArticleOpen(false)}
            onExport={exportArticle}
          />
        )}
        {metadataDialogOpen && (
          <GlossaryCategoryDialogFrame
            title={t('glossary.editArticleData')}
            busy={metadataSubmitting}
            primaryAction={{
              label: t(metadataSubmitting ? 'common.saving' : 'common.save'),
              icon: <Icon name="diskette-light" />,
              disabled: metadataSubmitting || !metadataTitle.trim(),
              onClick: () => document.querySelector<HTMLFormElement>('#glossary-article-metadata-form')?.requestSubmit(),
            }}
            initialFocusRef={metadataTitleInputRef}
            className="glossaryArticleMetadataDialog"
            onClose={() => setMetadataDialogOpen(false)}
          >
            {(closeDialog) => <form id="glossary-article-metadata-form" className="glossaryArticleMetadataForm mobileHeaderActionForm" onSubmit={(event) => void saveArticleMetadata(event, closeDialog)}>
              <label className="dialogField">
                <span>{t('glossary.articleTitle')}</span>
                <input ref={metadataTitleInputRef} required maxLength={240} value={metadataTitle} onChange={(event) => setMetadataTitle(event.target.value)} />
              </label>
              <label className="dialogField">
                <span>{t('glossary.articleSynopsisOptional')}</span>
                <textarea rows={3} maxLength={2000} value={metadataSynopsis} placeholder={t('glossary.synopsisPlaceholder')} onChange={(event) => setMetadataSynopsis(event.target.value)} />
              </label>
              <GlossaryImagePicker
                label={t('glossary.thumbnail')}
                mode="thumbnail"
                file={metadataThumbnail}
                onChange={setMetadataThumbnail}
                media={metadataThumbnailMedia}
                onMediaChange={setMetadataThumbnailMedia}
                existingUrl={activeArticle.thumbnailUrl ? `${API_BASE}${activeArticle.thumbnailUrl}` : ''}
                removeExisting={metadataRemoveThumbnail}
                onRemoveExistingChange={setMetadataRemoveThumbnail}
                busy={metadataSubmitting && Boolean(metadataThumbnail)}
              />
              <GlossaryImagePicker
                label={t('glossary.articleCover')}
                mode="cover"
                file={metadataCover}
                onChange={setMetadataCover}
                media={metadataCoverMedia}
                onMediaChange={setMetadataCoverMedia}
                existingUrl={activeArticle.coverUrl ? `${API_BASE}${activeArticle.coverUrl}` : ''}
                removeExisting={metadataRemoveCover}
                onRemoveExistingChange={setMetadataRemoveCover}
                busy={metadataSubmitting && Boolean(metadataCover)}
              />
              <footer>
                <button type="button" className="dialogCancel spaceButton" disabled={metadataSubmitting} onClick={closeDialog}>{t('common.cancel')}</button>
                <button type="submit" className="dialogSubmit spaceButton" disabled={metadataSubmitting || !metadataTitle.trim()}>{t(metadataSubmitting ? 'common.saving' : 'common.save')}</button>
              </footer>
            </form>}
          </GlossaryCategoryDialogFrame>
        )}
        {categoryPickerOpen && (
          <GlossaryArticleBottomSheetFrame
            title={t('glossary.changeCategory')}
            busy={categoryChanging}
            className="glossaryCategoryPickerDialog"
            onClose={() => setCategoryPickerOpen(false)}
          >
            {({ close, closing }) => <form onSubmit={(event) => void submitArticleCategory(event, close)}>
              <label className="dialogField">
                <span>{t('glossary.category')}</span>
                <CustomSelect value={categoryDraftId} onChange={(event) => setCategoryDraftId(event.target.value)}>
                  {scope.categories.map((category) => <option key={category.id} value={category.id}>{categoryLabel(category)}</option>)}
                </CustomSelect>
              </label>
              <footer>
                <button type="button" className="dialogCancel spaceButton" disabled={categoryChanging || closing} onClick={close}>{t('common.cancel')}</button>
                <button type="submit" className="dialogSubmit spaceButton" disabled={categoryChanging || categoryDraftId === activeArticle.categoryId}>{t(categoryChanging ? 'common.saving' : 'common.save')}</button>
              </footer>
            </form>}
          </GlossaryArticleBottomSheetFrame>
        )}
        {deleteArticleOpen && (
          <GlossaryArticleBottomSheetFrame
            role="alertdialog"
            title={t('glossary.deleteArticle')}
            busy={articleSubmitting}
            className="glossaryConfirmDialog"
            onClose={() => setDeleteArticleOpen(false)}
          >
            {({ close, closing, finishAfterExit }) => <div className="standardDialogSection">
              <p>{t('glossary.deleteArticleLead', { title: activeArticle.title })}</p>
              <footer className="standardDialogFooter">
                <button type="button" className="dialogCancel spaceButton" disabled={articleSubmitting || closing} onClick={close}>{t('common.cancel')}</button>
                <button type="button" className="dialogSubmit danger spaceButton" disabled={articleSubmitting} onClick={() => void deleteArticle(() => finishAfterExit(() => { setDeleteArticleOpen(false); setActiveArticle(null) }))}>{t(articleSubmitting ? 'account.deleting' : 'common.delete')}</button>
              </footer>
            </div>}
          </GlossaryArticleBottomSheetFrame>
        )}
      </section>
    )
  }

  return (
    <section className="glossaryPage">
      <aside className={`glossarySidebar ${mobileSidebarOpen ? 'mobileOpen' : ''}`} aria-label={t('glossary.navigation')}>
        <button type="button" className={`spaceButton ${view === 'all' ? 'active' : ''}`} onClick={() => selectView('all')}><Icon name="notebook-light" /> {t('glossary.mainPage')}</button>
        <div className="glossaryCategoryList">
          {scope.categories.filter((category) => !category.hidden).map((category) => (
            <div key={category.id} className={view === `category:${category.id}` ? 'active' : ''}>
              <button type="button" className="spaceButton" onClick={() => selectView(`category:${category.id}`)}>
                <GlossaryCategoryIcon category={category} /> {categoryLabel(category)}
              </button>
              <button type="button" className="categoryAction spaceButton" aria-label={category.systemKey ? t('glossary.hideCategory') : t('glossary.editCategory')} onClick={() => category.systemKey ? void toggleSystemCategory(category) : openEditCategory(category)}>
                <Icon name={category.systemKey ? 'eye-light' : 'menu-dots-light'} />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="newCategory spaceButton" onClick={openCreateCategory}><Icon name="sign-plus-light" /> {t('glossary.newCategory')}</button>
        <button type="button" className="manageCategories spaceButton" onClick={() => { setEditingCategory(null); setCategoryDialog('manage') }}><Icon name="settings-light" /> {t('glossary.manageCategories')}</button>
        <hr />
        <small>{t('glossary.filters')}</small>
        <button type="button" className={`spaceButton ${view === 'favourites' ? 'active' : ''}`} onClick={() => selectView('favourites')}><Icon name="star-light" /> {t('glossary.favourites')}</button>
        <button type="button" className={`spaceButton ${view === 'recent' ? 'active' : ''}`} onClick={() => selectView('recent')}><Icon name="history-light" /> {t('glossary.recentlyEdited')}</button>
        <button type="button" className="glossaryMobileSidebarClose spaceButton" onClick={() => setMobileSidebarOpen(false)}>
          <Icon name="arrow-left-1" />
          <span>{t('glossary.collapseSidebar')}</span>
        </button>
      </aside>
      {mobileSidebarOpen && <div className="glossarySidebarBackdrop" role="presentation" onPointerDown={() => setMobileSidebarOpen(false)} />}
      <main ref={mainScrollRef} className="glossaryMain">
        <header className="glossaryHeader">
          <div className="glossaryHeaderCopy">
            <h1>{title}</h1>
            <p>{description}</p>
            {scope.scopeType === 'series' && (
              <small className="glossarySeriesScope">
                {t('glossary.sharedSeriesScope', { series: scope.seriesTitle })}
              </small>
            )}
          </div>
          <div className="glossaryHeaderActions">
            <label className="glossarySearch"><Icon name="magnifer-outline" /><input value={search} placeholder={t('glossary.searchPlaceholder')} onChange={(event) => { setSearch(event.target.value); setInitial('') }} /></label>
            <CustomSelect value={sort} aria-label={t('glossary.sort')} onChange={(event) => setSort(event.target.value as GlossarySort)}>
              <option value="az">{t('glossary.sortAz')}</option>
              <option value="za">{t('glossary.sortZa')}</option>
              <option value="updated-desc">{t('glossary.sortNewest')}</option>
              <option value="updated-asc">{t('glossary.sortOldest')}</option>
            </CustomSelect>
            <div className="glossaryLayoutSwitch" role="group" aria-label={t('glossary.layout')}>
              <button type="button" className={`spaceButton ${layout === 'grid' ? 'active' : ''}`} aria-label={t('glossary.grid')} onClick={() => setLayout('grid')}><Icon name="mingcute-layout-grid-line" /></button>
              <button type="button" className={`spaceButton ${layout === 'list' ? 'active' : ''}`} aria-label={t('glossary.list')} onClick={() => setLayout('list')}><Icon name="mingcute-rows-2-line" /></button>
            </div>
            <button type="button" className="primary spaceButton" onClick={startArticleCreation}><Icon name="file-add-light" /> {t('glossary.newArticle')}</button>
          </div>
        </header>
        <nav className="glossaryAlphabet" aria-label={t('glossary.alphabet')}>
          <button type="button" className={`spaceButton ${!initial ? 'active' : ''}`} onClick={() => setInitial('')}>{t('glossary.all')}</button>
          {articlePage.initials.map((letter) => <button key={letter} type="button" className={`spaceButton ${initial === letter ? 'active' : ''}`} onClick={() => setInitial(letter)}>{letter}</button>)}
        </nav>
        <div className="glossaryResults">
          {articlePage.items.length === 0 ? (
            <div className="glossaryEmpty"><Icon name="notebook-light" /><h2>{t('glossary.emptyTitle')}</h2><p>{t('glossary.emptyLead')}</p></div>
          ) : (
            <div className={`glossaryCards ${layout}`}>
              {articlePage.items.map((article) => (
                <article key={article.id} onClick={() => openArticleFromList(article.id)}>
                  {article.thumbnailUrl ? <PrivateImage src={`${API_BASE}${article.thumbnailUrl}`} alt="" loading="lazy" decoding="async" /> : <div className="glossaryThumbnailPlaceholder"><Icon name="notebook-light" /></div>}
                  <div className="glossaryCardText"><h2>{article.title}</h2>{article.synopsis && <p>{article.synopsis}</p>}<small>{t('glossary.edited', { time: relativeTime(article.updatedAt, i18n.resolvedLanguage ?? 'en') })}</small></div>
                  <button type="button" className={`spaceButton ${article.favourite ? 'active' : ''}`} aria-label={t('glossary.favourite')} onClick={(event) => { event.stopPropagation(); void toggleFavourite(article) }}><Icon name="star-light" /></button>
                </article>
              ))}
            </div>
          )}
          {articlePage.total > articlePage.pageSize && (
            <div className="glossaryPagination">
              <button type="button" className="spaceButton" disabled={articlePage.page <= 1} onClick={() => void loadArticles(articlePage.page - 1)}>{t('glossary.previous')}</button>
              <span>{t('glossary.page', { page: articlePage.page })}</span>
              <button type="button" className="spaceButton" disabled={articlePage.page * articlePage.pageSize >= articlePage.total} onClick={() => void loadArticles(articlePage.page + 1)}>{t('glossary.next')}</button>
            </div>
          )}
        </div>
      </main>
      <nav className="glossaryMobileBottomBar" aria-label={t('glossary.navigation')} ref={mobileBottomBarRef}>
        {mobilePanel === 'alphabet' && (
          <div className="glossaryMobilePanel glossaryMobileAlphabetPanel">
            <button type="button" className={`spaceButton glossaryMobileAllInitials ${!initial ? 'active' : ''}`} onClick={() => { setInitial(''); setMobilePanel(null) }}>{t('glossary.all')}</button>
            {mobileAlphabetRanges.map((range) => (
              <div className="glossaryMobileAlphabetRange" key={range.join('-')}>
                <span>{range.length > 1 ? `${range[0]}–${range.at(-1)}` : range[0]}</span>
                <div>
                  {range.map((letter) => <button key={letter} type="button" className={`spaceButton ${initial === letter ? 'active' : ''}`} onClick={() => { setInitial(letter); setMobilePanel(null) }}>{letter}</button>)}
                </div>
              </div>
            ))}
          </div>
        )}
        {mobilePanel === 'search' && (
          <div className="glossaryMobilePanel glossaryMobileSearchPanel">
            <label className="glossarySearch"><Icon name="magnifer-outline" /><input ref={mobileSearchInputRef} value={search} placeholder={t('glossary.searchPlaceholder')} aria-label={t('glossary.searchPlaceholder')} onChange={(event) => { setSearch(event.target.value); setInitial('') }} />{search && <button type="button" className="spaceButton" aria-label={t('glossary.clearSearch')} onClick={() => setSearch('')}><Icon name="close-light" /></button>}</label>
          </div>
        )}
        {mobilePanel === 'sort' && (
          <div className="glossaryMobilePanel glossaryMobileSortPanel" role="menu">
            {([
              ['az', 'glossary.sortAz'],
              ['za', 'glossary.sortZa'],
              ['updated-desc', 'glossary.sortNewest'],
              ['updated-asc', 'glossary.sortOldest'],
            ] as const).map(([value, label]) => <button key={value} type="button" role="menuitemradio" aria-checked={sort === value} className={`spaceButton ${sort === value ? 'active' : ''}`} onClick={() => { setSort(value); setMobilePanel(null) }}>{t(label)}</button>)}
          </div>
        )}
        <div className="glossaryMobileBottomBarSurface">
          <button type="button" className={`glossaryMobileBarButton spaceButton ${mobileSidebarOpen ? 'active' : ''}`} aria-label={t('glossary.openNavigation')} aria-expanded={mobileSidebarOpen} onClick={() => { setMobileSidebarOpen((open) => !open); setMobilePanel(null) }}><Icon name="sidebar-minimalistic-light" /></button>
          <button type="button" className={`glossaryMobileBarButton spaceButton ${mobilePanel === 'alphabet' ? 'active' : ''}`} aria-label={t('glossary.alphabet')} aria-expanded={mobilePanel === 'alphabet'} onClick={() => toggleMobilePanel('alphabet')}><Icon name="sort-by-alphabet-light" /></button>
          <button type="button" className="glossaryMobilePrimaryAction spaceButton" aria-label={t('glossary.newArticle')} title={t('glossary.newArticle')} onClick={() => { setMobilePanel(null); startArticleCreation() }}><PlusIcon /></button>
          <button type="button" className={`glossaryMobileBarButton spaceButton ${mobilePanel === 'search' ? 'active' : ''}`} aria-label={t('glossary.searchPlaceholder')} aria-expanded={mobilePanel === 'search'} onClick={() => toggleMobilePanel('search')}><Icon name="magnifer-outline" /></button>
          <button type="button" className={`glossaryMobileBarButton spaceButton ${mobilePanel === 'sort' ? 'active' : ''}`} aria-label={t('glossary.sort')} aria-expanded={mobilePanel === 'sort'} onClick={() => toggleMobilePanel('sort')}><Icon name="tuning-2-light" /></button>
        </div>
      </nav>

      {createArticleOpen && (
        <>
          <GlossaryArticleCreateDialogFrame
            title={t(articleImporting ? 'glossary.importArticle' : 'glossary.newArticle')}
            description={t(articleImporting ? 'glossary.importArticleLead' : 'glossary.newArticleLead')}
            busy={articleSubmitting}
            importing={articleImporting}
            creationChoiceOpen={articleCreationChoiceOpen}
            stepDirection={articleStepDirection}
            primaryLabel={t(articleSubmitting ? (articleImporting ? 'glossary.importingArticle' : 'glossary.creating') : articleImporting ? 'glossary.importArticleSubmit' : 'common.continue')}
            primaryDisabled={articleSubmitting || !articleTitle.trim() || !articleCategoryId || (articleImporting && !articleImportFile)}
            initialFocusRef={articleTitleInputRef}
            onImportBack={showArticleDetailsStep}
            onContinue={() => setArticleCreationChoiceOpen(true)}
            onClose={() => {
              if (articleSubmitting && !createdArticleRef.current) return
              setCreateArticleOpen(false)
              setArticleCreationChoiceOpen(false)
              const createdArticle = createdArticleRef.current
              createdArticleRef.current = null
              if (createdArticle) {
                setActiveArticle(createdArticle)
                setArticleEditing(true)
              }
            }}
          >
            {(closeDialog) => <form id="glossary-article-create-form" ref={articleCreateFormRef} className="glossaryArticleCreateForm mobileHeaderActionForm" onSubmit={(event) => void createArticle(event, closeDialog)}>
              <div className={`glossaryCreationStep ${articleStepDirection === 'forward' ? 'enterFromRight' : ''}`} hidden={!articleImporting}>
                <GlossaryArticleImportStep file={articleImportFile} busy={articleSubmitting} onChange={setArticleImportFile} />
              </div>
              <div className={`glossaryArticleDetailsStep glossaryCreationStep ${articleStepDirection === 'back' ? 'enterFromLeft' : ''}`} hidden={articleImporting}>
                <label className="dialogField"><span>{t('glossary.articleTitle')}</span><input ref={articleTitleInputRef} required maxLength={240} value={articleTitle} onChange={(event) => setArticleTitle(event.target.value)} /></label>
                <label className="dialogField"><span>{t('glossary.articleSynopsisOptional')}</span><textarea rows={3} maxLength={2000} value={articleSynopsis} onChange={(event) => setArticleSynopsis(event.target.value)} /></label>
                <label className="dialogField"><span>{t('glossary.category')}</span><CustomSelect required value={articleCategoryId} onChange={(event) => setArticleCategoryId(event.target.value)}>{scope.categories.map((category) => <option key={category.id} value={category.id}>{categoryLabel(category)}</option>)}</CustomSelect></label>
                <GlossaryImagePicker label={t('glossary.thumbnail')} mode="thumbnail" file={articleThumbnail} onChange={setArticleThumbnail} media={articleThumbnailMedia} onMediaChange={setArticleThumbnailMedia} busy={articleSubmitting && Boolean(articleThumbnail)} />
                <GlossaryImagePicker label={t('glossary.articleCover')} mode="cover" file={articleCover} onChange={setArticleCover} media={articleCoverMedia} onMediaChange={setArticleCoverMedia} busy={articleSubmitting && Boolean(articleCover)} />
              </div>
              <footer>
                {articleImporting ? (
                  <button type="button" className="glossaryDialogImportAction spaceButton" disabled={articleSubmitting} onClick={showArticleDetailsStep}><Icon name="arrow-left-1" /> {t('glossary.importBack')}</button>
                ) : (
                  <button type="button" className="glossaryDialogImportAction spaceButton" disabled={articleSubmitting || !articleTitle.trim() || !articleCategoryId} onClick={showArticleImportStep}><Icon name="archive-up-light" /> {t('glossary.importAction')}</button>
                )}
                <button type="button" className="dialogCancel spaceButton" disabled={articleSubmitting} onClick={closeDialog}>{t('common.cancel')}</button>
                <button type="submit" className="dialogSubmit spaceButton" disabled={articleSubmitting || !articleTitle.trim() || !articleCategoryId || (articleImporting && !articleImportFile)}>{t(articleSubmitting ? (articleImporting ? 'glossary.importingArticle' : 'glossary.creating') : (articleImporting ? 'glossary.importArticleSubmit' : 'glossary.createAndEdit'))}</button>
              </footer>
            </form>}
          </GlossaryArticleCreateDialogFrame>
          <MobileLibraryActionSheet
            open={articleCreationChoiceOpen}
            title={t('glossary.chooseCreationPath')}
            dismissOnSelect
            onClose={() => setArticleCreationChoiceOpen(false)}
            actions={[
              {
                key: 'create',
                label: t('glossary.createArticleChoice'),
                icon: <Icon name="notebook-light" />,
                onSelect: () => {
                  createArticleWithoutImportRef.current = true
                  articleCreateFormRef.current?.requestSubmit()
                },
              },
              {
                key: 'import',
                label: t('glossary.importArticleChoice'),
                icon: <Icon name="archive-up-light" />,
                onSelect: showArticleImportStep,
              },
            ]}
          />
        </>
      )}

      {categoryDialog && (
        <GlossaryCategoryDialogFrame
          title={t(editingCategory ? 'glossary.editCategory' : categoryDialog === 'create' ? 'glossary.newCategory' : 'glossary.manageCategories')}
          description={categoryDialog === 'create' && !editingCategory ? t('glossary.newCategoryLead') : undefined}
          busy={categorySubmitting}
          primaryAction={categoryDialog === 'manage' && !editingCategory ? undefined : {
            label: t(categorySubmitting ? 'common.saving' : 'common.save'),
            icon: <Icon name="diskette-light" />,
            disabled: categorySubmitting || !categoryName.trim(),
            onClick: () => document.querySelector<HTMLFormElement>('#glossary-category-form')?.requestSubmit(),
          }}
          initialFocusRef={categoryDialog === 'manage' && !editingCategory ? undefined : categoryNameInputRef}
          onClose={() => {
            if (categorySubmitting) return
            setCategoryDialog(null)
            setEditingCategory(null)
          }}
        >
          {(closeDialog) => categoryDialog === 'manage' && !editingCategory ? (
            <div className="standardDialogSection glossaryCategoryManager">
              <section className="glossaryCategoryGroup">
                <h3>{t('glossary.systemCategoriesTitle')}</h3>
                <div className="glossaryCategoryRows">
                  {scope.categories.filter((category) => category.systemKey).map((category) => (
                    <div className="glossaryCategoryManagerRow" key={category.id}>
                      <span className="glossaryCategoryManagerIcon"><GlossaryCategoryIcon category={category} /></span>
                      <span className="glossaryCategoryManagerCopy"><strong>{categoryLabel(category)}</strong><small>{t(category.hidden ? 'glossary.categoryHidden' : 'glossary.categoryVisible')}</small></span>
                      <button type="button" className="spaceButton" onClick={() => void toggleSystemCategory(category)}>{t(category.hidden ? 'glossary.show' : 'glossary.hide')}</button>
                    </div>
                  ))}
                </div>
              </section>
              <section className="glossaryCategoryGroup">
                <h3>{t('glossary.customCategoriesTitle')}</h3>
                <div className="glossaryCategoryRows">
                  {scope.categories.filter((category) => !category.systemKey).map((category) => (
                    <div className="glossaryCategoryManagerRow" key={category.id}>
                      <span className="glossaryCategoryManagerIcon"><GlossaryCategoryIcon category={category} /></span>
                      <span className="glossaryCategoryManagerCopy"><strong>{category.name}</strong><small>{t('glossary.customCategory')}</small></span>
                      <button type="button" className="spaceButton" onClick={() => openEditCategory(category)}>{t('glossary.edit')}</button>
                    </div>
                  ))}
                  {!scope.categories.some((category) => !category.systemKey) && <p className="glossaryCategoryManagerEmpty">{t('glossary.noCustomCategories')}</p>}
                </div>
              </section>
              <footer className="standardDialogFooter">
                <button type="button" className="dialogCancel spaceButton" onClick={closeDialog}>{t('common.close')}</button>
              </footer>
            </div>
          ) : (
            <form id="glossary-category-form" className="glossaryCategoryForm mobileHeaderActionForm" onSubmit={(event) => void saveCategory(event, closeDialog)}>
              <label className="dialogField"><span>{t('glossary.categoryName')}</span><input ref={categoryNameInputRef} required maxLength={80} value={categoryName} onChange={(event) => setCategoryName(event.target.value)} /></label>
              <label className="dialogField"><span>{t('glossary.categoryDescriptionOptional')}</span><textarea rows={3} maxLength={500} value={categoryDescription} onChange={(event) => setCategoryDescription(event.target.value)} /></label>
              <label className="dialogField"><span>{t('glossary.searchIcons')}</span><input value={iconSearch} onChange={(event) => { setIconSearch(event.target.value); setIconLimit(ICON_PAGE_SIZE) }} /></label>
              <div className="glossaryIconChooser">
                <div className="glossaryIconPicker">
                  {filteredCategoryIcons.slice(0, iconLimit).map(([id, Component]) => <button key={id} type="button" className={`spaceButton ${categoryIcon === id ? 'active' : ''}`} aria-label={t('glossary.selectIcon')} aria-pressed={categoryIcon === id} onClick={() => setCategoryIcon(id)}><Component aria-hidden="true" /></button>)}
                </div>
                {filteredCategoryIcons.length > iconLimit && <button type="button" className="glossaryLoadMoreIcons spaceButton" onClick={() => setIconLimit((limit) => limit + ICON_PAGE_SIZE)}>{t('glossary.loadMoreIcons')}</button>}
                <small className="glossaryIconAttribution">
                  <a href="https://game-icons.net/" target="_blank" rel="noreferrer">{t('glossary.gameIconsAttribution')}</a>
                  {' · '}
                  <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer">CC BY 3.0</a>
                </small>
              </div>
              {editingCategory && <button type="button" className="glossaryMobileCategoryDanger spaceButton" disabled={categorySubmitting} onClick={() => setDeletingCategory(editingCategory)}><Icon name="trash-bin-trash-light" />{t('common.delete')}</button>}
              <footer>
                {editingCategory && <button type="button" className="glossaryDialogDangerAction dialogSubmit danger spaceButton" disabled={categorySubmitting} onClick={() => setDeletingCategory(editingCategory)}>{t('common.delete')}</button>}
                <button type="button" className="dialogCancel spaceButton" onClick={closeDialog}>{t('common.cancel')}</button>
                <button type="submit" className="dialogSubmit spaceButton" disabled={categorySubmitting || !categoryName.trim()}>{t('common.save')}</button>
              </footer>
            </form>
          )}
        </GlossaryCategoryDialogFrame>
      )}

      {deletingCategory && (
        <ActionDialog
          variant="structured"
          role="alertdialog"
          title={t('glossary.deleteCategory')}
          closeLabel={t('common.close')}
          busy={categorySubmitting}
          className="glossaryConfirmDialog"
          onClose={() => !categorySubmitting && setDeletingCategory(null)}
        >
          <div className="standardDialogSection">
            <p>{t('glossary.deleteCategoryLead', { name: deletingCategory.name })}</p>
            <footer className="standardDialogFooter">
              <button type="button" className="dialogCancel spaceButton" disabled={categorySubmitting} onClick={() => setDeletingCategory(null)}>{t('common.cancel')}</button>
              <button type="button" className="dialogSubmit danger spaceButton" disabled={categorySubmitting} onClick={() => void deleteCategory(deletingCategory)}>{t(categorySubmitting ? 'account.deleting' : 'common.delete')}</button>
            </footer>
          </div>
        </ActionDialog>
      )}
    </section>
  )
}
