import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { User, WorkspaceKind } from '../../types'
import { ResponsiveConfirmationDialog } from '../shared/ResponsiveConfirmationDialog'

type Props = {
  workspace: WorkspaceKind
  presentation?: 'compact' | 'promotional'
  onUserChange: (user: User) => void
  onMessage: (message: string) => void
  onError: (message: string) => void
}

export function WorkspaceActivationBanner({
  workspace,
  presentation = 'compact',
  onUserChange,
  onMessage,
  onError,
}: Props) {
  const { t } = useTranslation()
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const key = workspace === 'author' ? 'author' : 'editor'
  const promotional = presentation === 'promotional'
  const benefits = promotional && workspace === 'author'
    ? ['manuscripts', 'organization', 'progress'] as const
    : []

  async function activate() {
    setBusy(true)
    onError('')
    try {
      const payload = await apiRequest<{ user: User }>(
        `/api/auth/workspaces/${workspace}/activate/`,
        { method: 'POST', body: '{}' },
      )
      onUserChange(payload.user)
      onMessage(t(`workspaceActivation.${key}.activated`))
      setConfirmationOpen(false)
      return true
    } catch (error) {
      onError(error instanceof Error ? error.message : t('workspaceActivation.failed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section
        className={`settingsPanel workspaceActivationBanner workspaceActivationBanner--${presentation}`}
      >
        <span className="workspaceActivationIcon" aria-hidden="true">
          <Icon name={workspace === 'author' ? 'books-light' : 'mynaui-pen'} />
        </span>
        <div className="workspaceActivationCopy">
          <h3>{t(`workspaceActivation.${key}.title`)}</h3>
          <p>{t(`workspaceActivation.${key}.lead`)}</p>
        </div>
        {benefits.length > 0 && (
          <ul
            className="workspaceActivationBenefits"
            aria-label={t('workspaceActivation.author.benefitsLabel')}
          >
            {benefits.map((benefit) => (
              <li key={benefit}>
                <span className="workspaceActivationBenefitIcon" aria-hidden="true">
                  <Icon name="check-circle-1-light" />
                </span>
                <span>{t(`workspaceActivation.author.benefits.${benefit}`)}</span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="workspaceActivationAction"
          onClick={() => setConfirmationOpen(true)}
        >
          {t(`workspaceActivation.${key}.action`)}
        </button>
      </section>

      {confirmationOpen && (
        <ResponsiveConfirmationDialog
          title={t(`workspaceActivation.${key}.confirmTitle`)}
          description={<p>{t(`workspaceActivation.${key}.confirmLead`)}</p>}
          cancelLabel={t('common.cancel')}
          confirmLabel={t(`workspaceActivation.${key}.confirmAction`)}
          busyLabel={t('common.saving')}
          closeLabel={t('common.close')}
          busy={busy}
          danger={false}
          onClose={() => setConfirmationOpen(false)}
          onConfirm={activate}
        />
      )}
    </>
  )
}
