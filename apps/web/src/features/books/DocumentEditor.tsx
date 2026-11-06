import {
  type CSSProperties,
  forwardRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { TextAlign } from '@tiptap/extension-text-align'
import { Focus } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/react'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest, apiUpload } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { Manuscript } from './ManuscriptTypes'
import {
  collaborationFlushEndpoint,
  collaborationTicketEndpoint,
  documentEndpoint,
  editorAssetUrl,
  type ManuscriptAccessMode,
} from './ManuscriptEndpoints'
import type { EditorPreferences } from './EditorPreferences'
import type { EditorDocument } from './ManuscriptEditorPage'
import { SceneBreak } from './SceneBreak'
import { SmartTyping } from './SmartTyping'
import { ResizableIllustration } from './ResizableIllustration'
import {
  ImageUploadPlaceholder,
  removeImageUploadPlaceholder,
  replaceImageUploadPlaceholder,
  showImageUploadPlaceholder,
} from './ImageUploadPlaceholder'
import { StorageImagePickerDialog } from '../shared/StorageImagePickerDialog'
import { ActionDialog } from '../shared/ActionDialog'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import type { StorageItem } from '../../types'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { AnnotationAnchor, setAnnotationPresentation } from './AnnotationAnchor'
import type { AnnotationDraft, DocumentAnnotation } from './Annotations'
import {
  contentHash,
  createOfflineDocument,
  deleteOfflineDocument,
  putOfflineDocument,
} from './OfflineDocuments'
import type { EditorConnectionState, OfflineDocument } from './OfflineDocuments'
import { illustrationProjection } from './IllustrationProjection'
import {
  createSpellcheckExtension,
  refreshSpellcheck,
  setSpellcheckEnabled,
} from './spellcheck/SpellcheckExtension'
import { SpellcheckProvider } from './spellcheck/SpellcheckProvider'
import { SpellcheckPopup } from './spellcheck/SpellcheckPopup'
import { SpellcheckDictionaryDialog } from './spellcheck/SpellcheckDictionaryDialog'
import type {
  SpellcheckLexicon,
  SpellcheckCustomWord,
  SpellcheckPopupTarget,
  SpellcheckStatus,
} from './spellcheck/SpellcheckTypes'
import {
  getCachedSpellcheckLexicon,
  putCachedSpellcheckLexicon,
} from './spellcheck/OfflineSpellcheckLexicon'
import { useLiveCollaboration, waitForCollaborationSync } from './LiveCollaboration'

type SaveStatus = 'saved' | 'dirty' | 'saving' | 'offline' | 'error'
type EditorMode = 'edit' | 'view'
type MobileToolbarLevel = 'main' | 'format'
type MobileSettingsSheet = 'font-size' | 'smart-quotes' | 'spellcheck'
const OFFLINE_UI_GRACE_MS = 600
const mobileEditorQuery = '(max-width: 520px)'

const ReadOnlyIllustrations = Extension.create({
  name: 'readOnlyIllustrations',
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction: (transaction, state) => (
        !transaction.docChanged
        || isChangeOrigin(transaction)
        || JSON.stringify(illustrationProjection(state.doc.toJSON()))
          === JSON.stringify(illustrationProjection(transaction.doc.toJSON()))
      ),
      props: {
        handleClickOn: (_view, _position, node) => node.type.name === 'illustration',
      },
    })]
  },
})

function subscribeToMobileEditor(callback: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(mobileEditorQuery)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

function getMobileEditorSnapshot() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(mobileEditorQuery).matches
    : false
}

function MobileEditorSettingsDialog({ children, onClose, title, closeLabel, backLabel }: {
  children: ReactNode
  onClose: () => void
  title: string
  closeLabel: string
  backLabel: string
}) {
  const { backdropStateClass, close, closing } = useMobileDialogTransition({ onClose })

  return (
    <ActionDialog
      variant="structured"
      title={title}
      closeLabel={closeLabel}
      mobileBackLabel={backLabel}
      mobileBackAction={close}
      className="editorMobileSettingsDialog mobileFullView"
      backdropClassName={`editorMobileSettingsBackdrop mobileFullViewBackdrop ${backdropStateClass}`}
      busy={closing}
      onClose={close}
    >
      {children}
    </ActionDialog>
  )
}

function getServerMobileEditorSnapshot() {
  return false
}

type ManuscriptAsset = {
  id: string
  alt: string
  caption: string
}

type PendingSave = {
  content: JSONContent
  localRevision: number
}

type DocumentEditorProps = {
  manuscript: Manuscript
  documentItemId: string | null
  documentTitle: string
  userId: number
  document: EditorDocument
  initialOfflineDocument: OfflineDocument | null
  syncBlocked: boolean
  initialPreferences: EditorPreferences
  onManuscriptChange: (manuscript: Manuscript) => void
  onDocumentTitleChange: (title: string) => Promise<void>
  onError: (error: string) => void
  annotations: DocumentAnnotation[]
  activeAnnotationId: string | null
  onActiveAnnotationChange: (annotationId: string | null) => void
  onStartAnnotation: (draft: AnnotationDraft) => void
  onAnnotationDeleted: (annotationId: string) => void
  onAnnotationPositionsChange: (positions: Record<string, number>) => void
  onOpenComments: (annotationId?: string) => void
  onOpenContents: () => void
  contentsOpen: boolean
  onShare: () => void
  onComments: () => void
  onVersions: () => void
  onExport: () => void
  onConnectionStateChange: (state: EditorConnectionState) => void
  onSaveConflict: (content: JSONContent) => void
  onAnnotationsChanged: () => void
  onCollaborationEpochStale: (content: JSONContent, hasUnsyncedChanges: boolean) => void
  accessMode?: ManuscriptAccessMode
  onAccessLost?: () => void
}

export type DocumentEditorHandle = {
  startAnnotation: () => boolean
  focusAnnotation: (annotationId: string) => void
  clearAnnotationFocus: (annotationId: string) => void
  deleteAnnotation: (annotationId: string) => Promise<boolean>
  applyAnnotation: (annotationId: string) => boolean
  prepareVersionAction: () => Promise<number | null>
  prepareConflictResolution: () => Promise<void>
}

