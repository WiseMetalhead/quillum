import { useTranslation } from 'react-i18next'

export function EditorScaffoldSkeleton() {
  const { t } = useTranslation()
  return (
    <div className="editorScaffold editorSkeleton" aria-label={t('documentEditor.loadingEditor')} aria-busy="true">
      <aside className="contentsPanel">
        <div className="skeletonPanelHeader">
          <Skeleton width="58%" />
          <Skeleton square />
        </div>
        <Skeleton width="42%" />
        <Skeleton height={42} />
      </aside>
      <div className="editorPanelResizer contents" />
      <EditorDocumentSkeleton />
      <nav className="inspectorRail skeletonInspectorRail" aria-hidden="true">
        {[1, 2, 3, 4].map((item) => <Skeleton key={item} square />)}
      </nav>
    </div>
  )
}

export function EditorDocumentSkeleton() {
  const { t } = useTranslation()
  return (
    <main className="editorPanel editorDocumentSkeleton" aria-label={t('documentEditor.loadingDocument')} aria-busy="true">
      <div className="skeletonDocumentHeader">
        <Skeleton width="38%" />
        <Skeleton width="96px" />
      </div>
      <div className="skeletonToolbar">
        <Skeleton width="104px" height={34} />
        {[1, 2, 3, 4, 5, 6].map((item) => <Skeleton key={item} square />)}
        <span />
        <Skeleton width="66px" height={34} />
        <Skeleton square />
      </div>
      <div className="skeletonCanvas">
        <div className="skeletonPaper">
          <Skeleton width="92%" />
          <Skeleton />
          <Skeleton width="84%" />
          <Skeleton width="96%" />
          <Skeleton width="68%" />
        </div>
      </div>
      <div className="skeletonStatus"><Skeleton width="210px" /></div>
    </main>
  )
}

function Skeleton({
  width = '100%',
  height = 14,
  square = false,
}: {
  width?: string
  height?: number
  square?: boolean
}) {
  return (
    <span
      className="skeletonBlock"
      style={{ width: square ? 34 : width, height: square ? 34 : height }}
    />
  )
}
