import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import type { AdminTierQuota, AdminTierQuotasPayload } from '../../types'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { formatBytes } from './utils'

type Draft = Record<string, string>

type TierQuotasPanelProps = {
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
  mobile?: boolean
}

const byteQuotaKeys = new Set(['storage_bytes', 'image_upload_bytes'])

function draftKey(tier: string, key: string) {
  return `${tier}.${key}`
}

function initialDraft(payload: AdminTierQuotasPayload): Draft {
  return Object.fromEntries(
    payload.tiers.flatMap((tier) =>
      tier.quotas.map((quota) => [draftKey(tier.id, quota.key), String(quota.value)]),
    ),
  )
}

function quotaDisplayValue(quota: AdminTierQuota, locale: string | undefined) {
  if (byteQuotaKeys.has(quota.key)) {
    return formatBytes(quota.value, locale ?? 'en')
  }
  return new Intl.NumberFormat(locale).format(quota.value)
}

export function TierQuotasPanel({ onSensitiveAction, mobile = false }: TierQuotasPanelProps) {
  const { t, i18n } = useTranslation()
  const [payload, setPayload] = useState<AdminTierQuotasPayload | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [expandedTier, setExpandedTier] = useState<string | null>(null)

  const applyPayload = useCallback((next: AdminTierQuotasPayload) => {
    setPayload(next)
    setDraft(initialDraft(next))
    setEditingKey(null)
  }, [])

  useEffect(() => {
    let active = true
    void apiRequest<AdminTierQuotasPayload>('/api/admin/tier-quotas/')
      .then((next) => {
        if (active) applyPayload(next)
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error ? loadError.message : t('adminTiers.loadFailed'),
          )
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [applyPayload, t])

  function updateDraft(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: value }))
    setMessage('')
  }

  function startEditing(key: string, value: number) {
    if (!payload || submitting) return
    setError('')
    setMessage('')
    setDraft((current) => ({ ...current, [key]: String(value) }))
    setEditingKey(key)
  }

  function cancelEditing(key: string, value: number) {
    setDraft((current) => ({ ...current, [key]: String(value) }))
    setEditingKey(null)
  }

  async function save(tier: string, quota: AdminTierQuota) {
    const key = draftKey(tier, quota.key)
    if (!payload || submitting) return
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      const next = await onSensitiveAction(() =>
        apiRequest<AdminTierQuotasPayload>('/api/admin/tier-quotas/', {
          method: 'PATCH',
          body: JSON.stringify({
            values: [{
              tier,
              key: quota.key,
              value: Number(draft[key] ?? quota.value),
            }],
          }),
        }),
      )
      applyPayload(next)
      setMessage(t('adminTiers.saved'))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('adminTiers.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function reset(tier: string, quota: AdminTierQuota) {
    if (!payload || submitting) return
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      const next = await onSensitiveAction(() =>
        apiRequest<AdminTierQuotasPayload>('/api/admin/tier-quotas/', {
          method: 'PATCH',
          body: JSON.stringify({ reset: [{ tier, key: quota.key }] }),
        }),
      )
      applyPayload(next)
      setMessage(t('adminTiers.resetDone'))
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : t('adminTiers.resetFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  function quotaLabel(quota: AdminTierQuota) {
    return t(`tiers.quotas.${quota.key}`)
  }

  if (loading) {
    if (mobile) {
      return <TadpoleLoadingState className="adminSettingsMobileLoading" label={t('adminTiers.loading')} />
    }
    return (
      <section className="panel adminSettingsPanel adminSettingsSection">
        <div className="adminSettingsSectionHeader">
          <Icon name="crown-minimalistic-light" />
          <h2>{t('adminTiers.title')}</h2>
        </div>
        <TadpoleLoadingState className="adminSettingsLoading" label={t('adminTiers.loading')} />
      </section>
    )
  }

  if (!payload) {
    if (mobile) {
      return error ? <div className="notice error">{error}</div> : null
    }
    return (
      <section className="panel adminSettingsPanel adminSettingsSection">
        <div className="adminSettingsSectionHeader">
          <Icon name="crown-minimalistic-light" />
          <h2>{t('adminTiers.title')}</h2>
        </div>
        {error && <div className="notice error">{error}</div>}
      </section>
    )
  }

  if (mobile) {
    const activeQuota = payload.tiers.flatMap((tier) =>
      tier.quotas.map((quota) => ({ tier, quota, key: draftKey(tier.id, quota.key) })),
    ).find((item) => item.key === editingKey)

    return (
      <div className="adminTierQuotasMobile">
        {error && <div className="notice error">{error}</div>}
        {message && <div className="notice success">{message}</div>}
        <div className="adminSettingsMobileMenu adminTierQuotaMobileMenu">
          {payload.tiers.map((tier) => {
            const expanded = expandedTier === tier.id
            return (
              <div className={`adminTierQuotaMobileGroup ${expanded ? 'expanded' : ''}`} key={tier.id}>
                <button
                  type="button"
                  className="adminSettingsMobileRow adminTierQuotaTierRow withoutIcon spaceButton"
                  aria-expanded={expanded}
                  onClick={() => setExpandedTier(expanded ? null : tier.id)}
                >
                  <span className="adminSettingsMobileRowCopy">
                    <strong>{t(`tiers.names.${tier.id}`)}</strong>
                    <small>{t('adminTiers.mobileQuotaCount', { count: tier.quotas.length })}</small>
                  </span>
                  <Icon name={expanded ? 'arrow-up-2' : 'arrow-down-2'} />
                </button>
                {expanded && (
                  <div className="adminTierQuotaMobileItems">
                    {tier.quotas.map((quota) => {
                      const key = draftKey(tier.id, quota.key)
                      const label = quotaLabel(quota)
                      return (
                        <button
                          type="button"
                          className="adminSettingsMobileRow adminTierQuotaMobileRow spaceButton"
                          disabled={submitting}
                          onClick={() => startEditing(key, quota.value)}
                          key={quota.key}
                        >
                          <span className="adminSettingsMobileRowCopy">
                            <strong>{label}</strong>
                            <small>{quotaDisplayValue(quota, i18n.resolvedLanguage)}</small>
                          </span>
                          <Icon name="arrow-right-2" />
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {activeQuota && (
          <MobileSettingsSheet
            title={quotaLabel(activeQuota.quota)}
            busy={submitting}
            onClose={() => cancelEditing(activeQuota.key, activeQuota.quota.value)}
          >
            {(close) => (
              <form
                className="adminSettingsMobileSheetForm"
                onSubmit={(event) => {
                  event.preventDefault()
                  void save(activeQuota.tier.id, activeQuota.quota)
                }}
              >
                {error && <div className="notice error">{error}</div>}
                <input
                  type="number"
                  min={activeQuota.quota.minimum}
                  max={activeQuota.quota.maximum}
                  value={draft[activeQuota.key] ?? String(activeQuota.quota.value)}
                  disabled={submitting}
                  aria-label={quotaLabel(activeQuota.quota)}
                  onChange={(event) => updateDraft(activeQuota.key, event.target.value)}
                  autoFocus
                />
                <p className="adminSettingsMobileHint">
                  {t('adminTiers.mobileRange', {
                    minimum: activeQuota.quota.minimum,
                    maximum: activeQuota.quota.maximum,
                  })}
                </p>
                {activeQuota.quota.source === 'database' && (
                  <button
                    type="button"
                    className="adminSettingsMobileReset spaceButton"
                    disabled={submitting}
                    onClick={() => void reset(activeQuota.tier.id, activeQuota.quota)}
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
      </div>
    )
  }

  return (
    <section className="panel adminSettingsPanel adminTierQuotasPanel">
      <div className="adminSettingsSectionHeader">
        <Icon name="crown-minimalistic-light" />
        <h2>{t('adminTiers.title')}</h2>
      </div>
      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice success">{message}</div>}
      <div className="tierQuotaGrid">
        {payload.tiers.map((tier) => (
          <section className="tierQuotaGroup" key={tier.id}>
            <h3>{t(`tiers.names.${tier.id}`)}</h3>
            {tier.quotas.map((quota) => {
              const key = draftKey(tier.id, quota.key)
              const label = quotaLabel(quota)
              const isEditing = editingKey === key
              return (
                <div className="tierQuotaRow" key={quota.key}>
                  <strong className="tierQuotaLabel">{label}</strong>
                  {isEditing ? (
                    <form
                      className="tierQuotaEditForm"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void save(tier.id, quota)
                      }}
                    >
                      <input
                        type="number"
                        min={quota.minimum}
                        max={quota.maximum}
                        value={draft[key] ?? String(quota.value)}
                        disabled={submitting}
                        aria-label={label}
                        onChange={(event) => updateDraft(key, event.target.value)}
                      />
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
                        onClick={() => cancelEditing(key, quota.value)}
                      >
                        <Icon name="close-light" />
                      </button>
                    </form>
                  ) : (
                    <div className="tierQuotaValue">
                      <span>{quotaDisplayValue(quota, i18n.resolvedLanguage)}</span>
                      <button
                        type="button"
                        className="adminIconAction"
                        disabled={submitting}
                        title={t('adminTiers.editQuota', { quota: label })}
                        aria-label={t('adminTiers.editQuota', { quota: label })}
                        onClick={() => startEditing(key, quota.value)}
                      >
                        <Icon name="edit-light" />
                      </button>
                      {quota.source === 'database' && (
                        <button
                          type="button"
                          className="adminIconAction adminSettingResetAction"
                          disabled={submitting}
                          title={t('adminTiers.resetQuota', { quota: label })}
                          aria-label={t('adminTiers.resetQuota', { quota: label })}
                          onClick={() => void reset(tier.id, quota)}
                        >
                          <Icon name="restart-light" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        ))}
      </div>
    </section>
  )
}
