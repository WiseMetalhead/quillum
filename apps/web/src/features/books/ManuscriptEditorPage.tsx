import { useCallback, useEffect, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { JSONContent } from '@tiptap/core'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { Manuscript } from './ManuscriptTypes'
import { BookNavigator } from './BookNavigator'
import type { BookTree } from './BookNavigator'
import {
  annotationsEndpoint,
  collaborationReplaceEndpoint,
  documentEndpoint,
  editorAssetUrl,
  manuscriptTreeEndpoint,
  type ManuscriptAccessMode,
} from './ManuscriptEndpoints'
import { DocumentEditor } from './DocumentEditor'
import type { DocumentEditorHandle } from './DocumentEditor'
import { EditorDocumentSkeleton } from './EditorSkeleton'
import type { EditorPreferences } from './EditorPreferences'
import { CommentsPanel } from './CommentsPanel'
import type { AnnotationDraft, DocumentAnnotation } from './Annotations'
import { VersionsPanel } from './VersionsPanel'
import { EditorTasksPanel } from './EditorTasksPanel'
import { EditorNotesPanel } from './EditorNotesPanel'
import { GlossaryInspectorPanel } from './GlossaryInspectorPanel'
import type { PlannerData } from './PlannerTypes'
import { ActionDialog } from '../shared/ActionDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import { ReviewShareDialog, type ReviewShareScopeOption } from './ReviewShareDialog'
import { ManuscriptExportDialog } from './ManuscriptExportDialog'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { DocumentComparison } from './DocumentComparison'
import {
  contentHash,
  createOfflineDocument,
  deleteOfflineDocument,
  getOfflineDocument,
  putOfflineDocument,
} from './OfflineDocuments'
import type { EditorConnectionState, OfflineDocument } from './OfflineDocuments'
import { illustrationProjection } from './IllustrationProjection'

const inspectorTools = [
  { id: 'Comments', icon: 'dialog-2-light', labelKey: 'editorShell.comments' },
  { id: 'Drafts / Revisions', icon: 'history-light', labelKey: 'editorShell.drafts' },
  { id: 'Tasks', icon: 'checklist-minimalistic-light', labelKey: 'editorShell.tasks' },
  { id: 'Notes', icon: 'notes-light', labelKey: 'editorShell.notes' },
  { id: 'Glossary', icon: 'notebook-light', labelKey: 'editorShell.glossary' },
] as const
type InspectorTool = (typeof inspectorTools)[number]['id']

function ResponsiveBookItemCreateDialog({ title, closeLabel, busy, onClose, children }: {
  title: string
  closeLabel: string
  busy: boolean
  onClose: () => void
  children: (close: () => void) => ReactNode
}) {
  const isMobile = useMobileViewport()
  const { backdropStateClass, close, closing } = useMobileDialogTransition({ onClose })
  const dialog = (
    <ActionDialog
      variant="structured"
      title={title}
      closeLabel={closeLabel}
      busy={busy || closing}
      className={`bookItemActionDialog ${isMobile ? 'bookItemCreateSheet' : ''}`}
      backdropClassName={isMobile ? `bookItemCreateBackdrop ${backdropStateClass}` : ''}
      onClose={close}
    >
      {children(close)}
    </ActionDialog>
  )

  return isMobile ? createPortal(dialog, document.body) : dialog
}

function ConflictConfirmationDialog({
  choice,
  busy,
  onClose,
  onConfirm,
}: {
  choice: 'local' | 'server'
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const { backdropStateClass, close, closing } = useMobileDialogTransition({ onClose })
  const unavailable = busy || closing

  return (
    <ActionDialog
      variant="structured"
      role="alertdialog"
      title={t(choice === 'server' ? 'editorShell.confirmServerTitle' : 'editorShell.confirmLocalTitle')}
      closeLabel={t('common.cancel')}
      busy={unavailable}
      className={`conflictConfirmationDialog ${isMobile ? 'bookItemDeleteSheet' : ''}`.trim()}
      backdropClassName={`conflictConfirmationBackdrop ${isMobile ? `bookItemDeleteBackdrop ${backdropStateClass}` : ''}`.trim()}
      onClose={close}
    >
      <div className="standardDialogSection">
        <p>{t(choice === 'server' ? 'editorShell.confirmServerLead' : 'editorShell.confirmLocalLead')}</p>
        <footer className="standardDialogFooter">
          <button type="button" className="dialogCancel spaceButton" disabled={unavailable} onClick={close}>{t('common.cancel')}</button>
          <button type="button" className="dialogSubmit spaceButton" disabled={unavailable} onClick={onConfirm}>
            {t(choice === 'server' ? 'editorShell.confirmUseServer' : 'editorShell.confirmUseLocal')}
          </button>
        </footer>
      </div>
    </ActionDialog>
  )
}

const CONTENTS_MIN_WIDTH = 280
const INSPECTOR_MIN_WIDTH = 340
const EDITOR_MIN_WIDTH = 800
const RESIZER_WIDTH = 6
const INSPECTOR_RAIL_WIDTH = 56
const RESPONSIVE_LAYOUT_BREAKPOINT = 1520
const CONTENTS_COLLAPSED_BREAKPOINT = 1110
const INSPECTOR_REPLACES_CONTENTS_BREAKPOINT = 1450
const RESPONSIVE_EDITOR_MIN_WIDTH = 560

export type EditorDocument = {
  id: string
  content: JSONContent
  schemaVersion: number
  saveGeneration: number
  updatedAt: string
  syncMode: 'legacy' | 'collaborative'
  collaborationEpoch: number | null
  collaborationRoom: string | null
  collaborationMaterialization: 'ready' | 'failed'
}

type ManuscriptEditorPageProps = {
  userId: number
  manuscript: Manuscript
  initialDocumentItemId: string | null
  initialDialog: 'share' | 'export' | null
  initialAnnotationId: string | null
  onManuscriptChange: (manuscript: Manuscript) => void
  onError: (error: string) => void
  onMessage: (message: string) => void
  onOfflineModeChange: (offline: boolean) => void
  accessMode?: ManuscriptAccessMode
  onAccessLost?: () => void
}

export function ManuscriptEditorPage({
  userId,
  manuscript,
  initialDocumentItemId,
  initialDialog,
  initialAnnotationId,
  onManuscriptChange,
  onError,
  onMessage,
  onOfflineModeChange,
  accessMode = 'owner',
  onAccessLost,
}: ManuscriptEditorPageProps) {
  const { t, i18n } = useTranslation()
  const isMobileViewport = useMobileViewport()
  const [activeInspectorTool, setActiveInspectorTool] = useState<InspectorTool>('Comments')
  const [inspectorOpen, setInspectorOpen] = useState(initialAnnotationId !== null)
  const [document, setDocument] = useState<EditorDocument | null>(null)
  const [bookTree, setBookTree] = useState<BookTree | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(initialDocumentItemId)
  const [createLocationId, setCreateLocationId] = useState<string | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [createKind, setCreateKind] = useState<'folder' | 'document' | null>(null)
  const [createTitle, setCreateTitle] = useState('')
  const [creatingItem, setCreatingItem] = useState(false)
  const [preferences, setPreferences] = useState<EditorPreferences | null>(null)
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([])
  const [taskPlanner, setTaskPlanner] = useState<PlannerData | null>(null)
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(initialAnnotationId)
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null)
  const [annotationPositions, setAnnotationPositions] = useState<Record<string, number>>({})
  const [annotationPositionsReady, setAnnotationPositionsReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [initialOfflineDocument, setInitialOfflineDocument] = useState<OfflineDocument | null>(null)
  const [connectionState, setConnectionState] = useState<EditorConnectionState>('online')
  const [conflict, setConflict] = useState<{
    local: OfflineDocument
    server: EditorDocument
  } | null>(null)
  const [editorInstance, setEditorInstance] = useState(0)
  const [resolvingConflict, setResolvingConflict] = useState(false)
  const [pendingConflictChoice, setPendingConflictChoice] = useState<'local' | 'server' | null>(null)
  const [shareDialogOpen, setShareDialogOpen] = useState(initialDialog === 'share')
  const [exportDialogOpen, setExportDialogOpen] = useState(initialDialog === 'export')
  const [mobileCommentsOpen, setMobileCommentsOpen] = useState(initialAnnotationId !== null)
  const [mobileCommentTargetId, setMobileCommentTargetId] = useState<string | null>(initialAnnotationId)
  const [mobileVersionsOpen, setMobileVersionsOpen] = useState(false)
  const [contentsWidth, setContentsWidth] = useState(CONTENTS_MIN_WIDTH)
  const [inspectorWidth, setInspectorWidth] = useState(INSPECTOR_MIN_WIDTH)
  const [scaffoldWidth, setScaffoldWidth] = useState(0)
  const [mobileContentsOpen, setMobileContentsOpen] = useState(false)
  const scaffoldRef = useRef<HTMLDivElement>(null)
  const conflictDialogRef = useRef<HTMLElement>(null)
  const stopResizeRef = useRef<(() => void) | null>(null)
  const editorRef = useRef<DocumentEditorHandle>(null)
  const routeDocumentRef = useRef(initialDocumentItemId)
  const registeredEditor = accessMode === 'editor'
  const localConflictAllowed = !registeredEditor && (!conflict || (
    JSON.stringify(illustrationProjection(conflict.local.content))
      === JSON.stringify(illustrationProjection(conflict.server.content))
  ))
  const visibleInspectorTools = registeredEditor
    ? inspectorTools.filter((tool) => tool.id === 'Comments' || tool.id === 'Drafts / Revisions')
    : inspectorTools

  const offlineMode = connectionState !== 'online'
  const handleEditorConnectionStateChange = useCallback((state: EditorConnectionState) => {
    setConnectionState(state)
    if (state !== 'online') {
      setMobileCommentsOpen(false)
      setMobileCommentTargetId(null)
      setAnnotationDraft(null)
      setMobileVersionsOpen(false)
    }
  }, [])

  useEffect(() => {
    onOfflineModeChange(offlineMode)
    return () => onOfflineModeChange(false)
  }, [offlineMode, onOfflineModeChange])

  useEffect(() => {
    if (!initialDialog && !initialAnnotationId) return
    const parameters = new URLSearchParams(window.location.search)
    parameters.delete('dialog')
    parameters.delete('inspector')
    parameters.delete('annotation')
    const search = parameters.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
  }, [initialAnnotationId, initialDialog])

  useEffect(() => {
    if (!initialAnnotationId || loading) return
    if (!annotations.some((annotation) => annotation.id === initialAnnotationId)) return
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.focusAnnotation(initialAnnotationId)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [annotations, initialAnnotationId, loading])

  useEffect(() => {
    if (routeDocumentRef.current !== initialDocumentItemId) {
      routeDocumentRef.current = initialDocumentItemId
      setSelectedItemId(initialDocumentItemId)
    }
  }, [initialDocumentItemId])

  useEffect(() => () => stopResizeRef.current?.(), [])

  useEffect(() => {
    if (!mobileContentsOpen) return
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setMobileContentsOpen(false)
    }
    window.document.addEventListener('keydown', closeOnEscape)
    return () => window.document.removeEventListener('keydown', closeOnEscape)
  }, [mobileContentsOpen])

  useEffect(() => {
    if (!addMenuOpen) return
    function closeAddMenu(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest('.mobileLibraryActionBackdrop')) {
        return
      }
      if (!(event.target instanceof Element) || !event.target.closest('.contentsAddControl')) {
        setAddMenuOpen(false)
      }
    }
    function closeAddMenuOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setAddMenuOpen(false)
    }
    window.document.addEventListener('mousedown', closeAddMenu)
    window.document.addEventListener('keydown', closeAddMenuOnEscape)
    return () => {
      window.document.removeEventListener('mousedown', closeAddMenu)
      window.document.removeEventListener('keydown', closeAddMenuOnEscape)
    }
  }, [addMenuOpen])

  useEffect(() => {
    const scaffold = scaffoldRef.current
    if (!scaffold) return
    const observer = new ResizeObserver(([entry]) => {
      const nextScaffoldWidth = entry.contentRect.width
      setScaffoldWidth(nextScaffoldWidth)
      const editorMinimum = nextScaffoldWidth <= RESPONSIVE_LAYOUT_BREAKPOINT
        ? RESPONSIVE_EDITOR_MIN_WIDTH
        : EDITOR_MIN_WIDTH
      const contentsCollapsed = nextScaffoldWidth <= CONTENTS_COLLAPSED_BREAKPOINT
        || (inspectorOpen && nextScaffoldWidth <= INSPECTOR_REPLACES_CONTENTS_BREAKPOINT)
      const contentsReserved = contentsCollapsed
        ? 0
        : contentsWidth + RESIZER_WIDTH
      let overflow = contentsReserved + editorMinimum + INSPECTOR_RAIL_WIDTH
        + (inspectorOpen ? inspectorWidth + RESIZER_WIDTH : 0)
        - nextScaffoldWidth
      if (overflow <= 0) return
      const nextInspector = Math.max(INSPECTOR_MIN_WIDTH, inspectorWidth - overflow)
      overflow -= inspectorWidth - nextInspector
      const nextContents = contentsCollapsed
        ? contentsWidth
        : Math.max(CONTENTS_MIN_WIDTH, contentsWidth - overflow)
      if (nextInspector !== inspectorWidth) setInspectorWidth(nextInspector)
      if (nextContents !== contentsWidth) setContentsWidth(nextContents)
    })
    observer.observe(scaffold)
    return () => observer.disconnect()
  }, [contentsWidth, inspectorOpen, inspectorWidth])

  useEffect(() => {
    let active = true
    async function loadDocument() {
      setLoading(true)
      setLoadFailed(false)
      try {
        let documentItemId = selectedItemId
        if (manuscript.kind === 'book') {
          const treePayload = await apiRequest<{ tree: BookTree }>(
            manuscriptTreeEndpoint(manuscript.id, accessMode),
          )
          if (!treePayload.tree.items.some((item) => item.id === documentItemId && item.kind === 'document')) {
            documentItemId = treePayload.tree.items.find((item) => item.kind === 'document')?.id ?? null
            if (documentItemId) setSelectedItemId(documentItemId)
          }
          setBookTree(treePayload.tree)
          if (!documentItemId) throw new Error('book_has_no_documents')
        }
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        const [documentPayload, preferencesPayload, annotationsPayload, storedOfflineDocument, taskPlannerPayload] = await Promise.all([
          apiRequest<{ document: EditorDocument }>(
            documentEndpoint(manuscript, documentItemId, accessMode),
          ),
          apiRequest<{ preferences: EditorPreferences }>(
            registeredEditor ? '/api/editor/preferences/' : '/api/manuscripts/editor-preferences/',
          ),
          apiRequest<{ items: DocumentAnnotation[] }>(
            annotationsEndpoint(manuscript, documentItemId, accessMode),
          ),
          (registeredEditor ? Promise.resolve(null) : getOfflineDocument(userId, manuscript.id, documentItemId)).catch(() => {
            onError('offline_storage_failed')
            return null
          }),
          (registeredEditor ? Promise.resolve(null) : apiRequest<{ planner: PlannerData }>(
            `/api/manuscripts/${manuscript.id}/planner/?timezone=${encodeURIComponent(timezone)}`,
          )).catch((err) => {
            onError(err instanceof Error ? err.message : i18n.t('editorShell.loadTasksFailed'))
            return null
          }),
        ])
        if (active) {
          let editorDocument = documentPayload.document
          let recoveredDocument = storedOfflineDocument
          if (storedOfflineDocument && documentPayload.document.syncMode === 'collaborative') {
            const serverHash = await contentHash(documentPayload.document.content)
            const localHash = await contentHash(storedOfflineDocument.content)
            if (localHash === serverHash) {
              await deleteOfflineDocument(userId, manuscript.id, documentItemId)
              recoveredDocument = null
            } else {
              setConflict({ local: storedOfflineDocument, server: documentPayload.document })
              editorDocument = documentPayload.document
              setConnectionState('conflict')
            }
          } else if (storedOfflineDocument) {
            const serverHash = await contentHash(documentPayload.document.content)
            const localHash = await contentHash(storedOfflineDocument.content)
            if (
              storedOfflineDocument.lastAttemptHash
              && storedOfflineDocument.lastAttemptHash === serverHash
            ) {
              if (localHash === serverHash) {
                await deleteOfflineDocument(userId, manuscript.id, documentItemId)
                recoveredDocument = null
              } else {
                recoveredDocument = {
                  ...storedOfflineDocument,
                  confirmedGeneration: documentPayload.document.saveGeneration,
                  lastAttemptHash: null,
                }
                await putOfflineDocument(recoveredDocument)
                editorDocument = { ...documentPayload.document, content: recoveredDocument.content }
                setConnectionState('syncing')
              }
            } else if (
              storedOfflineDocument.confirmedGeneration === documentPayload.document.saveGeneration
            ) {
              editorDocument = { ...documentPayload.document, content: storedOfflineDocument.content }
              setConnectionState(navigator.onLine ? 'syncing' : 'offline')
            } else {
              setConflict({ local: storedOfflineDocument, server: documentPayload.document })
              editorDocument = { ...documentPayload.document, content: storedOfflineDocument.content }
              setConnectionState('conflict')
            }
          }
          setDocument(editorDocument)
          setInitialOfflineDocument(recoveredDocument)
          setPreferences(preferencesPayload.preferences)
          setAnnotations(annotationsPayload.items)
          setTaskPlanner(taskPlannerPayload?.planner ?? null)
        }
      } catch (err) {
        if (active) {
          if (registeredEditor && err instanceof ApiError && err.status === 404) {
            onAccessLost?.()
            return
          }
          setLoadFailed(true)
          onError(err instanceof Error ? err.message : i18n.t('editorShell.loadDocumentFailed'))
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadDocument()
    return () => {
      active = false
    }
  }, [accessMode, i18n, manuscript, onAccessLost, onError, registeredEditor, selectedItemId, userId])

  useEffect(() => {
    if (registeredEditor) return
    void navigator.storage?.persist?.().catch(() => false)
  }, [registeredEditor])

  useEffect(() => {
    if (!conflict) return
    globalThis.document.body.classList.add('conflictComparisonOpen')
    const frame = window.requestAnimationFrame(() => conflictDialogRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      globalThis.document.body.classList.remove('conflictComparisonOpen')
    }
  }, [conflict])

  const handleSaveConflict = useCallback(async (content: JSONContent) => {
    try {
      const [serverPayload, stored] = await Promise.all([
        apiRequest<{ document: EditorDocument }>(
          documentEndpoint(manuscript, selectedItemId, accessMode),
        ),
        registeredEditor
          ? Promise.resolve(null)
          : getOfflineDocument(userId, manuscript.id, selectedItemId),
      ])
      const local = createOfflineDocument(
        userId,
        manuscript.id,
        selectedItemId,
        serverPayload.document.schemaVersion,
        content,
        (stored?.localRevision ?? 0) + 1,
        stored?.confirmedGeneration ?? document?.saveGeneration ?? 0,
        stored?.lastAttemptHash ?? null,
      )
      if (!registeredEditor) await putOfflineDocument(local)
      setInitialOfflineDocument(local)
      setConflict({ local, server: serverPayload.document })
      setConnectionState('conflict')
    } catch (err) {
      setConnectionState('offline')
      onError(err instanceof Error ? err.message : i18n.t('editorShell.checkConflictFailed'))
    }
  }, [accessMode, document?.saveGeneration, i18n, manuscript, onError, registeredEditor, selectedItemId, userId])

  async function resolveConflict(choice: 'local' | 'server') {
    if (!conflict || resolvingConflict) return false
    if (choice === 'local' && !localConflictAllowed) return false
    setResolvingConflict(true)
    try {
      await editorRef.current?.prepareConflictResolution()
      if (choice === 'server') {
        if (!registeredEditor) await deleteOfflineDocument(userId, manuscript.id, selectedItemId)
        setInitialOfflineDocument(null)
        setDocument(conflict.server)
        setConnectionState('online')
      } else {
        if (conflict.server.syncMode === 'collaborative') {
          const payload = await apiRequest<{ document: EditorDocument }>(
            collaborationReplaceEndpoint(manuscript, selectedItemId),
            {
              method: 'POST',
              body: JSON.stringify({
                content: conflict.local.content,
                schemaVersion: conflict.server.schemaVersion,
                expectedGeneration: conflict.server.saveGeneration,
              }),
            },
          )
          await deleteOfflineDocument(userId, manuscript.id, selectedItemId)
          setInitialOfflineDocument(null)
          setDocument(payload.document)
          setConnectionState('online')
          setConflict(null)
          setPendingConflictChoice(null)
          setEditorInstance((value) => value + 1)
          return true
        }
        const local = {
          ...conflict.local,
          confirmedGeneration: conflict.server.saveGeneration,
          lastAttemptHash: null,
          updatedAt: new Date().toISOString(),
        }
        if (!registeredEditor) await putOfflineDocument(local)
        setInitialOfflineDocument(local)
        setDocument({ ...conflict.server, content: local.content })
        setConnectionState(navigator.onLine ? 'syncing' : 'offline')
      }
      setConflict(null)
      setPendingConflictChoice(null)
      setEditorInstance((value) => value + 1)
      return true
    } catch {
      setConnectionState('local-error')
      onError('offline_storage_failed')
      return false
    } finally {
      setResolvingConflict(false)
    }
  }

  const sortedAnnotations = annotations.map((annotation) => ({
    ...annotation,
    detached: annotationPositionsReady
      ? annotationPositions[annotation.id] === undefined
      : annotation.detached,
  })).sort((left, right) => {
    const leftPosition = annotationPositions[left.id] ?? Number.POSITIVE_INFINITY
    const rightPosition = annotationPositions[right.id] ?? Number.POSITIVE_INFINITY
    return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt)
  })

  function updateAnnotation(updated: DocumentAnnotation) {
    setAnnotations((current) => current.map((item) => item.id === updated.id ? updated : item))
    if (updated.status === 'resolved' && activeAnnotationId === updated.id) {
      setActiveAnnotationId(null)
      editorRef.current?.clearAnnotationFocus(updated.id)
    }
  }

  function annotationCreated(annotation: DocumentAnnotation) {
    const applied = editorRef.current?.applyAnnotation(annotation.id) ?? false
    if (!applied) return false
    setAnnotations((current) => [...current, annotation])
    setActiveAnnotationId(annotation.id)
    return true
  }

  const refreshAnnotations = useCallback(async () => {
    try {
      const payload = await apiRequest<{ items: DocumentAnnotation[] }>(
        annotationsEndpoint(manuscript, selectedItemId, accessMode),
        { invalidateQueryCache: false },
      )
      setAnnotations(payload.items)
    } catch (err) {
      if (registeredEditor && err instanceof ApiError && err.status === 404) {
        onAccessLost?.()
        return
      }
      onError(err instanceof Error ? err.message : i18n.t('editorShell.loadDocumentFailed'))
    }
  }, [accessMode, i18n, manuscript, onAccessLost, onError, registeredEditor, selectedItemId])

  const handleCollaborationEpochStale = useCallback(async (
    content: JSONContent,
    hasUnsyncedChanges: boolean,
  ) => {
    if (hasUnsyncedChanges) {
      await handleSaveConflict(content)
      return
    }
    try {
      setConnectionState('syncing')
      const [documentPayload, annotationsPayload] = await Promise.all([
        apiRequest<{ document: EditorDocument }>(
          documentEndpoint(manuscript, selectedItemId, accessMode),
          { invalidateQueryCache: false },
        ),
        apiRequest<{ items: DocumentAnnotation[] }>(
          annotationsEndpoint(manuscript, selectedItemId, accessMode),
          { invalidateQueryCache: false },
        ),
      ])
      setDocument(documentPayload.document)
      setAnnotations(annotationsPayload.items)
      setActiveAnnotationId(null)
      setAnnotationDraft(null)
      setAnnotationPositions({})
      setAnnotationPositionsReady(false)
      setConnectionState('online')
      setEditorInstance((value) => value + 1)
    } catch (err) {
      setConnectionState('local-error')
      onError(err instanceof Error ? err.message : i18n.t('editorShell.loadDocumentFailed'))
    }
  }, [accessMode, handleSaveConflict, i18n, manuscript, onError, selectedItemId])

  function openInspector(tool: InspectorTool) {
    setActiveInspectorTool(tool)
    setInspectorOpen(true)
  }

  function toggleInspector(tool: InspectorTool) {
    setInspectorOpen((open) => activeInspectorTool === tool ? !open : true)
    setActiveInspectorTool(tool)
  }

  function activateAnnotation(annotationId: string) {
    if (!isMobileViewport) openInspector('Comments')
    setActiveAnnotationId(annotationId)
    editorRef.current?.focusAnnotation(annotationId)
  }

  const handleAnnotationPositions = useCallback((positions: Record<string, number>) => {
    setAnnotationPositions(positions)
    setAnnotationPositionsReady(true)
  }, [])

  function maximumPanelWidth(side: 'contents' | 'inspector') {
    const editorMinimum = scaffoldWidth <= RESPONSIVE_LAYOUT_BREAKPOINT
      ? RESPONSIVE_EDITOR_MIN_WIDTH
      : EDITOR_MIN_WIDTH
    const contentsReserved = scaffoldWidth <= CONTENTS_COLLAPSED_BREAKPOINT
      ? 0
      : contentsWidth + RESIZER_WIDTH
    const reservedWidth = side === 'contents'
      ? INSPECTOR_RAIL_WIDTH + RESIZER_WIDTH
        + (inspectorOpen
          ? inspectorWidth + RESIZER_WIDTH
          : 0)
      : contentsReserved + INSPECTOR_RAIL_WIDTH + RESIZER_WIDTH
    return Math.max(
      side === 'contents' ? CONTENTS_MIN_WIDTH : INSPECTOR_MIN_WIDTH,
      scaffoldWidth - reservedWidth - editorMinimum,
    )
  }

  function resizePanel(side: 'contents' | 'inspector', nextWidth: number) {
    const minimum = side === 'contents' ? CONTENTS_MIN_WIDTH : INSPECTOR_MIN_WIDTH
    const width = Math.min(Math.max(nextWidth, minimum), maximumPanelWidth(side))
    if (side === 'contents') setContentsWidth(width)
    else setInspectorWidth(width)
  }

  function beginResize(side: 'contents' | 'inspector', event: ReactPointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    stopResizeRef.current?.()
    const startX = event.clientX
    const startWidth = side === 'contents' ? contentsWidth : inspectorWidth
    window.document.body.classList.add('resizingEditorPanels')

    function onPointerMove(pointerEvent: PointerEvent) {
      const delta = pointerEvent.clientX - startX
      resizePanel(side, side === 'contents' ? startWidth + delta : startWidth - delta)
    }

    function stopResize() {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.document.body.classList.remove('resizingEditorPanels')
      stopResizeRef.current = null
    }

    stopResizeRef.current = stopResize
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }

  function resizeWithKeyboard(
    side: 'contents' | 'inspector',
    event: KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const currentWidth = side === 'contents' ? contentsWidth : inspectorWidth
    resizePanel(side, currentWidth + direction * 16 * (side === 'contents' ? 1 : -1))
  }

  const selectedBookItem = bookTree?.items.find((item) => item.id === selectedItemId) ?? null
  const selectedParentItem = selectedBookItem?.parentId
    ? bookTree?.items.find((item) => item.id === selectedBookItem.parentId) ?? null
    : null
  const reviewShareScopeOptions: ReviewShareScopeOption[] = manuscript.kind === 'oneshot'
    ? [{
        scopeType: 'oneshot',
        itemId: null,
        label: manuscript.title,
        description: t('editorShell.shareOneShot'),
        recommended: true,
      }]
    : [
        ...(selectedParentItem?.kind === 'folder' ? [{
          scopeType: 'folder' as const,
          itemId: selectedParentItem.id,
          label: selectedParentItem.title,
          description: t('editorShell.shareChapter'),
          recommended: true,
        }] : []),
        ...(selectedBookItem ? [{
          scopeType: 'document' as const,
          itemId: selectedBookItem.id,
          label: selectedBookItem.title,
          description: t(selectedParentItem?.kind === 'folder'
            ? 'editorShell.shareScene'
            : 'editorShell.shareDocument'),
          recommended: selectedParentItem?.kind !== 'folder',
        }] : []),
      ]

  async function openBookDocument(itemId: string) {
    setMobileContentsOpen(false)
    if (itemId === selectedItemId) return
    const generation = await editorRef.current?.prepareVersionAction()
    if (generation === null) return
    setSelectedItemId(itemId)
  }

  async function openExportDialog() {
    const generation = await editorRef.current?.prepareVersionAction()
    if (generation == null) {
      onError(i18n.t('exports.flushRequired'))
      return
    }
    setExportDialogOpen(true)
  }

  async function renameSelectedDocument(title: string) {
    if (!selectedItemId) return
    await renameBookItem(selectedItemId, title)
  }

  async function renameBookItem(itemId: string, title: string) {
    if (!bookTree) return
    const payload = await apiRequest<{
      item: BookTree['items'][number]
      structureGeneration: number
    }>(`/api/manuscripts/book-items/${itemId}/`, {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'rename',
        title,
        expectedStructureGeneration: bookTree.structureGeneration,
      }),
    })
    setBookTree((current) => current ? {
      ...current,
      structureGeneration: payload.structureGeneration,
      items: current.items.map((item) => item.id === payload.item.id
        ? { ...payload.item, wordCount: item.wordCount, characterCount: item.characterCount }
        : item),
    } : current)
  }

  async function refreshBookTree() {
    const payload = await apiRequest<{ tree: BookTree }>(
      `/api/manuscripts/books/${manuscript.id}/tree/`,
    )
    setBookTree(payload.tree)
    return payload.tree
  }

  async function createBookItem(kind: 'folder' | 'document', parentId: string | null, title: string) {
    if (!bookTree) return
    try {
      const payload = await apiRequest<{ item: BookTree['items'][number] }>(
        `/api/manuscripts/books/${manuscript.id}/tree/`,
        {
          method: 'POST',
          body: JSON.stringify({
            kind,
            parentId,
            title,
            expectedStructureGeneration: bookTree.structureGeneration,
          }),
        },
      )
      const next = await refreshBookTree()
      if (payload.item.kind === 'document') setSelectedItemId(payload.item.id)
      setBookTree(next)
      return true
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n.t('editorShell.createItemFailed'))
      return false
    }
  }

  async function submitCreateBookItem(afterCreate?: () => void) {
    if (!createKind || !createTitle.trim() || creatingItem || !canCreateAtLocation) return
    setCreatingItem(true)
    try {
      const created = await createBookItem(createKind, createLocationId, createTitle.trim())
      if (!created) return
      setCreateTitle('')
      if (afterCreate) afterCreate()
      else setCreateKind(null)
    } finally {
      setCreatingItem(false)
    }
  }

  async function changeTrashState(itemId: string, action: 'trash' | 'restore') {
    if (!bookTree) return
    try {
      await apiRequest(`/api/manuscripts/book-items/${itemId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ action, expectedStructureGeneration: bookTree.structureGeneration }),
      })
      const next = await refreshBookTree()
      if (action === 'trash' && itemId === selectedItemId) {
        setSelectedItemId(next.items.find((item) => item.kind === 'document')?.id ?? null)
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n.t(action === 'trash' ? 'editorShell.trashItemFailed' : 'editorShell.restoreItemFailed'))
    }
  }

  async function permanentlyDeleteBookItem(itemId: string) {
    try {
      await apiRequest(`/api/manuscripts/book-items/${itemId}/`, { method: 'DELETE' })
      await refreshBookTree()
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n.t('editorShell.deleteItemFailed'))
    }
  }

  async function moveBookItem(itemId: string, parentId: string | null, beforeId: string | null) {
    if (!bookTree) return
    try {
      await apiRequest(`/api/manuscripts/book-items/${itemId}/`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'move',
          parentId,
          beforeId,
          expectedStructureGeneration: bookTree.structureGeneration,
        }),
      })
      await refreshBookTree()
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n.t('editorShell.moveItemFailed'))
    }
  }

  const navigatorTree: BookTree | null = manuscript.kind === 'book'
    ? bookTree
    : {
        items: [{
          id: `oneshot-${manuscript.id}`,
          parentId: null,
          kind: 'document',
          title: manuscript.title,
          position: 1024,
          ...contentStatistics(document?.content),
          trashedAt: null,
        }],
        trash: [],
        structureGeneration: 0,
        maxFolderDepth: 0,
      }
  const folderOptions = (bookTree?.items ?? []).filter((item) => item.kind === 'folder').map((item) => {
    let depth = 1
    let parentId = item.parentId
    while (parentId) {
      depth += 1
      parentId = bookTree?.items.find((candidate) => candidate.id === parentId)?.parentId ?? null
    }
    return { item, depth }
  })
  const createLocationDepth = folderOptions.find(({ item }) => item.id === createLocationId)?.depth ?? 0
  const canCreateAtLocation = createKind !== 'folder'
    || !bookTree
    || createLocationDepth < bookTree.maxFolderDepth

  return (
    <div
      ref={scaffoldRef}
      className={`editorScaffold ${offlineMode ? 'offlineMode' : ''} ${inspectorOpen ? 'inspectorOpen' : ''}`}
      style={{
        '--contents-panel-width': `${contentsWidth}px`,
        '--inspector-panel-width': `${inspectorWidth}px`,
      } as CSSProperties}
    >
      {offlineMode && (
        <div className={`editorOfflineBanner ${connectionState}`} role="status" aria-live="polite">
          {registeredEditor && connectionState === 'offline'
            ? t('editorShell.editorOfflineReadonly')
            : connectionState === 'syncing'
            ? t('editorShell.offlineSyncing')
            : connectionState === 'conflict'
              ? t('editorShell.offlineConflict')
              : connectionState === 'local-error'
                ? t('editorShell.offlineLocalError')
                : t('editorShell.offlineSaved')}
        </div>
      )}

      <aside className={`contentsPanel ${mobileContentsOpen ? 'mobileOpen' : ''}`} inert={offlineMode ? true : undefined}>
        <header>
          <h2>{t('editorShell.tableOfContents')}</h2>
          {!registeredEditor && <div className="contentsAddControl">
            <button
              type="button"
              className="spaceButton"
              aria-label={t('editorShell.addToContents')}
              aria-haspopup={manuscript.kind === 'book' ? 'menu' : undefined}
              aria-expanded={manuscript.kind === 'book' ? addMenuOpen : undefined}
              title={t(manuscript.kind === 'oneshot' ? 'editorShell.oneShotSingleDocument' : 'editorShell.addDocumentOrFolder')}
              disabled={manuscript.kind === 'oneshot'}
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              <Icon name="sign-plus-light" />
            </button>
            {addMenuOpen && manuscript.kind === 'book' && (
              <div className="contentsAddMenu" role="menu">
                <button type="button" className="spaceButton" role="menuitem" onClick={() => { setAddMenuOpen(false); setCreateLocationId(null); setCreateKind('document') }}>
                  <Icon name="file-add-light" /><span><strong>{t('editorShell.newDocument')}</strong><small>{t('editorShell.chooseLocation')}</small></span>
                </button>
                <button type="button" className="spaceButton" role="menuitem" onClick={() => { setAddMenuOpen(false); setCreateLocationId(null); setCreateKind('folder') }}>
                  <Icon name="folder-add-light" /><span><strong>{t('editorShell.newFolder')}</strong><small>{t('editorShell.chooseLocation')}</small></span>
                </button>
              </div>
            )}
            <MobileLibraryActionSheet
              open={addMenuOpen && manuscript.kind === 'book'}
              title={t('editorShell.addDocumentOrFolder')}
              dismissOnSelect
              onClose={() => setAddMenuOpen(false)}
              actions={[
                {
                  key: 'document',
                  label: t('editorShell.newDocument'),
                  icon: <Icon name="file-add-light" />,
                  onSelect: () => {
                    setCreateLocationId(null)
                    setCreateKind('document')
                  },
                },
                {
                  key: 'folder',
                  label: t('editorShell.newFolder'),
                  icon: <Icon name="folder-add-light" />,
                  onSelect: () => {
                    setCreateLocationId(null)
                    setCreateKind('folder')
                  },
                },
              ]}
            />
          </div>}
        </header>
        {navigatorTree ? (
          <BookNavigator
            manuscriptId={manuscript.id}
            tree={navigatorTree}
            activeId={manuscript.kind === 'book' ? selectedItemId : `oneshot-${manuscript.id}`}
            editable={!registeredEditor && manuscript.kind === 'book'}
            showTrash={!registeredEditor}
            onOpenDocument={(itemId) => manuscript.kind === 'book' && void openBookDocument(itemId)}
            onTrash={(itemId) => changeTrashState(itemId, 'trash')}
            onRestore={(itemId) => changeTrashState(itemId, 'restore')}
            onDelete={permanentlyDeleteBookItem}
            onMove={moveBookItem}
            onRename={renameBookItem}
          />
        ) : (
          <TadpoleLoadingState className="contentsNavigatorLoading" label={t('editorShell.loadingContents')} />
        )}
        <button type="button" className="editorMobileContentsClose spaceButton" onClick={() => setMobileContentsOpen(false)}>
          <Icon name="arrow-left-1" />
          <span>{t('editorShell.collapseContents')}</span>
        </button>
      </aside>
      {mobileContentsOpen && <div className="editorContentsBackdrop" role="presentation" onPointerDown={() => setMobileContentsOpen(false)} />}

      {!registeredEditor && createKind && (
        <ResponsiveBookItemCreateDialog
          title={t(createKind === 'folder' ? 'editorShell.newFolder' : 'editorShell.newDocument')}
          closeLabel={t('common.close')}
          busy={creatingItem}
          onClose={() => setCreateKind(null)}
        >
          {(close) => <form onSubmit={(event) => { event.preventDefault(); void submitCreateBookItem(close) }}>
            <label className="dialogField">
              <span>{t('editorShell.title')}</span>
              <input autoFocus value={createTitle} maxLength={240} placeholder={t(createKind === 'folder' ? 'editorShell.untitledFolder' : 'editorShell.untitledDocument')} onChange={(event) => setCreateTitle(event.target.value)} />
            </label>
            <label className="dialogField">
              <span>{t('editorShell.location')}</span>
              <CustomSelect value={createLocationId ?? ''} onChange={(event) => setCreateLocationId(event.target.value || null)}>
                <option value="">{t('editorShell.bookRoot')}</option>
                {folderOptions.map(({ item, depth }) => (
                  <option key={item.id} value={item.id} disabled={createKind === 'folder' && depth >= (bookTree?.maxFolderDepth ?? 3)}>
                    {`${'-- '.repeat(Math.max(0, depth - 1))}${item.title}`}
                  </option>
                ))}
              </CustomSelect>
            </label>
            {!canCreateAtLocation && <p className="fieldError">{t('editorShell.maxFolderDepth')}</p>}
            <footer>
              <button type="button" className="dialogCancel spaceButton" onClick={close} disabled={creatingItem}>{t('common.cancel')}</button>
              <button type="submit" className="dialogSubmit spaceButton" disabled={creatingItem || !createTitle.trim() || !canCreateAtLocation}>{t(creatingItem ? 'editorShell.creating' : 'editorShell.create')}</button>
            </footer>
          </form>}
        </ResponsiveBookItemCreateDialog>
      )}

      <PanelResizer
        side="contents"
        value={contentsWidth}
        minimum={CONTENTS_MIN_WIDTH}
        maximum={maximumPanelWidth('contents')}
        onPointerDown={(event) => beginResize('contents', event)}
        onKeyDown={(event) => resizeWithKeyboard('contents', event)}
        onReset={() => setContentsWidth(CONTENTS_MIN_WIDTH)}
        disabled={offlineMode}
      />

      {loading ? (
        <EditorDocumentSkeleton />
      ) : loadFailed || !document || !preferences ? (
        <main className="editorPanel editorLoadingState">{t('editorShell.documentOpenFailed')}</main>
      ) : (
        <DocumentEditor
          key={`${manuscript.id}:${document.collaborationEpoch ?? document.saveGeneration}:${editorInstance}`}
          ref={editorRef}
          userId={userId}
          manuscript={manuscript}
          documentItemId={selectedItemId}
          documentTitle={selectedBookItem?.title ?? manuscript.title}
          document={document}
          initialOfflineDocument={initialOfflineDocument}
          syncBlocked={conflict !== null}
          initialPreferences={preferences}
          onManuscriptChange={onManuscriptChange}
          onDocumentTitleChange={renameSelectedDocument}
          onError={onError}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          onActiveAnnotationChange={(annotationId) => {
            setActiveAnnotationId(annotationId)
          }}
          onStartAnnotation={setAnnotationDraft}
          onAnnotationDeleted={(annotationId) => {
            setAnnotations((current) => current.filter((item) => item.id !== annotationId))
          }}
          onAnnotationPositionsChange={handleAnnotationPositions}
          onOpenComments={(annotationId) => {
            if (isMobileViewport) {
              setMobileCommentTargetId(annotationId ?? null)
              setMobileCommentsOpen(true)
            } else {
              openInspector('Comments')
            }
          }}
          onOpenContents={() => setMobileContentsOpen(true)}
          contentsOpen={mobileContentsOpen}
          onShare={() => setShareDialogOpen(true)}
          onComments={() => {
            setMobileCommentTargetId(null)
            setMobileCommentsOpen(true)
          }}
          onVersions={() => setMobileVersionsOpen(true)}
          onExport={() => void openExportDialog()}
          onConnectionStateChange={handleEditorConnectionStateChange}
          onSaveConflict={(content) => void handleSaveConflict(content)}
          onAnnotationsChanged={() => void refreshAnnotations()}
          onCollaborationEpochStale={(content, hasUnsyncedChanges) => {
            void handleCollaborationEpochStale(content, hasUnsyncedChanges)
          }}
          accessMode={accessMode}
          onAccessLost={onAccessLost}
        />
      )}

      {!registeredEditor && shareDialogOpen && reviewShareScopeOptions.length > 0 && (
        <ReviewShareDialog
          manuscriptId={manuscript.id}
          scopeOptions={reviewShareScopeOptions}
          onClose={() => setShareDialogOpen(false)}
          onError={onError}
          onMessage={onMessage}
        />
      )}

      {!registeredEditor && exportDialogOpen && (
        <ManuscriptExportDialog
          manuscript={manuscript}
          onClose={() => setExportDialogOpen(false)}
          onError={onError}
          onMessage={onMessage}
        />
      )}

      {mobileVersionsOpen && isMobileViewport && !offlineMode && (
        <VersionsPanel
          mobilePresentation
          manuscriptId={manuscript.id}
          documentItemId={selectedItemId}
          manuscriptKind={manuscript.kind}
          prepareVersionAction={async () => (
            await editorRef.current?.prepareVersionAction() ?? null
          )}
          onRestored={(restoredDocument, restoredAnnotations) => {
            setDocument(restoredDocument)
            setAnnotations(restoredAnnotations)
            setActiveAnnotationId(null)
            setAnnotationDraft(null)
            setAnnotationPositions({})
            setAnnotationPositionsReady(false)
          }}
          onError={onError}
          onClose={() => setMobileVersionsOpen(false)}
          accessMode={accessMode}
          onAccessLost={onAccessLost}
        />
      )}

      {isMobileViewport && !offlineMode && (mobileCommentsOpen || annotationDraft) && (
        <CommentsPanel
          mobilePresentation
          mobileOpen={mobileCommentsOpen}
          mobileTargetId={mobileCommentTargetId}
          manuscriptId={manuscript.id}
          documentItemId={selectedItemId}
          manuscriptKind={manuscript.kind}
          annotations={sortedAnnotations}
          activeAnnotationId={activeAnnotationId}
          draft={annotationDraft}
          onStartAnnotation={() => {
            if (!editorRef.current?.startAnnotation()) onError('annotation_selection_required')
          }}
          onCancelDraft={() => setAnnotationDraft(null)}
          onCreated={annotationCreated}
          onAnnotationChange={updateAnnotation}
          onDeleteAnnotation={async (annotationId) => (
            await editorRef.current?.deleteAnnotation(annotationId) ?? false
          )}
          onActivate={activateAnnotation}
          onError={onError}
          onMobileTargetChange={setMobileCommentTargetId}
          onMobileClose={() => {
            setMobileCommentsOpen(false)
            setMobileCommentTargetId(null)
          }}
          accessMode={accessMode}
          onAccessLost={onAccessLost}
        />
      )}

      {inspectorOpen && !isMobileViewport && (
        <>
          <PanelResizer
            side="inspector"
            value={inspectorWidth}
            minimum={INSPECTOR_MIN_WIDTH}
            maximum={maximumPanelWidth('inspector')}
            onPointerDown={(event) => beginResize('inspector', event)}
            onKeyDown={(event) => resizeWithKeyboard('inspector', event)}
            onReset={() => setInspectorWidth(INSPECTOR_MIN_WIDTH)}
            disabled={offlineMode}
          />

          <aside className="inspectorPanel">
            <header className="inspectorToolHeader">
              <div>
                <Icon name={inspectorTools.find((tool) => tool.id === activeInspectorTool)!.icon} />
                <h2>{t(inspectorTools.find((tool) => tool.id === activeInspectorTool)!.labelKey)}</h2>
              </div>
              <button
                type="button"
                className="spaceButton"
                aria-label={t('editorShell.closeWritingTools')}
                title={t('editorShell.closePanel')}
                onClick={() => setInspectorOpen(false)}
              >
                <Icon name="close-light" />
              </button>
            </header>
            <div className="inspectorPanelBody">
              {offlineMode ? (
                <div className="inspectorEmptyState">
                  <span>{t('editorShell.offlineMode')}</span>
                  <p>{t('editorShell.offlineToolsLead')}</p>
                </div>
              ) : activeInspectorTool === 'Comments' ? (
                <CommentsPanel
                  manuscriptId={manuscript.id}
                  documentItemId={selectedItemId}
                  manuscriptKind={manuscript.kind}
                  annotations={sortedAnnotations}
                  activeAnnotationId={activeAnnotationId}
                  draft={annotationDraft}
                  onStartAnnotation={() => {
                    if (!editorRef.current?.startAnnotation()) onError('annotation_selection_required')
                  }}
                  onCancelDraft={() => setAnnotationDraft(null)}
                  onCreated={annotationCreated}
                  onAnnotationChange={updateAnnotation}
                  onDeleteAnnotation={async (annotationId) => (
                    await editorRef.current?.deleteAnnotation(annotationId) ?? false
                  )}
                  onActivate={activateAnnotation}
                  onError={onError}
                  accessMode={accessMode}
                  onAccessLost={onAccessLost}
                />
              ) : activeInspectorTool === 'Drafts / Revisions' ? (
                <VersionsPanel
                  manuscriptId={manuscript.id}
                  documentItemId={selectedItemId}
                  manuscriptKind={manuscript.kind}
                  prepareVersionAction={async () => (
                    await editorRef.current?.prepareVersionAction() ?? null
                  )}
                  onRestored={(restoredDocument, restoredAnnotations) => {
                    setDocument(restoredDocument)
                    setAnnotations(restoredAnnotations)
                    setActiveAnnotationId(null)
                    setAnnotationDraft(null)
                    setAnnotationPositions({})
                    setAnnotationPositionsReady(false)
                  }}
                  onError={onError}
                  accessMode={accessMode}
                  onAccessLost={onAccessLost}
                />
              ) : activeInspectorTool === 'Tasks' ? (
                <EditorTasksPanel
                  manuscriptId={manuscript.id}
                  selectedItemId={selectedItemId}
                  planner={taskPlanner}
                  onChange={setTaskPlanner}
                  onError={onError}
                />
              ) : activeInspectorTool === 'Notes' ? (
                <EditorNotesPanel
                  manuscriptId={manuscript.id}
                  selectedItemId={selectedItemId}
                  onError={onError}
                />
              ) : activeInspectorTool === 'Glossary' ? (
                <GlossaryInspectorPanel
                  userId={userId}
                  manuscript={manuscript}
                  selectedItemId={selectedItemId}
                  onError={onError}
                />
              ) : (
                <div className="inspectorEmptyState">
                  <span>{t(inspectorTools.find((tool) => tool.id === activeInspectorTool)!.labelKey)}</span>
                  <p>{t('editorShell.unavailableToolLead')}</p>
                </div>
              )}
            </div>
          </aside>
        </>
      )}

      <nav className="inspectorRail" aria-label={t('editorShell.writingTools')}>
        {visibleInspectorTools.map((tool) => {
          const active = inspectorOpen && activeInspectorTool === tool.id
          return (
            <button
              key={tool.id}
              type="button"
              className={`spaceButton ${active ? 'active' : ''}`}
              aria-label={t(tool.labelKey)}
              aria-pressed={active}
              title={t(tool.labelKey)}
              onClick={() => toggleInspector(tool.id)}
            >
              <Icon name={tool.icon} />
            </button>
          )
        })}
        {!registeredEditor && <button
          type="button"
          className="spaceButton editorExportButton"
          aria-label={t('exports.title')}
          title={t('exports.title')}
          onClick={() => void openExportDialog()}
        >
          <Icon name="archive-light" />
        </button>}
      </nav>
      {conflict && createPortal(
        <div className="conflictComparisonBackdrop">
          <section ref={conflictDialogRef} className="conflictComparisonDialog" role="dialog" aria-modal="true" aria-labelledby="conflict-comparison-title" tabIndex={-1}>
            <header>
              <div>
                <h2 id="conflict-comparison-title">{t('editorShell.resolveConflict')}</h2>
                <p>{t('editorShell.resolveConflictLead')}</p>
              </div>
            </header>
            <DocumentComparison
              ariaLabel={t('editorShell.resolveConflict')}
              left={{
                content: conflict.server.content,
                label: t('documentComparison.serverVersion'),
                updatedAt: conflict.server.updatedAt,
              }}
              right={{
                content: conflict.local.content,
                label: t('documentComparison.localVersion'),
                updatedAt: conflict.local.updatedAt,
              }}
              mobileConflictControls={{
                title: t('editorShell.resolveConflict'),
                resolving: resolvingConflict,
                onChoose: (choice) => setPendingConflictChoice(choice === 'left' ? 'server' : 'local'),
                rightDisabled: !localConflictAllowed,
              }}
              assetUrl={registeredEditor ? (assetId) => editorAssetUrl(manuscript.id, assetId) : undefined}
            />
            {!localConflictAllowed && <p className="fieldError">{t('editorShell.localConflictIllustrationsChanged')}</p>}
            <footer>
              <button type="button" className="spaceButton secondaryAction" disabled={resolvingConflict} onClick={() => setPendingConflictChoice('server')}>
                {t('editorShell.useServerCopy')}
              </button>
              <button type="button" className="spaceButton primaryAction" title={!localConflictAllowed ? t('editorShell.localConflictIllustrationsChanged') : undefined} disabled={resolvingConflict || !localConflictAllowed} onClick={() => setPendingConflictChoice('local')}>
                {t('editorShell.keepLocalCopy')}
              </button>
            </footer>
          </section>
          {pendingConflictChoice && (
            <ConflictConfirmationDialog
              choice={pendingConflictChoice}
              busy={resolvingConflict}
              onClose={() => setPendingConflictChoice(null)}
              onConfirm={() => void resolveConflict(pendingConflictChoice)}
            />
          )}
        </div>,
        isMobileViewport && scaffoldRef.current
          ? scaffoldRef.current
          : globalThis.document.body,
      )}
    </div>
  )
}

function contentStatistics(content: JSONContent | undefined) {
  if (!content) return { wordCount: 0, characterCount: 0 }
  const plainText = (content.content ?? []).map((block) => {
    if (block.type === 'sceneBreak') return '***'
    return (block.content ?? []).map((node) => {
      if (node.type === 'text') return node.text ?? ''
      if (node.type === 'hardBreak') return '\n'
      return ''
    }).join('')
  }).join('\n')
  return {
    wordCount: plainText.match(/\S+/gu)?.length ?? 0,
    characterCount: Array.from(plainText).length,
  }
}

function PanelResizer({
  side,
  value,
  minimum,
  maximum,
  onPointerDown,
  onKeyDown,
  onReset,
  disabled = false,
}: {
  side: 'contents' | 'inspector'
  value: number
  minimum: number
  maximum: number
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onReset: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div
      className={`editorPanelResizer ${side}`}
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-label={t(side === 'contents' ? 'editorShell.resizeContents' : 'editorShell.resizeInspector')}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={Math.round(maximum)}
      aria-valuenow={Math.round(value)}
      onPointerDown={disabled ? undefined : onPointerDown}
      onKeyDown={disabled ? undefined : onKeyDown}
      onDoubleClick={disabled ? undefined : onReset}
    />
  )
}
