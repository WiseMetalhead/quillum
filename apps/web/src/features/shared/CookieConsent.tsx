import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'

const COOKIE_CONSENT_STORAGE_KEY = 'quillum.functional-cookie-consent'

function hasCookieConsent() {
  try {
    return window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY) === 'accepted'
  } catch {
    return false
  }
}

export function CookieConsent() {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(() => !hasCookieConsent())
  const [footerOffset, setFooterOffset] = useState(0)

  useEffect(() => {
    if (!visible) {
      return
    }

    let observedFooter: HTMLElement | null = null
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateFooterOffset)

    function updateFooterOffset() {
      const footer = document.querySelector<HTMLElement>('.authFooter')
      if (footer !== observedFooter) {
        if (observedFooter) {
          resizeObserver?.unobserve(observedFooter)
        }
        observedFooter = footer
        if (footer) {
          resizeObserver?.observe(footer)
        }
      }

      if (!footer) {
        setFooterOffset((current) => current === 0 ? current : 0)
        return
      }

      const bounds = footer.getBoundingClientRect()
      const visibleFooterHeight = Math.min(
        bounds.height,
        Math.max(0, window.innerHeight - bounds.top),
      )
      setFooterOffset((current) => current === visibleFooterHeight ? current : visibleFooterHeight)
    }

    const mutationObserver = new MutationObserver(updateFooterOffset)
    mutationObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', updateFooterOffset)
    window.addEventListener('scroll', updateFooterOffset, true)
    updateFooterOffset()

    return () => {
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateFooterOffset)
      window.removeEventListener('scroll', updateFooterOffset, true)
    }
  }, [visible])

  if (!visible) {
    return null
  }

  function accept() {
    try {
      window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, 'accepted')
      setVisible(false)
    } catch {
      // Keep the notice visible when browser storage is unavailable.
    }
  }

  return (
    <aside
      className="cookieConsent"
      role="status"
      aria-label={t('cookieConsent.label')}
      style={{ '--cookie-footer-offset': `${footerOffset}px` } as CSSProperties}
    >
      <Icon name="mingcute-cookie-line" className="cookieConsentIcon" />
      <p>{t('cookieConsent.description')}</p>
      <button type="button" className="spaceButton" onClick={accept}>
        {t('cookieConsent.accept')}
      </button>
    </aside>
  )
}
