import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { IconName } from '../../icons/Icon'
import type { PasskeyCredential, SecurityPayload, User } from '../../types'
import { parseCreationOptions, serializeCredential } from '../auth/webauthn'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileViewport } from '../shared/useMobileViewport'
import { TotpSetupDetails } from './TotpSetupDetails'

type SecurityTabProps = {
  user: User
  onUserChange: (user: User) => void
  onMessage: (message: string) => void
  onError: (message: string) => void
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
}

type MobileSecuritySheet = 'password' | 'two-factor' | 'passkeys'
type MobileTwoFactorMethod = 'email' | 'totp'

function SecurityMobileRow({
  icon,
  title,
  subtitle,
  disabled = false,
  onClick,
}: {
  icon: IconName
  title: string
  subtitle: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="accountMobileSettingRow spaceButton"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="accountMobileSettingIcon"><Icon name={icon} /></span>
      <span className="accountMobileSettingCopy">
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </span>
      <Icon name="arrow-right-2" />
    </button>
  )
}

function daysSince(value: string, t: TFunction) {
  const changedAt = new Date(value).getTime()
  if (!Number.isFinite(changedAt)) {
    return t('security.changedDateUnavailable')
  }
  const days = Math.max(0, Math.floor((Date.now() - changedAt) / 86_400_000))
  if (days === 0) {
    return t('security.changedToday')
  }
  return t('security.changedDaysAgo', { count: days })
}

function passwordRequirements(
  password: string,
  username: string,
  email: string,
  labels: [string, string, string],
) {
  const normalizedPassword = password.toLowerCase()
  const identityParts = [username, email.split('@')[0]]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 3)

  return [
    { label: labels[0], met: password.length >= 12 },
    {
      label: labels[1],
      met: /[A-Za-z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password),
    },
    {
      label: labels[2],
      met:
        password.length > 0 &&
        !identityParts.some(
          (part) => normalizedPassword.includes(part) || part.includes(normalizedPassword),
        ),
    },
  ]
}

