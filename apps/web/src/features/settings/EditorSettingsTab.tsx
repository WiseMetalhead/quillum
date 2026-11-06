import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type {
  EditorIdentity,
  EditorInvitation,
  EditorSectionPayload,
  User,
} from '../../types'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { LibraryAction } from '../shared/MobileLibraryActionSheet'
import { ResponsiveConfirmationDialog } from '../shared/ResponsiveConfirmationDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileViewport } from '../shared/useMobileViewport'
import { WorkspaceActivationBanner } from './WorkspaceActivationBanner'

type Props = {
  user: User
  onUserChange: (user: User) => void
  onMessage: (message: string) => void
  onError: (message: string) => void
}

type Confirmation =
  | { kind: 'invitation'; item: EditorInvitation }
  | { kind: 'connection'; item: EditorIdentity }

type MobileActions =
  | { kind: 'invitation'; item: EditorInvitation; number: number }
  | { kind: 'connection'; item: EditorIdentity }

type MobileSection = 'invitations' | 'editors' | 'writers'

function identityName(item: EditorIdentity) {
  return item.displayName || item.username
}

function identityInitial(item: EditorIdentity) {
  return Array.from(identityName(item).trim())[0]?.toUpperCase() || '?'
}

export function EditorSettingsTab({
  user,
  onUserChange,
  onMessage,
  onError,
}: Props) {
  const { t, i18n } = useTranslation()
  const authorWorkspaceEnabled = user.authorWorkspaceEnabled
  const editorWorkspaceEnabled = user.editorWorkspaceEnabled
  const isMobile = useMobileViewport()
  const [payload, setPayload] = useState<EditorSectionPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [mobileActions, setMobileActions] = useState<MobileActions | null>(null)
  const [mobileSection, setMobileSection] = useState<MobileSection | null>(null)
  const [mobileMenuDirection, setMobileMenuDirection] = useState<'forward' | 'back'>('forward')
  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPayload(await apiRequest<EditorSectionPayload>('/api/editor/invitations/'))
    } catch (error) {
      onError(error instanceof Error ? error.message : t('editorSettings.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [onError, t])

  useEffect(() => {
    let active = true
    apiRequest<EditorSectionPayload>('/api/editor/invitations/')
      .then((response) => {
        if (active) setPayload(response)
      })
      .catch((error: unknown) => {
        if (active) onError(error instanceof Error ? error.message : t('editorSettings.loadFailed'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [onError, t])

  async function createInvitation() {
    setBusy(true)
    onError('')
    try {
      setPayload(await apiRequest<EditorSectionPayload>('/api/editor/invitations/', {
        method: 'POST',
        body: '{}',
      }))
      onMessage(t('editorSettings.invitationCreated'))
    } catch (error) {
      onError(error instanceof Error ? error.message : t('editorSettings.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function copyInvitation(invitation: EditorInvitation) {
    try {
      await navigator.clipboard.writeText(invitation.shareUrl)
      onMessage(t('editorSettings.linkCopied'))
    } catch {
      onError(t('editorSettings.copyFailed'))
    }
  }

  async function confirmRemoval() {
    if (!confirmation) return false
    setBusy(true)
    onError('')
    try {
      const path = confirmation.kind === 'invitation'
        ? `/api/editor/invitations/${confirmation.item.id}/`
        : `/api/editor/connections/${confirmation.item.id}/`
      setPayload(await apiRequest<EditorSectionPayload>(path, { method: 'DELETE' }))
      onMessage(t(confirmation.kind === 'invitation'
        ? 'editorSettings.invitationRevoked'
        : 'editorSettings.editorDisconnected'))
      setConfirmation(null)
      return true
    } catch (error) {
      onError(error instanceof Error ? error.message : t('editorSettings.updateFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <TadpoleLoadingState label={t('editorSettings.loading')} />
  }

  if (!payload) {
    return (
      <div className="emptyState">
        <Icon className="emptyStateIcon" name="mynaui-pen" />
        <strong>{t('editorSettings.loadFailed')}</strong>
        <button type="button" className="secondary" onClick={() => void load()}>{t('common.retry')}</button>
      </div>
    )
  }

  const mobileSheetActions: LibraryAction[] = mobileActions
    ? mobileActions.kind === 'invitation'
      ? [
          {
            key: 'copy',
            label: t('common.copy'),
            icon: <Icon name="clipboard-light" />,
            onSelect: () => void copyInvitation(mobileActions.item),
          },
          {
            key: 'revoke',
            label: t('editorSettings.revoke'),
            icon: <Icon name="trash-bin-trash-light" />,
            danger: true,
            onSelect: () => setConfirmation({ kind: 'invitation', item: mobileActions.item }),
          },
        ]
      : [
          {
            key: 'disconnect',
            label: t('editorSettings.disconnect'),
            icon: <Icon name="trash-bin-trash-light" />,
            danger: true,
            onSelect: () => setConfirmation({ kind: 'connection', item: mobileActions.item }),
          },
        ]
    : []

  const inviteControl = authorWorkspaceEnabled && (
    <div className="editorInviteActions">
      <strong>{t('editorSettings.quota', {
        used: payload.quota?.used ?? 0,
        limit: payload.quota?.limit ?? 0,
      })}</strong>
      <button
        type="button"
        disabled={busy || (payload.quota?.used ?? 0) >= (payload.quota?.limit ?? 0)}
        onClick={() => void createInvitation()}
      >
        <Icon name="sign-plus-light" />
        {t('editorSettings.createLink')}
      </button>
    </div>
  )

  const mobileActionSheet = isMobile && mobileActions && (
    <MobileLibraryActionSheet
      open
      title={mobileActions.kind === 'invitation'
        ? t('editorSettings.invitationNumber', { number: mobileActions.number })
        : identityName(mobileActions.item)}
      actions={mobileSheetActions}
      dismissOnSelect
      onClose={() => setMobileActions(null)}
    />
  )

  const confirmationDialog = confirmation && (
    <ResponsiveConfirmationDialog
      title={t(confirmation.kind === 'invitation'
        ? 'editorSettings.revokeTitle'
        : 'editorSettings.disconnectTitle')}
      description={t(confirmation.kind === 'invitation'
        ? 'editorSettings.revokeDescription'
        : 'editorSettings.disconnectDescription', confirmation.kind === 'connection'
          ? { name: identityName(confirmation.item) }
          : {})}
      cancelLabel={t('common.cancel')}
      confirmLabel={t(confirmation.kind === 'invitation'
        ? 'editorSettings.revoke'
        : 'editorSettings.disconnect')}
      busyLabel={t('common.saving')}
      closeLabel={t('common.close')}
      busy={busy}
      onClose={() => setConfirmation(null)}
      onConfirm={confirmRemoval}
    />
  )

  if (isMobile) {
    const pendingCount = payload.pendingInvitations.length

    function openMobileSection(section: MobileSection) {
      setMobileMenuDirection('forward')
      setMobileSection(section)
    }

    function closeMobileSection() {
      setMobileMenuDirection('back')
      setMobileSection(null)
      setMobileActions(null)
    }

    return (
      <div className={`settingsStack editorSettingsStack editorSettingsMobileLayout ${mobileMenuDirection}`.trim()}>
        {!mobileSection ? (
          <nav className="editorSettingsMobileMenu mobileMenuTransitionPane" aria-label={t('settings.editor')} key="root">
            {authorWorkspaceEnabled && !editorWorkspaceEnabled && (
              <WorkspaceActivationBanner
                workspace="editor"
                onUserChange={onUserChange}
                onMessage={onMessage}
                onError={onError}
              />
            )}
            {authorWorkspaceEnabled && (
              <div className="editorSettingsMobileMaintenanceRow">
                <span className="editorSettingsMobileRowIcon" aria-hidden="true">
                  <Icon name="letter-opened-linear" />
                </span>
                <span className="editorSettingsMobileRowCopy">
                  <strong>{t('editorSettings.inviteTitle')}</strong>
                  <small>{t('editorSettings.quota', {
                    used: payload.quota?.used ?? 0,
                    limit: payload.quota?.limit ?? 0,
                  })}</small>
                </span>
                <button
                  type="button"
                  className="editorSettingsMobileAction spaceButton"
                  disabled={busy || (payload.quota?.used ?? 0) >= (payload.quota?.limit ?? 0)}
                  aria-busy={busy}
                  aria-label={t('editorSettings.createLink')}
                  title={t('editorSettings.createLink')}
                  onClick={() => void createInvitation()}
                >
                  {busy ? <TadpoleIcon /> : <Icon name="sign-plus-light" />}
                </button>
              </div>
            )}
            {authorWorkspaceEnabled && (
              <button
                type="button"
                className="editorSettingsMobileMenuRow spaceButton"
                onClick={() => openMobileSection('invitations')}
              >
                <span className="editorSettingsMobileRowIcon" aria-hidden="true">
                  <Icon name="link-circle-linear" />
                </span>
                <span className="editorSettingsMobileRowCopy">
                  <strong>{t('editorSettings.pendingTitle')}</strong>
                  <small>{t('editorSettings.mobileInvitationCount', { count: pendingCount })}</small>
                </span>
                <Icon name="arrow-right-2" />
              </button>
            )}
            {authorWorkspaceEnabled && (
              <button
                type="button"
                className="editorSettingsMobileMenuRow spaceButton"
                onClick={() => openMobileSection('editors')}
              >
                <span className="editorSettingsMobileRowIcon" aria-hidden="true">
                  <Icon name="user-heart-linear" />
                </span>
                <span className="editorSettingsMobileRowCopy">
                  <strong>{t('editorSettings.connectedEditorsTitle')}</strong>
                  <small>{t('editorSettings.mobileEditorCount', { count: payload.editors.length })}</small>
                </span>
                <Icon name="arrow-right-2" />
              </button>
            )}
            {editorWorkspaceEnabled && (
              <button
                type="button"
                className="editorSettingsMobileMenuRow spaceButton"
                onClick={() => openMobileSection('writers')}
              >
                <span className="editorSettingsMobileRowIcon" aria-hidden="true">
                  <Icon name="user-heart-linear" />
                </span>
                <span className="editorSettingsMobileRowCopy">
                  <strong>{t('editorSettings.connectedWritersTitle')}</strong>
                  <small>{t('editorSettings.mobileWriterCount', { count: payload.writers.length })}</small>
                </span>
                <Icon name="arrow-right-2" />
              </button>
            )}
          </nav>
        ) : (
          <div className="editorSettingsMobileCategory mobileMenuTransitionPane" key={mobileSection}>
            <nav className="editorSettingsMobileMenu editorSettingsMobileBackMenu" aria-label={t('editorSettings.backToEditorial')}>
              <button
                type="button"
                className="editorSettingsMobileMenuRow editorSettingsMobileBackRow spaceButton"
                onClick={closeMobileSection}
              >
                <span className="editorSettingsMobileRowIcon"><Icon name="arrow-left-1" /></span>
                <span className="editorSettingsMobileRowCopy">
                  <strong>{t('editorSettings.backToEditorial')}</strong>
                </span>
              </button>
            </nav>

            {mobileSection === 'invitations' && (
              <nav className="editorSettingsMobileMenu" aria-label={t('editorSettings.pendingTitle')}>
                {payload.pendingInvitations.length ? payload.pendingInvitations.map((invitation, index) => {
                  const number = index + 1
                  return (
                    <button
                      type="button"
                      className="editorSettingsMobileMenuRow withoutIcon spaceButton"
                      key={invitation.id}
                      onClick={() => setMobileActions({ kind: 'invitation', item: invitation, number })}
                    >
                      <span className="editorSettingsMobileRowCopy">
                        <strong>{t('editorSettings.invitationNumber', { number })}</strong>
                        <small>{t('editorSettings.expiresAt', {
                          value: dateFormatter.format(new Date(invitation.expiresAt)),
                        })}</small>
                      </span>
                      <Icon name="arrow-right-2" />
                    </button>
                  )
                }) : (
                  <div className="editorSettingsMobileMenuRow withoutIcon readOnly">
                    <span className="editorSettingsMobileRowCopy">
                      <strong>{t('editorSettings.noPending')}</strong>
                    </span>
                  </div>
                )}
              </nav>
            )}

            {(mobileSection === 'editors' || mobileSection === 'writers') && (() => {
              const editorList = mobileSection === 'editors'
              const items = editorList ? payload.editors : payload.writers
              const connectionTitle = t(editorList
                ? 'editorSettings.connectedEditorsTitle'
                : 'editorSettings.connectedWritersTitle')
              return (
              <div className="editorSettingsMobileMenu" role="group" aria-label={connectionTitle}>
                {items.length ? items.map((item) => {
                  const name = identityName(item)
                  const connectionDetails = t('editorSettings.connectedAt', {
                    value: dateFormatter.format(new Date(item.connectedAt)),
                  })
                  const content = (
                    <>
                      <span className="editorConnectionAvatar" aria-hidden="true">
                        {item.avatarUrl ? <img src={`${API_BASE}${item.avatarUrl}`} alt="" /> : identityInitial(item)}
                      </span>
                      <span className="editorSettingsMobileRowCopy">
                        <strong>{name}</strong>
                        <small>{item.displayName ? `@${item.username} · ${connectionDetails}` : connectionDetails}</small>
                      </span>
                      {editorList && <Icon name="arrow-right-2" />}
                    </>
                  )
                  return editorList ? (
                    <button
                      type="button"
                      className="editorSettingsMobileMenuRow spaceButton"
                      key={item.id}
                      onClick={() => setMobileActions({ kind: 'connection', item })}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="editorSettingsMobileMenuRow readOnly" key={item.id}>
                      {content}
                    </div>
                  )
                }) : (
                  <div className="editorSettingsMobileMenuRow withoutIcon readOnly">
                    <span className="editorSettingsMobileRowCopy">
                      <strong>{t(editorList
                        ? 'editorSettings.noEditors'
                        : 'editorSettings.noWriters')}</strong>
                    </span>
                  </div>
                )}
              </div>
              )
            })()}
          </div>
        )}

        {mobileActionSheet}
        {confirmationDialog}
      </div>
    )
  }

  function desktopConnections(items: EditorIdentity[], editorList: boolean) {
    return (
      <section className="settingsPanel editorSettingsSection">
        <div className="editorSettingsSectionHeader">
          <div className="authorProfileSectionHeader">
            <Icon name="user-heart-linear" />
            <h3>{t(editorList
              ? 'editorSettings.connectedEditorsTitle'
              : 'editorSettings.connectedWritersTitle')}</h3>
          </div>
        </div>
        {items.length ? (
          <div className="editorSettingsList">
            {items.map((item) => {
              const name = identityName(item)
              const connectionDetails = t('editorSettings.connectedAt', {
                value: dateFormatter.format(new Date(item.connectedAt)),
              })
              return (
                <div className={`editorSettingsRow editorConnectionRow ${editorList ? '' : 'readOnly'}`} key={item.id}>
                  <span className="editorConnectionAvatar" aria-hidden="true">
                    {item.avatarUrl ? <img src={`${API_BASE}${item.avatarUrl}`} alt="" /> : identityInitial(item)}
                  </span>
                  <div className="editorSettingsIdentity">
                    <strong>{name}</strong>
                    {item.displayName && <span>@{item.username}</span>}
                    <span>{connectionDetails}</span>
                  </div>
                  {editorList && (
                    <button type="button" className="dangerButton" onClick={() => setConfirmation({ kind: 'connection', item })}>
                      {t('editorSettings.disconnect')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ) : <p className="editorSettingsEmpty">{t(editorList
          ? 'editorSettings.noEditors'
          : 'editorSettings.noWriters')}</p>}
      </section>
    )
  }

  return (
    <div className="settingsStack editorSettingsStack">
      {authorWorkspaceEnabled && !editorWorkspaceEnabled && (
        <WorkspaceActivationBanner
          workspace="editor"
          onUserChange={onUserChange}
          onMessage={onMessage}
          onError={onError}
        />
      )}
      {authorWorkspaceEnabled && (
        <section className="settingsPanel editorSettingsSection editorInviteSection">
          <div className="editorSettingsSectionHeader editorInviteHeader">
            <div className="authorProfileSectionHeader">
              <Icon name="letter-opened-linear" />
              <h3>{t('editorSettings.inviteTitle')}</h3>
            </div>
            {inviteControl}
          </div>
        </section>
      )}

      {authorWorkspaceEnabled && (
        <section className="settingsPanel editorSettingsSection">
          <div className="editorSettingsSectionHeader">
            <div className="authorProfileSectionHeader">
              <Icon name="link-circle-linear" />
              <h3>{t('editorSettings.pendingTitle')}</h3>
            </div>
          </div>
          {payload.pendingInvitations.length ? (
            <div className="editorSettingsList">
              {payload.pendingInvitations.map((invitation, index) => {
                const number = index + 1
                const label = t('editorSettings.invitationNumber', { number })
                return (
                  <div className="editorSettingsRow editorInvitationRow" key={invitation.id}>
                    <div className="editorSettingsIdentity">
                      <strong>{label}</strong>
                      <span>{t('editorSettings.expiresAt', {
                        value: dateFormatter.format(new Date(invitation.expiresAt)),
                      })}</span>
                    </div>
                    <div className="editorSettingsActions">
                      <button type="button" className="secondary" onClick={() => void copyInvitation(invitation)}>
                        <Icon name="clipboard-light" />
                        {t('common.copy')}
                      </button>
                      <button type="button" className="dangerButton" onClick={() => setConfirmation({ kind: 'invitation', item: invitation })}>
                        {t('editorSettings.revoke')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : <p className="editorSettingsEmpty">{t('editorSettings.noPending')}</p>}
        </section>
      )}

      {authorWorkspaceEnabled && desktopConnections(payload.editors, true)}
      {editorWorkspaceEnabled && desktopConnections(payload.writers, false)}

      {confirmationDialog}
    </div>
  )
}
