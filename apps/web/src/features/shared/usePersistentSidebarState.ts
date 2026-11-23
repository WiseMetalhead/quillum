import { useCallback, useEffect, useState } from 'react'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'quillum.sidebar-collapsed'

function storedSidebarState() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function usePersistentSidebarState() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarState)

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
        setSidebarCollapsed(event.newValue === 'true')
      }
    }

    window.addEventListener('storage', syncSidebarState)
    return () => window.removeEventListener('storage', syncSidebarState)
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => !collapsed)
  }, [])

  return [sidebarCollapsed, toggleSidebar] as const
}
