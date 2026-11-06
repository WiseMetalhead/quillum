import { useEffect, useId } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons/Icon'

type ActionDialogProps = {
  title: string
  onClose: () => void
  children: ReactNode
  description?: string
  closeLabel?: string
  busy?: boolean
  className?: string
  backdropClassName?: string
  mobileBackLabel?: string
  mobileBackAction?: () => void
  titleClassName?: string
  escapeAction?: () => void
  mobilePrimaryAction?: {
    label: string
    icon: ReactNode
    onClick: () => void
    disabled?: boolean
  }
  variant?: 'default' | 'structured' | 'compact'
  role?: 'dialog' | 'alertdialog'
}

export function ActionDialog({
  title,
  onClose,
  children,
  description,
  closeLabel,
  busy = false,
  className = '',
  backdropClassName = '',
  mobileBackLabel,
  mobileBackAction,
  titleClassName,
  escapeAction,
  mobilePrimaryAction,
  variant = 'default',
  role = 'dialog',
}: ActionDialogProps) {
  const titleId = useId()

  useEffect(() => {
    if (variant === 'default') return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) (escapeAction ?? onClose)()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [busy, escapeAction, onClose, variant])

  if (variant === 'compact') {
    return createPortal(
      <div
        className={`compactDialogBackdrop ${backdropClassName}`.trim()}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) onClose()
        }}
      >
        <section
          className={`compactActionDialog ${className}`.trim()}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <header>
            <div>
              <h2 id={titleId} className={titleClassName}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <button
              type="button"
              className="compactDialogClose spaceButton"
              aria-label={closeLabel ?? title}
              disabled={busy}
              onClick={onClose}
            >
              <Icon name="close-square-light" />
            </button>
          </header>
          <div className="compactDialogContent">{children}</div>
        </section>
      </div>,
      document.body,
    )
  }

  if (variant === 'structured') {
    return createPortal(
      <div
        className={`standardDialogBackdrop ${backdropClassName}`.trim()}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) onClose()
        }}
      >
        <section
          className={`standardActionDialog ${className}`.trim()}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <header>
            {mobileBackLabel && (
              <button type="button" className="standardDialogMobileBack mobileDialogBack spaceButton" aria-label={mobileBackLabel} disabled={busy} onClick={mobileBackAction ?? onClose}>
                <Icon name="arrow-left-1" />
              </button>
            )}
            <div className={mobileBackLabel ? 'mobileDialogHeaderCopy' : ''}>
              <h2 id={titleId} className={titleClassName}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <button
              type="button"
              className="standardDialogClose spaceButton"
              aria-label={closeLabel ?? title}
              disabled={busy}
              onClick={onClose}
            >
              <Icon name="close-square-light" />
            </button>
            {mobilePrimaryAction && (
              <button
                type="button"
                className="standardDialogMobilePrimary mobileDialogPrimary spaceButton"
                aria-label={mobilePrimaryAction.label}
                title={mobilePrimaryAction.label}
                disabled={busy || mobilePrimaryAction.disabled}
                onClick={mobilePrimaryAction.onClick}
              >
                {mobilePrimaryAction.icon}
              </button>
            )}
          </header>
          <div className="standardDialogContent">{children}</div>
        </section>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div className="modalBackdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`actionDialog ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </section>
    </div>,
    document.body,
  )
}
