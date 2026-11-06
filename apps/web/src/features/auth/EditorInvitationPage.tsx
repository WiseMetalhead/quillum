import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { getThemePreference } from '../../theme'
import type {
  EditorInvitationClaimPayload,
  ServicePageMetadata,
  User,
  WorkspaceKind,
} from '../../types'
import { publishedServicePage } from '../service-pages/servicePages'
import { ResponsiveConfirmationDialog } from '../shared/ResponsiveConfirmationDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { AuthField, AuthShell } from './AuthViews'
import { passwordRequirements } from './authPasswordRequirements'

type Props = {
  user: User | null
  servicePages: ServicePageMetadata[]
  onAuthenticated: (user: User, activeWorkspace?: WorkspaceKind) => void
}

export function EditorInvitationPage({ user, servicePages, onAuthenticated }: Props) {
  const { t, i18n } = useTranslation()
  const [claim, setClaim] = useState<EditorInvitationClaimPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(
    () => new URLSearchParams(window.location.search).get('oidcError') ?? '',
  )
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [confirmation, setConfirmation] = useState<'accept' | 'oidc' | null>(null)
  const privacyPage = publishedServicePage(servicePages, 'privacy')
  const termsPage = publishedServicePage(servicePages, 'terms')
  const hasConsentPages = Boolean(privacyPage || termsPage)
  const requirements = passwordRequirements(password, username, email, [
    t('auth.passwordLength'),
    t('auth.passwordKinds'),
    t('auth.passwordIdentity'),
  ])

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search)
    if (!parameters.has('oidcError')) return
    parameters.delete('oidcError')
    const search = parameters.toString()
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    )
  }, [])

  useEffect(() => {
    let active = true
    async function loadClaim() {
      const token = window.location.hash.slice(1)
      try {
        const payload = token
          ? await apiRequest<EditorInvitationClaimPayload>('/api/editor/invitation-claim/', {
              method: 'POST',
              body: JSON.stringify({ token }),
            })
          : await apiRequest<EditorInvitationClaimPayload>('/api/editor/invitation-claim/')
        if (active) setClaim(payload)
        if (token) {
          window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : t('editorInvitation.loadFailed'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadClaim()
    return () => {
      active = false
    }
  }, [t])

  function startOidc() {
    const parameters = new URLSearchParams({
      invitation: '1',
      language: i18n.resolvedLanguage || 'en',
      theme: getThemePreference(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    })
    window.location.assign(`${API_BASE}/api/auth/oidc/login/?${parameters.toString()}`)
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const response = await apiRequest<{ user: User; activeWorkspace?: WorkspaceKind }>(
        '/api/editor/invitation-claim/register/',
        {
          method: 'POST',
          body: JSON.stringify({
            username,
            email,
            password,
            language: i18n.resolvedLanguage || 'en',
            theme: getThemePreference(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }),
        },
      )
      onAuthenticated(response.user, response.activeWorkspace)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('editorInvitation.registerFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function acceptInvitation() {
    if (submitting) return false
    setSubmitting(true)
    setError('')
    try {
      const response = await apiRequest<{ user: User; activeWorkspace: WorkspaceKind }>('/api/editor/invitation-claim/accept/', {
        method: 'POST',
        body: '{}',
      })
      onAuthenticated(response.user, response.activeWorkspace)
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('editorInvitation.acceptFailed'))
      return false
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <AuthShell servicePages={servicePages}>
        <div className="authCard editorInvitationCard">
          <TadpoleLoadingState label={t('editorInvitation.loading')} />
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell servicePages={servicePages}>
      <div className="authCard authForm editorInvitationCard">
        <header className="authCardHeader">
          <h1>{t('editorInvitation.title')}</h1>
          {claim && (
            <p>{t('editorInvitation.lead', {
              name: claim.invitation.author.displayName || claim.invitation.author.username,
            })}</p>
          )}
        </header>

        {error && <div className="notice error" role="alert">{t(`errors.${error}`, { defaultValue: error })}</div>}

        {claim && user && !user.editorWorkspaceEnabled && (
          <div className="editorInvitationState">
            <strong>{t('editorInvitation.activateAndAcceptTitle')}</strong>
            <p>{t('editorInvitation.activateAndAcceptLead')}</p>
            <button type="button" className="primaryAction" disabled={submitting} onClick={() => setConfirmation('accept')}>
              {t('editorInvitation.activateAndAccept')}
            </button>
          </div>
        )}

        {claim && user?.editorWorkspaceEnabled && (
          <div className="editorInvitationState">
            <strong>{t('editorInvitation.acceptTitle')}</strong>
            <p>{t('editorInvitation.acceptLead')}</p>
            <button type="button" className="primaryAction" disabled={submitting} onClick={() => void acceptInvitation()}>
              {submitting ? t('editorInvitation.accepting') : t('editorInvitation.accept')}
            </button>
          </div>
        )}

        {claim && !user && (
          <>
            {claim.localPasswordLoginEnabled && (
              <form className="editorInvitationRegistration" onSubmit={(event) => void register(event)}>
                <AuthField label={t('auth.username')} icon="profile-light">
                  <input
                    autoComplete="username"
                    maxLength={150}
                    pattern="[A-Za-z0-9@.+_-]+"
                    value={username}
                    onChange={(event) => setUsername(event.currentTarget.value)}
                    required
                  />
                </AuthField>
                <AuthField label={t('auth.email')} icon="email-light">
                  <input
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    value={email}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    required
                  />
                </AuthField>
                <AuthField label={t('auth.password')} icon="lock-light">
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={4096}
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                    required
                  />
                </AuthField>
                <div className="passwordRequirements" aria-live="polite">
                  {requirements.map((requirement) => (
                    <div className={`passwordRequirement ${requirement.met ? 'met' : ''}`} key={requirement.label}>
                      <Icon name="check-circle-1-light" />
                      <span>{requirement.label}</span>
                    </div>
                  ))}
                </div>
                {hasConsentPages && (
                  <label className="agreementOption">
                    <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.currentTarget.checked)} />
                    <span>
                      {t('auth.acceptPoliciesPrefix')}{' '}
                      {privacyPage && <a href={`${privacyPage.path}?returnTo=editor-invitation`} target="_blank" rel="noreferrer">{t('auth.privacyPolicy')}</a>}
                      {privacyPage && termsPage && <> {' '}{t('auth.acceptPoliciesMiddle')}{' '} </>}
                      {termsPage && <a href={`${termsPage.path}?returnTo=editor-invitation`} target="_blank" rel="noreferrer">{t('auth.termsOfService')}</a>}
                    </span>
                  </label>
                )}
                <button type="submit" className="primaryAction" disabled={submitting || (hasConsentPages && !accepted)}>
                  {submitting ? t('auth.creatingAccount') : t('editorInvitation.createEditorAccount')}
                </button>
              </form>
            )}

            {claim.localPasswordLoginEnabled && claim.oidcEnabled && (
              <div className="authDivider" role="separator"><span>{t('auth.or')}</span></div>
            )}

            {claim.oidcEnabled && (
              <button type="button" className="secondaryAction" disabled={submitting} onClick={() => setConfirmation('oidc')}>
                <Icon name="global-light" />
                {t('editorInvitation.continueOpenId', { provider: claim.oidcProviderName })}
              </button>
            )}

            {claim.localPasswordLoginEnabled && (
              <p className="authSwitch">
                {t('editorInvitation.haveAccount')}{' '}
                <a className="authTextLink" href="/login?returnTo=%2Feditor-invitation">
                  {t('auth.signIn')}
                </a>
              </p>
            )}

            {!claim.localPasswordLoginEnabled && !claim.oidcEnabled && (
              <div className="notice error">{t('editorInvitation.authUnavailable')}</div>
            )}
          </>
        )}
      </div>

      {confirmation && (
        <ResponsiveConfirmationDialog
          title={t(`editorInvitation.${confirmation === 'accept' ? 'activateConfirmTitle' : 'oidcConfirmTitle'}`)}
          description={<p>{t(`editorInvitation.${confirmation === 'accept' ? 'activateConfirmLead' : 'oidcConfirmLead'}`)}</p>}
          cancelLabel={t('common.cancel')}
          confirmLabel={t(`editorInvitation.${confirmation === 'accept' ? 'activateConfirmAction' : 'oidcConfirmAction'}`)}
          busyLabel={t('editorInvitation.accepting')}
          closeLabel={t('common.close')}
          busy={submitting}
          danger={false}
          onClose={() => setConfirmation(null)}
          onConfirm={confirmation === 'accept'
            ? acceptInvitation
            : async () => {
                startOidc()
                return false
              }}
        />
      )}
    </AuthShell>
  )
}
