import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent } from 'react'
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { useTranslation } from 'react-i18next'
import { API_BASE } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import { PrivateImage } from '../shared/PrivateImage'
import { IllustrationNodeViewWrapper } from './IllustrationNodeViewWrapper'
import { useResizableIllustration } from './useResizableIllustration'

const CALLOUT_ICONS: Record<string, IconName> = {
  info: 'information-circle-light',
  attention: 'siren-rounded-light',
  warning: 'danger-light',
  check: 'check-circle-1-light',
}

function normalizedCalloutKind(value: unknown) {
  if (value === 'note') return 'attention'
  if (value === 'tip') return 'check'
  return typeof value === 'string' && value in CALLOUT_ICONS ? value : 'info'
}

export function GlossaryCalloutView({ node }: ReactNodeViewProps) {
  const kind = normalizedCalloutKind(node.attrs.kind)

  return (
    <NodeViewWrapper as="aside" className="glossaryCallout" data-glossary-callout="" data-kind={kind}>
      <span className="glossaryCalloutIcon" contentEditable={false}>
        <Icon name={CALLOUT_ICONS[kind]} />
      </span>
      <NodeViewContent className="glossaryCalloutContent" />
    </NodeViewWrapper>
  )
}

export function GlossaryIllustrationGalleryView({ node }: ReactNodeViewProps) {
  const columns = Math.min(node.childCount, 3)
  return (
    <NodeViewWrapper
      as="section"
      className={`glossaryGallery glossaryGalleryColumns${columns}`}
      data-glossary-gallery=""
    >
      <NodeViewContent className="glossaryGalleryGrid" />
    </NodeViewWrapper>
  )
}

export function GlossaryIllustrationView({
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
    defaultDisplayWidth: 100,
  })
  const manuscriptId = String(extension.options.manuscriptId ?? '')

  const leftResizeLabel = t('glossary.resizeImageLeft')
  const rightResizeLabel = t('glossary.resizeImageRight')
  const openImageLabel = t('glossary.openImageLightbox')

  function selectOrPreserveReadMode(event: MouseEvent<HTMLElement>) {
    if (editor.isEditable) selectIllustration(event)
    else event.preventDefault()
  }

  function openIllustration(event: MouseEvent<HTMLElement>) {
    if (editor.isEditable) return
    event.currentTarget.focus()
    extension.options.onOpenLightbox?.({
      assetId: String(node.attrs.assetId ?? ''),
      alt: String(node.attrs.alt ?? ''),
      caption: String(node.attrs.caption ?? ''),
    })
  }

  function openWithKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
    if (editor.isEditable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    extension.options.onOpenLightbox?.({
      assetId: String(node.attrs.assetId ?? ''),
      alt: String(node.attrs.alt ?? ''),
      caption: String(node.attrs.caption ?? ''),
    })
  }

  return (
    <IllustrationNodeViewWrapper
      ref={figureRef}
      className={`glossaryIllustration ${selected ? 'selected' : ''} ${previewWidth !== null ? 'resizing' : ''}`.trim()}
      data-glossary-asset=""
      data-asset-id={node.attrs.assetId}
      data-alignment={node.attrs.alignment}
      data-display-width={displayWidth}
      data-drag-handle={editor.isEditable ? '' : undefined}
      draggable={editor.isEditable}
      style={{ width: `${displayWidth}%` }}
      contentEditable={false}
      role={editor.isEditable ? undefined : 'button'}
      tabIndex={editor.isEditable ? undefined : 0}
      aria-label={editor.isEditable ? undefined : openImageLabel}
      title={editor.isEditable ? undefined : openImageLabel}
      onMouseDown={selectOrPreserveReadMode}
      onClick={openIllustration}
      onKeyDown={openWithKeyboard}
    >
      <div className="glossaryIllustrationFrame">
        <PrivateImage
          src={`${API_BASE}/api/manuscripts/${manuscriptId}/glossary/assets/${node.attrs.assetId}/large/`}
          alt={node.attrs.alt}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
        {editor.isEditable && selected && (
          <>
            <button
              type="button"
              className="spaceButton glossaryIllustrationResizeHandle left"
              aria-label={leftResizeLabel}
              title={leftResizeLabel}
              onPointerDown={(event) => beginResize('left', event)}
              onKeyDown={resizeWithKeyboard}
            />
            <button
              type="button"
              className="spaceButton glossaryIllustrationResizeHandle right"
              aria-label={rightResizeLabel}
              title={rightResizeLabel}
              onPointerDown={(event) => beginResize('right', event)}
              onKeyDown={resizeWithKeyboard}
            />
            {previewWidth !== null && <span className="glossaryIllustrationResizeValue">{displayWidth}%</span>}
          </>
        )}
      </div>
      <figcaption>{node.attrs.caption}</figcaption>
    </IllustrationNodeViewWrapper>
  )
}
