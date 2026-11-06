import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import type { WorkspaceSearchResult } from '../../types'
import { useMobileViewport } from '../shared/useMobileViewport'
import { WorkspaceSearch } from './WorkspaceSearch'

type Props = {
  endpoint: string
  kinds: ReadonlyArray<WorkspaceSearchResult['kind']>
  placeholder: string
  emptyMessage: string
  onSelect: (result: WorkspaceSearchResult) => void
  onOpen?: () => void
  showAuthor?: boolean
  disabled?: boolean
}

export function HeaderWorkspaceSearch({
  endpoint,
  kinds,
  placeholder,
  emptyMessage,
  onSelect,
  onOpen,
  showAuthor = false,
  disabled = false,
}: Props) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const [mobileOpen, setMobileOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const overlayRef = useRef<HTMLElement>(null)
  const mobileOverlayOpen = mobileOpen && isMobile && !disabled

  const closeMobileSearch = useCallback(() => {
    setMobileOpen(false)
  }, [])

  useEffect(() => {
    if (isMobile && !disabled) return
    const closeFrame = window.requestAnimationFrame(closeMobileSearch)
    return () => window.cancelAnimationFrame(closeFrame)
  }, [closeMobileSearch, disabled, isMobile])

  useEffect(() => {
    if (!mobileOverlayOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const restoreFocusTarget = triggerRef.current ?? previousFocus
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusFrame = window.requestAnimationFrame(() => {
      overlayRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
    })

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeMobileSearch()
        return
      }
      if (event.key !== 'Tab' || !overlayRef.current) return
      const focusable = Array.from(overlayRef.current.querySelectorAll<HTMLElement>(
        'input:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
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

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = previousBodyOverflow
      if (restoreFocusTarget?.isConnected) restoreFocusTarget.focus({ preventScroll: true })
    }
  }, [closeMobileSearch, mobileOverlayOpen])

  function selectMobileResult(result: WorkspaceSearchResult) {
    closeMobileSearch()
    onSelect(result)
  }

  if (!isMobile) {
    return (
      <WorkspaceSearch
        endpoint={endpoint}
        kinds={kinds}
        placeholder={placeholder}
        emptyMessage={emptyMessage}
        onSelect={onSelect}
        showAuthor={showAuthor}
        presentation="header"
        clearOnSelect
        disabled={disabled}
      />
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="headerSearchButton spaceButton"
        title={placeholder}
        aria-label={placeholder}
        aria-haspopup="dialog"
        aria-expanded={mobileOverlayOpen}
        aria-controls="header-workspace-search-overlay"
        disabled={disabled}
        onClick={() => {
          onOpen?.()
          setMobileOpen(true)
        }}
      >
        <Icon name="magnifer-outline" className="workspaceMagniferIcon" />
      </button>
      {mobileOverlayOpen && createPortal(
        <section
          ref={overlayRef}
          id="header-workspace-search-overlay"
          className="headerSearchMobileOverlay"
          role="dialog"
          aria-modal="true"
          aria-label={placeholder}
        >
          <button
            type="button"
            className="headerSearchMobileClose spaceButton"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={closeMobileSearch}
          >
            <Icon name="close-light" />
          </button>
          <WorkspaceSearch
            endpoint={endpoint}
            kinds={kinds}
            placeholder={placeholder}
            emptyMessage={emptyMessage}
            onSelect={selectMobileResult}
            onEscape={closeMobileSearch}
            showAuthor={showAuthor}
            presentation="mobileOverlay"
            clearOnSelect
          />
        </section>,
        document.body,
      )}
    </>
  )
}
