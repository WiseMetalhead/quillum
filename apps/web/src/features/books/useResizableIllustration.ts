import { useEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import type { ReactNodeViewProps } from '@tiptap/react'

const MIN_DISPLAY_WIDTH = 25
const MAX_DISPLAY_WIDTH = 100

type Options = Pick<
  ReactNodeViewProps<HTMLElement>,
  'editor' | 'getPos' | 'node' | 'updateAttributes'
> & {
  defaultDisplayWidth: number
  resizeAllowed?: (figure: HTMLElement | null) => boolean
}

export function useResizableIllustration({
  editor,
  getPos,
  node,
  updateAttributes,
  defaultDisplayWidth,
  resizeAllowed,
}: Options) {
  const figureRef = useRef<HTMLElement | null>(null)
  const cleanupResizeRef = useRef<(() => void) | null>(null)
  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  const persistedWidth = normalizedDisplayWidth(node.attrs.displayWidth, defaultDisplayWidth)
  const displayWidth = previewWidth ?? persistedWidth

  useEffect(() => () => cleanupResizeRef.current?.(), [])

  function canResize() {
    return editor.isEditable && (resizeAllowed?.(figureRef.current) ?? true)
  }

  function updateWidth(nextWidth: number) {
    const normalizedWidth = Math.min(
      MAX_DISPLAY_WIDTH,
      Math.max(MIN_DISPLAY_WIDTH, Math.round(nextWidth)),
    )
    if (normalizedWidth !== persistedWidth) updateAttributes({ displayWidth: normalizedWidth })
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!canResize()) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      updateWidth(persistedWidth - 5)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      updateWidth(persistedWidth + 5)
    }
  }

  function beginResize(edge: 'left' | 'right', event: ReactPointerEvent<HTMLButtonElement>) {
    if (!canResize() || !figureRef.current) return
    event.preventDefault()
    event.stopPropagation()
    cleanupResizeRef.current?.()

    const startX = event.clientX
    const startWidth = figureRef.current.getBoundingClientRect().width
    const availableWidth = startWidth / (persistedWidth / 100)
    if (!Number.isFinite(availableWidth) || availableWidth <= 0) return
    let nextWidth = persistedWidth

    const move = (pointerEvent: PointerEvent) => {
      const delta = edge === 'right'
        ? pointerEvent.clientX - startX
        : startX - pointerEvent.clientX
      nextWidth = Math.min(
        MAX_DISPLAY_WIDTH,
        Math.max(MIN_DISPLAY_WIDTH, Math.round(((startWidth + delta) / availableWidth) * 100)),
      )
      setPreviewWidth(nextWidth)
    }

    const finish = () => {
      cleanupResizeRef.current?.()
      setPreviewWidth(null)
      updateWidth(nextWidth)
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      cleanupResizeRef.current = null
    }

    cleanupResizeRef.current = cleanup
    setPreviewWidth(persistedWidth)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  function selectIllustration(event: MouseEvent<HTMLElement>) {
    if (!editor.isEditable || (event.target instanceof Element && event.target.closest('button'))) return
    const position = getPos()
    if (typeof position !== 'number') return
    editor.commands.setNodeSelection(position)
  }

  return {
    beginResize,
    displayWidth,
    figureRef,
    previewWidth,
    resizeWithKeyboard,
    selectIllustration,
  }
}

function normalizedDisplayWidth(value: unknown, fallback: number) {
  return Number.isInteger(value) && Number(value) >= MIN_DISPLAY_WIDTH && Number(value) <= MAX_DISPLAY_WIDTH
    ? Number(value)
    : fallback
}
