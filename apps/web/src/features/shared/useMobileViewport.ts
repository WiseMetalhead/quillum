import { useSyncExternalStore } from 'react'

const MOBILE_VIEWPORT_QUERY = '(max-width: 520px)'

function subscribeToMobileViewport(callback: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(MOBILE_VIEWPORT_QUERY)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

function getMobileViewportSnapshot() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_VIEWPORT_QUERY).matches
    : false
}

function getServerMobileViewportSnapshot() {
  return false
}

export function useMobileViewport() {
  return useSyncExternalStore(
    subscribeToMobileViewport,
    getMobileViewportSnapshot,
    getServerMobileViewportSnapshot,
  )
}
