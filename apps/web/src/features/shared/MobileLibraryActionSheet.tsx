import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMobileViewport } from './useMobileViewport'
import './MobileLibraryActionSheet.css'

export type LibraryAction = {
  key: string
  label: string
  icon: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  selected?: boolean
}

type Props = {
  open: boolean
  title: string
  actions: LibraryAction[]
  onClose: () => void
  dismissOnSelect?: boolean
  topContent?: ReactNode
  onActionSelect?: (action: LibraryAction) => void
  backdropClassName?: string
}

export function MobileLibraryActionSheet({ open, title, actions, onClose, dismissOnSelect = false, topContent, onActionSelect, backdropClassName = '' }: Props) {
  const isMobile = useMobileViewport()
  const titleId = useId()
  const sheetRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const dragStartRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const [dragOffset, setDragOffset] = useState(0)
  const [closing, setClosing] = useState(false)

  const closeSheet = useCallback((afterClose?: () => void) => {
    if (closingRef.current) return
    closingRef.current = true
    dragStartRef.current = null
    setClosing(true)
    const closeDelay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      closingRef.current = false
      setClosing(false)
      setDragOffset(0)
      onCloseRef.current()
      afterClose?.()
    }, closeDelay)
  }, [])

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isMobile || !open) return

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sheetRef.current?.querySelector<HTMLElement>(
      'input:not(:disabled), button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
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
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousBodyOverflow
      previousFocus?.focus()
      dragStartRef.current = null
      closingRef.current = false
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }
  }, [closeSheet, isMobile, open])

  if (!isMobile || !open) return null

  const sheetStyle = { '--library-sheet-drag': `${dragOffset}px` } as CSSProperties

  return createPortal(
    <div
      className={`mobileLibraryActionBackdrop ${backdropClassName} ${closing ? 'closing' : ''}`.trim()}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeSheet()
      }}
    >
      <section
        className={`mobileLibraryActionSheet ${dragOffset > 0 ? 'dragging' : ''} ${closing ? 'closing' : ''}`}
        style={sheetStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={sheetRef}
      >
        <div
          className="mobileLibraryActionHandle"
          aria-hidden="true"
          onPointerDown={(event) => {
            dragStartRef.current = event.clientY
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (dragStartRef.current === null) return
            setDragOffset(Math.max(0, event.clientY - dragStartRef.current))
          }}
          onPointerUp={(event) => {
            const finalOffset = dragStartRef.current === null
              ? dragOffset
              : Math.max(0, event.clientY - dragStartRef.current)
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            dragStartRef.current = null
            if (finalOffset >= 72) closeSheet()
            else setDragOffset(0)
          }}
          onPointerCancel={() => {
            dragStartRef.current = null
            setDragOffset(0)
          }}
        >
          <span />
        </div>
        <header className="mobileLibraryActionHeader">
          <h2 id={titleId}>{title}</h2>
        </header>
        {topContent && <div className="mobileLibraryActionTopContent">{topContent}</div>}
        <div className="mobileLibraryActionList">
          {actions.map((action) => (
            <button
              type="button"
              className={`mobileLibraryAction booksButton ${action.danger ? 'danger' : ''} ${action.selected ? 'selected' : ''}`.trim()}
              disabled={action.disabled}
              aria-pressed={action.selected}
              key={action.key}
              onClick={() => {
                const selectAction = () => {
                  if (action.onSelect) action.onSelect()
                  else onActionSelect?.(action)
                }
                if (dismissOnSelect) closeSheet(selectAction)
                else selectAction()
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  )
}
