import { useCallback, useEffect, useMemo, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { FormEvent } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { IconName } from '../../icons/Icon'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileViewport } from '../shared/useMobileViewport'
import type {
  AdminSetting,
  AdminSettingsPayload,
  AdminSettingType,
} from '../../types'
import { TierQuotasPanel } from './TierQuotasPanel'
import { TierProgressionPanel } from './TierProgressionPanel'

type DraftValue = boolean | string

type MobileSettingsCategory = 'general' | 'oidc' | 'speech' | 'mail' | 'policies' | 'tiers'

type SettingsTabProps = {
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
}

const OPEN_REGISTRATION_KEY = 'open_registration'
const LOCAL_PASSWORD_LOGIN_KEY = 'local_password_login_enabled'
const AUDIO_TRANSCRIPTION_KEY = 'audio_transcription_enabled'

function initialDraft(items: AdminSetting[]): Record<string, DraftValue> {
  return Object.fromEntries(
    items.map((item) => [
      item.key,
      item.secret ? '' : item.type === 'boolean' ? item.value === true : String(item.value ?? ''),
    ]),
  )
}

function sourceLabel(source: AdminSetting['source'], t: TFunction) {
  if (source === 'environment') {
    return t('adminSettings.sourceEnvironment')
  }
  return source === 'database'
    ? t('adminSettings.sourceDatabase')
    : t('adminSettings.sourceDefault')
}

function inputType(type: AdminSettingType) {
  if (type === 'integer') {
    return 'number'
  }
  if (type === 'email') {
    return 'text'
  }
  return type === 'secret' ? 'password' : 'text'
}

function settingsErrorMessage(error: unknown, fallback: string, t: TFunction) {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : fallback
  }
  return t(`adminSettings.errors.${error.code}`, { defaultValue: error.message })
}

