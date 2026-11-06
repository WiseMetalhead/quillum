import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setInterfaceLanguage } from '../../i18n'
import { Icon } from '../../icons/Icon'
import type { ServicePageMetadata } from '../../types'
import { ServicePageLinks } from './ServicePageLinks'

type Props = {
  pages: ServicePageMetadata[]
}

export function PublicFooter({ pages }: Props) {
  const { t, i18n } = useTranslation()
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
  const languageMenuRef = useRef<HTMLDivElement>(null)
  const currentLanguage = i18n.resolvedLanguage?.startsWith('ru') ? 'ru' : 'en'

  useEffect(() => {
    if (!languageMenuOpen) return
    function closeMenu(event: PointerEvent) {
      if (!languageMenuRef.current?.contains(event.target as Node)) setLanguageMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setLanguageMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [languageMenuOpen])

  function selectLanguage(language: 'en' | 'ru') {
    setLanguageMenuOpen(false)
    void setInterfaceLanguage(language)
  }

  return (
    <footer className="authFooter">
      <span>&copy; 2026 Quillum</span>
      <ServicePageLinks pages={pages} shortLabels />
      <div className="authLanguage" ref={languageMenuRef}>
        <Icon name="global-light" />
        <button
          type="button"
          className="authLanguageButton spaceButton"
          aria-label={t('common.language')}
          aria-haspopup="menu"
          aria-expanded={languageMenuOpen}
          onClick={() => setLanguageMenuOpen((open) => !open)}
        >
          <span>{t(currentLanguage === 'ru' ? 'common.russian' : 'common.english')}</span>
          <Icon name="arrow-down-2" />
        </button>
        {languageMenuOpen && (
          <div className="authLanguageMenu" role="menu">
            {(['en', 'ru'] as const).map((language) => (
              <button
                type="button"
                className="spaceButton"
                role="menuitemradio"
                aria-checked={currentLanguage === language}
                key={language}
                onClick={() => selectLanguage(language)}
              >
                <span>{t(language === 'ru' ? 'common.russian' : 'common.english')}</span>
                {currentLanguage === language && <Icon name="check-read-light" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </footer>
  )
}
