import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import { subscribeThemeChange, toggleGuestTheme } from '../../theme'

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function ThemeToggle() {
  const { t } = useTranslation()
  const [theme, setTheme] = useState(currentTheme)

  useEffect(() => subscribeThemeChange(() => setTheme(currentTheme())), [])

  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const label = nextTheme === 'dark' ? t('theme.useDark') : t('theme.useLight')

  return (
    <button
      type="button"
      className="themeToggle spaceButton"
      aria-label={label}
      title={label}
      onClick={() => setTheme(toggleGuestTheme())}
    >
      <Icon name={theme === 'dark' ? 'sun-light' : 'moon-light'} />
    </button>
  )
}
