import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { AdminTierProgressionPayload } from '../../types'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'

type Props = {
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
  mobile?: boolean
}

type Draft = {
  enabled: boolean
  noviceToAuthorDays: string
  authorToBelieverDays: string
}

function draftFromPayload(payload: AdminTierProgressionPayload): Draft {
  return {
    enabled: payload.enabled,
    noviceToAuthorDays: String(payload.noviceToAuthorDays),
    authorToBelieverDays: String(payload.authorToBelieverDays),
  }
}

export function TierProgressionPanel({ onSensitiveAction, mobile = false }: Props) {
  const { t } = useTranslation()
  const [payload, setPayload] = useState<AdminTierProgressionPayload | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [mobileOpen, setMobileOpen] = useState(false)

  const applyPayload = useCallback((next: AdminTierProgressionPayload) => {
    setPayload(next)
    setDraft(draftFromPayload(next))
  }, [])

  useEffect(() => {
    let active = true
    void apiRequest<AdminTierProgressionPayload>('/api/admin/tier-progression/')
      .then((next) => {
        if (active) applyPayload(next)
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : t('adminTierProgression.loadFailed'))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [applyPayload, t])

  function errorMessage(saveError: unknown) {
    if (saveError instanceof ApiError) {
      return t(`adminTierProgression.errors.${saveError.code}`, { defaultValue: saveError.message })
    }
    return saveError instanceof Error ? saveError.message : t('adminTierProgression.saveFailed')
  }

  async function save() {
    if (!payload || !draft || submitting) return
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      const next = await onSensitiveAction(() =>
        apiRequest<AdminTierProgressionPayload>('/api/admin/tier-progression/', {
          method: 'PATCH',
          body: JSON.stringify({
            enabled: draft.enabled,
            noviceToAuthorDays: Number(draft.noviceToAuthorDays),
            authorToBelieverDays: Number(draft.authorToBelieverDays),
          }),
        }),
      )
      applyPayload(next)
      setConfirmDisable(false)
      setMobileOpen(false)
      setMessage(t('adminTierProgression.saved'))
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSubmitting(false)
    }
  }

  function submit() {
    if (payload?.enabled && draft && !draft.enabled) {
      if (mobile) setMobileOpen(false)
      setConfirmDisable(true)
      return
    }
    void save()
  }

  if (loading) {
    if (mobile) {
      return <TadpoleLoadingState className="adminSettingsMobileLoading" label={t('adminTierProgression.loading')} />
    }
    return (
      <section className="panel adminSettingsPanel adminSettingsSection">
        <div className="adminSettingsSectionHeader">
          <Icon name="crown-minimalistic-light" />
          <h2>{t('adminTierProgression.title')}</h2>
        </div>
        <TadpoleLoadingState className="adminSettingsLoading" label={t('adminTierProgression.loading')} />
      </section>
    )
  }

  if (!payload || !draft) {
    if (mobile) {
      return error ? <div className="notice error">{error}</div> : null
    }
    return (
      <section className="panel adminSettingsPanel adminSettingsSection">
        <div className="adminSettingsSectionHeader">
          <Icon name="crown-minimalistic-light" />
          <h2>{t('adminTierProgression.title')}</h2>
        </div>
        {error && <div className="notice error">{error}</div>}
      </section>
    )
  }

  if (mobile) {
    return (
      <>
        {error && <div className="notice error">{error}</div>}
        {message && <div className="notice success">{message}</div>}
        <div className="adminSettingsMobileMenu adminTierProgressionMobileMenu">
          <button
            type="button"
            className="adminSettingsMobileRow withoutIcon spaceButton"
            disabled={submitting}
            onClick={() => {
              setError('')
              setMessage('')
              setDraft(draftFromPayload(payload))
              setMobileOpen(true)
            }}
          >
            <span className="adminSettingsMobileRowCopy">
              <strong>{t('adminTierProgression.title')}</strong>
              <small>{t(payload.enabled ? 'common.enabled' : 'common.disabled')}</small>
            </span>
            <Icon name="arrow-right-2" />
          </button>
        </div>

        {mobileOpen && (
          <MobileSettingsSheet
            title={t('adminTierProgression.title')}
            busy={submitting}
            onClose={() => {
              if (submitting) return
              setDraft(draftFromPayload(payload))
              setMobileOpen(false)
            }}
          >
            {(close) => (
              <form
                className="adminSettingsMobileSheetForm adminTierProgressionMobileForm"
                onSubmit={(event) => {
                  event.preventDefault()
                  submit()
                }}
              >
                {error && <div className="notice error">{error}</div>}
                <div className="tierProgressionToggle">
                  <p className="adminTierProgressionMobileLead">
                    {t('adminTierProgression.enabledHint')}
                  </p>
                  <div className="tierProgressionSwitch">
                    <span>{t(draft.enabled ? 'common.enabled' : 'common.disabled')}</span>
                    <button
                      type="button"
                      role="switch"
                      className="securityToggle"
                      aria-checked={draft.enabled}
                      aria-label={t('adminTierProgression.enabledLabel')}
                      disabled={submitting}
                      onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                    >
                      <span />
                    </button>
                  </div>
                </div>
                <label>
                  <span>{t('adminTierProgression.noviceToAuthor')}</span>
                  <input
                    type="number"
                    min={payload.minimumDays}
                    max={payload.maximumDays}
                    value={draft.noviceToAuthorDays}
                    disabled={submitting}
                    onChange={(event) => setDraft({ ...draft, noviceToAuthorDays: event.target.value })}
                  />
                </label>
                <label>
                  <span>{t('adminTierProgression.authorToBeliever')}</span>
                  <input
                    type="number"
                    min={payload.minimumDays}
                    max={payload.maximumDays}
                    value={draft.authorToBelieverDays}
                    disabled={submitting}
                    onChange={(event) => setDraft({ ...draft, authorToBelieverDays: event.target.value })}
                  />
                </label>
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

        {confirmDisable && (
          <MobileSettingsSheet
            title={t('adminTierProgression.disableTitle')}
            onClose={() => {
              setConfirmDisable(false)
              setMobileOpen(true)
            }}
            busy={submitting}
            role="alertdialog"
          >
            {(close) => <div className="standardDialogSection adminTierProgressionMobileConfirm">
              <p>{t('adminTierProgression.disableWarning')}</p>
              <footer className="standardDialogFooter">
                <button type="button" className="dialogCancel spaceButton" disabled={submitting} onClick={close}>
                  {t('common.cancel')}
                </button>
                <button type="button" className="dialogSubmit danger spaceButton" disabled={submitting} onClick={() => void save()}>
                  {t('adminTierProgression.disableAction')}
                </button>
              </footer>
            </div>}
          </MobileSettingsSheet>
        )}
      </>
    )
  }

  return (
    <>
      <section className="panel adminSettingsPanel adminTierProgressionPanel">
        <div className="adminSettingsSectionHeader">
          <Icon name="crown-minimalistic-light" />
          <h2>{t('adminTierProgression.title')}</h2>
        </div>
        <p className="adminSettingsSectionLead">{t('adminTierProgression.lead')}</p>
        {error && <div className="notice error">{error}</div>}
        {message && <div className="notice success">{message}</div>}
        <form
          className="tierProgressionForm"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="tierProgressionToggle">
            <span>
              <strong>{t('adminTierProgression.enabledLabel')}</strong>
              <small>{t('adminTierProgression.enabledHint')}</small>
            </span>
            <div className="tierProgressionSwitch">
              <span>{t(draft.enabled ? 'common.enabled' : 'common.disabled')}</span>
              <button
                type="button"
                role="switch"
                className="securityToggle"
                aria-checked={draft.enabled}
                aria-label={t('adminTierProgression.enabledLabel')}
                disabled={submitting}
                onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
              >
                <span />
              </button>
            </div>
          </div>
          <div className="tierProgressionThresholds">
            <label>
              <span>{t('adminTierProgression.noviceToAuthor')}</span>
              <input
                type="number"
                min={payload.minimumDays}
                max={payload.maximumDays}
                value={draft.noviceToAuthorDays}
                disabled={submitting}
                onChange={(event) => setDraft({ ...draft, noviceToAuthorDays: event.target.value })}
              />
            </label>
            <label>
              <span>{t('adminTierProgression.authorToBeliever')}</span>
              <input
                type="number"
                min={payload.minimumDays}
                max={payload.maximumDays}
                value={draft.authorToBelieverDays}
                disabled={submitting}
                onChange={(event) => setDraft({ ...draft, authorToBelieverDays: event.target.value })}
              />
            </label>
          </div>
          <div className="tierProgressionActions">
            <button type="submit" className="spaceButton" disabled={submitting}>
              {submitting ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      </section>

      {confirmDisable && (
        <ActionDialog
          title={t('adminTierProgression.disableTitle')}
          closeLabel={t('common.close')}
          onClose={() => setConfirmDisable(false)}
          variant="structured"
          busy={submitting}
          role="alertdialog"
        >
          <div className="standardDialogSection">
            <p>{t('adminTierProgression.disableWarning')}</p>
            <footer className="standardDialogFooter">
              <button type="button" className="dialogCancel spaceButton" disabled={submitting} onClick={() => setConfirmDisable(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="dialogSubmit danger spaceButton" disabled={submitting} onClick={() => void save()}>
                {t('adminTierProgression.disableAction')}
              </button>
            </footer>
          </div>
        </ActionDialog>
      )}
    </>
  )
}
