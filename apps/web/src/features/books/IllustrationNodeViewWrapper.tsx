import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type DragEvent,
} from 'react'

type Props = ComponentPropsWithoutRef<'figure'>

function installDragPreview(event: DragEvent<HTMLElement>) {
  if (!event.dataTransfer) return
  const source = event.currentTarget
  const rect = source.getBoundingClientRect()
  const preview = source.cloneNode(true) as HTMLElement
  preview.classList.remove('selected', 'resizing')
  preview.querySelectorAll('button, .editorIllustrationResizeValue, .glossaryIllustrationResizeValue')
    .forEach((element) => element.remove())
  preview.removeAttribute('draggable')
  preview.style.width = `${Math.round(rect.width)}px`
  preview.style.height = `${Math.round(rect.height)}px`
  preview.style.maxWidth = 'none'
  preview.style.margin = '0'
  preview.style.pointerEvents = 'none'

  const host = document.createElement('div')
  host.className = source.classList.contains('editorIllustration')
    ? 'tiptapEditor'
    : 'glossaryDocument editable'
  host.style.position = 'fixed'
  host.style.top = '0'
  host.style.left = '-10000px'
  host.style.pointerEvents = 'none'
  host.appendChild(preview)
  document.body.appendChild(host)

  const offsetX = Math.max(0, Math.min(event.clientX - rect.left, rect.width))
  const offsetY = Math.max(0, Math.min(event.clientY - rect.top, rect.height))
  event.dataTransfer.setDragImage(preview, offsetX, offsetY)
  window.setTimeout(() => host.remove(), 0)
}

export const IllustrationNodeViewWrapper = forwardRef<HTMLElement, Props>(
  function IllustrationNodeViewWrapper({ onDragStart, style, ...props }, ref) {
    return (
      <figure
        {...props}
        ref={ref}
        data-node-view-wrapper=""
        style={{ whiteSpace: 'normal', ...style }}
        onDragStart={(event) => {
          installDragPreview(event)
          onDragStart?.(event)
        }}
      />
    )
  },
)
