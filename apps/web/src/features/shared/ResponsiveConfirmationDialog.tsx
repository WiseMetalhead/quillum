import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from './ActionDialog'
import { useMobileDialogTransition } from './useMobileDialogTransition'
import { useMobileViewport } from './useMobileViewport'
import './ResponsiveConfirmationDialog.css'

type Props = {
  title: string
  description: ReactNode
  cancelLabel: string
  confirmLabel: string
  busyLabel: string
  closeLabel: string
  busy?: boolean
  danger?: boolean
  onClose: () => void
  onConfirm: () => Promise<boolean>
  onConfirmed?: () => void
}

export function ResponsiveConfirmationDialog({
  title,
  description,
  cancelLabel,
  confirmLabel,
  busyLabel,
  closeLabel,
  busy = false,
  danger = true,
  onClose,
  onConfirm,
  onConfirmed,
}: Props) {
  const isMobile = useMobileViewport()

  async function confirmOnDesktop() {
    try {
      if (await onConfirm()) (onConfirmed ?? onClose)()
    } catch {
      // The owning feature keeps the dialog open and presents the operation error.
    }
  }

  if (!isMobile) {
    return (
      <ActionDialog
        variant="structured"
        role="alertdialog"
        title={title}
        closeLabel={closeLabel}
        busy={busy}
        backdropClassName="responsiveConfirmationBackdrop"
        className="responsiveConfirmationDialog"
        onClose={onClose}
      >
        <div className="standardDialogSection">
          <div className="responsiveConfirmationCopy">{description}</div>
          <footer className="standardDialogFooter">
            <button type="button" className="dialogCancel spaceButton" disabled={busy} onClick={onClose}>{cancelLabel}</button>
            <button type="button" className={`dialogSubmit ${danger ? 'danger' : ''} spaceButton`} disabled={busy} onClick={() => void confirmOnDesktop()}>{busy ? busyLabel : confirmLabel}</button>
          </footer>
        </div>
      </ActionDialog>
    )
  }

  return (
    <MobileConfirmationDialog
      title={title}
      description={description}
      cancelLabel={cancelLabel}
      confirmLabel={confirmLabel}
      busyLabel={busyLabel}
      closeLabel={closeLabel}
      busy={busy}
      danger={danger}
      onClose={onClose}
      onConfirm={onConfirm}
      onConfirmed={onConfirmed}
    />
  )
}

function MobileConfirmationDialog({
  title,
  description,
  cancelLabel,
  confirmLabel,
  busyLabel,
  closeLabel,
  busy = false,
  danger = true,
  onClose,
  onConfirm,
  onConfirmed,
}: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const { backdropStateClass, close, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({
    onClose,
    initialFocusRef: confirmRef,
  })
  const blocked = busy || submitting || closing

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !blocked) close()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [blocked, close])

  async function confirm() {
    if (blocked) return
    setSubmitting(true)
    try {
      const confirmed = await onConfirm()
      if (confirmed) {
        finishAfterExit(onConfirmed ?? onClose)
      } else {
        setSubmitting(false)
      }
    } catch {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      className={`dialogBackdrop mobileBottomSheetBackdrop responsiveConfirmationBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !blocked) close()
      }}
    >
      <section
        className="createOneShotDialog manuscriptDeleteDialog mobileBottomSheet responsiveConfirmationDialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        ref={setDialogRef}
      >
        <header>
          <div><h2 id={titleId}>{title}</h2></div>
          <button type="button" className="dialogClose spaceButton" aria-label={closeLabel} disabled={blocked} onClick={close}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="manuscriptDeleteBody">
          <div className="responsiveConfirmationCopy" id={descriptionId}>{description}</div>
        </div>
        <footer>
          <button type="button" className="dialogCancel spaceButton" disabled={blocked} onClick={close}>{cancelLabel}</button>
          <button ref={confirmRef} type="button" className={danger ? 'dialogDelete spaceButton' : 'dialogSubmit spaceButton'} disabled={blocked} onClick={() => void confirm()}>{busy || submitting ? busyLabel : confirmLabel}</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