export function SettingsTab({ onSensitiveAction }: SettingsTabProps) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const [payload, setPayload] = useState<AdminSettingsPayload | null>(null)
  const [draft, setDraft] = useState<Record<string, DraftValue>>({})
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [testRecipient, setTestRecipient] = useState('')
  const [testingEmail, setTestingEmail] = useState(false)
  const [mobileCategory, setMobileCategory] = useState<MobileSettingsCategory | null>(null)
  const [mobileMenuDirection, setMobileMenuDirection] = useState<'forward' | 'back'>('forward')
  const [mobileEmailTestOpen, setMobileEmailTestOpen] = useState(false)

  const applyPayload = useCallback((nextPayload: AdminSettingsPayload) => {
    setPayload(nextPayload)
    setDraft(initialDraft(nextPayload.items))
    setEditingKey(null)
  }, [])

  const loadSettings = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      applyPayload(await apiRequest<AdminSettingsPayload>('/api/admin/settings/'))
    } catch (loadError) {
      setError(settingsErrorMessage(
        loadError,
        i18n.t('adminSettings.loadFailed'),
        i18n.t,
      ))
    } finally {
      setLoading(false)
    }
  }, [applyPayload, i18n])

  useEffect(() => {
    let active = true
    void apiRequest<AdminSettingsPayload>('/api/admin/settings/')
      .then((nextPayload) => {
        if (active) {
          applyPayload(nextPayload)
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(settingsErrorMessage(
            loadError,
            i18n.t('adminSettings.loadFailed'),
            i18n.t,
          ))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [applyPayload, i18n])

  const generalSettings = useMemo(
    () => payload?.items.filter(
      (item) => item.key === OPEN_REGISTRATION_KEY || item.key === LOCAL_PASSWORD_LOGIN_KEY,
    ) ?? [],
    [payload],
  )
  const emailSettings = useMemo(
    () => payload?.items.filter(
      (item) => item.section === 'primary' && item.key.startsWith('email_'),
    ) ?? [],
    [payload],
  )
  const transcriptionSettings = useMemo(
    () => payload?.items.filter((item) => item.key === AUDIO_TRANSCRIPTION_KEY) ?? [],
    [payload],
  )
  const policySettings = useMemo(
    () => payload?.items.filter((item) => item.section === 'advanced') ?? [],
    [payload],
  )

  function updateDraft(key: string, value: DraftValue) {
    setDraft((current) => ({ ...current, [key]: value }))
    setMessage('')
  }

  function startEditing(item: AdminSetting) {
    if (!item.editable || submitting) return
    setError('')
    setMessage('')
    setDraft((current) => ({
      ...current,
      [item.key]: item.secret
        ? ''
        : item.type === 'boolean'
          ? item.value === true
          : String(item.value ?? ''),
    }))
    setEditingKey(item.key)
  }

  function cancelEditing(item: AdminSetting) {
    setDraft((current) => ({
      ...current,
      [item.key]: item.secret
        ? ''
        : item.type === 'boolean'
          ? item.value === true
          : String(item.value ?? ''),
    }))
    setEditingKey(null)
  }

  function serializedValue(item: AdminSetting) {
    const value = draft[item.key]
    if (item.type === 'boolean') {
      return value === true
    }
    if (item.type === 'integer') {
      return Number(value)
    }
    return String(value ?? '')
  }

  async function saveSetting(item: AdminSetting) {
    if (!payload || !item.editable || submitting) return
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      const nextPayload = await onSensitiveAction(() =>
        apiRequest<AdminSettingsPayload>('/api/admin/settings/', {
          method: 'PATCH',
          body: JSON.stringify({ values: { [item.key]: serializedValue(item) } }),
        }),
      )
      applyPayload(nextPayload)
    } catch (saveError) {
      setError(settingsErrorMessage(saveError, t('adminSettings.saveFailed'), t))
    } finally {
      setSubmitting(false)
    }
  }

  async function resetSetting(key: string) {
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      const nextPayload = await onSensitiveAction(() =>
        apiRequest<AdminSettingsPayload>('/api/admin/settings/', {
          method: 'PATCH',
          body: JSON.stringify({ reset: [key] }),
        }),
      )
      applyPayload(nextPayload)
    } catch (resetError) {
      setError(settingsErrorMessage(resetError, t('adminSettings.resetFailed'), t))
    } finally {
      setSubmitting(false)
    }
  }

  async function sendTestEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTestingEmail(true)
    setError('')
    setMessage('')
    try {
      await onSensitiveAction(() =>
        apiRequest<{ ok: boolean; sent: number }>('/api/admin/settings/email/test/', {
          method: 'POST',
          body: JSON.stringify({ recipient: testRecipient.trim() }),
        }),
      )
      setMessage(t('adminSettings.testEmailSent'))
      setMobileEmailTestOpen(false)
    } catch (testError) {
      setError(settingsErrorMessage(testError, t('adminSettings.testEmailFailed'), t))
    } finally {
      setTestingEmail(false)
    }
  }

  function settingLabel(item: AdminSetting) {
    return t(`adminSettings.labels.${item.key}`, { defaultValue: item.label })
  }

  function settingDisplayValue(item: AdminSetting) {
    if (item.secret) {
      return item.configured
        ? t('adminSettings.configured')
        : t('adminSettings.notConfigured')
    }
    if (item.type === 'boolean') {
      return item.value === true ? t('adminSettings.enabled') : t('adminSettings.disabled')
    }
    if (item.type === 'choice') {
      return item.value === 'smtp'
        ? t('adminSettings.smtp')
        : item.value === 'console'
          ? t('adminSettings.console')
          : String(item.value ?? '')
    }
    return String(item.value ?? '') || t('adminSettings.notConfigured')
  }

  function renderInput(item: AdminSetting) {
    const disabled = !item.editable || submitting
    if (item.type === 'boolean') {
      return (
        <label className="adminSettingToggle">
          <input
            type="checkbox"
            aria-label={settingLabel(item)}
            checked={draft[item.key] === true}
            disabled={disabled}
            onChange={(event) => updateDraft(item.key, event.target.checked)}
          />
          <span>
            {draft[item.key] === true
              ? t('adminSettings.enabled')
              : t('adminSettings.disabled')}
          </span>
        </label>
      )
    }
    if (item.type === 'choice') {
      return (
        <CustomSelect
          aria-label={settingLabel(item)}
          value={String(draft[item.key] ?? '')}
          disabled={disabled}
          onChange={(event) => updateDraft(item.key, event.target.value)}
        >
          {item.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice === 'smtp'
                ? t('adminSettings.smtp')
                : choice === 'console'
                  ? t('adminSettings.console')
                  : choice}
            </option>
          ))}
        </CustomSelect>
      )
    }
    return (
      <input
        aria-label={settingLabel(item)}
        type={inputType(item.type)}
        value={String(draft[item.key] ?? '')}
        min={item.minimum ?? undefined}
        max={item.maximum ?? undefined}
        maxLength={item.maxLength ?? undefined}
        autoComplete={item.secret ? 'new-password' : undefined}
        placeholder={
          item.secret && item.configured
            ? t('adminSettings.secretReplacement')
            : undefined
        }
        disabled={disabled}
        onChange={(event) => updateDraft(item.key, event.target.value)}
      />
    )
  }

  function renderSetting(item: AdminSetting) {
    const label = settingLabel(item)
    const isEditing = editingKey === item.key
    return (
      <div className={`adminSettingRow ${item.locked ? 'locked' : ''}`} key={item.key}>
        <span className="adminSettingLabel">{label}</span>
        <div className="adminSettingValueCell">
          {isEditing ? (
            <form
              className="adminSettingInlineForm"
              onSubmit={(event) => {
                event.preventDefault()
                void saveSetting(item)
              }}
            >
              {renderInput(item)}
              <button
                type="submit"
                className="adminIconAction adminSettingSaveAction"
                disabled={submitting}
                title={t('common.save')}
                aria-label={t('common.save')}
              >
                <Icon name="check-circle-1-light" />
              </button>
              <button
                type="button"
                className="adminIconAction adminSettingCancelAction"
                disabled={submitting}
                title={t('common.cancel')}
                aria-label={t('common.cancel')}
                onClick={() => cancelEditing(item)}
              >
                <Icon name="close-light" />
              </button>
            </form>
          ) : (
            <span className="adminSettingValueWithAction">
              <span className="adminSettingDisplayValue">{settingDisplayValue(item)}</span>
              {item.editable && (
                <button
                  type="button"
                  className="adminIconAction"
                  disabled={submitting}
                  title={t('adminSettings.editSetting', { setting: label })}
                  aria-label={t('adminSettings.editSetting', { setting: label })}
                  onClick={() => startEditing(item)}
                >
                  <Icon name="edit-light" />
                </button>
              )}
              {item.source === 'database' && item.editable && (
                <button
                  type="button"
                  className="adminIconAction adminSettingResetAction"
                  disabled={submitting}
                  title={t('adminSettings.resetSetting', { setting: label })}
                  aria-label={t('adminSettings.resetSetting', { setting: label })}
                  onClick={() => void resetSetting(item.key)}
                >
                  <Icon name="restart-light" />
                </button>
              )}
            </span>
          )}
        </div>
        <span className={`adminSettingSource ${item.source}`}>
          {sourceLabel(item.source, t)}
        </span>
      </div>
    )
  }

  function sectionHeader(
    icon: IconName,
    title: string,
  ) {
    return (
      <div className="adminSettingsSectionHeader">
        <Icon name={icon} />
        <h2>{title}</h2>
      </div>
    )
  }

  function renderMobileMenuRow({
    label,
    value,
    icon,
    onClick,
    disabled = false,
  }: {
    label: string
    value?: string
    icon?: IconName
    onClick?: () => void
    disabled?: boolean
  }) {
    const content = (
      <>
        {icon && <span className="adminSettingsMobileRowIcon"><Icon name={icon} /></span>}
        <span className="adminSettingsMobileRowCopy">
          <strong>{label}</strong>
          {value && <small>{value}</small>}
        </span>
        {onClick && !disabled && <Icon name="arrow-right-2" />}
      </>
    )
    return onClick ? (
      <button
        type="button"
        className={`adminSettingsMobileRow spaceButton ${icon ? '' : 'withoutIcon'}`.trim()}
        disabled={disabled}
        onClick={onClick}
        key={label}
      >
        {content}
      </button>
    ) : (
      <div className={`adminSettingsMobileRow readOnly ${icon ? '' : 'withoutIcon'}`.trim()} key={label}>{content}</div>
    )
  }

  function renderMobileSetting(item: AdminSetting) {
    return renderMobileMenuRow({
      label: settingLabel(item),
      value: `${settingDisplayValue(item)} · ${sourceLabel(item.source, t)}`,
      disabled: submitting,
      onClick: item.editable ? () => startEditing(item) : undefined,
    })
  }

  function renderMobileBackRow() {
    return (
      <button
        type="button"
        className="adminSettingsMobileRow adminSettingsMobileBackRow spaceButton"
        onClick={() => {
          setMobileMenuDirection('back')
          setMobileCategory(null)
        }}
      >
        <span className="adminSettingsMobileRowIcon"><Icon name="arrow-left-1" /></span>
        <span className="adminSettingsMobileRowCopy"><strong>{t('adminSettings.backToCategories')}</strong></span>
      </button>
    )
  }

  if (loading) {
    if (isMobile) {
      return <TadpoleLoadingState className="adminSettingsMobileLoading" label={t('adminSettings.loading')} />
    }
    return (
      <div className="panel adminSettingsPanel adminSettingsSection">
        {sectionHeader('tuning-2-light', t('adminSettings.generalSettings'))}
        <TadpoleLoadingState className="adminSettingsLoading" label={t('adminSettings.loading')} />
      </div>
    )
  }

  if (!payload) {
    if (isMobile) {
      return (
        <div className="adminSettingsMobileLayout">
          {error && <div className="notice error">{error}</div>}
          <button type="button" onClick={() => void loadSettings()}>{t('adminSettings.retry')}</button>
        </div>
      )
    }
    return (
      <div className="panel adminSettingsPanel adminSettingsSection">
        {sectionHeader('tuning-2-light', t('adminSettings.generalSettings'))}
        {error && <div className="notice error">{error}</div>}
        <button type="button" onClick={() => void loadSettings()}>
          {t('adminSettings.retry')}
        </button>
      </div>
    )
  }

  if (isMobile) {
    const activeSetting = payload.items.find((item) => item.key === editingKey)
    const categories: Array<{
      id: MobileSettingsCategory
      label: string
      description: string
      icon: IconName
    }> = [
      {
        id: 'general',
        label: t('adminSettings.generalSettings'),
        description: t('adminSettings.mobileGeneralLead'),
        icon: 'tuning-2-light',
      },
      {
        id: 'oidc',
        label: t('adminSettings.oidcSettings'),
        description: t('adminSettings.mobileOidcLead'),
        icon: 'global-light',
      },
      {
        id: 'speech',
        label: t('adminSettings.speechRecognition'),
        description: t('adminSettings.mobileSpeechLead'),
        icon: 'microphone-3-linear',
      },
      {
        id: 'mail',
        label: t('adminSettings.mailSettings'),
        description: t('adminSettings.mobileMailLead'),
        icon: 'mailbox-light',
      },
      {
        id: 'policies',
        label: t('adminSettings.policies'),
        description: t('adminSettings.mobilePoliciesLead'),
        icon: 'info-square-light',
      },
      {
        id: 'tiers',
        label: t('adminSettings.tiers'),
        description: t('adminSettings.mobileTiersLead'),
        icon: 'crown-minimalistic-light',
      },
    ]
    const oidcRows = [
      [t('adminSettings.oidcStatus'), payload.oidc.configured
        ? t('adminSettings.configured')
        : t('adminSettings.notConfigured')],
      [t('adminSettings.oidcProvider'), payload.oidc.providerName],
      [t('adminSettings.oidcIssuer'), payload.oidc.issuer || '—'],
      [t('adminSettings.oidcCallback'), payload.oidc.callbackPath],
    ]
    const transcriptionRows = [
      [t('adminSettings.transcriptionEngine'), payload.transcription.engine],
      [t('adminSettings.transcriptionModel'), t('adminSettings.whisperSmall')],
      [t('adminSettings.transcriptionLanguages'), t('adminSettings.transcriptionLanguageList')],
      [t('adminSettings.transcriptionReadiness'), t(payload.transcription.ready
        ? 'adminSettings.transcriptionReady'
        : 'adminSettings.transcriptionNotReady')],
    ]

    return (
      <div className={`adminSettingsMobileLayout mobileMenuTransition ${mobileMenuDirection}`.trim()}>
        {!mobileCategory ? (
          <nav className="adminSettingsMobileMenu mobileMenuTransitionPane" aria-label={t('admin.settings')} key="root">
            {categories.map((category) => renderMobileMenuRow({
              label: category.label,
              value: category.description,
              icon: category.icon,
              onClick: () => {
                setMobileMenuDirection('forward')
                setMobileCategory(category.id)
              },
            }))}
          </nav>
        ) : (
          <div className="adminSettingsMobileCategory mobileMenuTransitionPane" key={mobileCategory}>
            <nav
              className="adminSettingsMobileMenu adminSettingsMobileBackMenu"
              aria-label={categories.find((category) => category.id === mobileCategory)?.label}
            >
              {renderMobileBackRow()}
            </nav>
            {mobileCategory === 'general' && (
              <nav className="adminSettingsMobileMenu" aria-label={t('adminSettings.generalSettings')}>
                {generalSettings.map((item) => renderMobileSetting(item))}
              </nav>
            )}
            {mobileCategory === 'oidc' && (
              <div className="adminSettingsMobileMenu" role="list" aria-label={t('adminSettings.oidcSettings')}>
                {oidcRows.map(([label, value]) => renderMobileMenuRow({ label, value }))}
              </div>
            )}
            {mobileCategory === 'speech' && (
              <div className="adminSettingsMobileMenu" role="list" aria-label={t('adminSettings.speechRecognition')}>
                {transcriptionSettings.map((item) => renderMobileSetting(item))}
                {transcriptionRows.map(([label, value]) => renderMobileMenuRow({ label, value }))}
              </div>
            )}
            {mobileCategory === 'mail' && (
              <>
                <nav className="adminSettingsMobileMenu" aria-label={t('adminSettings.mailSettings')}>
                  {emailSettings.map((item) => renderMobileSetting(item))}
                </nav>
                <nav className="adminSettingsMobileMenu adminSettingsMobileEmailTestMenu" aria-label={t('adminSettings.sendTestEmail')}>
                  {renderMobileMenuRow({
                    label: t('adminSettings.sendTestEmail'),
                    value: t('adminSettings.mobileEmailTestLead'),
                    disabled: testingEmail || submitting || editingKey !== null,
                    onClick: () => {
                      setError('')
                      setMessage('')
                      setMobileEmailTestOpen(true)
                    },
                  })}
                </nav>
              </>
            )}
            {mobileCategory === 'policies' && (
              <nav className="adminSettingsMobileMenu" aria-label={t('adminSettings.policies')}>
                {policySettings.map((item) => renderMobileSetting(item))}
              </nav>
            )}
            {mobileCategory === 'tiers' && (
              <div className="adminSettingsMobileTierContent">
                <TierQuotasPanel mobile onSensitiveAction={onSensitiveAction} />
                <TierProgressionPanel mobile onSensitiveAction={onSensitiveAction} />
              </div>
            )}
          </div>
        )}

        {error && <div className="notice error">{error}</div>}
        {message && <div className="notice success">{message}</div>}

        {activeSetting && (
          <MobileSettingsSheet
            title={settingLabel(activeSetting)}
            busy={submitting}
            onClose={() => cancelEditing(activeSetting)}
          >
            {(close) => (
              <form
                className="adminSettingsMobileSheetForm"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveSetting(activeSetting)
                }}
              >
                {error && <div className="notice error">{error}</div>}
                {activeSetting.type === 'boolean' ? (
                  <div className="adminSettingsMobileToggleRow">
                    <span>{t(draft[activeSetting.key] === true ? 'common.enabled' : 'common.disabled')}</span>
                    <button
                      type="button"
                      role="switch"
                      className="securityToggle"
                      aria-checked={draft[activeSetting.key] === true}
                      aria-label={settingLabel(activeSetting)}
                      disabled={submitting}
                      onClick={() => updateDraft(activeSetting.key, draft[activeSetting.key] !== true)}
                    >
                      <span />
                    </button>
                  </div>
                ) : renderInput(activeSetting)}
                {activeSetting.source === 'database' && activeSetting.editable && (
                  <button
                    type="button"
                    className="adminSettingsMobileReset spaceButton"
                    disabled={submitting}
                    onClick={() => void resetSetting(activeSetting.key)}
                  >
                    <Icon name="restart-light" />
                    {t('adminSettings.reset')}
                  </button>
                )}
                <div className="dialogActions">
                  <button type="button" className="secondary" disabled={submitting} onClick={close}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" disabled={submitting}>
                    {t(submitting ? 'common.saving' : 'common.save')}
                  </button>
                </div>
              </form>
            )}
          </MobileSettingsSheet>
        )}

        {mobileEmailTestOpen && (
          <MobileSettingsSheet
            title={t('adminSettings.sendTestEmail')}
            busy={testingEmail}
            onClose={() => {
              if (!testingEmail) setMobileEmailTestOpen(false)
            }}
          >
            {(close) => (
              <form className="adminSettingsMobileSheetForm" onSubmit={(event) => void sendTestEmail(event)}>
                {error && <div className="notice error">{error}</div>}
                <input
                  type="email"
                  value={testRecipient}
                  aria-label={t('adminSettings.testRecipient')}
                  placeholder={t('adminSettings.testRecipientPlaceholder')}
                  disabled={testingEmail}
                  onChange={(event) => setTestRecipient(event.target.value)}
                  required
                />
                <div className="dialogActions">
                  <button type="button" className="secondary" disabled={testingEmail} onClick={close}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" disabled={testingEmail}>
                    {t(testingEmail ? 'adminSettings.sending' : 'adminSettings.sendTestEmail')}
                  </button>
                </div>
              </form>
            )}
          </MobileSettingsSheet>
        )}
      </div>
    )
  }

  return (
    <div className="adminSettingsStack">
      <section className="panel adminSettingsPanel adminSettingsSection">
        {sectionHeader('tuning-2-light', t('adminSettings.generalSettings'))}
        <div className="adminSettingsGrid">{generalSettings.map(renderSetting)}</div>
      </section>

      <section className="panel adminSettingsPanel adminSettingsSection">
        {sectionHeader('global-light', t('adminSettings.oidcSettings'))}
        <p className="adminSettingsSectionLead">{t('adminSettings.oidcEnvironmentLead')}</p>
        <div className="adminSettingsGrid">
          {[
            [t('adminSettings.oidcStatus'), payload.oidc.configured
              ? t('adminSettings.configured')
              : t('adminSettings.notConfigured')],
            [t('adminSettings.oidcProvider'), payload.oidc.providerName],
            [t('adminSettings.oidcIssuer'), payload.oidc.issuer || '—'],
            [t('adminSettings.oidcCallback'), payload.oidc.callbackPath],
          ].map(([label, value]) => (
            <div className="adminSettingRow" key={label}>
              <span className="adminSettingLabel">{label}</span>
              <span className="adminSettingValueCell adminSettingDisplayValue">{value}</span>
              <span className={`adminSettingSource ${payload.oidc.configured ? 'database' : ''}`}>
                {payload.oidc.enabled ? t('adminSettings.enabled') : t('adminSettings.disabled')}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel adminSettingsPanel adminSettingsSection">
        {sectionHeader('microphone-3-linear', t('adminSettings.speechRecognition'))}
        <p className="adminSettingsSectionLead">{t('adminSettings.transcriptionLead')}</p>
        <div className="adminSettingsGrid">
          {transcriptionSettings.map(renderSetting)}
          {[
            [t('adminSettings.transcriptionEngine'), payload.transcription.engine],
            [t('adminSettings.transcriptionModel'), t('adminSettings.whisperSmall')],
            [t('adminSettings.transcriptionLanguages'), t('adminSettings.transcriptionLanguageList')],
            [t('adminSettings.transcriptionReadiness'), t(payload.transcription.ready
              ? 'adminSettings.transcriptionReady'
              : 'adminSettings.transcriptionNotReady')],
          ].map(([label, value]) => (
            <div className="adminSettingRow" key={label}>
              <span className="adminSettingLabel">{label}</span>
              <span className="adminSettingValueCell adminSettingDisplayValue">{value}</span>
              <span className={`adminSettingSource ${payload.transcription.ready ? 'database' : ''}`}>
                {payload.transcription.ready ? t('adminSettings.ready') : t('adminSettings.unavailable')}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel adminSettingsPanel adminSettingsSection">
        {sectionHeader('mailbox-light', t('adminSettings.mailSettings'))}
        {error && <div className="notice error">{error}</div>}
        {message && <div className="notice success">{message}</div>}
        <div className="adminSettingsGrid">{emailSettings.map(renderSetting)}</div>

        <form className="adminEmailTest" onSubmit={(event) => void sendTestEmail(event)}>
          <label>
            {t('adminSettings.testRecipient')}
            <input
              type="email"
              value={testRecipient}
              placeholder={t('adminSettings.testRecipientPlaceholder')}
              disabled={testingEmail || submitting || editingKey !== null}
              onChange={(event) => setTestRecipient(event.target.value)}
              required
            />
          </label>
          <button
            type="submit"
            disabled={testingEmail || submitting || editingKey !== null}
          >
            {testingEmail ? t('adminSettings.sending') : t('adminSettings.sendTestEmail')}
          </button>
        </form>
      </section>

      <section className="panel adminSettingsPanel adminSettingsSection">
        {sectionHeader('info-square-light', t('adminSettings.policies'))}
        <div className="adminSettingsGrid">{policySettings.map(renderSetting)}</div>
      </section>

      <TierQuotasPanel onSensitiveAction={onSensitiveAction} />
      <TierProgressionPanel onSensitiveAction={onSensitiveAction} />
    </div>
  )
}
