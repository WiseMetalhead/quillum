import { useEffect, useId, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../../icons/Icon'
import { useMobileDialogTransition } from './useMobileDialogTransition'
import './ResponsiveDetailsPanel.css'

const mobileDetailsQuery = '(max-width: 520px)'

type ResponsiveDetailsPanelProps = {
  open: boolean
  title: string
  closeLabel: string
  desktopClassName: string
  children: ReactNode
  onClose: () => void
  mobileClassName?: string
  backdropClassName?: string
  desktopDialog?: boolean
  mobileBackLabel?: string
  mobileHeaderAction?: ReactNode
  mobileFullViewTransition?: boolean
}

function subscribeToMobileViewport(callback: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(mobileDetailsQuery)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

function getMobileViewportSnapshot() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(mobileDetailsQuery).matches
    : false
}

function getServerMobileViewportSnapshot() {
  return false
}

export function ResponsiveDetailsPanel({
  open,
  title,
  closeLabel,
  desktopClassName,
  mobileClassName = '',
  backdropClassName = '',
  desktopDialog = false,
  mobileBackLabel,
  mobileHeaderAction,
  mobileFullViewTransition = false,
  children,
  onClose,
}: ResponsiveDetailsPanelProps) {
  const isMobile = useSyncExternalStore(
    subscribeToMobileViewport,
    getMobileViewportSnapshot,
    getServerMobileViewportSnapshot,
  )
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const dialogMode = isMobile || desktopDialog

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!dialogMode || !open) return

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (!(isMobile && mobileFullViewTransition)) {
      closeButtonRef.current?.focus({ preventScroll: true })
    }

    function isTopmostDialog() {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
      return dialogs.at(-1) === dialogRef.current
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!isTopmostDialog()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
      previousFocus?.focus({ preventScroll: true })
    }
  }, [dialogMode, isMobile, mobileFullViewTransition, open])

  if (!dialogMode) {
    return <aside className={desktopClassName}>{children}</aside>
  }

  if (!open) return null

  if (isMobile && mobileFullViewTransition) {
    return (
      <TransitionedMobileDetailsPanel
        title={title}
        titleId={titleId}
        closeLabel={closeLabel}
        mobileClassName={mobileClassName}
        backdropClassName={backdropClassName}
        mobileBackLabel={mobileBackLabel}
        mobileHeaderAction={mobileHeaderAction}
        dialogRef={dialogRef}
        closeButtonRef={closeButtonRef}
        onClose={onClose}
      >
        {children}
      </TransitionedMobileDetailsPanel>
    )
  }

  return (
    <div
      className={`responsiveDetailsBackdrop ${backdropClassName}`.trim()}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className={`responsiveDetailsDialog ${isMobile ? mobileClassName : desktopClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <header className={`responsiveDetailsHeader ${isMobile && mobileBackLabel ? 'withMobileNavigation' : ''}`.trim()}>
          {isMobile && mobileBackLabel && (
            <button
              type="button"
              className="responsiveDetailsBack spaceButton"
              aria-label={mobileBackLabel}
              ref={closeButtonRef}
              onClick={onClose}
            >
              <Icon name="arrow-left-1" />
            </button>
          )}
          <h2 id={titleId}>{title}</h2>
          {isMobile && mobileBackLabel ? (
            mobileHeaderAction ?? <span className="responsiveDetailsHeaderSpacer" aria-hidden="true" />
          ) : (
            <button
              type="button"
              className="responsiveDetailsClose spaceButton"
              aria-label={closeLabel}
              ref={closeButtonRef}
              onClick={onClose}
            >
              <Icon name="close-square-light" />
            </button>
          )}
        </header>
        <div className="responsiveDetailsContent">{children}</div>
      </section>
    </div>
  )
}

type TransitionedMobileDetailsPanelProps = {
  title: string
  titleId: string
  closeLabel: string
  mobileClassName: string
  backdropClassName: string
  mobileBackLabel?: string
  mobileHeaderAction?: ReactNode
  dialogRef: React.RefObject<HTMLElement | null>
  closeButtonRef: React.RefObject<HTMLButtonElement | null>
  children: ReactNode
  onClose: () => void
}

function TransitionedMobileDetailsPanel({
  title,
  titleId,
  closeLabel,
  mobileClassName,
  backdropClassName,
  mobileBackLabel,
  mobileHeaderAction,
  dialogRef,
  closeButtonRef,
  children,
  onClose,
}: TransitionedMobileDetailsPanelProps) {
  const {
    backdropStateClass,
    close,
    closing,
    setDialogRef,
  } = useMobileDialogTransition({ onClose, focusOnDesktop: false })

  function setCombinedDialogRef(node: HTMLElement | null) {
    dialogRef.current = node
    setDialogRef(node)
  }

  return (
    <div
      className={`responsiveDetailsBackdrop mobileFullViewBackdrop ${backdropClassName} ${backdropStateClass}`.trim()}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <section
        className={`responsiveDetailsDialog mobileFullView ${mobileClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={setCombinedDialogRef}
      >
        <header className={`responsiveDetailsHeader ${mobileBackLabel ? 'withMobileNavigation' : ''}`.trim()}>
          {mobileBackLabel && (
            <button
              type="button"
              className="responsiveDetailsBack spaceButton"
              aria-label={mobileBackLabel}
              ref={closeButtonRef}
              disabled={closing}
              onClick={close}
            >
              <Icon name="arrow-left-1" />
            </button>
          )}
          <h2 id={titleId}>{title}</h2>
          {mobileBackLabel ? (
            mobileHeaderAction ?? <span className="responsiveDetailsHeaderSpacer" aria-hidden="true" />
          ) : (
            <button
              type="button"
              className="responsiveDetailsClose spaceButton"
              aria-label={closeLabel}
              ref={closeButtonRef}
              disabled={closing}
              onClick={close}
            >
              <Icon name="close-square-light" />
            </button>
          )}
        </header>
        <div className="responsiveDetailsContent">{children}</div>
      </section>
    </div>
  )
}
