import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest } from '../../api/client'
import { setInterfaceLanguage } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { applyThemePreference } from '../../theme'
import type { OnboardingPayload, ThemePreference, User } from '../../types'
import { CustomSelect } from '../shared/CustomSelect'
import './OnboardingFlow.css'

type OnboardingFlowProps = {
  user: User
  onComplete: (user: User) => void
}

type OnboardingStep = 'regional' | 'theme' | 'identity' | 'resources' | 'finish'

const THEME_IMAGES: Record<ThemePreference, string> = {
  system: '/onboarding/theme-system.webp',
  light: '/onboarding/theme-light.webp',
  dark: '/onboarding/theme-dark.webp',
}

const RESOURCE_FIELDS = [
  ['authorWebsite', 'settings.website'],
  ['authorTodayProfile', 'settings.authorTodayProfile'],
  ['authorLitresProfile', 'settings.authorLitresProfile'],
  ['authorProzaProfile', 'settings.authorProzaProfile'],
  ['authorSamizdatProfile', 'settings.authorSamizdatProfile'],
  ['authorCellulosaProfile', 'settings.authorCellulosaProfile'],
  ['authorWattpadProfile', 'settings.authorWattpadProfile'],
] as const

function draftFromUser(user: User): OnboardingPayload {
  return {
    language: user.language,
    timezone: user.timezone,
    theme: user.theme,
    displayName: user.displayName,
    authorName: user.authorName,
    authorWebsite: user.authorWebsite,
    authorTodayProfile: user.authorTodayProfile,
    authorLitresProfile: user.authorLitresProfile,
    authorProzaProfile: user.authorProzaProfile,
    authorSamizdatProfile: user.authorSamizdatProfile,
    authorCellulosaProfile: user.authorCellulosaProfile,
    authorWattpadProfile: user.authorWattpadProfile,
  }
}

