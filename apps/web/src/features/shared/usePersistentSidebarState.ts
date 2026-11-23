import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FocusEventHandler, PointerEventHandler } from 'react'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'quillum.sidebar-collapsed'
const SIDEBAR_PREVIEW_DELAY_MS = 320
const SIDEBAR_PREVIEW_POINTER_QUERY = '(hover: hover) and (pointer: fine)'

export type SidebarPreviewProps = {
  'data-sidebar-preview-expanded'?: 'true'
  onPointerEnter: PointerEventHandler<HTMLElement>
  onPointerLeave: PointerEventHandler<HTMLElement>
  onFocusCapture: FocusEventHandler<HTMLElement>
  onBlurCapture: FocusEventHandler<HTMLElement>
}

function storedSidebarState() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function usePersistentSidebarState() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarState)
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const previewTimerRef = useRef<number | null>(null)

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
  }, [])

  const closePreview = useCallback(() => {
    clearPreviewTimer()
    setPreviewExpanded(false)
  }, [clearPreviewTimer])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        sidebarCollapsed ? 'true' : 'false',
      )
    } catch {
      // Keep the in-memory preference when browser storage is unavailable.
    }
  }, [sidebarCollapsed])

  useEffect(() => {
    function syncSidebarState(event: StorageEvent) {
      if (event.key === SIDEBAR_COLLAPSED_STORAGE_KEY) {
        closePreview()
        setSidebarCollapsed(event.newValue === 'true')
      }
    }

    window.addEventListener('storage', syncSidebarState)
    return () => window.removeEventListener('storage', syncSidebarState)
  }, [closePreview])

  useEffect(() => clearPreviewTimer, [clearPreviewTimer])

  const toggleSidebar = useCallback(() => {
    closePreview()
    setSidebarCollapsed((collapsed) => !collapsed)
  }, [closePreview])

  const sidebarPreviewProps = useMemo<SidebarPreviewProps>(() => ({
    'data-sidebar-preview-expanded': sidebarCollapsed && previewExpanded ? 'true' : undefined,
    onPointerEnter: (event) => {
      if (
        !sidebarCollapsed
        || (event.pointerType && event.pointerType !== 'mouse')
        || !window.matchMedia(SIDEBAR_PREVIEW_POINTER_QUERY).matches
      ) {
        return
      }

      clearPreviewTimer()
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = null
        setPreviewExpanded(true)
      }, SIDEBAR_PREVIEW_DELAY_MS)
    },
    onPointerLeave: closePreview,
    onFocusCapture: (event) => {
      if (sidebarCollapsed && event.target instanceof HTMLElement && event.target.matches(':focus-visible')) {
        clearPreviewTimer()
        setPreviewExpanded(true)
      }
    },
    onBlurCapture: (event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
        closePreview()
      }
    },
  }), [sidebarCollapsed, previewExpanded, clearPreviewTimer, closePreview])

  return [sidebarCollapsed, toggleSidebar, sidebarPreviewProps] as const
}
