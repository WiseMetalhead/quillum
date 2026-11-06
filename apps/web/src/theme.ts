export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'quillum.theme-preference'
const THEME_CHANGE_EVENT = 'quillum-theme-change'
const themeListeners = new Set<() => void>()
let systemThemeQuery: MediaQueryList | null = null

function applyThemeColor(preference: ThemePreference, resolved: ResolvedTheme) {
  document.querySelectorAll<HTMLMetaElement>('meta[data-theme-color]').forEach((meta) => {
    const metaTheme = meta.dataset.themeColor
    meta.media = preference === 'system'
      ? `(prefers-color-scheme: ${metaTheme})`
      : metaTheme === resolved ? 'all' : 'not all'
  })
}

function handleSystemThemeChange() {
  if (getThemePreference() === 'system') {
    applyThemePreference('system', { persist: false })
  }
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function getThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isThemePreference(stored) ? stored : 'system'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') {
    return preference
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyThemePreference(
  preference: ThemePreference,
  options: { persist?: boolean } = {},
) {
  const resolved = resolveTheme(preference)
  document.documentElement.dataset.themePreference = preference
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  applyThemeColor(preference, resolved)
  if (options.persist !== false) {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, {
    detail: { preference, resolved },
  }))
  return resolved
}

export function toggleGuestTheme() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  return applyThemePreference(current === 'dark' ? 'light' : 'dark')
}

export function subscribeThemeChange(listener: () => void) {
  themeListeners.add(listener)
  window.addEventListener(THEME_CHANGE_EVENT, listener)
  if (!systemThemeQuery) {
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    systemThemeQuery.addEventListener('change', handleSystemThemeChange)
  }
  return () => {
    themeListeners.delete(listener)
    window.removeEventListener(THEME_CHANGE_EVENT, listener)
    if (themeListeners.size === 0 && systemThemeQuery) {
      systemThemeQuery.removeEventListener('change', handleSystemThemeChange)
      systemThemeQuery = null
    }
  }
}
