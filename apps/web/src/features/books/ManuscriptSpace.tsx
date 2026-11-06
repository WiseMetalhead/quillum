import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, apiQuery } from '../../api/client'
import { clearPrivateMediaCache } from '../shared/privateMediaCache'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import type { Manuscript } from './ManuscriptTypes'
import { ManuscriptDashboard } from './ManuscriptDashboard'
import { PlannerPage } from './PlannerPage'
import { BoardsPage } from './BoardsPage'
import { EditorScaffoldSkeleton } from './EditorSkeleton'
import {
  loadManuscriptEditorPage,
  preloadManuscriptEditor,
} from './ManuscriptEditorLoader'
import './ManuscriptSpace.css'
import { manuscriptDetailEndpoint, type ManuscriptAccessMode } from './ManuscriptEndpoints'

export type ManuscriptSpaceView = 'dashboard' | 'planner' | 'boards' | 'glossary' | 'editor'

const ManuscriptEditorPage = lazy(loadManuscriptEditorPage)
const GlossaryPage = lazy(() => import('./GlossaryPage').then((module) => ({
  default: module.GlossaryPage,
})))

type ManuscriptSpaceProps = {
  userId: number
  manuscriptId: string
  view: ManuscriptSpaceView
  routeSearch: string
  onError: (error: string) => void
  onMessage: (message: string) => void
  onViewChange: (view: ManuscriptSpaceView) => void
  onOfflineModeChange: (offline: boolean) => void
  accessMode?: ManuscriptAccessMode
  onAccessLost?: () => void
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function ManuscriptSpace({
  userId,
  manuscriptId,
  view,
  routeSearch,
  onError,
  onMessage,
  onViewChange,
  onOfflineModeChange,
  accessMode = 'owner',
  onAccessLost,
}: ManuscriptSpaceProps) {
  const { t, i18n } = useTranslation()
  const [manuscript, setManuscript] = useState<Manuscript | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editorTarget, setEditorTarget] = useState<{
    manuscriptId: string
    itemId: string | null
  } | null>(null)
  const routeParams = useMemo(() => new URLSearchParams(routeSearch), [routeSearch])
  const requestedItemId = view === 'editor' ? routeParams.get('item') : null
  const routeDocumentItemId = requestedItemId && UUID_PATTERN.test(requestedItemId)
    ? requestedItemId
    : null
  const requestedDialog = view === 'editor' ? routeParams.get('dialog') : null
  const routeEditorDialog = accessMode === 'owner' && (requestedDialog === 'share' || requestedDialog === 'export')
    ? requestedDialog
    : null
  const requestedInspector = view === 'editor' ? routeParams.get('inspector') : null
  const requestedAnnotation = view === 'editor' ? routeParams.get('annotation') : null
  const routeAnnotationId = requestedInspector === 'comments'
    && requestedAnnotation
    && UUID_PATTERN.test(requestedAnnotation)
    ? requestedAnnotation
    : null
  const routeArticleId = view === 'glossary' ? routeParams.get('article') : null
  const routeNoteId = view === 'boards' ? routeParams.get('note') : null

  useEffect(() => {
    let active = true
    async function loadManuscript() {
      setLoading(true)
      setLoadFailed(false)
      try {
        const payload = await apiQuery<{ manuscript: Manuscript }>(
          manuscriptDetailEndpoint(manuscriptId, accessMode),
          {
            onBackgroundUpdate: (next) => {
              if (active) setManuscript(next.manuscript)
            },
          },
        )
        if (active) {
          setManuscript(payload.manuscript)
        }
      } catch (err) {
        if (active) {
          if (accessMode === 'editor' && err instanceof ApiError && err.status === 404) {
            clearPrivateMediaCache()
            onAccessLost?.()
            return
          }
          setLoadFailed(true)
          onError(err instanceof Error ? err.message : i18n.t('editorShell.loadManuscriptFailed'))
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }
    void loadManuscript()
    return () => {
      active = false
    }
  }, [accessMode, i18n, manuscriptId, onAccessLost, onError])

  useEffect(() => {
    if (!manuscript) return
    const timer = window.setTimeout(preloadManuscriptEditor, 250)
    return () => window.clearTimeout(timer)
  }, [manuscript])

  if (loading) {
    return <TadpoleLoadingState className="manuscriptPageState" label={t('editorShell.loadingManuscript')} />
  }
  if (loadFailed || !manuscript) {
    return <div className="manuscriptPageState">{t('editorShell.manuscriptOpenFailed')}</div>
  }
  if (view === 'editor' || accessMode === 'editor') return (
    <Suspense fallback={<EditorScaffoldSkeleton />}>
      <ManuscriptEditorPage
        userId={userId}
        manuscript={manuscript}
        initialDocumentItemId={routeDocumentItemId ?? (editorTarget?.manuscriptId === manuscriptId ? editorTarget.itemId : null)}
        initialDialog={routeEditorDialog}
        initialAnnotationId={routeAnnotationId}
        onManuscriptChange={setManuscript}
        onError={onError}
        onMessage={onMessage}
        onOfflineModeChange={onOfflineModeChange}
        accessMode={accessMode}
        onAccessLost={onAccessLost}
      />
    </Suspense>
  )
  if (view === 'planner') return (
    <PlannerPage
      manuscript={manuscript}
      onManuscriptChange={setManuscript}
      onError={onError}
      onOpenEditorDocument={(itemId) => {
        setEditorTarget({ manuscriptId, itemId })
        onViewChange('editor')
      }}
    />
  )
  if (view === 'boards') return <BoardsPage manuscript={manuscript} initialNoteId={routeNoteId} onError={onError} />
  if (view === 'glossary') return (
    <Suspense fallback={<TadpoleLoadingState className="manuscriptPageState" label={t('glossary.loading')} />}>
      <GlossaryPage
        userId={userId}
        manuscript={manuscript}
        initialArticleId={routeArticleId}
        onError={onError}
      />
    </Suspense>
  )
  return (
    <ManuscriptDashboard
      manuscript={manuscript}
      onManuscriptChange={setManuscript}
      onError={onError}
      onOpenEditorDocument={(itemId) => {
        setEditorTarget({ manuscriptId, itemId })
        onViewChange('editor')
      }}
    />
  )
}
