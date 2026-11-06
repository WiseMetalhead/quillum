import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './locales/en'
import { ru } from './locales/ru'

export const supportedLanguages = ['en', 'ru'] as const
export type SupportedLanguage = (typeof supportedLanguages)[number]

const LANGUAGE_STORAGE_KEY = 'quillum.interface-language'

export function normalizeLanguage(value: string | null | undefined): SupportedLanguage | null {
  const language = value?.trim().toLowerCase().split('-')[0]
  return supportedLanguages.find((candidate) => candidate === language) ?? null
}

export function detectedLanguage(): SupportedLanguage {
  const stored = normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
  if (stored) return stored
  for (const language of navigator.languages ?? [navigator.language]) {
    const normalized = normalizeLanguage(language)
    if (normalized) return normalized
  }
  return 'en'
}

export async function setInterfaceLanguage(
  value: string,
  options: { persist?: boolean } = {},
): Promise<SupportedLanguage> {
  const language = normalizeLanguage(value) ?? 'en'
  if (options.persist !== false) {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  }
  document.documentElement.lang = language
  await i18n.changeLanguage(language)
  return language
}

const initialLanguage = detectedLanguage()
document.documentElement.lang = initialLanguage

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
  lng: initialLanguage,
  fallbackLng: 'en',
  supportedLngs: [...supportedLanguages],
  load: 'languageOnly',
  interpolation: { escapeValue: false },
  returnNull: false,
})

export default i18n