export const DocumentEditor = forwardRef<DocumentEditorHandle, DocumentEditorProps>(function DocumentEditor({
  manuscript,
  documentItemId,
  documentTitle,
  userId,
  document: initialDocument,
  initialOfflineDocument,
  syncBlocked,
  initialPreferences,
  onManuscriptChange,
  onDocumentTitleChange,
  onError,
  annotations,
  activeAnnotationId,
  onActiveAnnotationChange,
  onStartAnnotation,
  onAnnotationDeleted,
  onAnnotationPositionsChange,
  onOpenComments,
  onOpenContents,
  contentsOpen,
  onShare,
  onComments,
  onVersions,
  onExport,
  onConnectionStateChange,
  onSaveConflict,
  onAnnotationsChanged,
  onCollaborationEpochStale,
  accessMode = 'owner',
  onAccessLost,
}, ref) {
  const { t, i18n } = useTranslation()
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(
    initialDocument.syncMode === 'collaborative'
      ? 'saving'
      : initialOfflineDocument ? 'dirty' : 'saved',
  )
  const registeredEditor = accessMode === 'editor'
  const collaborative = initialDocument.syncMode === 'collaborative'
  const [connectionState, setConnectionState] = useState<EditorConnectionState>(
    collaborative
      ? 'syncing'
      : syncBlocked
      ? 'conflict'
      : initialOfflineDocument
        ? navigator.onLine ? 'syncing' : 'offline'
        : navigator.onLine ? 'online' : 'offline',
  )
  const connectionStateRef = useRef(connectionState)
  const [titleSaveStatus, setTitleSaveStatus] = useState<SaveStatus | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(documentTitle)
  const [formatMenuOpen, setFormatMenuOpen] = useState(false)
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<EditorMode>('edit')
  const [focusMode, setFocusMode] = useState(false)
  const [typewriterMode, setTypewriterMode] = useState(false)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)
  const [mobileToolbarLevel, setMobileToolbarLevel] = useState<MobileToolbarLevel>('main')
  const [mobileAnnotationAvailable, setMobileAnnotationAvailable] = useState(false)
  const [mobileFormatSheetOpen, setMobileFormatSheetOpen] = useState(false)
  const [mobileSettingsSheet, setMobileSettingsSheet] = useState<MobileSettingsSheet | null>(null)
  const [assetUploading, setAssetUploading] = useState(false)
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [editorInitialPreferences] = useState(() => initialPreferences)
  const [preferences, setPreferences] = useState(initialPreferences)
  const [spellcheckStatus, setSpellcheckStatus] = useState<SpellcheckStatus>('disabled')
  const [spellcheckLexicon, setSpellcheckLexicon] = useState<SpellcheckLexicon | null>(null)
  const [spellcheckPopup, setSpellcheckPopup] = useState<SpellcheckPopupTarget | null>(null)
  const [spellcheckSuggestions, setSpellcheckSuggestions] = useState<string[]>([])
  const [spellcheckSuggestionsLoading, setSpellcheckSuggestionsLoading] = useState(false)
  const [spellcheckDictionaryOpen, setSpellcheckDictionaryOpen] = useState(false)
  const [editorRevision, renderToolbar] = useState(0)
  const generationRef = useRef(initialDocument.saveGeneration)
  const latestContentRef = useRef(initialDocument.content)
  const localRevisionRef = useRef(initialOfflineDocument?.localRevision ?? 0)
  const offlineDocumentRef = useRef(initialOfflineDocument)
  const pendingSaveRef = useRef<PendingSave | null>(initialOfflineDocument ? {
    content: initialOfflineDocument.content,
    localRevision: initialOfflineDocument.localRevision,
  } : null)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const saveErrorVisibleRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const localSaveTimerRef = useRef<number | null>(null)
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve())
  const localStorageFailedRef = useRef(false)
  const flushSaveRef = useRef<() => Promise<void>>(async () => {})
  const formatMenuRef = useRef<HTMLDivElement>(null)
  const statusPopoverRef = useRef<HTMLDivElement>(null)
  const focusStatusPopoverRef = useRef<HTMLDivElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const cancelTitleEditRef = useRef(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const assetInputRef = useRef<HTMLInputElement>(null)
  const latestPreferencesRef = useRef(initialPreferences)
  const persistedPreferencesRef = useRef(initialPreferences)
  const preferencesSequenceRef = useRef(0)
  const preferencesQueueRef = useRef<Promise<void>>(Promise.resolve())
  const annotationSelectionRef = useRef<{
    from: number
    to: number
    quote: string
  } | null>(null)
  const suppressedMobileAnnotationSelectionRef = useRef<{ from: number; to: number } | null>(null)
  const annotationScrollFrameRef = useRef<number | null>(null)
  const typewriterScrollFrameRef = useRef<number | null>(null)
  const typewriterModeRef = useRef(false)
  const editorCanvasRef = useRef<HTMLDivElement>(null)
  const spellcheckProvider = useMemo(() => new SpellcheckProvider(), [])
  const spellcheckPopupSequenceRef = useRef(0)
  const isMobile = useSyncExternalStore(
    subscribeToMobileEditor,
    getMobileEditorSnapshot,
    getServerMobileEditorSnapshot,
  )
  const onErrorRef = useRef(onError)
  const onOpenCommentsRef = useRef(onOpenComments)
  const annotationCallbacksRef = useRef({
    onActiveAnnotationChange,
    onAnnotationPositionsChange,
  })
  const liveCollaboration = useLiveCollaboration({
    enabled: collaborative,
    userId,
    document: initialDocument,
    persistent: !registeredEditor,
    ticketEndpoint: collaborationTicketEndpoint(manuscript, documentItemId, accessMode),
    onConnectionState: (state) => {
      connectionStateRef.current = state
      setConnectionState(state)
    },
    onSaveStatus: setSaveStatus,
    onError,
    onAccessLost,
    onAnnotationsChanged,
    onEpochStale: (hasUnsyncedChanges) => {
      onCollaborationEpochStale(latestContentRef.current, hasUnsyncedChanges)
    },
  })

  useEffect(() => {
    annotationCallbacksRef.current = { onActiveAnnotationChange, onAnnotationPositionsChange }
  }, [onActiveAnnotationChange, onAnnotationPositionsChange])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    onOpenCommentsRef.current = onOpenComments
  }, [onOpenComments])

  const openSpellcheckPopup = useCallback((target: SpellcheckPopupTarget) => {
    const sequence = spellcheckPopupSequenceRef.current + 1
    spellcheckPopupSequenceRef.current = sequence
    setSpellcheckPopup(target)
    setSpellcheckSuggestions([])
    setSpellcheckSuggestionsLoading(true)
    void spellcheckProvider.suggest(target.word)
      .then((suggestions) => {
        if (spellcheckPopupSequenceRef.current === sequence) setSpellcheckSuggestions(suggestions)
      })
      .catch(() => {
        if (spellcheckPopupSequenceRef.current === sequence) setSpellcheckSuggestions([])
      })
      .finally(() => {
        if (spellcheckPopupSequenceRef.current === sequence) setSpellcheckSuggestionsLoading(false)
      })
  }, [spellcheckProvider])

  const handleSpellcheckError = useCallback((error: Error) => {
    spellcheckPopupSequenceRef.current += 1
    setSpellcheckPopup(null)
    setSpellcheckStatus('error')
    onErrorRef.current(error.message)
  }, [])

  useEffect(() => {
    onConnectionStateChange(connectionState)
  }, [connectionState, onConnectionStateChange])

  const editorExtensions = useMemo(
    () => [
      StarterKit.configure({
        blockquote: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        heading: { levels: [1, 2, 3] },
        horizontalRule: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        trailingNode: false,
        underline: false,
        undoRedo: collaborative ? false : {},
      }),
      TextAlign.configure({
        types: ['paragraph', 'heading'],
        alignments: ['left', 'center', 'right'],
        defaultAlignment: 'left',
      }),
      SceneBreak,
      registeredEditor
        ? ResizableIllustration.configure({
            assetUrl: (assetId: string) => editorAssetUrl(manuscript.id, assetId),
            readOnly: true,
          })
        : ResizableIllustration,
      ...(registeredEditor ? [ReadOnlyIllustrations] : []),
      ImageUploadPlaceholder,
      AnnotationAnchor,
      Focus.configure({ className: 'typewriterActive', mode: 'deepest' }),
      SmartTyping.configure({ preferences: editorInitialPreferences }),
      // The factory stores these callbacks for later ProseMirror events; it does not invoke them during render.
      // eslint-disable-next-line react-hooks/refs
      createSpellcheckExtension({
        provider: spellcheckProvider,
        onOpen: openSpellcheckPopup,
        onError: handleSpellcheckError,
      }),
      ...(collaborative && liveCollaboration.ydoc && liveCollaboration.provider && liveCollaboration.identity
        ? [
            Collaboration.configure({
              document: liveCollaboration.ydoc,
              field: 'default',
              provider: liveCollaboration.provider,
            }),
            CollaborationCaret.configure({
              provider: liveCollaboration.provider,
              user: liveCollaboration.identity,
            }),
          ]
        : []),
    ],
    [
      collaborative,
      editorInitialPreferences,
      handleSpellcheckError,
      liveCollaboration.identity,
      liveCollaboration.provider,
      liveCollaboration.ydoc,
      manuscript.id,
      openSpellcheckPopup,
      registeredEditor,
      spellcheckProvider,
    ],
  )

  const scheduleSave = useCallback((delay = 1000) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => void flushSaveRef.current(), delay)
  }, [])

  const persistOfflineDocument = useCallback((document: OfflineDocument) => {
    if (registeredEditor) return
    offlineDocumentRef.current = document
    persistenceQueueRef.current = persistenceQueueRef.current
      .catch(() => undefined)
      .then(() => putOfflineDocument(document))
      .catch(() => {
        localStorageFailedRef.current = true
        if (!mountedRef.current) return
        setConnectionState('local-error')
        setSaveStatus('error')
        onError('offline_storage_failed')
      })
  }, [onError, registeredEditor])

  const scheduleLocalPersistence = useCallback((document: OfflineDocument) => {
    offlineDocumentRef.current = document
    if (localSaveTimerRef.current !== null) window.clearTimeout(localSaveTimerRef.current)
    localSaveTimerRef.current = window.setTimeout(() => {
      localSaveTimerRef.current = null
      persistOfflineDocument(document)
    }, 200)
  }, [persistOfflineDocument])

  const stageContent = useCallback((content: JSONContent) => {
    const localRevision = localRevisionRef.current + 1
    localRevisionRef.current = localRevision
    if (registeredEditor) {
      pendingSaveRef.current = { content, localRevision }
      return localRevision
    }
    const document = createOfflineDocument(
      userId,
      manuscript.id,
      documentItemId,
      initialDocument.schemaVersion,
      content,
      localRevision,
      generationRef.current,
      offlineDocumentRef.current?.lastAttemptHash ?? null,
    )
    scheduleLocalPersistence(document)
    pendingSaveRef.current = { content, localRevision }
    return localRevision
  }, [documentItemId, initialDocument.schemaVersion, manuscript.id, registeredEditor, scheduleLocalPersistence, userId])

  const flushSave = useCallback(async () => {
    if (collaborative) return
    if (savingRef.current || !pendingSaveRef.current || syncBlocked) return
    if (!navigator.onLine) {
      if (mountedRef.current) {
        setConnectionState('offline')
        setSaveStatus('offline')
      }
      scheduleSave(5000)
      return
    }
    const submitted = pendingSaveRef.current
    pendingSaveRef.current = null
    savingRef.current = true
    let requestSucceeded = false
    if (mountedRef.current) {
      setConnectionState(connectionState === 'online' ? 'online' : 'syncing')
      setSaveStatus('saving')
    }
    try {
      if (!registeredEditor && localSaveTimerRef.current !== null) {
        window.clearTimeout(localSaveTimerRef.current)
        localSaveTimerRef.current = null
        if (offlineDocumentRef.current) persistOfflineDocument(offlineDocumentRef.current)
      }
      const submittedHash = registeredEditor ? '' : await contentHash(submitted.content)
      if (!registeredEditor && offlineDocumentRef.current) {
        persistOfflineDocument({
          ...offlineDocumentRef.current,
          lastAttemptHash: submittedHash,
          updatedAt: new Date().toISOString(),
        })
      }
      if (!registeredEditor) await persistenceQueueRef.current
      const payload = await apiRequest<{ document: EditorDocument }>(
        documentEndpoint(manuscript, documentItemId, accessMode),
        {
          method: 'PUT',
          invalidateQueryCache: false,
          body: JSON.stringify({
            content: submitted.content,
            schemaVersion: initialDocument.schemaVersion,
            expectedGeneration: generationRef.current,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }),
        },
      )
      requestSucceeded = true
      generationRef.current = payload.document.saveGeneration
      if (mountedRef.current) {
        if (saveErrorVisibleRef.current) {
          saveErrorVisibleRef.current = false
          onError('')
        }
        setConnectionState('online')
        setSaveStatus(pendingSaveRef.current ? 'dirty' : 'saved')
      }
    } catch (err) {
      if (!pendingSaveRef.current) pendingSaveRef.current = submitted
      if (mountedRef.current) {
        if (err instanceof ApiError && err.status === 404 && registeredEditor) {
          onAccessLost?.()
        } else if (err instanceof ApiError && err.status === 409) {
          setConnectionState('conflict')
          setSaveStatus('error')
          setEditingTitle(false)
          setFormatMenuOpen(false)
          setSettingsOpen(false)
          onSaveConflict(pendingSaveRef.current.content)
        } else if (!(err instanceof ApiError)) {
          setConnectionState(localStorageFailedRef.current ? 'local-error' : 'offline')
          setSaveStatus(localStorageFailedRef.current ? 'error' : 'offline')
          setEditingTitle(false)
          setFormatMenuOpen(false)
          setSettingsOpen(false)
          scheduleSave(5000)
        } else {
          saveErrorVisibleRef.current = true
          setSaveStatus('error')
          onError(err.message)
        }
      }
    } finally {
      savingRef.current = false
      if (requestSucceeded && !registeredEditor) {
        const pending = pendingSaveRef.current
        if (pending && offlineDocumentRef.current) {
          persistOfflineDocument({
            ...offlineDocumentRef.current,
            confirmedGeneration: generationRef.current,
            updatedAt: new Date().toISOString(),
          })
          if (mountedRef.current) scheduleSave(1000)
          else void flushSaveRef.current()
        } else {
          offlineDocumentRef.current = null
          persistenceQueueRef.current = persistenceQueueRef.current
            .catch(() => undefined)
            .then(() => deleteOfflineDocument(userId, manuscript.id, documentItemId))
        }
      }
    }
  }, [
    collaborative,
    connectionState,
    accessMode,
    documentItemId,
    initialDocument.schemaVersion,
    manuscript,
    onError,
    onAccessLost,
    onSaveConflict,
    persistOfflineDocument,
    registeredEditor,
    scheduleSave,
    syncBlocked,
    userId,
  ])

  useEffect(() => {
    flushSaveRef.current = flushSave
  }, [flushSave])

  useEffect(() => {
    if (collaborative) return
    let active = true
    let probeTimer: number | null = null
    let offlineUiTimer: number | null = null

    function clearOfflineUiTimer() {
      if (offlineUiTimer === null) return
      window.clearTimeout(offlineUiTimer)
      offlineUiTimer = null
    }

    async function resumeSaving() {
      if (!active || syncBlocked || !navigator.onLine) return
      if (pendingSaveRef.current) {
        scheduleSave(0)
        return
      }
      try {
        await apiRequest(documentEndpoint(manuscript, documentItemId, accessMode))
        if (active) {
          setConnectionState('online')
          setSaveStatus('saved')
        }
      } catch (err) {
        if (!active) return
        if (err instanceof ApiError && err.status === 404 && registeredEditor) {
          onAccessLost?.()
          return
        }
        if (err instanceof ApiError) {
          setConnectionState('online')
          return
        }
        setConnectionState('offline')
        probeTimer = window.setTimeout(() => void resumeSaving(), 5000)
      }
    }
    function enterOfflineMode() {
      clearOfflineUiTimer()
      offlineUiTimer = window.setTimeout(() => {
        offlineUiTimer = null
        if (!active || navigator.onLine) return
        setConnectionState(localStorageFailedRef.current ? 'local-error' : 'offline')
        setSaveStatus(localStorageFailedRef.current ? 'error' : 'offline')
        setEditingTitle(false)
        setTitleDraft(documentTitle)
        setFormatMenuOpen(false)
        setSettingsOpen(false)
      }, OFFLINE_UI_GRACE_MS)
    }
    function handleOnline() {
      clearOfflineUiTimer()
      void resumeSaving()
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', enterOfflineMode)
    if (pendingSaveRef.current) void resumeSaving()
    return () => {
      active = false
      clearOfflineUiTimer()
      if (probeTimer !== null) window.clearTimeout(probeTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', enterOfflineMode)
    }
  }, [accessMode, collaborative, documentItemId, documentTitle, manuscript, manuscript.id, onAccessLost, registeredEditor, scheduleSave, syncBlocked])

  useEffect(() => {
    mountedRef.current = true
    function persistLatestContent() {
      if (registeredEditor || collaborative) return
      const latest = offlineDocumentRef.current
      if (!latest) return
      if (localSaveTimerRef.current !== null) {
        window.clearTimeout(localSaveTimerRef.current)
        localSaveTimerRef.current = null
      }
      persistOfflineDocument({ ...latest, updatedAt: new Date().toISOString() })
    }
    function persistWhenHidden() {
      if (document.visibilityState === 'hidden') persistLatestContent()
    }
    window.addEventListener('pagehide', persistLatestContent)
    document.addEventListener('visibilitychange', persistWhenHidden)
    return () => {
      mountedRef.current = false
      window.removeEventListener('pagehide', persistLatestContent)
      document.removeEventListener('visibilitychange', persistWhenHidden)
      if (annotationScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(annotationScrollFrameRef.current)
      }
      if (typewriterScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(typewriterScrollFrameRef.current)
      }
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      if (pendingSaveRef.current) persistLatestContent()
      if (pendingSaveRef.current && !savingRef.current && navigator.onLine) {
        void flushSaveRef.current()
      }
    }
  }, [collaborative, persistOfflineDocument, registeredEditor])

  useEffect(() => {
    if (saveStatus === 'saved') return
    function warnAboutUnsavedChanges(event: BeforeUnloadEvent) {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warnAboutUnsavedChanges)
    return () => window.removeEventListener('beforeunload', warnAboutUnsavedChanges)
  }, [saveStatus])

  useEffect(() => {
    if (!formatMenuOpen) return
    function closeFormatMenu(event: MouseEvent) {
      if (!formatMenuRef.current?.contains(event.target as Node)) setFormatMenuOpen(false)
    }
    function closeFormatMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setFormatMenuOpen(false)
    }
    document.addEventListener('mousedown', closeFormatMenu)
    document.addEventListener('keydown', closeFormatMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeFormatMenu)
      document.removeEventListener('keydown', closeFormatMenuOnEscape)
    }
  }, [formatMenuOpen])

  useEffect(() => {
    if (!statusPopoverOpen) return
    function closeStatusPopover(event: MouseEvent) {
      const target = event.target as Node
      if (!statusPopoverRef.current?.contains(target)
        && !focusStatusPopoverRef.current?.contains(target)) setStatusPopoverOpen(false)
    }
    function closeStatusPopoverOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setStatusPopoverOpen(false)
    }
    document.addEventListener('mousedown', closeStatusPopover)
    document.addEventListener('keydown', closeStatusPopoverOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeStatusPopover)
      document.removeEventListener('keydown', closeStatusPopoverOnEscape)
    }
  }, [statusPopoverOpen])

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select()
  }, [editingTitle])

  useEffect(() => {
    if (!settingsOpen || isMobile) return
    function closeSettings(event: MouseEvent) {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false)
    }
    function closeSettingsOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('mousedown', closeSettings)
    document.addEventListener('keydown', closeSettingsOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeSettings)
      document.removeEventListener('keydown', closeSettingsOnEscape)
    }
  }, [isMobile, settingsOpen])

  const centerTypewriterSelection = useCallback((currentEditor: Editor) => {
    if (typewriterScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(typewriterScrollFrameRef.current)
    }
    typewriterScrollFrameRef.current = window.requestAnimationFrame(() => {
      typewriterScrollFrameRef.current = null
      const canvas = editorCanvasRef.current
      if (!canvas || currentEditor.isDestroyed) return
      const { selection } = currentEditor.state
      const topLevelPosition = selection.$from.depth > 0
        ? selection.$from.before(1)
        : selection.from
      const domNode = currentEditor.view.nodeDOM(topLevelPosition)
      const block = domNode instanceof HTMLElement
        ? domNode
        : domNode?.parentElement
      if (!block) return
      const canvasRect = canvas.getBoundingClientRect()
      const blockRect = block.getBoundingClientRect()
      const targetCenter = blockRect.height <= canvas.clientHeight * 0.6
        ? blockRect.top + blockRect.height / 2
        : currentEditor.view.coordsAtPos(selection.head).top
      canvas.scrollTop += targetCenter - (canvasRect.top + canvasRect.height / 2)
    })
  }, [])

  const editor = useEditor({
    injectCSS: false,
    extensions: editorExtensions,
    content: collaborative ? undefined : initialDocument.content,
    editable: (!collaborative || liveCollaboration.ready) && !syncBlocked && (
      !registeredEditor || connectionState === 'online'
    ),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'tiptapEditor',
        spellcheck: 'false',
        'aria-label': t('documentEditor.manuscriptText', { title: documentTitle }),
      },
      handleClick: (_view, _position, event) => {
        const element = (event.target as HTMLElement).closest<HTMLElement>('[data-annotation-id]')
        const annotationId = element?.dataset.annotationId
        if (!annotationId) return false
        annotationCallbacksRef.current.onActiveAnnotationChange(annotationId)
        onOpenCommentsRef.current(annotationId)
        return false
      },
    },
    onUpdate: ({ editor: currentEditor, transaction, appendedTransactions }) => {
      if (!transaction.docChanged && !appendedTransactions.some((candidate) => candidate.docChanged)) return
      const content = currentEditor.getJSON()
      latestContentRef.current = content
      if (collaborative) {
        setSaveStatus(
          connectionStateRef.current === 'offline'
            ? 'offline'
            : liveCollaboration.provider?.hasUnsyncedChanges ? 'saving' : 'saved',
        )
      } else {
        stageContent(content)
        setSaveStatus('dirty')
        scheduleSave(1000)
      }
      renderToolbar((value) => value + 1)
      annotationCallbacksRef.current.onAnnotationPositionsChange(
        collectAnnotationPositions(currentEditor),
      )
      if (typewriterModeRef.current) centerTypewriterSelection(currentEditor)
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      renderToolbar((value) => value + 1)
      const selection = currentEditor.state.selection
      const anchorMark = selection.$from.marks().find((mark) => mark.type.name === 'annotationAnchor')
      annotationCallbacksRef.current.onActiveAnnotationChange(anchorMark?.attrs.annotationId ?? null)
      if (selection.empty) {
        suppressedMobileAnnotationSelectionRef.current = null
        setMobileAnnotationAvailable(false)
      } else {
        const suppressedSelection = suppressedMobileAnnotationSelectionRef.current
        const quote = currentEditor.state.doc.textBetween(selection.from, selection.to, '\n').trim()
        if (
          suppressedSelection
          && suppressedSelection.from === selection.from
          && suppressedSelection.to === selection.to
        ) {
          setMobileAnnotationAvailable(false)
        } else {
          suppressedMobileAnnotationSelectionRef.current = null
          setMobileAnnotationAvailable(Boolean(quote) && quote.length <= 20_000)
        }
      }
      if (typewriterModeRef.current) centerTypewriterSelection(currentEditor)
    },
    onTransaction: ({ transaction }) => {
      if (!transaction.docChanged) return
      if (annotationSelectionRef.current) {
        annotationSelectionRef.current = {
          from: transaction.mapping.map(annotationSelectionRef.current.from, 1),
          to: transaction.mapping.map(annotationSelectionRef.current.to, -1),
          quote: annotationSelectionRef.current.quote,
        }
      }
      if (suppressedMobileAnnotationSelectionRef.current) {
        suppressedMobileAnnotationSelectionRef.current = {
          from: transaction.mapping.map(suppressedMobileAnnotationSelectionRef.current.from, 1),
          to: transaction.mapping.map(suppressedMobileAnnotationSelectionRef.current.to, -1),
        }
      }
    },
    onBlur: () => {
      if (collaborative) liveCollaboration.provider?.flushPendingUpdates()
      else if (pendingSaveRef.current) scheduleSave(0)
    },
  }, [collaborative, editorExtensions, liveCollaboration.ready])

  useEffect(() => {
    let active = true
    if (!preferences.spellcheckEnabled) {
      spellcheckProvider.terminate()
      if (editor && !editor.isDestroyed) setSpellcheckEnabled(editor, false)
      return () => { active = false }
    }

    if (editor && !editor.isDestroyed) setSpellcheckEnabled(editor, false)
    spellcheckProvider.terminate()
    queueMicrotask(() => { if (active) setSpellcheckStatus('loading') })
    async function initializeSpellcheck() {
      let lexicon: SpellcheckLexicon
      if (registeredEditor) {
        lexicon = {
          scope: { type: 'manuscript', id: manuscript.id },
          revision: '',
          customWords: [],
          glossaryTerms: [],
        }
      } else if (navigator.onLine) {
        try {
          const payload = await apiRequest<{ lexicon: SpellcheckLexicon }>(
            `/api/manuscripts/${manuscript.id}/spellcheck-lexicon/`,
          )
          lexicon = payload.lexicon
          void putCachedSpellcheckLexicon(userId, manuscript.id, lexicon).catch(() => undefined)
        } catch (error) {
          const cached = await getCachedSpellcheckLexicon(userId, manuscript.id).catch(() => null)
          if (!cached) throw error
          lexicon = cached
        }
      } else {
        lexicon = await getCachedSpellcheckLexicon(userId, manuscript.id).catch(() => null) ?? {
          scope: { type: 'manuscript', id: manuscript.id },
          revision: '',
          customWords: [],
          glossaryTerms: [],
        }
      }
      await spellcheckProvider.initialize(lexicon, preferences.spellcheckDictionary)
      if (!active) return
      setSpellcheckLexicon(lexicon)
      setSpellcheckStatus('ready')
      if (editor && !editor.isDestroyed) refreshSpellcheck(editor)
    }
    void initializeSpellcheck().catch((error) => {
      if (!active) return
      handleSpellcheckError(error instanceof Error ? error : new Error('spellcheck_worker_failed'))
      if (editor && !editor.isDestroyed) refreshSpellcheck(editor)
    })
    return () => { active = false }
  }, [editor, handleSpellcheckError, manuscript.id, preferences.spellcheckDictionary, preferences.spellcheckEnabled, registeredEditor, spellcheckProvider, userId])

  useEffect(() => {
    const enabled = preferences.spellcheckEnabled
      && spellcheckStatus === 'ready'
      && editorMode === 'edit'
    if (!enabled) {
      spellcheckPopupSequenceRef.current += 1
    }
    if (editor && !editor.isDestroyed) setSpellcheckEnabled(editor, enabled)
  }, [editor, editorMode, preferences.spellcheckEnabled, spellcheckStatus])

  useEffect(() => () => spellcheckProvider.terminate(), [spellcheckProvider])

  const closeSpellcheckPopup = useCallback(() => {
    spellcheckPopupSequenceRef.current += 1
    setSpellcheckPopup(null)
    setSpellcheckSuggestionsLoading(false)
    if (editor && !editor.isDestroyed) editor.view.dom.focus({ preventScroll: true })
  }, [editor])

  const applySpellcheckLexicon = useCallback(async (lexicon: SpellcheckLexicon) => {
    setSpellcheckLexicon(lexicon)
    await spellcheckProvider.updateLexicon(lexicon)
    void putCachedSpellcheckLexicon(userId, manuscript.id, lexicon).catch(() => undefined)
    if (editor && !editor.isDestroyed) refreshSpellcheck(editor)
  }, [editor, manuscript.id, spellcheckProvider, userId])

  function replaceMisspelledWord(suggestion: string) {
    if (!editor || !spellcheckPopup || editorMode !== 'edit') return
    const current = editor.state.doc.textBetween(spellcheckPopup.from, spellcheckPopup.to)
    if (current !== spellcheckPopup.word) {
      closeSpellcheckPopup()
      return
    }
    const transaction = editor.state.tr.insertText(
      suggestion,
      spellcheckPopup.from,
      spellcheckPopup.to,
    )
    transaction.setSelection(TextSelection.create(
      transaction.doc,
      spellcheckPopup.from + suggestion.length,
    ))
    editor.view.dispatch(transaction)
    closeSpellcheckPopup()
  }

  async function addPopupWord() {
    if (registeredEditor || !spellcheckPopup || !spellcheckLexicon || connectionState !== 'online') return
    try {
      const payload = await apiRequest<{ word: SpellcheckCustomWord }>(
        `/api/manuscripts/${manuscript.id}/spellcheck-lexicon/words/`,
        { method: 'POST', body: JSON.stringify({ word: spellcheckPopup.word }) },
      )
      const customWords = spellcheckLexicon.customWords.some((item) => item.id === payload.word.id)
        ? spellcheckLexicon.customWords
        : [...spellcheckLexicon.customWords, payload.word]
      await applySpellcheckLexicon({
        ...spellcheckLexicon,
        revision: new Date().toISOString(),
        customWords,
      })
      onError('')
      closeSpellcheckPopup()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'spellcheck_word_add_failed')
    }
  }

  useEffect(() => {
    editor?.setOptions({
      editorProps: {
        attributes: {
          class: 'tiptapEditor',
          spellcheck: 'false',
          'aria-label': t('documentEditor.manuscriptText', { title: documentTitle }),
        },
      },
    })
  }, [documentTitle, editor, i18n.resolvedLanguage, t])

  useEffect(() => {
    typewriterModeRef.current = typewriterMode
  }, [typewriterMode])

  useEffect(() => {
    if (!focusMode) return
    function exitFocusModeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      typewriterModeRef.current = false
      setFocusMode(false)
      setTypewriterMode(false)
      setStatusPopoverOpen(false)
    }
    document.addEventListener('keydown', exitFocusModeOnEscape)
    return () => document.removeEventListener('keydown', exitFocusModeOnEscape)
  }, [focusMode])

  useEffect(() => {
    if (editor) onAnnotationPositionsChange(collectAnnotationPositions(editor))
  }, [editor, onAnnotationPositionsChange])

  useEffect(() => {
    if (!editor) return
    setAnnotationPresentation(
      editor,
      activeAnnotationId,
      annotations
        .filter((annotation) => annotation.status === 'resolved')
        .map((annotation) => annotation.id),
    )
  }, [activeAnnotationId, annotations, editor, editorRevision])

  useEffect(() => {
    editor?.commands.setSmartTypingPreferences(preferences)
  }, [editor, preferences])

  const onlineActionsDisabled = connectionState !== 'online' || syncBlocked
  const textMutationDisabled = editorMode === 'view' || (registeredEditor && onlineActionsDisabled)
  const historyCommandsReady = editor?.extensionManager.extensions.some(
    (extension) => extension.name === (collaborative ? 'collaboration' : 'undoRedo'),
  ) ?? false
  const canUndo = historyCommandsReady
    && !textMutationDisabled
    && (editor?.can().chain().focus().undo().run() ?? false)
  const canRedo = historyCommandsReady
    && !textMutationDisabled
    && (editor?.can().chain().focus().redo().run() ?? false)

  function undo() {
    if (!historyCommandsReady) return
    editor?.chain().focus().undo().run()
  }

  function redo() {
    if (!historyCommandsReady) return
    editor?.chain().focus().redo().run()
  }
  const plainText = editor?.getText({ blockSeparator: '\n' }) ?? ''
  const wordCount = plainText.match(/\S+/gu)?.length ?? 0
  const characterCount = Array.from(plainText).length
  const authorSheets = characterCount / 40_000
  const combinedSaveStatus = titleSaveStatus ?? saveStatus
  const activeBlockLabel = editor?.isActive('heading', { level: 1 })
    ? t('documentEditor.heading', { level: 1 })
    : editor?.isActive('heading', { level: 2 })
      ? t('documentEditor.heading', { level: 2 })
      : editor?.isActive('heading', { level: 3 })
        ? t('documentEditor.heading', { level: 3 })
        : t('documentEditor.paragraph')
  const activeIllustration = editor?.isActive('illustration')
    ? editor.getAttributes('illustration') as {
        assetId: string
        alt: string
        caption: string
        alignment: 'left' | 'center' | 'right'
        displayWidth: number
      }
    : null
  const illustrationResizeAllowed = !registeredEditor && editorMode === 'edit' && !onlineActionsDisabled && !focusMode

  useEffect(() => {
    if (!registeredEditor || !editor || editor.isDestroyed) return
    editor.setEditable(editorMode === 'edit' && connectionState === 'online' && !syncBlocked, false)
  }, [connectionState, editor, editorMode, registeredEditor, syncBlocked])

  async function flushBeforeView() {
    if (collaborative) {
      if (!liveCollaboration.provider || connectionState !== 'online') return false
      try {
        await waitForCollaborationSync(liveCollaboration.provider)
        const payload = await apiRequest<{ document: EditorDocument }>(
          collaborationFlushEndpoint(manuscript, documentItemId, accessMode),
          { method: 'POST', invalidateQueryCache: false },
        )
        generationRef.current = payload.document.saveGeneration
        return true
      } catch (error) {
        onError(error instanceof Error ? error.message : 'collaboration_unavailable')
        return false
      }
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    while (savingRef.current) await new Promise((resolve) => window.setTimeout(resolve, 25))
    await flushSaveRef.current()
    while (savingRef.current) await new Promise((resolve) => window.setTimeout(resolve, 25))
    return pendingSaveRef.current === null
  }

  async function prepareConflictResolution() {
    if (collaborative) {
      liveCollaboration.provider?.disconnect()
      return
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (localSaveTimerRef.current !== null) {
      window.clearTimeout(localSaveTimerRef.current)
      localSaveTimerRef.current = null
    }
    pendingSaveRef.current = null
    offlineDocumentRef.current = null
    await persistenceQueueRef.current.catch(() => undefined)
  }

  function startAnnotation() {
    if (!editor || editorMode === 'view' || onlineActionsDisabled) return false
    const { from, to, empty } = editor.state.selection
    if (empty) return false
    const quote = editor.state.doc.textBetween(from, to, '\n').trim()
    if (!quote || quote.length > 20_000) return false
    annotationSelectionRef.current = { from, to, quote }
    onStartAnnotation({ quote })
    if (!isMobile) onOpenComments()
    return true
  }

  function applyAnnotation(annotationId: string) {
    if (!editor || !annotationSelectionRef.current) return false
    const { from, to, quote } = annotationSelectionRef.current
    if (from >= to || to > editor.state.doc.content.size) return false
    if (editor.state.doc.textBetween(from, to, '\n').trim() !== quote) return false
    const mark = editor.schema.marks.annotationAnchor.create({ annotationId })
    suppressedMobileAnnotationSelectionRef.current = { from, to }
    setMobileAnnotationAvailable(false)
    let transaction = editor.state.tr
    editor.state.doc.nodesBetween(from, to, (node, position) => {
      if (!node.isText) return
      const markFrom = Math.max(from, position)
      const markTo = Math.min(to, position + node.nodeSize)
      if (markFrom < markTo) transaction = transaction.addMark(markFrom, markTo, mark)
    })
    transaction = transaction
      .setSelection(TextSelection.create(transaction.doc, from, to))
    editor.view.dispatch(transaction)
    editor.view.dom.focus({ preventScroll: true })
    annotationSelectionRef.current = null
    onActiveAnnotationChange(annotationId)
    onAnnotationPositionsChange(collectAnnotationPositions(editor))
    return true
  }

  function focusAnnotation(annotationId: string) {
    if (!editor) return
    let from: number | null = null
    let to: number | null = null
    editor.state.doc.descendants((node, position) => {
      if (!node.isText) return
      if (!node.marks.some(
        (mark) => mark.type.name === 'annotationAnchor'
          && mark.attrs.annotationId === annotationId,
      )) return
      from = from === null ? position : Math.min(from, position)
      to = to === null ? position + node.nodeSize : Math.max(to, position + node.nodeSize)
    })
    if (from === null || to === null) return
    const selectionFrom = from
    const selectionTo = to
    onActiveAnnotationChange(annotationId)
    if (annotationScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(annotationScrollFrameRef.current)
    }
    annotationScrollFrameRef.current = window.requestAnimationFrame(() => {
      annotationScrollFrameRef.current = null
      if (editor.isDestroyed) return
      editor.view.dom.focus({ preventScroll: true })
      const transaction = editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, selectionFrom, selectionTo),
      )
      editor.view.dispatch(transaction)
      annotationScrollFrameRef.current = window.requestAnimationFrame(() => {
        annotationScrollFrameRef.current = null
        if (editor.isDestroyed) return
        const selector = `[data-annotation-id="${CSS.escape(annotationId)}"]`
        const anchor = editor.view.dom.querySelector<HTMLElement>(selector)
        const canvas = editorCanvasRef.current
        if (!anchor || !canvas) return
        const anchorRect = anchor.getBoundingClientRect()
        const canvasRect = canvas.getBoundingClientRect()
        canvas.scrollTop += anchorRect.top
          - canvasRect.top
          - (canvas.clientHeight - anchorRect.height) / 2
      })
    })
  }

  function clearAnnotationFocus(annotationId: string) {
    if (!editor) return
    let anchorEnd: number | null = null
    editor.state.doc.descendants((node, position) => {
      if (!node.isText || !node.marks.some(
        (mark) => mark.type.name === 'annotationAnchor'
          && mark.attrs.annotationId === annotationId,
      )) return
      anchorEnd = Math.max(anchorEnd ?? 0, position + node.nodeSize)
    })
    if (anchorEnd !== null) {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchorEnd)),
      )
    }
  }

  async function deleteAnnotation(annotationId: string) {
    if (!editor || onlineActionsDisabled || !(await flushBeforeView())) return false
    try {
      if (collaborative) {
        const markType = editor.schema.marks.annotationAnchor
        let transaction = editor.state.tr
        editor.state.doc.descendants((node, position) => {
          if (!node.isText) return
          for (const mark of node.marks) {
            if (mark.type === markType && mark.attrs.annotationId === annotationId) {
              transaction = transaction.removeMark(position, position + node.nodeSize, mark)
            }
          }
        })
        editor.view.dispatch(transaction)
        await waitForCollaborationSync(liveCollaboration.provider!)
      }
      const payload = await apiRequest<{ document: EditorDocument }>(
        accessMode === 'editor'
          ? `/api/editor/manuscripts/${manuscript.id}/annotations/${annotationId}/`
          : `/api/manuscripts/annotations/${annotationId}/`,
        {
          method: 'DELETE',
          body: JSON.stringify(collaborative ? {} : {
            expectedGeneration: generationRef.current,
          }),
        },
      )
      generationRef.current = payload.document.saveGeneration
      if (!collaborative) {
        const markType = editor.schema.marks.annotationAnchor
        let transaction = editor.state.tr
        editor.state.doc.descendants((node, position) => {
          if (!node.isText) return
          for (const mark of node.marks) {
            if (mark.type === markType && mark.attrs.annotationId === annotationId) {
              transaction = transaction.removeMark(position, position + node.nodeSize, mark)
            }
          }
        })
        editor.view.dispatch(transaction)
      }
      onAnnotationDeleted(annotationId)
      onActiveAnnotationChange(null)
      return true
    } catch (err) {
      if (registeredEditor && err instanceof ApiError && err.status === 404) {
        onAccessLost?.()
        return false
      }
      onError(err instanceof Error ? err.message : i18n.t('documentEditor.deleteAnnotationFailed'))
      return false
    }
  }

  useImperativeHandle(ref, () => ({
    startAnnotation,
    focusAnnotation,
    clearAnnotationFocus,
    deleteAnnotation,
    applyAnnotation,
    prepareConflictResolution,
    prepareVersionAction: async () => (
      await flushBeforeView() ? generationRef.current : null
    ),
  }))

  function enterFocusMode() {
    titleInputRef.current?.blur()
    setFormatMenuOpen(false)
    setSettingsOpen(false)
    setStatusPopoverOpen(false)
    setFocusMode(true)
    window.requestAnimationFrame(() => editor?.view.dom.focus({ preventScroll: true }))
  }

  function exitFocusMode() {
    typewriterModeRef.current = false
    setTypewriterMode(false)
    setFocusMode(false)
    setStatusPopoverOpen(false)
  }

  function toggleTypewriterMode() {
    if (!editor || editorMode === 'view') return
    const enabled = !typewriterMode
    typewriterModeRef.current = enabled
    setTypewriterMode(enabled)
    if (!enabled) {
      if (typewriterScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(typewriterScrollFrameRef.current)
        typewriterScrollFrameRef.current = null
      }
      return
    }
    editor.view.dom.focus({ preventScroll: true })
    centerTypewriterSelection(editor)
  }

  async function toggleEditorMode() {
    if (!editor || onlineActionsDisabled) return
    if (editorMode === 'view') {
      editor.setEditable(true, false)
      setEditorMode('edit')
      return
    }
    setFormatMenuOpen(false)
    spellcheckPopupSequenceRef.current += 1
    setSpellcheckPopup(null)
    if (!(await flushBeforeView())) return
    typewriterModeRef.current = false
    setTypewriterMode(false)
    editor.setEditable(false, false)
    setEditorMode('view')
  }

  async function uploadIllustration(file: File | undefined) {
    if (!file || onlineActionsDisabled) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      onError('asset_type_unsupported')
      return
    }
    if (!editor) return
    const placeholderId = showImageUploadPlaceholder(editor, t('uploads.processingImage'))
    setAssetUploading(true)
    try {
      const form = new FormData()
      form.set('image', file)
      const payload = await apiUpload<{ asset: ManuscriptAsset }>(
        `/api/manuscripts/${manuscript.id}/assets/`,
        form,
      )
      replaceImageUploadPlaceholder(editor, placeholderId, [
        {
          type: 'illustration',
          attrs: {
            assetId: payload.asset.id,
            alt: payload.asset.alt,
            caption: payload.asset.caption,
            alignment: 'center',
            displayWidth: 80,
          },
        },
        { type: 'paragraph' },
      ])
      onError('')
    } catch (err) {
      if (!editor.isDestroyed) removeImageUploadPlaceholder(editor, placeholderId)
      onError(err instanceof Error ? err.message : i18n.t('documentEditor.uploadIllustrationFailed'))
    } finally {
      setAssetUploading(false)
      if (assetInputRef.current) assetInputRef.current.value = ''
    }
  }

  async function selectStoredIllustration(item: StorageItem) {
    if (onlineActionsDisabled || assetUploading || !editor) return
    const placeholderId = showImageUploadPlaceholder(editor, t('uploads.processingImage'))
    setAssetUploading(true)
    try {
      const form = new FormData()
      form.set('mediaId', item.id.replace(/^media:/, ''))
      const payload = await apiUpload<{ asset: ManuscriptAsset }>(`/api/manuscripts/${manuscript.id}/assets/`, form)
      replaceImageUploadPlaceholder(editor, placeholderId, [{ type: 'illustration', attrs: { assetId: payload.asset.id, alt: payload.asset.alt, caption: payload.asset.caption, alignment: 'center', displayWidth: 80 } }, { type: 'paragraph' }])
      setAssetPickerOpen(false)
      onError('')
    } catch (err) {
      if (!editor.isDestroyed) removeImageUploadPlaceholder(editor, placeholderId)
      onError(err instanceof Error ? err.message : i18n.t('documentEditor.uploadIllustrationFailed'))
    } finally {
      setAssetUploading(false)
    }
  }

  function updateIllustration(attributes: Partial<NonNullable<typeof activeIllustration>>) {
    editor?.commands.updateAttributes('illustration', attributes)
  }

  async function saveIllustrationMetadata() {
    if (onlineActionsDisabled) return
    const attributes = editor?.getAttributes('illustration') as typeof activeIllustration
    if (!attributes?.assetId) return
    try {
      await apiRequest(`/api/manuscripts/assets/${attributes.assetId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ alt: attributes.alt, caption: attributes.caption }),
      })
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n.t('documentEditor.saveIllustrationFailed'))
    }
  }

  function applyBlockFormat(format: 'paragraph' | 1 | 2 | 3) {
    if (!editor || textMutationDisabled) return
    if (format === 'paragraph') editor.chain().focus().setParagraph().run()
    else editor.chain().focus().setHeading({ level: format }).run()
    setFormatMenuOpen(false)
  }

  function beginTitleEdit() {
    if (onlineActionsDisabled) return
    setTitleDraft(documentTitle)
    setEditingTitle(true)
    setTitleSaveStatus(null)
  }

  function cancelTitleEdit() {
    cancelTitleEditRef.current = true
    setTitleDraft(documentTitle)
    setTitleSaveStatus(null)
    titleInputRef.current?.blur()
  }

  async function saveTitle() {
    if (onlineActionsDisabled) return
    if (cancelTitleEditRef.current) {
      cancelTitleEditRef.current = false
      setEditingTitle(false)
      return
    }
    const title = titleDraft.trim()
    setEditingTitle(false)
    if (!title) {
      setTitleDraft(documentTitle)
      setTitleSaveStatus('error')
      onError('oneshot_title_required')
      return
    }
    if (title === documentTitle) {
      setTitleSaveStatus(null)
      return
    }
    setTitleSaveStatus('saving')
    try {
      if (manuscript.kind === 'book') {
        await onDocumentTitleChange(title)
        setTitleDraft(title)
      } else {
        const payload = await apiRequest<{ manuscript: Manuscript }>(
          `/api/manuscripts/${manuscript.id}/`,
          { method: 'PATCH', body: JSON.stringify({ title }) },
        )
        setTitleDraft(payload.manuscript.title)
        onManuscriptChange(payload.manuscript)
      }
      setTitleSaveStatus(null)
      if (saveStatus !== 'error') onError('')
    } catch (err) {
      setTitleSaveStatus('error')
      onError(err instanceof Error ? err.message : i18n.t('documentEditor.renameFailed'))
    }
  }

  function updatePreferences(patch: Partial<EditorPreferences>) {
    if (onlineActionsDisabled) return
    if (
      patch.spellcheckEnabled === false
      || (patch.spellcheckDictionary && patch.spellcheckDictionary !== preferences.spellcheckDictionary)
    ) {
      spellcheckPopupSequenceRef.current += 1
      setSpellcheckPopup(null)
      if (patch.spellcheckEnabled === false) {
        setSpellcheckLexicon(null)
        setSpellcheckStatus('disabled')
      }
    }
    const nextPreferences = { ...latestPreferencesRef.current, ...patch }
    const sequence = preferencesSequenceRef.current + 1
    preferencesSequenceRef.current = sequence
    latestPreferencesRef.current = nextPreferences
    setPreferences(nextPreferences)
    preferencesQueueRef.current = preferencesQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const payload = await apiRequest<{ preferences: EditorPreferences }>(
          registeredEditor ? '/api/editor/preferences/' : '/api/manuscripts/editor-preferences/',
          { method: 'PATCH', body: JSON.stringify(nextPreferences) },
        )
        persistedPreferencesRef.current = payload.preferences
        if (mountedRef.current && preferencesSequenceRef.current === sequence) {
          latestPreferencesRef.current = payload.preferences
          setPreferences(payload.preferences)
          onError('')
        }
      })
      .catch((err) => {
        if (mountedRef.current && preferencesSequenceRef.current === sequence) {
          latestPreferencesRef.current = persistedPreferencesRef.current
          setPreferences(persistedPreferencesRef.current)
          onError(err instanceof Error ? err.message : i18n.t('documentEditor.saveSettingsFailed'))
        }
      })
  }

  function renderSettingsControls() {
    return (
      <>
        <button type="button" className="editorMobileSettingLink spaceButton" onClick={() => setMobileSettingsSheet('font-size')}>
          <span>
            <strong>{t('documentEditor.fontSize')}</strong>
            <small>{t('documentEditor.fontSizeLead')}</small>
          </span>
          <Icon name="arrow-right-2" />
        </button>
        <button type="button" className="editorMobileSettingLink spaceButton" onClick={() => setMobileSettingsSheet('smart-quotes')}>
          <span>
            <strong>{t('documentEditor.smartQuotes')}</strong>
            <small>{t('documentEditor.smartQuotesLead')}</small>
          </span>
          <Icon name="arrow-right-2" />
        </button>
        <div className="editorMobileSettingToggle">
          <span>
            <strong>{t('documentEditor.capitalize')}</strong>
            <small>{t('documentEditor.capitalizeLead')}</small>
          </span>
          <button
            type="button"
            role="switch"
            className="editorMobileSwitch spaceButton"
            aria-checked={preferences.autoCapitalize}
            aria-label={t('documentEditor.capitalize')}
            onClick={() => updatePreferences({ autoCapitalize: !preferences.autoCapitalize })}
          >
            <span />
          </button>
        </div>
        <div className="editorMobileSettingToggle">
          <span>
            <strong>{t('documentEditor.autoReplace')}</strong>
            <small>{t('documentEditor.autoReplaceLead')}</small>
          </span>
          <button
            type="button"
            role="switch"
            className="editorMobileSwitch spaceButton"
            aria-checked={preferences.autoReplace}
            aria-label={t('documentEditor.autoReplace')}
            onClick={() => updatePreferences({ autoReplace: !preferences.autoReplace })}
          >
            <span />
          </button>
        </div>
        <button type="button" className="editorMobileSettingLink spaceButton" onClick={() => setMobileSettingsSheet('spellcheck')}>
          <span>
            <strong>{t('spellcheck.setting')}</strong>
            <small>{t('spellcheck.settingLead')}</small>
            {preferences.spellcheckEnabled && <small className={`spellcheckSettingStatus ${spellcheckStatus}`}>{t(`spellcheck.status.${spellcheckStatus}`)}</small>}
          </span>
          <Icon name="arrow-right-2" />
        </button>
      </>
    )
  }

  return (
    <main
      className={`editorPanel ${!registeredEditor && editorMode === 'edit' && activeIllustration ? 'hasIllustrationControls' : ''} ${illustrationResizeAllowed ? 'illustrationResizeEnabled' : ''} ${focusMode ? 'focusMode' : ''} ${typewriterMode ? 'typewriterMode' : ''}`}
    >
      <header className="editorDocumentHeader">
        <button
          type="button"
          className={`editorMobileContentsButton spaceButton ${contentsOpen ? 'active' : ''}`}
          aria-label={t('editorShell.openContents')}
          aria-expanded={contentsOpen}
          onClick={onOpenContents}
          disabled={onlineActionsDisabled}
        >
          <Icon name="sidebar-minimalistic-light" />
        </button>
        <div className="editorDocumentTitle">
          {registeredEditor ? (
            <span className="documentTitleButton editorAccessDocumentTitle">{documentTitle}</span>
          ) : editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              maxLength={240}
              aria-label={t('documentEditor.documentTitle')}
              onChange={(event) => {
                setTitleDraft(event.target.value)
                setTitleSaveStatus('dirty')
              }}
              onBlur={() => void saveTitle()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') cancelTitleEdit()
              }}
            />
          ) : (
            <button
              type="button"
              className="documentTitleButton spaceButton"
              title={t('documentEditor.renameDocument')}
              onClick={beginTitleEdit}
              disabled={editorMode === 'view' || onlineActionsDisabled}
            >
              {titleSaveStatus === 'saving' ? titleDraft.trim() : documentTitle}
            </button>
          )}
          {!isMobile && (
            <SaveStatusIndicator
              status={combinedSaveStatus}
              open={statusPopoverOpen}
              containerRef={statusPopoverRef}
              onToggle={() => setStatusPopoverOpen((isOpen) => !isOpen)}
            />
          )}
        </div>
        <div className="editorHeaderPlaceholders">
          {!registeredEditor && <button type="button" className="editorShareButton spaceButton" onClick={onShare} disabled={onlineActionsDisabled}><Icon name="share-light" />{t('documentEditor.share')}</button>}
        </div>
        <button
          type="button"
          className={`editorMobileActionsButton spaceButton ${mobileActionsOpen ? 'active' : ''}`}
          aria-label={t('documentEditor.documentActions')}
          aria-haspopup="dialog"
          aria-expanded={mobileActionsOpen}
          onClick={() => setMobileActionsOpen(true)}
        >
          <Icon name="menu-dots-light" />
        </button>
      </header>

      <div className="editorToolbar" aria-label={t('documentEditor.toolbar')}>
        <div className="formatSelector" ref={formatMenuRef}>
          <button
            type="button"
            className="spaceButton formatSelectorButton"
            aria-haspopup="menu"
            aria-expanded={formatMenuOpen}
            onClick={() => setFormatMenuOpen((isOpen) => !isOpen)}
            disabled={!editor || textMutationDisabled}
          >
            {activeBlockLabel}
            <Icon name={formatMenuOpen ? 'arrow-up-2' : 'arrow-down-2'} />
          </button>
          {formatMenuOpen && (
            <div className="formatDropdown" role="menu">
              <button
                type="button"
                className={`spaceButton ${editor?.isActive('paragraph') ? 'active' : ''}`}
                role="menuitem"
                onClick={() => applyBlockFormat('paragraph')}
              >
                {t('documentEditor.paragraph')}
              </button>
              {[1, 2, 3].map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`spaceButton headingOption heading${level} ${editor?.isActive('heading', { level }) ? 'active' : ''}`}
                  role="menuitem"
                  onClick={() => applyBlockFormat(level as 1 | 2 | 3)}
                >
                  {t('documentEditor.heading', { level })}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="toolbarDivider" />
        <button
          type="button"
          className={`spaceButton ${editor?.isActive('bold') ? 'active' : ''}`}
          aria-label={t('documentEditor.bold')}
          title={t('documentEditor.boldShortcut')}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          disabled={textMutationDisabled || !editor?.can().chain().focus().toggleBold().run()}
        >
          <Icon name="text-bold-light" />
        </button>
        <button
          type="button"
          className={`spaceButton ${editor?.isActive('italic') ? 'active' : ''}`}
          aria-label={t('documentEditor.italic')}
          title={t('documentEditor.italicShortcut')}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          disabled={textMutationDisabled || !editor?.can().chain().focus().toggleItalic().run()}
        >
          <Icon name="text-italic-light" />
        </button>
        <button
          type="button"
          className={`spaceButton ${editor?.isActive('strike') ? 'active' : ''}`}
          aria-label={t('documentEditor.strikethrough')}
          title={t('documentEditor.strikethrough')}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
          disabled={textMutationDisabled || !editor?.can().chain().focus().toggleStrike().run()}
        >
          <Icon name="text-cross-light" />
        </button>
        <span className="toolbarDivider" />
        <button
          type="button"
          className={`spaceButton toolbarIconButton ${editor?.isActive({ textAlign: 'left' }) ? 'active' : ''}`}
          aria-label={t('documentEditor.alignLeft')}
          title={t('documentEditor.alignLeftShortcut')}
          onClick={() => editor?.chain().focus().setTextAlign('left').run()}
          disabled={textMutationDisabled || !editor?.can().chain().focus().setTextAlign('left').run()}
        >
          <Icon name="mingcute-align-left-line" className="mingcuteToolbarIcon" />
        </button>
        <button
          type="button"
          className={`spaceButton toolbarIconButton ${editor?.isActive({ textAlign: 'center' }) ? 'active' : ''}`}
          aria-label={t('documentEditor.alignCenter')}
          title={t('documentEditor.alignCenterShortcut')}
          onClick={() => editor?.chain().focus().setTextAlign('center').run()}
          disabled={textMutationDisabled || !editor?.can().chain().focus().setTextAlign('center').run()}
        >
          <Icon name="mingcute-align-center-line" className="mingcuteToolbarIcon" />
        </button>
        <button
          type="button"
          className={`spaceButton toolbarIconButton ${editor?.isActive({ textAlign: 'right' }) ? 'active' : ''}`}
          aria-label={t('documentEditor.alignRight')}
          title={t('documentEditor.alignRightShortcut')}
          onClick={() => editor?.chain().focus().setTextAlign('right').run()}
          disabled={textMutationDisabled || !editor?.can().chain().focus().setTextAlign('right').run()}
        >
          <Icon name="mingcute-align-right-line" className="mingcuteToolbarIcon" />
        </button>
        <span className="toolbarDivider" />
        <button
          type="button"
          className="spaceButton toolbarIconButton"
          aria-label={t('documentEditor.insertSceneBreak')}
          title={t('documentEditor.insertSceneBreakLead')}
          onClick={() => editor?.chain().focus().insertSceneBreak().run()}
          disabled={textMutationDisabled || !editor?.can().chain().focus().insertSceneBreak().run()}
        >
          <Icon name="mingcute-asterisk-line" className="mingcuteToolbarIcon" />
        </button>
        {!registeredEditor && <button
          type="button"
          className="spaceButton toolbarIconButton"
          aria-label={t('documentEditor.insertIllustration')}
          title={t('documentEditor.insertIllustration')}
          onClick={() => setAssetPickerOpen(true)}
          disabled={!editor || assetUploading || editorMode === 'view' || onlineActionsDisabled}
        >
          <Icon name="gallery-light" />
        </button>}
        {!registeredEditor && <StorageImagePickerDialog open={assetPickerOpen} onClose={() => setAssetPickerOpen(false)} onSelect={(item) => void selectStoredIllustration(item)} onUpload={() => { setAssetPickerOpen(false); assetInputRef.current?.click() }} />}
        <button
          type="button"
          className="spaceButton toolbarIconButton"
          aria-label={t('documentEditor.addComment')}
          title={t('documentEditor.addComment')}
          onClick={startAnnotation}
          disabled={
            !editor
            || editorMode === 'view'
            || onlineActionsDisabled
            || editor.state.selection.empty
          }
        >
          <Icon name="chat-line-light" />
        </button>
        {!registeredEditor && <input
          ref={assetInputRef}
          className="editorAssetInput"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => void uploadIllustration(event.target.files?.[0])}
        />}
        <span className="toolbarDivider" />
        <button
          type="button"
          className="spaceButton toolbarIconButton"
          aria-label={t('documentEditor.undo')}
          title={t('documentEditor.undoShortcut')}
          onClick={undo}
          disabled={!canUndo}
        >
          <Icon name="mingcute-back-2-line" className="mingcuteToolbarIcon" />
        </button>
        <button
          type="button"
          className="spaceButton toolbarIconButton"
          aria-label={t('documentEditor.redo')}
          title={t('documentEditor.redoShortcut')}
          onClick={redo}
          disabled={!canRedo}
        >
          <Icon name="mingcute-forward-2-line" className="mingcuteToolbarIcon" />
        </button>
        <span className="editorToolbarSpacer" />
        <button
          type="button"
          className={`spaceButton editorModeButton ${editorMode === 'view' ? 'active' : ''}`}
          aria-label={t(editorMode === 'edit' ? 'documentEditor.switchToView' : 'documentEditor.switchToEdit')}
          title={t(editorMode === 'edit' ? 'documentEditor.viewMode' : 'documentEditor.editMode')}
          onClick={() => void toggleEditorMode()}
          disabled={!editor || onlineActionsDisabled}
        >
          <Icon name={editorMode === 'edit' ? 'eye-light' : 'edit-light'} />
          <span>{t(editorMode === 'edit' ? 'documentEditor.view' : 'documentEditor.edit')}</span>
        </button>
        <div className="editorSettings" ref={settingsRef}>
          <button
            type="button"
            className={`spaceButton toolbarIconButton ${settingsOpen ? 'active' : ''}`}
            aria-label={t('documentEditor.settings')}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            title={t('documentEditor.settings')}
            onClick={() => setSettingsOpen((isOpen) => !isOpen)}
            disabled={onlineActionsDisabled}
          >
            <Icon name="settings-light" />
          </button>
          {settingsOpen && !isMobile && (
            <div className="editorSettingsPopover" role="dialog" aria-label={t('documentEditor.settings')}>
              <header>
                <strong>{t('documentEditor.settings')}</strong>
              </header>
              <label className="editorSettingRow">
                <span>
                  <strong>{t('documentEditor.fontSize')}</strong>
                  <small>{t('documentEditor.fontSizeLead')}</small>
                </span>
                <CustomSelect
                  value={preferences.fontSize}
                  onChange={(event) => updatePreferences({ fontSize: Number(event.target.value) })}
                >
                  {[14, 16, 18, 20, 22, 24].map((size) => (
                    <option key={size} value={size}>{t('documentEditor.fontSizeOption', { size })}</option>
                  ))}
                </CustomSelect>
              </label>
              <label className="editorSettingToggle">
                <span>
                  <strong>{t('documentEditor.smartQuotes')}</strong>
                  <small>{t('documentEditor.smartQuotesLead')}</small>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.smartQuotes}
                  onChange={(event) => updatePreferences({ smartQuotes: event.target.checked })}
                />
              </label>
              <label className="editorSettingRow nested">
                <span>
                  <strong>{t('documentEditor.quoteStyle')}</strong>
                </span>
                <CustomSelect
                  value={preferences.quoteStyle}
                  disabled={!preferences.smartQuotes}
                  onChange={(event) =>
                    updatePreferences({
                      quoteStyle: event.target.value as EditorPreferences['quoteStyle'],
                    })
                  }
                >
                  <option value="guillemets">«…»</option>
                  <option value="curly">“…”</option>
                </CustomSelect>
              </label>
              <label className="editorSettingToggle">
                <span>
                  <strong>{t('documentEditor.capitalize')}</strong>
                  <small>{t('documentEditor.capitalizeLead')}</small>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.autoCapitalize}
                  onChange={(event) => updatePreferences({ autoCapitalize: event.target.checked })}
                />
              </label>
              <label className="editorSettingToggle">
                <span>
                  <strong>{t('documentEditor.autoReplace')}</strong>
                  <small>{t('documentEditor.autoReplaceLead')}</small>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.autoReplace}
                  onChange={(event) => updatePreferences({ autoReplace: event.target.checked })}
                />
              </label>
              <label className="editorSettingToggle">
                <span>
                  <strong>{t('spellcheck.setting')}</strong>
                  <small>{t('spellcheck.settingLead')}</small>
                  {preferences.spellcheckEnabled && (
                    <small className={`spellcheckSettingStatus ${spellcheckStatus}`}>
                      {t(`spellcheck.status.${spellcheckStatus}`)}
                    </small>
                  )}
                </span>
                <input
                  type="checkbox"
                  checked={preferences.spellcheckEnabled}
                  onChange={(event) => updatePreferences({ spellcheckEnabled: event.target.checked })}
                />
              </label>
              {preferences.spellcheckEnabled && (
                <label className="editorSettingRow nested">
                  <span>
                    <strong>{t('spellcheck.dictionary')}</strong>
                    <small>{t('spellcheck.dictionaryLead')}</small>
                  </span>
                  <CustomSelect
                    value={preferences.spellcheckDictionary}
                    onChange={(event) => updatePreferences({
                      spellcheckDictionary: event.target.value as EditorPreferences['spellcheckDictionary'],
                    })}
                  >
                    <option value="ru">{t('spellcheck.dictionaries.ru')}</option>
                    <option value="en-US">{t('spellcheck.dictionaries.enUs')}</option>
                    <option value="en-GB">{t('spellcheck.dictionaries.enGb')}</option>
                  </CustomSelect>
                </label>
              )}
              {preferences.spellcheckEnabled && !registeredEditor && (
                <div className="editorSettingAction">
                  <button
                    type="button"
                    className="spaceButton"
                    disabled={!spellcheckLexicon || spellcheckStatus !== 'ready'}
                    onClick={() => {
                      setSettingsOpen(false)
                      setSpellcheckDictionaryOpen(true)
                    }}
                  >
                    {t('spellcheck.manageDictionary')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {isMobile && settingsOpen && (
        <MobileEditorSettingsDialog
          title={t('documentEditor.settings')}
          closeLabel={t('common.close')}
          backLabel={t('common.back')}
          onClose={() => {
            setMobileSettingsSheet(null)
            setSettingsOpen(false)
          }}
        >
          <div className="editorMobileSettingsBody">{renderSettingsControls()}</div>
        </MobileEditorSettingsDialog>
      )}

      <MobileLibraryActionSheet
        open={mobileSettingsSheet === 'font-size'}
        title={t('documentEditor.fontSize')}
        dismissOnSelect
        backdropClassName="editorMobileSettingSheetBackdrop"
        onClose={() => setMobileSettingsSheet(null)}
        actions={[14, 16, 18, 20, 22, 24].map((size) => ({
          key: String(size),
          label: t('documentEditor.fontSizeOption', { size }),
          icon: preferences.fontSize === size
            ? <Icon name="check-circle-1-light" />
            : <span className="editorMobileSettingChoicePlaceholder" aria-hidden="true" />,
          selected: preferences.fontSize === size,
          // The sheet invokes this only from its button click handler.
          // eslint-disable-next-line react-hooks/refs
          onSelect: () => updatePreferences({ fontSize: size }),
        }))}
      />

      <MobileLibraryActionSheet
        open={mobileSettingsSheet === 'smart-quotes'}
        title={t('documentEditor.smartQuotes')}
        dismissOnSelect
        backdropClassName="editorMobileSettingSheetBackdrop"
        onClose={() => setMobileSettingsSheet(null)}
        topContent={(
          <div className="editorMobileSettingSheetControls">
            <div className="editorMobileSettingToggle">
              <span>
                <strong>{t('documentEditor.smartQuotes')}</strong>
                <small>{t('documentEditor.smartQuotesLead')}</small>
              </span>
              <button
                type="button"
                role="switch"
                className="editorMobileSwitch spaceButton"
                aria-checked={preferences.smartQuotes}
                aria-label={t('documentEditor.smartQuotes')}
                onClick={() => updatePreferences({ smartQuotes: !preferences.smartQuotes })}
              >
                <span />
              </button>
            </div>
            <strong className={`editorMobileSettingSheetHeading ${preferences.smartQuotes ? '' : 'disabled'}`}>
              {t('documentEditor.quoteStyle')}
            </strong>
          </div>
        )}
          actions={[
          {
            key: 'guillemets',
            label: '«…»',
            icon: preferences.quoteStyle === 'guillemets'
              ? <Icon name="check-circle-1-light" />
              : <span className="editorMobileSettingChoicePlaceholder" aria-hidden="true" />,
            selected: preferences.quoteStyle === 'guillemets',
            disabled: !preferences.smartQuotes,
            onSelect: () => updatePreferences({ quoteStyle: 'guillemets' }),
          },
          {
            key: 'curly',
            label: '“…”',
            icon: preferences.quoteStyle === 'curly'
              ? <Icon name="check-circle-1-light" />
              : <span className="editorMobileSettingChoicePlaceholder" aria-hidden="true" />,
            selected: preferences.quoteStyle === 'curly',
            disabled: !preferences.smartQuotes,
            onSelect: () => updatePreferences({ quoteStyle: 'curly' }),
          },
        ]}
      />

      <MobileLibraryActionSheet
        open={mobileSettingsSheet === 'spellcheck'}
        title={t('spellcheck.setting')}
        dismissOnSelect
        backdropClassName="editorMobileSettingSheetBackdrop"
        onClose={() => setMobileSettingsSheet(null)}
        topContent={(
          <div className="editorMobileSettingSheetControls">
            <div className="editorMobileSettingToggle">
              <span>
                <strong>{t('spellcheck.setting')}</strong>
                <small>{t('spellcheck.settingLead')}</small>
                {preferences.spellcheckEnabled && <small className={`spellcheckSettingStatus ${spellcheckStatus}`}>{t(`spellcheck.status.${spellcheckStatus}`)}</small>}
              </span>
              <button
                type="button"
                role="switch"
                className="editorMobileSwitch spaceButton"
                aria-checked={preferences.spellcheckEnabled}
                aria-label={t('spellcheck.setting')}
                onClick={() => updatePreferences({ spellcheckEnabled: !preferences.spellcheckEnabled })}
              >
                <span />
              </button>
            </div>
            {!registeredEditor && <button
              type="button"
              className="editorMobileSettingManage spaceButton"
              disabled={!spellcheckLexicon || spellcheckStatus !== 'ready'}
              onClick={() => {
                setMobileSettingsSheet(null)
                setSpellcheckDictionaryOpen(true)
              }}
            >
              <span>{t('spellcheck.manageDictionary')}</span>
              <Icon name="arrow-right-2" />
            </button>}
            <div className={`editorMobileSettingSheetHeading ${preferences.spellcheckEnabled ? '' : 'disabled'}`}>
              <strong>{t('spellcheck.dictionary')}</strong>
              <small>{t('spellcheck.dictionaryLead')}</small>
            </div>
          </div>
        )}
        actions={[
          {
            key: 'ru',
            label: t('spellcheck.dictionaries.ru'),
            icon: preferences.spellcheckDictionary === 'ru'
              ? <Icon name="check-circle-1-light" />
              : <span className="editorMobileSettingChoicePlaceholder" aria-hidden="true" />,
            selected: preferences.spellcheckDictionary === 'ru',
            disabled: !preferences.spellcheckEnabled,
            onSelect: () => updatePreferences({ spellcheckDictionary: 'ru' }),
          },
          {
            key: 'en-US',
            label: t('spellcheck.dictionaries.enUs'),
            icon: preferences.spellcheckDictionary === 'en-US'
              ? <Icon name="check-circle-1-light" />
              : <span className="editorMobileSettingChoicePlaceholder" aria-hidden="true" />,
            selected: preferences.spellcheckDictionary === 'en-US',
            disabled: !preferences.spellcheckEnabled,
            onSelect: () => updatePreferences({ spellcheckDictionary: 'en-US' }),
          },
          {
            key: 'en-GB',
            label: t('spellcheck.dictionaries.enGb'),
            icon: preferences.spellcheckDictionary === 'en-GB'
              ? <Icon name="check-circle-1-light" />
              : <span className="editorMobileSettingChoicePlaceholder" aria-hidden="true" />,
            selected: preferences.spellcheckDictionary === 'en-GB',
            disabled: !preferences.spellcheckEnabled,
            onSelect: () => updatePreferences({ spellcheckDictionary: 'en-GB' }),
          },
        ]}
      />

      <MobileLibraryActionSheet
        open={mobileActionsOpen}
        title={documentTitle}
        dismissOnSelect
        onClose={() => setMobileActionsOpen(false)}
        actions={[
          {
            key: 'comments',
            label: t('editorShell.comments'),
            icon: <Icon name="dialog-2-light" />,
            disabled: onlineActionsDisabled,
            onSelect: onComments,
          },
          {
            key: 'versions',
            label: t('editorShell.drafts'),
            icon: <Icon name="history-light" />,
            disabled: onlineActionsDisabled,
            onSelect: onVersions,
          },
          ...(registeredEditor ? [] : [{
            key: 'export',
            label: t('exports.title'),
            icon: <Icon name="download-minimalistic-light" />,
            disabled: onlineActionsDisabled,
            onSelect: onExport,
          }]),
        ]}
        topContent={(
          <div className={`editorMobileQuickActions ${registeredEditor ? 'editorAccess' : ''}`}>
            <button type="button" className="spaceButton" disabled={onlineActionsDisabled} onClick={() => { setMobileActionsOpen(false); setSettingsOpen(true) }}>
              <Icon name="settings-light" />
              <span>{t('documentEditor.settings')}</span>
            </button>
            {!registeredEditor && <button type="button" className="spaceButton" disabled={onlineActionsDisabled} onClick={() => { setMobileActionsOpen(false); onShare() }}>
              <Icon name="share-light" />
              <span>{t('documentEditor.share')}</span>
            </button>}
          </div>
        )}
      />

      {!registeredEditor && editorMode === 'edit' && activeIllustration && !onlineActionsDisabled && (
        <div className="illustrationControls" aria-label={t('documentEditor.illustrationSettings')}>
          <label>
            <span>{t('documentEditor.altText')}</span>
            <input
              value={activeIllustration.alt}
              maxLength={500}
              onChange={(event) => updateIllustration({ alt: event.target.value })}
              onBlur={() => void saveIllustrationMetadata()}
            />
          </label>
          <label>
            <span>{t('documentEditor.caption')}</span>
            <input
              value={activeIllustration.caption}
              maxLength={2000}
              onChange={(event) => updateIllustration({ caption: event.target.value })}
              onBlur={() => void saveIllustrationMetadata()}
            />
          </label>
          <div className="illustrationAlignment" aria-label={t('documentEditor.illustrationAlignment')}>
            {(['left', 'center', 'right'] as const).map((alignment) => (
              <button
                key={alignment}
                type="button"
                className={`spaceButton ${activeIllustration.alignment === alignment ? 'active' : ''}`}
                aria-label={t(`documentEditor.alignIllustration${alignment[0].toUpperCase()}${alignment.slice(1)}`)}
                onClick={() => updateIllustration({ alignment })}
              >
                {alignment === 'left' ? <AlignLeftIcon /> : alignment === 'center' ? <AlignCenterIcon /> : <AlignRightIcon />}
              </button>
            ))}
          </div>
        </div>
      )}

      {isMobile
        && !focusMode
        && editorMode === 'edit'
        && !onlineActionsDisabled
        && !activeIllustration
        && mobileAnnotationAvailable && (
          <button
            type="button"
            className="editorMobileCommentButton spaceButton"
            aria-label={t('documentEditor.addComment')}
            title={t('documentEditor.addComment')}
            onClick={startAnnotation}
          >
            <Icon name="chat-line-light" />
          </button>
        )}

      <div ref={editorCanvasRef} className="editorCanvas">
        <div
          className="editorPaper"
          style={{ '--editor-font-size': `${preferences.fontSize}px` } as CSSProperties}
        >
          <EditorContent editor={editor} />
        </div>
      </div>

      {isMobile && !focusMode && (
        <div className={`editorMobileToolbar level-${mobileToolbarLevel}`} aria-label={t('documentEditor.toolbar')}>
          <div className="editorMobileToolbarLevel">
            <div className="editorMobileToolbarLeading">
              {mobileToolbarLevel === 'main' ? (
                <>
                  <button
                    type="button"
                    className={`spaceButton ${editorMode === 'view' ? 'active' : ''}`}
                    aria-label={t(editorMode === 'edit' ? 'documentEditor.switchToView' : 'documentEditor.switchToEdit')}
                    onClick={() => {
                      setMobileFormatSheetOpen(false)
                      setMobileToolbarLevel('main')
                      void toggleEditorMode()
                    }}
                    disabled={!editor || onlineActionsDisabled}
                  >
                    <Icon name={editorMode === 'edit' ? 'eye-light' : 'edit-light'} />
                  </button>
                  <button
                    type="button"
                    className="spaceButton"
                    aria-label={t('documentEditor.toolbar')}
                    onClick={() => setMobileToolbarLevel('format')}
                    disabled={!editor || textMutationDisabled}
                  >
                    <Icon name="mynaui-type-text" className="mynauiToolbarIcon" />
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="spaceButton editorMobileToolbarBack" aria-label={t('common.back')} onClick={() => { setMobileFormatSheetOpen(false); setMobileToolbarLevel('main') }}>
                    <Icon name="arrow-left-1" />
                  </button>
                  <span className="editorMobileToolbarDivider" />
                  <div className="editorMobileFormatScroll">
                    <button type="button" className={`spaceButton editorMobileBlockStyle ${mobileFormatSheetOpen ? 'active' : ''}`} aria-label={activeBlockLabel} onClick={() => setMobileFormatSheetOpen(true)} disabled={textMutationDisabled}>
                      <Icon name={editor?.isActive('heading', { level: 1 }) ? 'mynaui-heading-1' : editor?.isActive('heading', { level: 2 }) ? 'mynaui-heading-2' : editor?.isActive('heading', { level: 3 }) ? 'mynaui-heading-3' : 'mynaui-type-text'} className="mynauiToolbarIcon" />
                    </button>
                    <span />
                    <button type="button" className={`spaceButton ${editor?.isActive('bold') ? 'active' : ''}`} aria-label={t('documentEditor.bold')} onClick={() => editor?.chain().focus().toggleBold().run()} disabled={textMutationDisabled || !editor?.can().chain().focus().toggleBold().run()}><Icon name="text-bold-light" /></button>
                    <button type="button" className={`spaceButton ${editor?.isActive('italic') ? 'active' : ''}`} aria-label={t('documentEditor.italic')} onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={textMutationDisabled || !editor?.can().chain().focus().toggleItalic().run()}><Icon name="text-italic-light" /></button>
                    <button type="button" className={`spaceButton ${editor?.isActive('strike') ? 'active' : ''}`} aria-label={t('documentEditor.strikethrough')} onClick={() => editor?.chain().focus().toggleStrike().run()} disabled={textMutationDisabled || !editor?.can().chain().focus().toggleStrike().run()}><Icon name="text-cross-light" /></button>
                    <span />
                    <button type="button" className={`spaceButton ${editor?.isActive({ textAlign: 'left' }) ? 'active' : ''}`} aria-label={t('documentEditor.alignLeft')} onClick={() => editor?.chain().focus().setTextAlign('left').run()} disabled={textMutationDisabled || !editor?.can().chain().focus().setTextAlign('left').run()}><Icon name="mingcute-align-left-line" className="mingcuteToolbarIcon" /></button>
                    <button type="button" className={`spaceButton ${editor?.isActive({ textAlign: 'center' }) ? 'active' : ''}`} aria-label={t('documentEditor.alignCenter')} onClick={() => editor?.chain().focus().setTextAlign('center').run()} disabled={textMutationDisabled || !editor?.can().chain().focus().setTextAlign('center').run()}><Icon name="mingcute-align-center-line" className="mingcuteToolbarIcon" /></button>
                    <button type="button" className={`spaceButton ${editor?.isActive({ textAlign: 'right' }) ? 'active' : ''}`} aria-label={t('documentEditor.alignRight')} onClick={() => editor?.chain().focus().setTextAlign('right').run()} disabled={textMutationDisabled || !editor?.can().chain().focus().setTextAlign('right').run()}><Icon name="mingcute-align-right-line" className="mingcuteToolbarIcon" /></button>
                    <span />
                    <button type="button" className="spaceButton" aria-label={t('documentEditor.insertSceneBreak')} onClick={() => editor?.chain().focus().insertSceneBreak().run()} disabled={textMutationDisabled || !editor?.can().chain().focus().insertSceneBreak().run()}><Icon name="mingcute-asterisk-line" className="mingcuteToolbarIcon" /></button>
                    {!registeredEditor && <button type="button" className="spaceButton" aria-label={t('documentEditor.insertIllustration')} onClick={() => setAssetPickerOpen(true)} disabled={!editor || assetUploading || onlineActionsDisabled}><Icon name="gallery-light" /></button>}
                    <span />
                    <button type="button" className="spaceButton" aria-label={t('documentEditor.undo')} onClick={undo} disabled={!canUndo}><Icon name="mingcute-back-2-line" className="mingcuteToolbarIcon" /></button>
                    <button type="button" className="spaceButton" aria-label={t('documentEditor.redo')} onClick={redo} disabled={!canRedo}><Icon name="mingcute-forward-2-line" className="mingcuteToolbarIcon" /></button>
                  </div>
                </>
              )}
            </div>
            <div className="editorMobileToolbarTrailing">
              <SaveStatusIndicator
                status={combinedSaveStatus}
                open={statusPopoverOpen}
                containerRef={statusPopoverRef}
                onToggle={() => setStatusPopoverOpen((isOpen) => !isOpen)}
              />
              {mobileToolbarLevel === 'main' && (
                <>
                  <span className="editorMobileToolbarDivider" />
                  <button type="button" className="spaceButton" aria-label={t('documentEditor.focus')} onClick={enterFocusMode}>
                    <Icon name="eye-scan-light" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <MobileLibraryActionSheet
        open={mobileFormatSheetOpen}
        title={t('documentEditor.textStyle')}
        dismissOnSelect
        onClose={() => setMobileFormatSheetOpen(false)}
        actions={[
          { key: 'paragraph', label: t('documentEditor.paragraph'), icon: <Icon name="mynaui-type-text" className="mynauiToolbarIcon" />, disabled: textMutationDisabled, onSelect: () => applyBlockFormat('paragraph') },
          ...([1, 2, 3] as const).map((level) => ({ key: `heading-${level}`, label: t('documentEditor.heading', { level }), icon: <Icon name={`mynaui-heading-${level}` as IconName} className="mynauiToolbarIcon" />, disabled: textMutationDisabled, onSelect: () => applyBlockFormat(level) })),
        ]}
      />

      <footer className="editorStatusBar">
        <div>
          <span>{t('documentEditor.words', { count: wordCount, formatted: new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en').format(wordCount) })}</span>
          <span>{t('documentEditor.characters', { count: characterCount, formatted: new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en').format(characterCount) })}</span>
          <span>{t('documentEditor.authorSheets', { formatted: new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(authorSheets) })}</span>
        </div>
        <button type="button" className="spaceButton" onClick={enterFocusMode}><Icon name="eye-scan-light" /> {t('documentEditor.focus')}</button>
      </footer>

      {spellcheckPopup && preferences.spellcheckEnabled && editorMode === 'edit' && (
        <SpellcheckPopup
          target={spellcheckPopup}
          suggestions={spellcheckSuggestions}
          loading={spellcheckSuggestionsLoading}
          online={connectionState === 'online'}
          onReplace={replaceMisspelledWord}
          onAdd={() => void addPopupWord()}
          onManage={() => {
            closeSpellcheckPopup()
            setSpellcheckDictionaryOpen(true)
          }}
          onClose={closeSpellcheckPopup}
          canManageDictionary={!registeredEditor}
        />
      )}

      {spellcheckDictionaryOpen && spellcheckLexicon && (
        <SpellcheckDictionaryDialog
          manuscriptId={manuscript.id}
          lexicon={spellcheckLexicon}
          dictionary={preferences.spellcheckDictionary}
          online={connectionState === 'online'}
          onChange={(lexicon) => {
            void applySpellcheckLexicon(lexicon).catch(handleSpellcheckError)
          }}
          onClose={() => setSpellcheckDictionaryOpen(false)}
          onError={onError}
        />
      )}

      {focusMode && (
        <div
          className="focusModeControls"
          aria-label={t('documentEditor.focusControls')}
          onMouseDown={(event) => event.preventDefault()}
        >
          <SaveStatusIndicator
            status={combinedSaveStatus}
            open={statusPopoverOpen}
            containerRef={focusStatusPopoverRef}
            onToggle={() => setStatusPopoverOpen((isOpen) => !isOpen)}
          />
          <button
            type="button"
            className={`spaceButton ${editorMode === 'view' ? 'active' : ''}`}
            aria-label={t(editorMode === 'edit' ? 'documentEditor.switchToView' : 'documentEditor.switchToEdit')}
            title={t(editorMode === 'edit' ? 'documentEditor.viewMode' : 'documentEditor.editMode')}
            onClick={() => void toggleEditorMode()}
            disabled={!editor || onlineActionsDisabled}
          >
            <Icon name={editorMode === 'edit' ? 'eye-light' : 'edit-light'} />
          </button>
          <button
            type="button"
            className={`spaceButton ${typewriterMode ? 'active' : ''}`}
            aria-label={t('documentEditor.typewriterMode')}
            aria-pressed={typewriterMode}
            title={t('documentEditor.typewriterMode')}
            onClick={toggleTypewriterMode}
            disabled={!editor || editorMode === 'view'}
          >
            <Icon name="keyboard-light" />
          </button>
          <button
            type="button"
            className="spaceButton"
            aria-label={t('documentEditor.exitFocus')}
            title={t('documentEditor.exitFocusShortcut')}
            onClick={exitFocusMode}
          >
            <Icon name="eye-scan-light" />
          </button>
        </div>
      )}
    </main>
  )
})

function SaveStatusIndicator({
  status,
  open,
  containerRef,
  onToggle,
}: {
  status: SaveStatus
  open: boolean
  containerRef: RefObject<HTMLDivElement | null>
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const details = {
    saved: { icon: 'cloud-yes' as const, label: t('documentEditor.saved'), description: t('documentEditor.savedLead') },
    dirty: { icon: 'cloud-upload' as const, label: t('documentEditor.dirty'), description: t('documentEditor.dirtyLead') },
    saving: { icon: 'cloud-upload' as const, label: t('documentEditor.saving'), description: t('documentEditor.savingLead') },
    offline: { icon: 'cloud-no' as const, label: t('documentEditor.offline'), description: t('documentEditor.offlineLead') },
    error: { icon: 'cloud-no' as const, label: t('documentEditor.saveFailed'), description: t('documentEditor.saveFailedLead') },
  }[status]
  return (
    <div className="saveStatus" ref={containerRef}>
      <button
        type="button"
        className={`saveStatusButton spaceButton ${status}`}
        aria-label={details.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={details.label}
        onClick={onToggle}
      >
        <Icon name={details.icon} />
      </button>
      {open && (
        <div className="saveStatusPopover" role="status">
          <Icon name={details.icon} />
          <div>
            <strong>{details.label}</strong>
            <span>{details.description}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function AlignLeftIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 10h11M4 14h16M4 18h9" /></svg>
}

function AlignCenterIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 10h10M4 14h16M8 18h8" /></svg>
}

function AlignRightIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 10h11M4 14h16M11 18h9" /></svg>
}

function collectAnnotationPositions(editor: Editor) {
  const positions: Record<string, number> = {}
  editor.state.doc.descendants((node, position) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      if (mark.type.name === 'annotationAnchor' && positions[mark.attrs.annotationId] === undefined) {
        positions[mark.attrs.annotationId] = position
      }
    }
  })
  return positions
}
