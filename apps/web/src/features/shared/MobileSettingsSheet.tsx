import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useMobileDialogTransition } from './useMobileDialogTransition'
import './MobileSettingsSheet.css'

type Props = {
  title: string
  onClose: () => void
  children: ReactNode | ((close: () => void) => ReactNode)
  busy?: boolean
  role?: 'dialog' | 'alertdialog'
  initialFocus?: 'first-control' | 'dialog'
}

export function MobileSettingsSheet({
  title,
  onClose,
  children,
  busy = false,
  role = 'dialog',
  initialFocus = 'first-control',
}: Props) {
  const titleId = useId()
  const sheetRef = useRef<HTMLElement | null>(null)
  const dragStartRef = useRef<number | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const {
    backdropStateClass,
    close,
    closing,
    setDialogRef,
  } = useMobileDialogTransition({ onClose })
  const blocked = busy || closing

  const setSheetRef = useCallback((node: HTMLElement | null) => {
    sheetRef.current = node
    setDialogRef(node)
  }, [setDialogRef])

  const closeSheet = useCallback(() => {
    if (!blocked) close()
  }, [blocked, close])

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const finalOffset = dragStartRef.current === null
      ? dragOffset
      : Math.max(0, event.clientY - dragStartRef.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragStartRef.current = null
    if (finalOffset >= 72) closeSheet()
    else setDragOffset(0)
  }

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.requestAnimationFrame(() => {
      if (initialFocus === 'dialog') {
        sheetRef.current?.focus()
        return
      }
      sheetRef.current?.querySelector<HTMLElement>(
        'input:not(:disabled), button:not(:disabled), textarea:not(:disabled)',
      )?.focus()
    })

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeSheet()
        return
      }
      if (event.key !== 'Tab' || !sheetRef.current) return
      const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(
        'input:not(:disabled), button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheetRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = previousBodyOverflow
      previousFocus?.focus()
    }
  }, [closeSheet, initialFocus])

  const content = typeof children === 'function' ? children(closeSheet) : children

  return createPortal(
    <div
      className={`accountSheetBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSheet()
      }}
    >
      <section
        className={`accountSheet ${dragOffset > 0 ? 'dragging' : ''}`}
        style={{ '--account-sheet-drag': `${dragOffset}px` } as CSSProperties}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={blocked || undefined}
        tabIndex={initialFocus === 'dialog' ? -1 : undefined}
        ref={setSheetRef}
      >
        <div
          className="accountSheetHandle"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (blocked) return
            dragStartRef.current = event.clientY
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (dragStartRef.current === null) return
            setDragOffset(Math.max(0, event.clientY - dragStartRef.current))
          }}
          onPointerUp={finishDrag}
          onPointerCancel={() => {
            dragStartRef.current = null
            setDragOffset(0)
          }}
        >
          <span />
        </div>
        <header><h2 id={titleId}>{title}</h2></header>
        <div className="accountSheetContent">{content}</div>
      </section>
    </div>,
    document.body,
  )
}