export function OnboardingFlow({ user, onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation()
  const flowRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<OnboardingPayload>(() => draftFromUser(user))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const steps: OnboardingStep[] = user.authorWorkspaceEnabled
    ? ['regional', 'theme', 'identity', 'resources', 'finish']
    : ['regional', 'theme', 'identity', 'finish']
  const stepType = steps[step]
  const timezoneOptions = useMemo(() => Array.from(new Set([
    draft.timezone,
    'UTC',
    ...(typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : []),
  ])).sort(), [draft.timezone])

  useEffect(() => {
    void setInterfaceLanguage(user.language)
  }, [user.language])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    titleRef.current?.focus()

    function keepFocusInside(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        return
      }
      if (event.key !== 'Tab' || !flowRef.current?.contains(document.activeElement)) return
      const focusable = Array.from(flowRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement as HTMLElement | null
      if (event.shiftKey && (activeElement === first || !activeElement || !focusable.includes(activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', keepFocusInside, true)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', keepFocusInside, true)
    }
  }, [])

  useEffect(() => {
    titleRef.current?.focus()
  }, [step])

  function setField<K extends keyof OnboardingPayload>(field: K, value: OnboardingPayload[K]) {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  function nextStep(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    setError('')
    setStep((current) => Math.min(steps.length - 1, current + 1))
  }

  async function complete() {
    if (submitting) return
    setError('')
    setSubmitting(true)
    try {
      const response = await apiRequest<{ user: User }>('/api/auth/onboarding/complete/', {
        method: 'POST',
        body: JSON.stringify(draft),
      })
      await setInterfaceLanguage(response.user.language)
      applyThemePreference(response.user.theme)
      onComplete(response.user)
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'onboarding_completion_failed')
    } finally {
      setSubmitting(false)
    }
  }

  const stepTitles: Record<OnboardingStep, string> = {
    regional: t('onboarding.regionalTitle'),
    theme: t('onboarding.themeTitle'),
    identity: t('onboarding.identityTitle'),
    resources: t('onboarding.resourcesTitle'),
    finish: t(user.authorWorkspaceEnabled ? 'onboarding.finishTitle' : 'onboarding.editorFinishTitle'),
  }
  const stepLeads: Record<OnboardingStep, string> = {
    regional: t('onboarding.step1Lead'),
    theme: t('onboarding.step2Lead'),
    identity: t(user.authorWorkspaceEnabled ? 'onboarding.step3Lead' : 'onboarding.editorIdentityLead'),
    resources: t('onboarding.step4Lead'),
    finish: t(user.authorWorkspaceEnabled ? 'onboarding.step5Lead' : 'onboarding.editorFinishLead'),
  }
  const formStep = stepType === 'regional' || stepType === 'identity' || stepType === 'resources'
  const nextLabel = stepType === 'finish'
    ? t('onboarding.startJourney')
    : t('common.continue')

  return (
    <div className="onboardingBackdrop" role="presentation" ref={flowRef}>
      {step > 0 ? (
        <button
          type="button"
          className="onboardingDesktopNav onboardingDesktopBack"
          aria-label={t('common.back')}
          title={t('common.back')}
          disabled={submitting}
          onClick={() => setStep((current) => Math.max(0, current - 1))}
        >
          <Icon name="arrow-left-1" />
        </button>
      ) : <span className="onboardingDesktopNavPlaceholder" aria-hidden="true" />}
      <section
        className="onboardingDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-lead"
        aria-busy={submitting || undefined}
      >
        <div className="onboardingProgress" role="status" aria-live="polite" aria-label={t('onboarding.progressLabel')}>
          <span>{t('onboarding.stepProgress', { current: step + 1, total: steps.length })}</span>
          <div aria-hidden="true">
            {Array.from({ length: steps.length }, (_, index) => (
              <i className={index <= step ? 'active' : ''} key={index} />
            ))}
          </div>
        </div>

        <div className="onboardingContent">
          <header className="onboardingHeader">
            <img
              className="onboardingHeaderImage"
              src="/onboarding/quillum-onboarding.webp"
              alt=""
              aria-hidden="true"
            />
            <h1 id="onboarding-title" tabIndex={-1} ref={titleRef}>{stepTitles[stepType]}</h1>
            <p id="onboarding-lead">{stepLeads[stepType]}</p>
          </header>

          {stepType === 'regional' && (
            <form id="onboarding-step-form" className="onboardingForm" onSubmit={nextStep}>
              <label>
                <span>{t('common.language')}</span>
                <CustomSelect
                  value={draft.language}
                  onChange={(event) => {
                    const language = event.currentTarget.value
                    setField('language', language)
                    void setInterfaceLanguage(language)
                  }}
                  aria-label={t('common.language')}
                >
                  <option value="en">{t('common.english')}</option>
                  <option value="ru">{t('common.russian')}</option>
                </CustomSelect>
              </label>
              <label>
                <span>{t('account.timezone')}</span>
                <CustomSelect
                  value={draft.timezone}
                  onChange={(event) => setField('timezone', event.currentTarget.value)}
                  aria-label={t('account.timezone')}
                >
                  {timezoneOptions.map((timezone) => (
                    <option value={timezone} key={timezone}>{timezone}</option>
                  ))}
                </CustomSelect>
              </label>
              <div className="onboardingMobileActions single"><button className="primaryAction" type="submit">{t('common.continue')}</button></div>
            </form>
          )}

          {stepType === 'theme' && (
            <div className="onboardingThemeStep">
              <div className="onboardingThemeOptions" role="radiogroup" aria-label={t('theme.label')}>
                {(['system', 'light', 'dark'] as ThemePreference[]).map((theme) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.theme === theme}
                    className={draft.theme === theme ? 'selected' : ''}
                    key={theme}
                    onClick={() => {
                      setField('theme', theme)
                      applyThemePreference(theme)
                    }}
                  >
                    <img
                      className="onboardingThemeImage"
                      src={THEME_IMAGES[theme]}
                      alt=""
                      aria-hidden="true"
                    />
                    <strong>{t(`theme.${theme}`)}</strong>
                  </button>
                ))}
              </div>
              <div className="onboardingMobileActions">
                <button type="button" className="secondaryAction" onClick={() => setStep(0)}>{t('common.back')}</button>
                <button type="button" className="primaryAction" onClick={() => nextStep()}>{t('common.continue')}</button>
              </div>
            </div>
          )}

          {stepType === 'identity' && (
            <form id="onboarding-step-form" className="onboardingForm" onSubmit={nextStep}>
              <label>
                <span>{t('account.displayName')}</span>
                <input maxLength={160} value={draft.displayName} onChange={(event) => setField('displayName', event.currentTarget.value)} autoComplete="name" />
              </label>
              {user.authorWorkspaceEnabled && (
                <label>
                  <span>{t('settings.authorName')}</span>
                  <input value={draft.authorName} onChange={(event) => setField('authorName', event.currentTarget.value)} autoComplete="nickname" />
                </label>
              )}
              <div className="onboardingMobileActions">
                <button type="button" className="secondaryAction" onClick={() => setStep(1)}>{t('common.back')}</button>
                <button type="submit" className="primaryAction">{t('common.continue')}</button>
              </div>
            </form>
          )}

          {stepType === 'resources' && (
            <form id="onboarding-step-form" className="onboardingForm onboardingResources" onSubmit={nextStep}>
              <div className="onboardingResourceGrid">
                {RESOURCE_FIELDS.map(([field, labelKey]) => (
                  <label key={field}>
                    <span>{t(labelKey)}</span>
                    <input type="url" inputMode="url" value={draft[field]} onChange={(event) => setField(field, event.currentTarget.value)} placeholder={t('onboarding.urlPlaceholder')} />
                  </label>
                ))}
              </div>
              <div className="onboardingMobileActions">
                <button type="button" className="secondaryAction" onClick={() => setStep(2)}>{t('common.back')}</button>
                <button type="submit" className="primaryAction">{t('common.continue')}</button>
              </div>
            </form>
          )}

          {stepType === 'finish' && (
            <div className="onboardingFinish">
              <span className="onboardingFinishIcon" aria-hidden="true"><Icon name="star-light" /></span>
              <p>{t(user.authorWorkspaceEnabled
                ? 'onboarding.finishMessage'
                : 'onboarding.editorFinishMessage')}</p>
              {error && <div className="notice error" role="alert">{t(`errors.${error}`, { defaultValue: error })}</div>}
              <div className="onboardingMobileActions">
                <button type="button" className="secondaryAction" disabled={submitting} onClick={() => setStep((current) => Math.max(0, current - 1))}>{t('common.back')}</button>
                <button type="button" className="primaryAction" disabled={submitting} onClick={() => void complete()}>
                  {submitting ? t('onboarding.starting') : t('onboarding.startJourney')}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
      {formStep ? (
        <button
          type="submit"
          form="onboarding-step-form"
          className="onboardingDesktopNav onboardingDesktopNext"
          aria-label={nextLabel}
          title={nextLabel}
        >
          <Icon name="arrow-right-1" />
        </button>
      ) : (
        <button
          type="button"
          className="onboardingDesktopNav onboardingDesktopNext"
          aria-label={nextLabel}
          title={nextLabel}
          disabled={submitting}
          onClick={() => {
            if (stepType === 'finish') void complete()
            else nextStep()
          }}
        >
          <Icon name={stepType === 'finish' ? 'star-light' : 'arrow-right-1'} />
        </button>
      )}
    </div>
  )
}
