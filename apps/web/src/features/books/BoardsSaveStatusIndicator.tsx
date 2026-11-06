import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import type { BoardsSaveStatus } from './BoardsTypes'
import './BoardsSaveStatusIndicator.css'

type Props = {
  status: BoardsSaveStatus
  className?: string
  retryLabel?: string
  onRetry?: () => void
}

export function BoardsSaveStatusIndicator({ status, className = '', retryLabel, onRetry }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const details = {
    saved: { icon: 'cloud-yes' as const, label: t('boards.synced'), description: t('boards.syncedLead') },
    dirty: { icon: 'cloud-upload' as const, label: t('boards.dirty'), description: t('boards.dirtyLead') },
    saving: { icon: 'cloud-upload' as const, label: t('boards.syncing'), description: t('boards.syncingLead') },
    error: { icon: 'cloud-no' as const, label: t('boards.syncFailed'), description: t('boards.syncFailedLead') },
  }[status]

  useEffect(() => {
    if (!open) return
    function closeStatus(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeStatusOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeStatus)
    document.addEventListener('keydown', closeStatusOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeStatus)
      document.removeEventListener('keydown', closeStatusOnEscape)
    }
  }, [open])

  return (
    <div className={`boardsSaveStatus ${className}`.trim()} ref={containerRef}>
      <button type="button" className={`boardsSaveStatusButton spaceButton ${status}`} aria-label={details.label} aria-haspopup="dialog" aria-expanded={open} title={details.label} onClick={() => setOpen((current) => !current)}><Icon name={details.icon} /></button>
      {open && (
        <div className="boardsSaveStatusPopover" role={status === 'error' && onRetry ? 'dialog' : 'status'}>
          <Icon name={details.icon} />
          <div>
            <strong>{details.label}</strong>
            <span>{details.description}</span>
            {status === 'error' && onRetry && retryLabel && (
              <button
                type="button"
                className="spaceButton"
                onClick={() => {
                  setOpen(false)
                  onRetry()
                }}
              >
                {retryLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
