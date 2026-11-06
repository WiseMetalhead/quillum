export const PWA_UPDATE_EVENT = 'quillum:pwa-update-available'

function announceUpdate() {
  window.dispatchEvent(new Event(PWA_UPDATE_EVENT))
}

function watchWorker(worker: ServiceWorker, announceWhenInstalled: boolean) {
  worker.addEventListener('statechange', () => {
    if (
      announceWhenInstalled
      && worker.state === 'installed'
      && navigator.serviceWorker.controller
    ) {
      announceUpdate()
    }
  })
}

export function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    }).then(async (registration) => {
      let announceFutureUpdates = false

      if (registration.installing) watchWorker(registration.installing, false)
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        if (!worker) return
        watchWorker(worker, announceFutureUpdates)
      })

      try {
        await registration.update()
      } catch {
        // Registration succeeded; a later foreground check can retry update discovery.
      } finally {
        announceFutureUpdates = true
      }

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update()
      })
    }).catch(() => {
      // PWA installation is optional; the hosted application remains usable without registration.
    })
  }, { once: true })
}
