import type { CSSProperties } from 'react'
import type { ReactNodeViewProps } from '@tiptap/react'
import { useTranslation } from 'react-i18next'
import { PrivateImage } from '../shared/PrivateImage'
import { IllustrationNodeViewWrapper } from './IllustrationNodeViewWrapper'
import { useResizableIllustration } from './useResizableIllustration'

const DEFAULT_DISPLAY_WIDTH = 80

export function ResizableIllustrationView({
  node,
  editor,
  extension,
  getPos,
  selected,
  updateAttributes,
}: ReactNodeViewProps<HTMLElement>) {
  const { t } = useTranslation()
  const {
    beginResize,
    displayWidth,
    figureRef,
    previewWidth,
    resizeWithKeyboard,
    selectIllustration,
  } = useResizableIllustration({
    editor,
    getPos,
    node,
    updateAttributes,
    defaultDisplayWidth: DEFAULT_DISPLAY_WIDTH,
    resizeAllowed: (figure) => Boolean(figure?.closest('.editorPanel.illustrationResizeEnabled')),
  })

  const assetId = String(node.attrs.assetId ?? '')
  const readOnly = Boolean(extension.options.readOnly)
  const leftResizeLabel = t('documentEditor.resizeImageLeft')
  const rightResizeLabel = t('documentEditor.resizeImageRight')

  return (
    <IllustrationNodeViewWrapper
      ref={figureRef}
      className={`editorIllustration ${selected ? 'selected' : ''} ${previewWidth !== null ? 'resizing' : ''}`.trim()}
      data-asset-id={assetId}
      data-alignment={node.attrs.alignment}
      data-display-width={displayWidth}
      data-drag-handle={editor.isEditable && !readOnly ? '' : undefined}
      draggable={editor.isEditable && !readOnly}
      style={{ '--illustration-display-width': `${displayWidth}%` } as CSSProperties}
      contentEditable={false}
      onMouseDown={readOnly ? undefined : selectIllustration}
    >
      <div className="editorIllustrationFrame">
        <PrivateImage src={extension.options.assetUrl(assetId)} alt={node.attrs.alt} decoding="async" draggable={false} />
        {editor.isEditable && !readOnly && selected && (
          <>
            <button
              type="button"
              className="spaceButton editorIllustrationResizeHandle left"
              aria-label={leftResizeLabel}
              title={leftResizeLabel}
              onPointerDown={(event) => beginResize('left', event)}
              onKeyDown={resizeWithKeyboard}
            />
            <button
              type="button"
              className="spaceButton editorIllustrationResizeHandle right"
              aria-label={rightResizeLabel}
              title={rightResizeLabel}
              onPointerDown={(event) => beginResize('right', event)}
              onKeyDown={resizeWithKeyboard}
            />
            {previewWidth !== null && <span className="editorIllustrationResizeValue">{displayWidth}%</span>}
          </>
        )}
      </div>
      <figcaption>{node.attrs.caption}</figcaption>
    </IllustrationNodeViewWrapper>
  )
}
