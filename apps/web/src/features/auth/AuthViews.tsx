import { useRef, useState } from 'react'
import type { FormEvent, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import type { ServicePageMetadata, TwoFactorMethod } from '../../types'
import { PublicFooter } from '../service-pages/PublicFooter'
import { publishedServicePage } from '../service-pages/servicePages'
import { passwordRequirements } from './authPasswordRequirements'

type AuthViewsProps = {
  view: 'loading' | 'registration' | 'login' | 'forgotPassword' | 'twoFactor'
  openRegistration: boolean
  localPasswordLoginEnabled: boolean
  oidcEnabled: boolean
  oidcProviderName: string
  onRegistration: (event: FormEvent<HTMLFormElement>) => void
  onLogin: (event: FormEvent<HTMLFormElement>) => void
  onPasskeyLogin: (username: string) => void
  onOidcLogin: () => void
  onPasswordResetRequest: (email: string) => Promise<{ ok: boolean }>
  onPasswordResetVerify: (email: string, code: string) => Promise<boolean>
  onPasswordResetConfirm: (
    email: string,
    code: string,
    newPassword: string,
  ) => Promise<boolean>
  onTwoFactor: (event: FormEvent<HTMLFormElement>) => void
  onNavigate: (path: string) => void
  isSubmitting: boolean
  twoFactorMethod: TwoFactorMethod | null
  servicePages: ServicePageMetadata[]
}

type AuthShellProps = {
  children: ReactNode
  servicePages: ServicePageMetadata[]
}

export function AuthShell({ children, servicePages }: AuthShellProps) {
  return (
    <div className="authPage">
      <div className="authStage">
        <div className="authCenter">{children}</div>
      </div>

      <PublicFooter pages={servicePages} />
    </div>
  )
}

type FieldIcon = 'email-light' | 'lock-light' | 'profile-light' | 'shield-yes-light'

type AuthFieldProps = {
  label: string
  icon: FieldIcon
  children: ReactNode
  trailing?: ReactNode
}

export function AuthField({ label, icon, children, trailing }: AuthFieldProps) {
  return (
    <label className="authField">
      <span>{label}</span>
      <span className="inputShell">
        <Icon name={icon} className="inputIcon" />
        {children}
        {trailing}
      </span>
    </label>
  )
}

export function AuthViews({
  view,
  openRegistration,
  localPasswordLoginEnabled,
  oidcEnabled,
  oidcProviderName,
  onRegistration,
  onLogin,
  onPasskeyLogin,
  onOidcLogin,
  onPasswordResetRequest,
  onPasswordResetVerify,
  onPasswordResetConfirm,
  onTwoFactor,
  onNavigate,
  isSubmitting,
  twoFactorMethod,
  servicePages,
}: AuthViewsProps) {
  const { t } = useTranslation()
  const requirementLabels: [string, string, string] = [
    t('auth.passwordLength'),
    t('auth.passwordKinds'),
    t('auth.passwordIdentity'),
  ]
  const loginFormRef = useRef<HTMLFormElement | null>(null)
  const [registrationUsername, setRegistrationUsername] = useState('')
  const [registrationEmail, setRegistrationEmail] = useState('')
  const [registrationPassword, setRegistrationPassword] = useState('')
  const [registrationAccepted, setRegistrationAccepted] = useState(false)
  const [forgotStep, setForgotStep] = useState<'email' | 'code' | 'password'>('email')
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotCode, setForgotCode] = useState('')
  const [forgotPassword, setForgotPassword] = useState('')
  const [forgotSubmitting, setForgotSubmitting] = useState(false)
  const [showLoginPassword, setShowLoginPassword] = useState(false)

  function navigateWithLink(event: MouseEvent<HTMLAnchorElement>, path: string) {
    event.preventDefault()
    if (!isSubmitting) {
      onNavigate(path)
    }
  }

  if (view === 'loading') {
    return null
  }

  if (view === 'registration') {
    const privacyPage = publishedServicePage(servicePages, 'privacy')
    const termsPage = publishedServicePage(servicePages, 'terms')
    const hasConsentPages = Boolean(privacyPage || termsPage)
    const requirements = passwordRequirements(
      registrationPassword,
      registrationUsername,
      registrationEmail,
      requirementLabels,
    )

    return (
      <AuthShell servicePages={servicePages}>
        <form key="registration" className="authCard authForm" onSubmit={onRegistration}>
          <header className="authCardHeader">
            <h1>{t('auth.createAccount')}</h1>
            <p>{t('auth.createAccountLead')}</p>
          </header>

          <AuthField label={t('auth.username')} icon="profile-light">
            <input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={150}
              pattern="[A-Za-z0-9@.+_-]+"
              onChange={(event) => setRegistrationUsername(event.currentTarget.value)}
              required
            />
          </AuthField>

          <AuthField label={t('auth.email')} icon="email-light">
            <input
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              onChange={(event) => setRegistrationEmail(event.currentTarget.value)}
              required
            />
          </AuthField>

          <AuthField label={t('auth.password')} icon="lock-light">
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={4096}
              onChange={(event) => setRegistrationPassword(event.currentTarget.value)}
              required
            />
          </AuthField>

          <div className="passwordRequirements" aria-live="polite">
            {requirements.map((requirement) => (
              <div
                className={`passwordRequirement ${requirement.met ? 'met' : ''}`}
                key={requirement.label}
              >
                <Icon name="check-circle-1-light" />
                <span>{requirement.label}</span>
              </div>
            ))}
          </div>

          {hasConsentPages && (
            <label className="agreementOption">
              <input
                type="checkbox"
                checked={registrationAccepted}
                onChange={(event) => setRegistrationAccepted(event.currentTarget.checked)}
              />
              <span>
                {t('auth.acceptPoliciesPrefix')}{' '}
                {privacyPage && (
                  <a
                    href={`${privacyPage.path}?returnTo=registration`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {t('auth.privacyPolicy')}
                  </a>
                )}
                {privacyPage && termsPage && <> {' '}{t('auth.acceptPoliciesMiddle')}{' '} </>}
                {termsPage && (
                  <a
                    href={`${termsPage.path}?returnTo=registration`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {t('auth.termsOfService')}
                  </a>
                )}
              </span>
            </label>
          )}

          <button type="submit" className="primaryAction" disabled={isSubmitting || (hasConsentPages && !registrationAccepted)}>
            {isSubmitting ? t('auth.creatingAccount') : t('auth.createAccount')}
          </button>

          <p className="authSwitch">
            {t('auth.alreadyRegistered')}{' '}
            <a
              className="authTextLink"
              href="/login"
              aria-disabled={isSubmitting}
              onClick={(event) => navigateWithLink(event, '/login')}
            >
              {t('auth.signIn')}
            </a>
          </p>
        </form>
      </AuthShell>
    )
  }

  if (view === 'forgotPassword') {
    const requirements = passwordRequirements(forgotPassword, '', forgotEmail, requirementLabels)

    async function submitForgotEmail(event: FormEvent<HTMLFormElement>) {
      event.preventDefault()
      if (forgotSubmitting) {
        return
      }
      setForgotSubmitting(true)
      const form = new FormData(event.currentTarget)
      const email = String(form.get('email') || '').trim()
      try {
        const payload = await onPasswordResetRequest(email)
        if (payload.ok) {
          setForgotEmail(email)
          setForgotStep('code')
        }
      } finally {
        setForgotSubmitting(false)
      }
    }

    async function submitForgotCode(event: FormEvent<HTMLFormElement>) {
      event.preventDefault()
      if (forgotSubmitting) {
        return
      }
      setForgotSubmitting(true)
      const form = new FormData(event.currentTarget)
      const code = String(form.get('code') || '').trim()
      try {
        if (await onPasswordResetVerify(forgotEmail, code)) {
          setForgotCode(code)
          setForgotStep('password')
        }
      } finally {
        setForgotSubmitting(false)
      }
    }

    async function submitForgotPassword(event: FormEvent<HTMLFormElement>) {
      event.preventDefault()
      if (forgotSubmitting) {
        return
      }
      setForgotSubmitting(true)
      try {
        await onPasswordResetConfirm(forgotEmail, forgotCode, forgotPassword)
      } finally {
        setForgotSubmitting(false)
      }
    }

    return (
      <AuthShell servicePages={servicePages}>
        {forgotStep === 'email' && (
          <form key="forgot-email" className="authCard authForm" onSubmit={(event) => void submitForgotEmail(event)}>
            <header className="authCardHeader">
              <h1>{t('auth.resetPassword')}</h1>
              <p>{t('auth.resetEmailExisting')}</p>
            </header>

            <AuthField label={t('auth.email')} icon="email-light">
              <input
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
              />
            </AuthField>

            <button type="submit" className="primaryAction" disabled={forgotSubmitting}>
              {forgotSubmitting ? t('auth.sendingCode') : t('auth.sendCode')}
            </button>

            <p className="authSwitch">
              {t('auth.rememberPassword')}{' '}
              <a
                className="authTextLink"
                href="/login"
                aria-disabled={forgotSubmitting}
                onClick={(event) => navigateWithLink(event, '/login')}
              >
                {t('auth.backToSignIn')}
              </a>
            </p>
          </form>
        )}

        {forgotStep === 'code' && (
          <form key="forgot-code" className="authCard authForm" onSubmit={(event) => void submitForgotCode(event)}>
            <header className="authCardHeader">
              <h1>{t('auth.enterCode')}</h1>
              <p>{t('auth.resetCodePrivacy', { email: forgotEmail })}</p>
            </header>

            <AuthField label={t('auth.code')} icon="shield-yes-light">
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,13}"
                maxLength={13}
                required
                autoFocus
              />
            </AuthField>

            <button type="submit" className="primaryAction" disabled={forgotSubmitting}>
              {forgotSubmitting ? t('auth.checkingCode') : t('common.continue')}
            </button>
          </form>
        )}

        {forgotStep === 'password' && (
          <form
            key="forgot-password"
            className="authCard authForm"
            onSubmit={(event) => void submitForgotPassword(event)}
          >
            <header className="authCardHeader">
              <h1>{t('auth.newPassword')}</h1>
              <p>{t('auth.createNewPassword')}</p>
            </header>

            <AuthField label={t('auth.newPassword')} icon="lock-light">
              <input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={4096}
                onChange={(event) => setForgotPassword(event.currentTarget.value)}
                required
                autoFocus
              />
            </AuthField>

            <div className="passwordRequirements" aria-live="polite">
              {requirements.map((requirement) => (
                <div
                  className={`passwordRequirement ${requirement.met ? 'met' : ''}`}
                  key={requirement.label}
                >
                  <Icon name="check-circle-1-light" />
                  <span>{requirement.label}</span>
                </div>
              ))}
            </div>

            <button type="submit" className="primaryAction" disabled={forgotSubmitting}>
              {forgotSubmitting ? t('auth.updatingPassword') : t('auth.updatePassword')}
            </button>
          </form>
        )}
      </AuthShell>
    )
  }

  if (view === 'twoFactor') {
    const isEmailCode = twoFactorMethod === 'email'
    return (
      <AuthShell servicePages={servicePages}>
        <form key="two-factor" className="authCard authForm" onSubmit={onTwoFactor}>
          <header className="authCardHeader">
            <h1>{t('auth.verificationCodeTitle')}</h1>
            <p>
              {isEmailCode
                ? t('auth.emailCodeLead')
                : t('auth.authenticatorCodeLead')}
            </p>
          </header>

          <AuthField label={t('auth.code')} icon="shield-yes-light">
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,13}"
              maxLength={13}
              required
              autoFocus
            />
          </AuthField>

          <button type="submit" className="primaryAction" disabled={isSubmitting}>
            {isSubmitting ? t('auth.verifying') : t('auth.verifyCode')}
          </button>
          <p className="authSwitch">
            {t('auth.wrongAccount')}{' '}
            <a
              className="authTextLink"
              href="/login"
              aria-disabled={isSubmitting}
              onClick={(event) => navigateWithLink(event, '/login')}
            >
              {t('auth.backToSignIn')}
            </a>
          </p>
          <input type="hidden" name="method" value={twoFactorMethod ?? 'totp'} />
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell servicePages={servicePages}>
      <form
        key="login"
        className="authCard authForm"
        onSubmit={onLogin}
        ref={(form) => {
          loginFormRef.current = form
        }}
      >
        <header className="authCardHeader">
          <h1>{t('auth.welcomeBack')}</h1>
          <p>{t('auth.welcomeBackLead')}</p>
        </header>

        {localPasswordLoginEnabled && (
          <>
          <AuthField label={t('auth.username')} icon="profile-light">
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={150}
            required
          />
        </AuthField>

        <AuthField
          label={t('auth.password')}
          icon="lock-light"
          trailing={(
            <button
              type="button"
              className="inputTrailButton"
              onClick={() => setShowLoginPassword((visible) => !visible)}
              aria-label={t(showLoginPassword ? 'auth.hidePassword' : 'auth.showPassword')}
              title={t(showLoginPassword ? 'auth.hidePassword' : 'auth.showPassword')}
            >
              <Icon name={showLoginPassword ? 'eye-scan-light' : 'eye-light'} className="inputTrailIcon" />
            </button>
          )}
        >
          <input
            name="password"
            type={showLoginPassword ? 'text' : 'password'}
            autoComplete="current-password"
            maxLength={4096}
            required
          />
        </AuthField>

        <div className="authOptions">
          <label className="rememberOption">
            <input type="checkbox" name="remember" />
            <span>{t('auth.rememberMe')}</span>
          </label>
          <a
            className="authTextLink"
            href="/forgot-password"
            aria-disabled={isSubmitting}
            onClick={(event) => navigateWithLink(event, '/forgot-password')}
          >
            {t('auth.forgotPassword')}
          </a>
        </div>

        <button type="submit" className="primaryAction" disabled={isSubmitting}>
          {isSubmitting ? t('auth.signingIn') : t('auth.login')}
        </button>

        <div className="authDivider" role="separator">
          <span>{t('auth.or')}</span>
        </div>
          </>
        )}

        <button
          type="button"
          className="secondaryAction"
          onClick={() => {
            const form = loginFormRef.current
            const username = form ? String(new FormData(form).get('username') || '') : ''
            onPasskeyLogin(username)
          }}
          disabled={isSubmitting}
        >
          <Icon name="shield-yes-light" />
          {t('auth.loginPasskey')}
        </button>

        {oidcEnabled && (
          <button type="button" className="secondaryAction" onClick={onOidcLogin} disabled={isSubmitting}>
            <Icon name="global-light" />
            {t('auth.loginOpenIdProvider', { provider: oidcProviderName })}
          </button>
        )}

        {localPasswordLoginEnabled && openRegistration && (
          <p className="authSwitch">
            {t('auth.noAccount')}{' '}
            <a
              className="authTextLink"
              href="/registration"
              aria-disabled={isSubmitting}
              onClick={(event) => navigateWithLink(event, '/registration')}
            >
              {t('auth.createOne')}
            </a>
          </p>
        )}
      </form>
    </AuthShell>
  )
}