export function SecurityTab({
  user,
  onUserChange,
  onMessage,
  onError,
  onSensitiveAction,
}: SecurityTabProps) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const [security, setSecurity] = useState<SecurityPayload | null>(null)
  const [securityError, setSecurityError] = useState('')
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [newPasswordDraft, setNewPasswordDraft] = useState('')
  const [passwordCodeRequested, setPasswordCodeRequested] = useState(false)
  const [totpSetup, setTotpSetup] = useState<{ provisioningUri: string } | null>(null)
  const [emailTwoFactorRequested, setEmailTwoFactorRequested] = useState(false)
  const [mobileSheet, setMobileSheet] = useState<MobileSecuritySheet | null>(null)
  const [mobileTwoFactorEnabled, setMobileTwoFactorEnabled] = useState(false)
  const [mobileTwoFactorMethod, setMobileTwoFactorMethod] = useState<MobileTwoFactorMethod | null>(null)

  useEffect(() => {
    let active = true

    async function loadSecurity() {
      setSecurityError('')
      try {
        const payload = await apiRequest<SecurityPayload>('/api/auth/security/')
        if (active) {
          setSecurity(payload)
        }
      } catch (err) {
        if (active) {
          setSecurityError(err instanceof Error ? err.message : i18n.t('security.loadFailed'))
        }
      }
    }

    void loadSecurity()

    return () => {
      active = false
    }
  }, [i18n])

  async function handlePasswordRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onError('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const currentPassword = form.get('currentPassword')
      const newPassword = form.get('newPassword')
      await onSensitiveAction(() =>
        apiRequest<{ ok: boolean; expiresAt: string }>(
          '/api/auth/security/password/request/',
          {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword }),
          },
        ),
      )
      setPasswordCodeRequested(true)
      onMessage(t('security.passwordCodeSent'))
      formElement.reset()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.passwordRequestFailed'))
    }
  }

  async function handlePasswordConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onError('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const payload = await apiRequest<{ user: User }>('/api/auth/security/password/confirm/', {
        method: 'POST',
        body: JSON.stringify({ code: form.get('code') }),
      })
      onUserChange(payload.user)
      onMessage(t('security.passwordChanged'))
      setPasswordCodeRequested(false)
      setPasswordOpen(false)
      setMobileSheet(null)
      setNewPasswordDraft('')
      formElement.reset()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.passwordConfirmFailed'))
    }
  }

  async function handlePasskeyCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onError('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      if (!window.PublicKeyCredential) {
        throw new Error(t('security.passkeyUnsupported'))
      }
      const optionsPayload = await onSensitiveAction(() =>
        apiRequest<{ options: PublicKeyCredentialCreationOptionsJSON }>(
          '/api/auth/security/passkeys/start/',
          {
            method: 'POST',
            body: JSON.stringify({ name: form.get('name') }),
          },
        ),
      )
      const credential = await navigator.credentials.create({
        publicKey: parseCreationOptions(optionsPayload.options),
      })
      const payload = await onSensitiveAction(() =>
        apiRequest<{ passkey: PasskeyCredential; security: SecurityPayload }>(
          '/api/auth/security/passkeys/finish/',
          {
            method: 'POST',
            body: JSON.stringify({ credential: serializeCredential(credential) }),
          },
        ),
      )
      setSecurity(payload.security)
      onMessage(t('security.passkeyCreated'))
      formElement.reset()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.passkeyCreateFailed'))
    }
  }

  async function handlePasskeyDelete(passkeyId: number) {
    onError('')
    try {
      const payload = await onSensitiveAction(() =>
        apiRequest<{ security: SecurityPayload }>(
          `/api/auth/security/passkeys/${passkeyId}/delete/`,
          {
            method: 'POST',
            body: '{}',
          },
        ),
      )
      setSecurity(payload.security)
      onMessage(t('security.passkeyDeleted'))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.passkeyDeleteFailed'))
    }
  }

  async function handleTotpStart() {
    onError('')
    setEmailTwoFactorRequested(false)
    try {
      const payload = await onSensitiveAction(() =>
        apiRequest<{ provisioningUri: string }>(
          '/api/auth/security/totp/start/',
          {
            method: 'POST',
            body: '{}',
          },
        ),
      )
      setTotpSetup(payload)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.totpStartFailed'))
    }
  }

  async function handleTotpConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onError('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const payload = await onSensitiveAction(() =>
        apiRequest<{ security: SecurityPayload; user: User }>(
          '/api/auth/security/totp/confirm/',
          {
            method: 'POST',
            body: JSON.stringify({ code: form.get('code') }),
          },
        ),
      )
      setSecurity(payload.security)
      setTotpSetup(null)
      setMobileTwoFactorEnabled(true)
      setMobileTwoFactorMethod(null)
      onUserChange(payload.user)
      onMessage(t('security.totpEnabled'))
      formElement.reset()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.totpConfirmFailed'))
    }
  }

  async function handleEmailTwoFactorStart() {
    onError('')
    setTotpSetup(null)
    try {
      const payload = await onSensitiveAction(() =>
        apiRequest<{ ok: boolean; email: string }>(
          '/api/auth/security/email-2fa/start/',
          {
            method: 'POST',
            body: '{}',
          },
        ),
      )
      setEmailTwoFactorRequested(true)
      onMessage(t('security.emailCodeSent', { email: payload.email }))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.emailSetupFailed'))
    }
  }

  async function handleEmailTwoFactorConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onError('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const payload = await onSensitiveAction(() =>
        apiRequest<{ security: SecurityPayload; user: User }>(
          '/api/auth/security/email-2fa/confirm/',
          {
            method: 'POST',
            body: JSON.stringify({ code: form.get('code') }),
          },
        ),
      )
      setSecurity(payload.security)
      setEmailTwoFactorRequested(false)
      setTotpSetup(null)
      setMobileTwoFactorEnabled(true)
      setMobileTwoFactorMethod(null)
      onUserChange(payload.user)
      onMessage(t('security.emailEnabled'))
      formElement.reset()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.emailConfirmFailed'))
    }
  }

  async function handleTwoFactorDisable() {
    onError('')
    try {
      const payload = await onSensitiveAction(() =>
        apiRequest<SecurityPayload>('/api/auth/security/', {
          method: 'PATCH',
          body: JSON.stringify({ twoFactorMethod: 'none' }),
        }),
      )
      setSecurity(payload)
      onUserChange({ ...user, twoFactorMethod: payload.twoFactorMethod })
      setTotpSetup(null)
      setEmailTwoFactorRequested(false)
      setMobileTwoFactorEnabled(false)
      onMessage(t('security.twoFactorDisabled'))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('security.twoFactorDisableFailed'))
    }
  }

  function handleTwoFactorToggle(method: 'email' | 'totp') {
    if (!security) return
    if (currentMethod === method) {
      void handleTwoFactorDisable()
      return
    }
    if (method === 'email') {
      void handleEmailTwoFactorStart()
      return
    }
    void handleTotpStart()
  }

  function closePasswordSheet() {
    setMobileSheet(null)
    setPasswordOpen(false)
    setPasswordCodeRequested(false)
    setNewPasswordDraft('')
  }

  function openTwoFactorSheet() {
    setMobileTwoFactorEnabled(currentMethod !== 'none')
    setMobileTwoFactorMethod(null)
    setMobileSheet('two-factor')
  }

  function openMobileTwoFactorMethod(method: MobileTwoFactorMethod) {
    if (!security || !mobileTwoFactorEnabled) return
    setMobileTwoFactorMethod(method)
    if (currentMethod === method) return
    if (method === 'email') void handleEmailTwoFactorStart()
    else void handleTotpStart()
  }

  function closeMobileTwoFactorMethod() {
    setMobileTwoFactorMethod(null)
    setTotpSetup(null)
    setEmailTwoFactorRequested(false)
  }

  function toggleMobileTwoFactor() {
    if (!mobileTwoFactorEnabled) {
      setMobileTwoFactorEnabled(true)
      return
    }
    if (currentMethod !== 'none') {
      void handleTwoFactorDisable()
      return
    }
    setMobileTwoFactorEnabled(false)
    setTotpSetup(null)
    setEmailTwoFactorRequested(false)
  }

  const currentMethod = security?.twoFactorMethod ?? user.twoFactorMethod
  const newPasswordRequirements = passwordRequirements(
    newPasswordDraft,
    user.username,
    user.email,
    [t('auth.passwordLength'), t('auth.passwordKinds'), t('auth.passwordIdentity')],
  )
  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const passwordStatus = user.hasUsablePassword
    ? daysSince(user.passwordChangedAt, t)
    : user.oidcLinked
      ? t('security.usesOidc')
      : t('security.passwordNotSet')
  const twoFactorStatus = currentMethod === 'email'
    ? t('security.email')
    : currentMethod === 'totp'
      ? t('security.authenticator')
      : t('security.notConfigured')
  const passkeyStatus = security
    ? t('security.passkeysUsed', {
        used: security.passkeys.length,
        limit: security.passkeyLimit,
      })
    : t('security.passkeysLoading')

  function renderMobilePasswordForm(close: () => void) {
    if (passwordCodeRequested) {
      return (
        <form className="accountMobileSheetForm securityMobileSheetForm" onSubmit={handlePasswordConfirm}>
          <p>{t('security.codeLead', { email: user.email })}</p>
          <label className="dialogField">
            <span>{t('account.confirmationCode')}</span>
            <input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
          </label>
          <div className="dialogActions">
            <button type="button" className="secondary" onClick={close}>{t('common.cancel')}</button>
            <button type="submit">{t('common.confirm')}</button>
          </div>
        </form>
      )
    }

    return (
      <form className="accountMobileSheetForm securityMobileSheetForm" onSubmit={handlePasswordRequest}>
        <label className="dialogField">
          <span>{t('security.currentPassword')}</span>
          <input name="currentPassword" type="password" autoComplete="current-password" required autoFocus />
        </label>
        <label className="dialogField">
          <span>{t('security.newPassword')}</span>
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={newPasswordDraft}
            onChange={(event) => setNewPasswordDraft(event.currentTarget.value)}
            required
          />
        </label>
        <div className="passwordRequirements compactRequirements" aria-live="polite">
          {newPasswordRequirements.map((requirement) => (
            <div className={`passwordRequirement ${requirement.met ? 'met' : ''}`} key={requirement.label}>
              <Icon name="check-circle-1-light" />
              <span>{requirement.label}</span>
            </div>
          ))}
        </div>
        <div className="dialogActions">
          <button type="button" className="secondary" onClick={close}>{t('common.cancel')}</button>
          <button type="submit">{t('account.sendCode')}</button>
        </div>
      </form>
    )
  }

  function renderMobileTwoFactor() {
    return (
      <div className="securityMobileSheetBody securityMobileTwoFactorBody">
        <div className="securityMobileMasterToggle">
          <span>
            <strong>{t('security.twoFactor')}</strong>
            <small>{t(mobileTwoFactorEnabled ? 'common.enabled' : 'common.disabled')}</small>
          </span>
          <button
            type="button"
            role="switch"
            className="securityToggle"
            aria-checked={mobileTwoFactorEnabled}
            aria-label={t('security.twoFactor')}
            disabled={!security}
            onClick={toggleMobileTwoFactor}
          >
            <span />
          </button>
        </div>

        <div className={`securityMobileMethods ${mobileTwoFactorEnabled ? '' : 'disabled'}`.trim()}>
          <button
            type="button"
            className={`securityMobileMethod spaceButton ${currentMethod === 'email' ? 'selected' : ''}`.trim()}
            disabled={!security || !mobileTwoFactorEnabled}
            onClick={() => openMobileTwoFactorMethod('email')}
          >
            <span className="methodIcon"><Icon name="email-light" /></span>
            <span>
              <strong>{t('security.email')}</strong>
              <small>{t('security.emailMethodLead', { email: user.email })}</small>
            </span>
            {currentMethod === 'email'
              ? <Icon name="check-circle-1-light" />
              : <Icon name="arrow-right-2" />}
          </button>

          <button
            type="button"
            className={`securityMobileMethod spaceButton ${currentMethod === 'totp' ? 'selected' : ''}`.trim()}
            disabled={!security || !mobileTwoFactorEnabled}
            onClick={() => openMobileTwoFactorMethod('totp')}
          >
            <span className="methodIcon"><Icon name="smartphone-light" /></span>
            <span>
              <strong>{t('security.authenticator')}</strong>
              <small>{t('security.authenticatorLead')}</small>
            </span>
            {currentMethod === 'totp'
              ? <Icon name="check-circle-1-light" />
              : <Icon name="arrow-right-2" />}
          </button>

        </div>
      </div>
    )
  }

  function renderMobileTwoFactorMethod(method: MobileTwoFactorMethod) {
    const active = currentMethod === method
    const isEmail = method === 'email'
    return (
      <div className="securityMobileMethodSheetBody">
        <section className="securityMobileMethodIntro">
          <span className="methodIcon">
            <Icon name={isEmail ? 'email-light' : 'smartphone-light'} />
          </span>
          <span>
            <strong>{t(isEmail ? 'security.email' : 'security.authenticator')}</strong>
            <p>
              {t(isEmail ? 'security.emailMethodLead' : 'security.authenticatorLead', {
                email: user.email,
              })}
            </p>
            {active && <small>{t('common.enabled')}</small>}
          </span>
        </section>

        {!active && isEmail && emailTwoFactorRequested && (
          <form className="securityMobileMethodSetup" onSubmit={handleEmailTwoFactorConfirm}>
            <p>{t('security.codeLead', { email: user.email })}</p>
            <div className="securityMobileConfirmRow">
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,13}"
                maxLength={13}
                required
                autoFocus
              />
              <button type="submit" className="iconAction emailConfirmAction" title={t('common.confirm')} aria-label={t('common.confirm')}>
                <Icon name="check-circle-1-light" />
              </button>
            </div>
          </form>
        )}

        {!active && !isEmail && totpSetup && (
          <form className="securityMobileMethodSetup totpMobileSetup" onSubmit={handleTotpConfirm}>
            <TotpSetupDetails provisioningUri={totpSetup.provisioningUri} />
            <div className="securityMobileConfirmRow">
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,13}"
                maxLength={13}
                required
              />
              <button type="submit" className="iconAction emailConfirmAction" title={t('common.confirm')} aria-label={t('common.confirm')}>
                <Icon name="check-circle-1-light" />
              </button>
            </div>
          </form>
        )}
      </div>
    )
  }

  function renderMobilePasskeys() {
    return (
      <div className="securityMobileSheetBody passkeyMobileSheetBody">
        <form className="securityMobilePasskeyForm" onSubmit={handlePasskeyCreate}>
          <label className="dialogField">
            <span>{t('security.passkeyName')}</span>
            <input
              name="name"
              maxLength={120}
              required
              disabled={!security || security.passkeys.length >= security.passkeyLimit}
            />
          </label>
          <button
            type="submit"
            disabled={!security || security.passkeys.length >= security.passkeyLimit}
          >
            {t('security.createPasskey')}
          </button>
        </form>

        <div className="securityMobilePasskeyHeading">
          <strong>{t('security.createdPasskeys')}</strong>
          <small>{passkeyStatus}</small>
        </div>

        {security?.passkeys.length ? (
          <div className="securityMobilePasskeyList">
            {security.passkeys.map((passkey) => (
              <div className="securityMobilePasskeyItem" key={passkey.id}>
                <span className="methodIcon"><Icon name="key-light" /></span>
                <span>
                  <strong>{passkey.name}</strong>
                  <small>
                    {t('security.passkeyCreatedAt', {
                      value: dateFormatter.format(new Date(passkey.createdAt)),
                    })}
                  </small>
                  <small>
                    {t('security.passkeyLastUsedAt', {
                      value: passkey.lastUsedAt
                        ? dateFormatter.format(new Date(passkey.lastUsedAt))
                        : t('common.never'),
                    })}
                  </small>
                </span>
                <button
                  type="button"
                  className="iconAction securityMobilePasskeyDelete"
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                  onClick={() => void handlePasskeyDelete(passkey.id)}
                >
                  <Icon name="trash-bin-trash-light" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="securityMobileEmptyState">
            <Icon name="key-light" />
            <strong>{t('security.noPasskeys')}</strong>
            <p>{security ? t('security.createPasskeyLead') : t('security.passkeysLoading')}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="settingsStack securitySettingsStack">
      {securityError && <div className="notice error inline">{securityError}</div>}

      {!isMobile && <>
      <section className="settingsPanel securityPanel securityCard">
        <div className="authorProfileSectionHeader">
          <Icon name="password-light" />
          <h3>{t('security.password')}</h3>
        </div>
        <div className="authorProfileRows">
          <div className="authorProfileRow noIcon securityPasswordRow">
            <span className="accountFieldLabel">{t('security.password')}</span>
            <span className="accountValueWithAction authorProfileValue">
              <span className="securityPasswordValue">
                <strong className={user.hasUsablePassword ? undefined : 'passwordNotSet'}>
                  {user.hasUsablePassword ? '****' : t('security.passwordNotSet')}
                </strong>
                <small>
                  {user.hasUsablePassword
                    ? daysSince(user.passwordChangedAt, t)
                    : user.oidcLinked
                      ? t('security.usesOidc')
                      : t('security.passwordNotSet')}
                </small>
              </span>
              {user.hasUsablePassword && (
                <button
                  type="button"
                  className="iconAction ghost"
                  onClick={() => setPasswordOpen((isOpen) => !isOpen)}
                  title={t('security.changePassword')}
                  aria-label={t('security.changePassword')}
                >
                  <Icon name="edit-light" />
                </button>
              )}
            </span>
          </div>
        </div>

        {user.hasUsablePassword && passwordOpen && (
          <form
            className="securityInlinePanel desktopPasswordChangePanel"
            onSubmit={handlePasswordRequest}
          >
            <div
              className="passwordRequirements compactRequirements desktopPasswordRequirements"
              aria-live="polite"
            >
              {newPasswordRequirements.map((requirement) => (
                <div
                  className={`passwordRequirement ${requirement.met ? 'met' : ''}`}
                  key={requirement.label}
                >
                  <Icon name="check-circle-1-light" />
                  <span>{requirement.label}</span>
                </div>
              ))}
            </div>
            <div className="desktopPasswordFields">
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                placeholder={t('security.currentPassword')}
                required
              />
              <div className="desktopPasswordSubmitRow">
                <input
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  placeholder={t('security.newPassword')}
                  onChange={(event) => setNewPasswordDraft(event.currentTarget.value)}
                  required
                />
                <button
                  type="submit"
                  className="iconAction passwordSendAction"
                  title={t('account.sendCode')}
                  aria-label={t('account.sendCode')}
                >
                  <Icon name="plain-light" />
                </button>
              </div>
            </div>
          </form>
        )}

        {passwordCodeRequested && (
          <form className="securityInlinePanel" onSubmit={handlePasswordConfirm}>
            <p>{t('security.codeLead', { email: user.email })}</p>
            <div className="securityInlineGrid confirm">
              <input name="code" inputMode="numeric" autoComplete="one-time-code" required />
              <button type="submit" className="compact">
                {t('common.confirm')}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="settingsPanel securityPanel securityCard">
        <div className="securitySectionHeader">
          <div className="authorProfileSectionHeader">
            <Icon name="lock-light" />
            <h3>{t('security.twoFactor')}</h3>
          </div>
        </div>

        <div className="twoFactorList">
          <div className="twoFactorOption">
            <span className="methodIcon">
              <Icon name="email-light" />
            </span>
            <div>
              <strong>{t('security.email')}</strong>
              <p>{t('security.emailMethodLead', { email: user.email })}</p>
            </div>
            <button
              type="button"
              role="switch"
              className="securityToggle"
              aria-checked={currentMethod === 'email'}
              aria-label={t('security.toggleTwoFactorMethod', { method: t('security.email') })}
              disabled={!security}
              onClick={() => handleTwoFactorToggle('email')}
            >
              <span />
            </button>
          </div>

          {emailTwoFactorRequested && (
            <form className="twoFactorConfirm" onSubmit={handleEmailTwoFactorConfirm}>
              <p>{t('security.codeLead', { email: user.email })}</p>
              <div className="securityInlineGrid confirm">
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,13}"
                  maxLength={13}
                  required
                />
                <button type="submit" className="compact">
                  {t('common.confirm')}
                </button>
              </div>
            </form>
          )}

          <div className="twoFactorOption">
            <span className="methodIcon">
              <Icon name="smartphone-light" />
            </span>
            <div>
              <strong>{t('security.authenticator')}</strong>
              <p>{t('security.authenticatorLead')}</p>
            </div>
            <button
              type="button"
              role="switch"
              className="securityToggle"
              aria-checked={currentMethod === 'totp'}
              aria-label={t('security.toggleTwoFactorMethod', { method: t('security.authenticator') })}
              disabled={!security}
              onClick={() => handleTwoFactorToggle('totp')}
            >
              <span />
            </button>
          </div>

          {totpSetup && (
            <form className="twoFactorConfirm" onSubmit={handleTotpConfirm}>
              <TotpSetupDetails provisioningUri={totpSetup.provisioningUri} />
              <div className="securityInlineGrid confirm">
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,13}"
                  maxLength={13}
                  required
                />
                <button type="submit" className="compact">
                  {t('common.confirm')}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>

      <section className="settingsPanel securityPanel securityCard">
        <div className="securitySectionHeader">
          <div className="authorProfileSectionHeader">
            <Icon name="key-light" />
            <h3>{t('security.passkeys')}</h3>
          </div>
          {security && (
            <span>
              {t('security.passkeysUsed', {
                used: security.passkeys.length,
                limit: security.passkeyLimit,
              })}
            </span>
          )}
        </div>
        <form className="passkeyInlineForm" onSubmit={handlePasskeyCreate}>
          <input
            name="name"
            maxLength={120}
            placeholder={t('security.passkeyName')}
            required
            disabled={!security || security.passkeys.length >= security.passkeyLimit}
          />
          <button
            type="submit"
            disabled={!security || security.passkeys.length >= security.passkeyLimit}
          >
            {t('security.createPasskey')}
          </button>
        </form>
        {security?.passkeys.length ? (
          <table className="passkeyTable">
            <thead>
              <tr>
                <th>{t('security.name')}</th>
                <th>{t('security.created')}</th>
                <th>{t('security.lastUsed')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {security.passkeys.map((passkey) => (
                <tr key={passkey.id}>
                  <td>{passkey.name}</td>
                  <td>{dateFormatter.format(new Date(passkey.createdAt))}</td>
                  <td>
                    {passkey.lastUsedAt
                      ? dateFormatter.format(new Date(passkey.lastUsedAt))
                      : t('common.never')}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => void handlePasskeyDelete(passkey.id)}
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="emptyState securityEmptyState">
            <span className="emptyStateIcon">
              <Icon name="siren-rounded-light" />
            </span>
            <div>
              <strong>{t('security.noPasskeys')}</strong>
              <p>
                {security
                  ? t('security.createPasskeyLead')
                  : t('security.passkeysLoading')}
              </p>
            </div>
          </div>
        )}
      </section>
      </>}

      {isMobile && (
        <section className="accountMobileSettingsList securityMobileSettingsList">
          <SecurityMobileRow
            icon="password-light"
            title={t('security.password')}
            subtitle={passwordStatus}
            disabled={!user.hasUsablePassword}
            onClick={() => setMobileSheet('password')}
          />
          <SecurityMobileRow
            icon="lock-light"
            title={t('security.twoFactor')}
            subtitle={twoFactorStatus}
            disabled={!security}
            onClick={openTwoFactorSheet}
          />
          <SecurityMobileRow
            icon="key-light"
            title={t('security.passkeys')}
            subtitle={passkeyStatus}
            onClick={() => setMobileSheet('passkeys')}
          />
        </section>
      )}

      {isMobile && mobileSheet === 'password' && (
        <MobileSettingsSheet
          title={t('security.changePassword')}
          onClose={closePasswordSheet}
        >
          {(close) => renderMobilePasswordForm(close)}
        </MobileSettingsSheet>
      )}

      {isMobile && mobileSheet === 'two-factor' && (
        <MobileSettingsSheet
          title={t('security.twoFactor')}
          onClose={() => {
            setMobileSheet(null)
            setMobileTwoFactorMethod(null)
            if (currentMethod === 'none') {
              setMobileTwoFactorEnabled(false)
              setTotpSetup(null)
              setEmailTwoFactorRequested(false)
            }
          }}
        >
          {renderMobileTwoFactor()}
        </MobileSettingsSheet>
      )}

      {isMobile && mobileSheet === 'two-factor' && mobileTwoFactorMethod && (
        <MobileSettingsSheet
          title={t(
            mobileTwoFactorMethod === 'email'
              ? 'security.email'
              : 'security.authenticator',
          )}
          onClose={closeMobileTwoFactorMethod}
        >
          {renderMobileTwoFactorMethod(mobileTwoFactorMethod)}
        </MobileSettingsSheet>
      )}

      {isMobile && mobileSheet === 'passkeys' && (
        <MobileSettingsSheet
          title={t('security.passkeys')}
          onClose={() => setMobileSheet(null)}
        >
          {renderMobilePasskeys()}
        </MobileSettingsSheet>
      )}

    </div>
  )
}
