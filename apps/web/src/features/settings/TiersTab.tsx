import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { apiQuery } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { QuotaKey, UserTierPayload } from '../../types'
import { formatBytes } from '../admin/utils'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileViewport } from '../shared/useMobileViewport'

const byteQuotas = new Set<QuotaKey>(['storage_bytes', 'image_upload_bytes'])
const perDocumentQuotas = new Set<QuotaKey>(['drafts_per_document', 'revisions_per_document'])
const progressQuotas = new Set<QuotaKey>([
  'oneshots',
  'books',
  'series',
  'storage_bytes',
  'editor_invites',
])
const quotaIcons: Record<QuotaKey, IconName> = {
  oneshots: 'document-light',
  books: 'books-light',
  series: 'library-light',
  drafts_per_document: 'file-document-light',
  revisions_per_document: 'history-light',
  storage_bytes: 'box-light',
  image_upload_bytes: 'gallery-light',
  editor_invites: 'users-light',
}

export function TiersTab() {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const [payload, setPayload] = useState<UserTierPayload | null>(null)
  const [error, setError] = useState('')
  const [showPromotion, setShowPromotion] = useState(false)
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  )

  useEffect(() => {
    let active = true
    void apiQuery<{ tier: UserTierPayload }>('/api/auth/tier/', {
      onBackgroundUpdate: (next) => {
        if (active) setPayload(next.tier)
      },
    })
      .then((next) => {
        if (active) {
          setPayload(next.tier)
          setError('')
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : i18n.t('settings.tiersLoadFailed'),
          )
        }
      })
    return () => {
      active = false
    }
  }, [i18n])

  function formatQuotaValue(key: QuotaKey, value: number) {
    if (byteQuotas.has(key)) {
      return formatBytes(value, i18n.resolvedLanguage ?? 'en')
    }
    return numberFormatter.format(value)
  }

  if (error) {
    return (
      <section className="settingsPanel">
        <h2>{t('settings.tiers')}</h2>
        <div className="notice error">{error}</div>
      </section>
    )
  }

  if (!payload) {
    return (
      <section className="settingsPanel tiersLoadingPanel" aria-busy="true">
        <h2>{t('settings.tiers')}</h2>
        <div className="settingsLoadingState" role="status" aria-label={t('settings.loadingTiers')}>
          <TadpoleIcon />
        </div>
      </section>
    )
  }

  const usageQuotas = payload.quotas.filter((quota) => !perDocumentQuotas.has(quota.key))
  const documentLimitQuotas = payload.quotas.filter((quota) => perDocumentQuotas.has(quota.key))
  const tierName = t(`tiers.names.${payload.tier}`)
  const automaticPromotion = payload.automaticPromotion

  function renderMobileQuotaValue(quota: UserTierPayload['quotas'][number]) {
    return progressQuotas.has(quota.key)
      ? t('tiers.usageValue', {
        used: formatQuotaValue(quota.key, quota.used),
        limit: formatQuotaValue(quota.key, quota.limit),
      })
      : formatQuotaValue(quota.key, quota.limit)
  }

  function renderMobileQuotaRow(
    quota: UserTierPayload['quotas'][number],
    value: string,
  ) {
    return (
      <div className="accountMobileSettingRow tierMobileQuotaRow" key={quota.key}>
        <span className="accountMobileSettingIcon"><Icon name={quotaIcons[quota.key]} /></span>
        <span className="accountMobileSettingCopy">
          <strong>{t(`tiers.quotas.${quota.key}`)}</strong>
          <small>{value}</small>
        </span>
      </div>
    )
  }

  function renderPromotionContent(close: () => void, mobile = false) {
    if (!automaticPromotion) return null
    const promotion = automaticPromotion

    return (
      <div className={`${mobile ? 'tierPromotionMobileContent' : 'standardDialogSection'} tierPromotionContent`}>
        {mobile && <p className="tierPromotionMobileLead">{t('tiers.promotion.subtitle')}</p>}
        <div className="tierPromotionMetric">
          <div>
            <strong>{t('tiers.promotion.activeHeading')}</strong>
            <span>{t('tiers.promotion.progressValue', {
              count: promotion.requiredDays,
              active: numberFormatter.format(promotion.activeDays),
              required: numberFormatter.format(promotion.requiredDays),
            })}</span>
          </div>
          <div
            className="tierPromotionTrack"
            role="progressbar"
            aria-label={t('tiers.promotion.progressLabel')}
            aria-valuemin={0}
            aria-valuemax={promotion.requiredDays}
            aria-valuenow={Math.min(promotion.activeDays, promotion.requiredDays)}
          >
            <span style={{ width: `${quotaFillPercent(
              promotion.activeDays,
              promotion.requiredDays,
            )}%` }} />
          </div>
        </div>
        <div className="tierPromotionCounted">
          <h3>{t('tiers.promotion.countedHeading')}</h3>
          <ul>
            <li><Icon name="pen-light" /><span>{t('tiers.promotion.countedManuscript')}</span></li>
            <li><Icon name="notes-light" /><span>{t('tiers.promotion.countedNotes')}</span></li>
            <li><Icon name="notebook-light" /><span>{t('tiers.promotion.countedGlossary')}</span></li>
          </ul>
        </div>
        <p className="tierPromotionClosing">
          <Icon name="star-light" />
          <span>{t('tiers.promotion.closing')}</span>
        </p>
        <footer className={mobile ? 'tierPromotionMobileFooter' : 'standardDialogFooter'}>
          <button type="button" className="dialogSubmit spaceButton" onClick={close}>
            {t('tiers.promotion.understood')}
          </button>
        </footer>
      </div>
    )
  }

  return (
    <div className="settingsStack tiersStack">
      {!isMobile && <><section className="settingsPanel tiersPanel">
        <div className="tierCurrentHeader">
          <div className="tierSectionHeader">
            <Icon name="crown-minimalistic-light" />
            <h3>{t('settings.currentTierHeading', { tier: '' })}<span className="tierHeadingValue">{tierName}</span></h3>
          </div>
          {automaticPromotion && (
            <button type="button" className="tierPromotionButton spaceButton" onClick={() => setShowPromotion(true)}>
              {t('tiers.promotion.open')}
            </button>
          )}
        </div>
      </section>

      <section className="settingsPanel tiersPanel">
        <div className="tierSectionHeader">
          <Icon name="traffic-light" />
          <h3>{t('settings.quotasAndUsage')}</h3>
        </div>
        <div className="quotaList">
          {usageQuotas.map((quota) => {
            const hasProgress = progressQuotas.has(quota.key)
            const ratio = hasProgress ? quotaFillPercent(quota.used, quota.limit) : 0
            return (
              <div className={`quotaRow ${hasProgress ? '' : 'limitOnly'}`} key={quota.key}>
                <span className="quotaIcon">
                  <Icon name={quotaIcons[quota.key]} />
                </span>
                <strong>{t(`tiers.quotas.${quota.key}`)}</strong>
                {hasProgress && (
                  <i className="quotaTrack" aria-hidden="true">
                    <b style={{ width: `${ratio}%` }} />
                  </i>
                )}
                <span className="quotaValue">
                  {hasProgress
                    ? t('tiers.usageValue', {
                      used: formatQuotaValue(quota.key, quota.used),
                      limit: formatQuotaValue(quota.key, quota.limit),
                    })
                    : formatQuotaValue(quota.key, quota.limit)}
                </span>
              </div>
            )
          })}
        </div>
      </section>

      <section className="settingsPanel tiersPanel">
        <div className="tierSectionHeader">
          <Icon name="layers-minimalistic-light" />
          <h3>{t('settings.documentLimits')}</h3>
        </div>
        <div className="documentLimitGrid">
          {documentLimitQuotas.map((quota) => (
            <div className="documentLimitCard" key={quota.key}>
              <span className="quotaIcon">
                <Icon name={quotaIcons[quota.key]} />
              </span>
              <div>
                <strong>{t(`tiers.quotas.${quota.key}`)}</strong>
                <span>
                  {t('tiers.perDocumentLimit', {
                    limit: formatQuotaValue(quota.key, quota.limit),
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
      </>}

      {isMobile && (
        <div className="tiersMobileLayout">
          <section className="accountMobileProfile tierMobileProfile">
            {automaticPromotion ? (
              <button
                type="button"
                className="tierMobileCrown spaceButton"
                title={t('tiers.promotion.open')}
                aria-label={t('tiers.promotion.open')}
                onClick={() => setShowPromotion(true)}
              >
                <Icon name="crown-minimalistic-light" />
                <span className="tierMobilePromotionBadge" aria-hidden="true">
                  <Icon name="round-double-alt-arrow-up-light" />
                </span>
              </button>
            ) : (
              <span className="tierMobileCrown" aria-hidden="true">
                <Icon name="crown-minimalistic-light" />
              </span>
            )}
            <strong className="tierMobileName">{tierName}</strong>
          </section>

          <section className="tierMobileSection">
            <h2>{t('settings.quotasAndUsage')}</h2>
            <div className="accountMobileSettingsList tierMobileQuotaList">
              {usageQuotas.map((quota) => renderMobileQuotaRow(
                quota,
                renderMobileQuotaValue(quota),
              ))}
            </div>
          </section>

          <section className="tierMobileSection">
            <h2>{t('settings.documentLimits')}</h2>
            <div className="accountMobileSettingsList tierMobileQuotaList">
              {documentLimitQuotas.map((quota) => renderMobileQuotaRow(
                quota,
                t('tiers.perDocumentLimit', {
                  limit: formatQuotaValue(quota.key, quota.limit),
                }),
              ))}
            </div>
          </section>
        </div>
      )}

      {showPromotion && automaticPromotion && isMobile && (
        <MobileSettingsSheet
          title={t('tiers.promotion.title')}
          onClose={() => setShowPromotion(false)}
        >
          {(close) => renderPromotionContent(close, true)}
        </MobileSettingsSheet>
      )}

      {showPromotion && automaticPromotion && !isMobile && (
        <ActionDialog
          title={t('tiers.promotion.title')}
          description={t('tiers.promotion.subtitle')}
          closeLabel={t('tiers.promotion.close')}
          className="tierPromotionDialog"
          variant="structured"
          onClose={() => setShowPromotion(false)}
        >
          {renderPromotionContent(() => setShowPromotion(false))}
        </ActionDialog>
      )}
    </div>
  )
}

function quotaFillPercent(used: number, limit: number) {
  if (used <= 0) return 0
  if (limit <= 0) return 100
  return Math.min(100, Math.max(2, (used / limit) * 100))
}
