import { useCallback, useEffect, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type {
  AdminNotificationCampaign,
  NotificationItem,
  NotificationKind,
  TierId,
} from '../../types'
import { SafeNotificationMarkdown } from '../notifications/SafeNotificationMarkdown'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import '../shared/MobileChoiceList.css'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'

const kinds: NotificationKind[] = [
  'service.password_stale', 'service.two_factor_missing', 'service.review_share_expired',
  'service.export_expiring', 'service.storage_near_limit', 'service.tier_changed', 'service.new_login',
  'service.account_export_ready',
  'service.audio_transcription_ready', 'service.audio_transcription_failed',
  'service.editor_manuscript_access_granted', 'service.editor_manuscript_access_revoked',
]
const emailKinds = new Set<NotificationKind>([
  'service.password_stale', 'service.two_factor_missing', 'service.storage_near_limit',
  'service.tier_changed', 'service.new_login', 'service.account_export_ready',
  'service.editor_manuscript_access_granted', 'service.editor_manuscript_access_revoked',
])
const tiers: TierId[] = ['novice', 'author', 'believer', 'god']
const CAMPAIGN_STATUS_POLL_INTERVAL_MS = 1_000
const CAMPAIGN_STATUS_POLL_LIMIT = 60

function campaignDeliveryIsPending(campaign: AdminNotificationCampaign) {
  return campaign.status === 'scheduled' || campaign.status === 'processing'
}

type Props = {
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
  onMessage: (message: string) => void
  onError: (message: string) => void
}

export function NotificationsTestTab({ onSensitiveAction, onMessage, onError }: Props) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const [kind, setKind] = useState<NotificationKind>('service.password_stale')
  const [channel, setChannel] = useState<'panel' | 'panel_email'>('panel')
  const [sendingTest, setSendingTest] = useState(false)
  const [campaigns, setCampaigns] = useState<AdminNotificationCampaign[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [selectedTiers, setSelectedTiers] = useState<TierId[]>([])
  const [scheduledFor, setScheduledFor] = useState('')
  const [busy, setBusy] = useState(false)
  const [campaignPollingId, setCampaignPollingId] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<'root' | 'campaigns'>('root')
  const [mobileMenuDirection, setMobileMenuDirection] = useState<'forward' | 'back'>('forward')
  const [mobileTestOpen, setMobileTestOpen] = useState(false)
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false)

  const loadCampaigns = useCallback(async () => {
    const payload = await apiRequest<{ items: AdminNotificationCampaign[] }>(
      '/api/admin/notifications/campaigns/',
    )
    setCampaigns(payload.items)
    return payload.items
  }, [])

  useEffect(() => {
    let active = true
    void apiRequest<{ items: AdminNotificationCampaign[] }>(
      '/api/admin/notifications/campaigns/',
    ).then((payload) => {
      if (active) setCampaigns(payload.items)
    }).catch((value) => {
      if (active) onError(value instanceof Error ? value.message : t('admin.campaignLoadFailed'))
    })
    return () => { active = false }
  }, [onError, t])

  function editCampaign(campaign: AdminNotificationCampaign) {
    setSelectedId(campaign.id)
    setTitle(campaign.title)
    setBody(campaign.body)
    setSelectedTiers(campaign.tiers)
    setScheduledFor(campaign.scheduledFor
      ? new Date(campaign.scheduledFor).toISOString().slice(0, 16)
      : '')
  }

  function newCampaign() {
    setSelectedId(null)
    setTitle('')
    setBody('')
    setSelectedTiers([])
    setScheduledFor('')
  }

  const selected = campaigns.find((item) => item.id === selectedId) ?? null
  const editable = !selected || selected.status === 'draft' || selected.status === 'scheduled'

  useEffect(() => {
    if (!campaignPollingId) return
    const campaignId = campaignPollingId
    let active = true
    let attempts = 0
    let timer: number | null = null

    function scheduleRefresh() {
      timer = window.setTimeout(async () => {
        attempts += 1
        try {
          const payload = await apiRequest<{ campaign: AdminNotificationCampaign }>(
            `/api/admin/notifications/campaigns/${campaignId}/`,
          )
          if (!active) return
          setCampaigns((current) => current.map((campaign) => (
            campaign.id === payload.campaign.id ? payload.campaign : campaign
          )))
          if (campaignDeliveryIsPending(payload.campaign) && attempts < CAMPAIGN_STATUS_POLL_LIMIT) {
            scheduleRefresh()
          } else {
            setCampaignPollingId((current) => current === campaignId ? null : current)
          }
        } catch {
          if (active && attempts < CAMPAIGN_STATUS_POLL_LIMIT) {
            scheduleRefresh()
          } else if (active) {
            setCampaignPollingId((current) => current === campaignId ? null : current)
          }
        }
      }, CAMPAIGN_STATUS_POLL_INTERVAL_MS)
    }

    scheduleRefresh()
    return () => {
      active = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [campaignPollingId])

  async function saveCampaign() {
    setBusy(true)
    try {
      const endpoint = selectedId
        ? `/api/admin/notifications/campaigns/${selectedId}/`
        : '/api/admin/notifications/campaigns/'
      const payload = await apiRequest<{ campaign: AdminNotificationCampaign }>(endpoint, {
        method: selectedId ? 'PATCH' : 'POST',
        body: JSON.stringify({ title, body, tiers: selectedTiers }),
      })
      await loadCampaigns()
      editCampaign(payload.campaign)
      onMessage(t('admin.campaignSaved'))
    } catch (value) {
      onError(value instanceof Error ? value.message : t('admin.campaignSaveFailed'))
    } finally { setBusy(false) }
  }

  async function campaignAction(action: 'schedule' | 'send' | 'cancel' | 'retry') {
    if (!selectedId) return
    setBusy(true)
    try {
      const request = () => apiRequest<{ campaign: AdminNotificationCampaign }>(
        `/api/admin/notifications/campaigns/${selectedId}/${action}/`,
        {
          method: 'POST',
          body: action === 'schedule'
            ? JSON.stringify({ scheduledFor: new Date(scheduledFor).toISOString() })
            : '{}',
        },
      )
      const payload = await onSensitiveAction(request)
      setCampaignPollingId(
        action === 'send' || action === 'retry' ? payload.campaign.id : null,
      )
      const refreshed = await loadCampaigns()
      editCampaign(refreshed.find((campaign) => campaign.id === payload.campaign.id) ?? payload.campaign)
      onMessage(t(`admin.campaignAction_${action}`))
    } catch (value) {
      onError(value instanceof Error ? value.message : t('admin.campaignActionFailed'))
    } finally { setBusy(false) }
  }

  async function sendTest() {
    setSendingTest(true)
    try {
      await apiRequest<{ notification: NotificationItem }>('/api/admin/notifications/test/', {
        method: 'POST', body: JSON.stringify({ kind, channel }),
      })
      onMessage(t('admin.notificationTestSent'))
      return true
    } catch (value) {
      onError(value instanceof Error ? value.message : t('admin.notificationTestFailed'))
      return false
    } finally { setSendingTest(false) }
  }

  function openNewMobileCampaign() {
    newCampaign()
    setMobileEditorOpen(true)
  }

  function openMobileCampaign(campaign: AdminNotificationCampaign) {
    editCampaign(campaign)
    setMobileEditorOpen(true)
  }

  if (isMobile) {
    const dateTimeFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })

    return (
      <div className="adminNotificationsMobileLayout">
        {mobileView === 'root' ? (
          <nav className={`adminSettingsMobileMenu adminNotificationsMobileMenu mobileMenuTransitionPane ${mobileMenuDirection}`.trim()} aria-label={t('admin.notifications')} key="root">
            <button type="button" className="adminSettingsMobileRow spaceButton" onClick={() => setMobileTestOpen(true)}>
              <span className="adminSettingsMobileRowIcon"><Icon name="bell-light" /></span>
              <span className="adminSettingsMobileRowCopy"><strong>{t('admin.notificationTestTitle')}</strong></span>
              <Icon name="arrow-right-2" />
            </button>
            <button type="button" className="adminSettingsMobileRow spaceButton" onClick={() => {
              setMobileMenuDirection('forward')
              setMobileView('campaigns')
            }}>
              <span className="adminSettingsMobileRowIcon"><Icon name="mailbox-light" /></span>
              <span className="adminSettingsMobileRowCopy">
                <strong>{t('admin.campaignsTitle')}</strong>
                <small>{t('admin.campaignHistoryCount', { count: campaigns.length })}</small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
          </nav>
        ) : (
          <div className={`adminNotificationsMobileCampaigns mobileMenuTransitionPane ${mobileMenuDirection}`.trim()} key="campaigns">
            <nav className="adminSettingsMobileMenu adminNotificationsMobileMenu adminNotificationsMobileBackMenu" aria-label={t('admin.campaignsTitle')}>
              <button type="button" className="adminSettingsMobileRow adminSettingsMobileBackRow spaceButton" onClick={() => {
                setMobileMenuDirection('back')
                setMobileView('root')
              }}>
                <span className="adminSettingsMobileRowIcon"><Icon name="arrow-left-1" /></span>
                <span className="adminSettingsMobileRowCopy"><strong>{t('admin.backToNotifications')}</strong></span>
                <Icon name="arrow-right-2" />
              </button>
            </nav>
            <nav className="adminSettingsMobileMenu adminNotificationsMobileMenu adminNotificationsMobileCreateMenu" aria-label={t('admin.campaignNew')}>
              <button type="button" className="adminSettingsMobileRow spaceButton" onClick={openNewMobileCampaign}>
                <span className="adminSettingsMobileRowIcon"><Icon name="sign-plus-light" /></span>
                <span className="adminSettingsMobileRowCopy"><strong>{t('admin.campaignNew')}</strong></span>
                <Icon name="arrow-right-2" />
              </button>
            </nav>

            <section className="adminNotificationsMobileHistory" aria-label={t('admin.campaignHistory')}>
              {campaigns.length === 0 ? (
                <div className="adminNotificationsMobileEmpty">
                  <Icon name="mailbox-light" />
                  <span>{t('admin.campaignsEmpty')}</span>
                </div>
              ) : campaigns.map((campaign) => (
                <button
                  type="button"
                  className="adminNotificationsMobileHistoryRow spaceButton"
                  key={campaign.id}
                  onClick={() => openMobileCampaign(campaign)}
                >
                  <span>
                    <strong>{campaign.title}</strong>
                    <small>{dateTimeFormatter.format(new Date(campaign.updatedAt))}</small>
                  </span>
                  <span className={`adminNotificationsMobileCampaignStatus ${campaign.status}`}>
                    {t(`admin.campaignStatus_${campaign.status}`)}
                  </span>
                </button>
              ))}
            </section>
          </div>
        )}

        {mobileTestOpen && (
          <MobileSettingsSheet title={t('admin.notificationTestTitle')} busy={sendingTest} onClose={() => setMobileTestOpen(false)}>
            {(close) => (
              <form
                className="adminNotificationTestMobileForm"
                onSubmit={(event) => {
                  event.preventDefault()
                  void sendTest().then((sent) => { if (sent) close() })
                }}
              >
                <label>
                  <span>{t('admin.notificationKind')}</span>
                  <CustomSelect value={kind} onChange={(event) => {
                    const value = event.target.value as NotificationKind
                    setKind(value)
                    if (!emailKinds.has(value)) setChannel('panel')
                  }}>
                    {kinds.map((value) => <option key={value} value={value}>{t(`notifications.kinds.${value.replaceAll('.', '_')}.title`)}</option>)}
                  </CustomSelect>
                </label>
                <label>
                  <span>{t('admin.notificationChannel')}</span>
                  <CustomSelect value={channel} onChange={(event) => setChannel(event.target.value as 'panel' | 'panel_email')}>
                    <option value="panel">{t('admin.notificationChannelPanel')}</option>
                    {emailKinds.has(kind) && <option value="panel_email">{t('admin.notificationChannelPanelEmail')}</option>}
                  </CustomSelect>
                </label>
                <div className="adminNotificationTestMobileActions">
                  <button type="button" className="secondary spaceButton" onClick={close}>{t('common.cancel')}</button>
                  <button type="submit" className="spaceButton" disabled={sendingTest}>
                    {t(sendingTest ? 'admin.sendingNotificationTest' : 'admin.sendNotificationTest')}
                  </button>
                </div>
              </form>
            )}
          </MobileSettingsSheet>
        )}

        {mobileEditorOpen && (
          <MobileCampaignEditor
            selected={selected}
            title={title}
            body={body}
            selectedTiers={selectedTiers}
            scheduledFor={scheduledFor}
            editable={editable}
            busy={busy}
            onTitleChange={setTitle}
            onBodyChange={setBody}
            onTiersChange={setSelectedTiers}
            onScheduledForChange={setScheduledFor}
            onSave={saveCampaign}
            onAction={campaignAction}
            onClose={() => setMobileEditorOpen(false)}
          />
        )}
      </div>
    )
  }

  return <div className="adminNotificationsContent">
    <section className="panel adminSettingsPanel adminSettingsSection adminNotificationTest">
      <div className="adminSettingsSectionHeader"><Icon name="bell-light" /><h2>{t('admin.notificationTestTitle')}</h2></div>
      <div className="adminSettingsGrid">
        <label className="adminNotificationSettingRow"><span>{t('admin.notificationKind')}</span><CustomSelect value={kind} onChange={(event) => { const value = event.target.value as NotificationKind; setKind(value); if (!emailKinds.has(value)) setChannel('panel') }}>{kinds.map((value) => <option key={value} value={value}>{t(`notifications.kinds.${value.replaceAll('.', '_')}.title`)}</option>)}</CustomSelect></label>
        <label className="adminNotificationSettingRow"><span>{t('admin.notificationChannel')}</span><CustomSelect value={channel} onChange={(event) => setChannel(event.target.value as 'panel' | 'panel_email')}><option value="panel">{t('admin.notificationChannelPanel')}</option>{emailKinds.has(kind) && <option value="panel_email">{t('admin.notificationChannelPanelEmail')}</option>}</CustomSelect></label>
      </div>
      <button type="button" className="adminUsersApplyButton spaceButton" disabled={sendingTest} onClick={() => void sendTest()}>{t(sendingTest ? 'admin.sendingNotificationTest' : 'admin.sendNotificationTest')}</button>
    </section>

    <section className="panel adminSettingsPanel adminSettingsSection adminCampaignPanel">
      <div className="adminSettingsSectionHeader"><Icon name="mailbox-light" /><h2>{t('admin.campaignsTitle')}</h2><button type="button" className="spaceButton adminUsersResetButton adminCampaignNew" onClick={newCampaign}><Icon name="sign-plus-light" />{t('admin.campaignNew')}</button></div>
      <div className="adminCampaignLayout">
        <div className="adminCampaignList">
          {campaigns.length === 0 && <p>{t('admin.campaignsEmpty')}</p>}
          {campaigns.map((campaign) => <button type="button" className={`spaceButton ${campaign.id === selectedId ? 'active' : ''}`} key={campaign.id} onClick={() => editCampaign(campaign)}><strong>{campaign.title}</strong><span>{t(`admin.campaignStatus_${campaign.status}`)}</span><small>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(campaign.updatedAt))}</small></button>)}
        </div>
        <div className="adminCampaignEditor">
          <label>{t('admin.campaignTitle')}<input value={title} maxLength={120} disabled={!editable || busy} onChange={(event) => setTitle(event.target.value)} /><small>{title.length}/120</small></label>
          <label>{t('admin.campaignBody')}<textarea value={body} maxLength={4000} rows={10} disabled={!editable || busy} onChange={(event) => setBody(event.target.value)} /><small>{body.length}/4000</small></label>
          <fieldset disabled={!editable || busy}><legend>{t('admin.campaignAudience')}</legend><p>{t('admin.campaignAudienceAllHint')}</p><div>{tiers.map((tier) => <label key={tier}><input type="checkbox" checked={selectedTiers.includes(tier)} onChange={() => setSelectedTiers((current) => current.includes(tier) ? current.filter((item) => item !== tier) : [...current, tier])} />{t(`tiers.names.${tier}`)}</label>)}</div></fieldset>
          <div className="adminCampaignPreview"><strong>{title || t('admin.campaignPreviewTitle')}</strong><SafeNotificationMarkdown source={body || t('admin.campaignPreviewEmpty')} /></div>
          {selected && <p className="adminCampaignCounts">{t('admin.campaignCounts', { recipients: selected.recipientCount, sent: selected.sentCount, failed: selected.failedCount })}</p>}
          <div className="adminCampaignActions">
            {editable && <button type="button" className="spaceButton adminUsersApplyButton" disabled={busy || !title.trim() || !body.trim()} onClick={() => void saveCampaign()}>{t('common.save')}</button>}
            {selected && editable && <><input type="datetime-local" value={scheduledFor} disabled={busy} onChange={(event) => setScheduledFor(event.target.value)} /><button type="button" className="spaceButton adminUsersResetButton" disabled={busy || !scheduledFor} onClick={() => void campaignAction('schedule')}>{t('admin.campaignSchedule')}</button><button type="button" className="spaceButton adminUsersApplyButton" disabled={busy} onClick={() => void campaignAction('send')}>{t('admin.campaignSend')}</button><button type="button" className="spaceButton adminUsersResetButton" disabled={busy} onClick={() => void campaignAction('cancel')}>{t('common.cancel')}</button></>}
            {selected?.status === 'failed' && <button type="button" className="spaceButton adminUsersApplyButton" disabled={busy} onClick={() => void campaignAction('retry')}>{t('admin.campaignRetry')}</button>}
          </div>
        </div>
      </div>
    </section>
  </div>
}

type MobileCampaignEditorProps = {
  selected: AdminNotificationCampaign | null
  title: string
  body: string
  selectedTiers: TierId[]
  scheduledFor: string
  editable: boolean
  busy: boolean
  onTitleChange: (value: string) => void
  onBodyChange: (value: string) => void
  onTiersChange: (tiers: TierId[]) => void
  onScheduledForChange: (value: string) => void
  onSave: () => Promise<void>
  onAction: (action: 'schedule' | 'send' | 'cancel' | 'retry') => Promise<void>
  onClose: () => void
}

function MobileCampaignEditor({
  selected,
  title,
  body,
  selectedTiers,
  scheduledFor,
  editable,
  busy,
  onTitleChange,
  onBodyChange,
  onTiersChange,
  onScheduledForChange,
  onSave,
  onAction,
  onClose,
}: MobileCampaignEditorProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'editor' | 'preview'>('editor')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState(scheduledFor)
  const [scheduleMinimum, setScheduleMinimum] = useState('')
  const [audienceOpen, setAudienceOpen] = useState(false)
  const [audienceDraft, setAudienceDraft] = useState<TierId[]>(selectedTiers)
  const [sendActionsOpen, setSendActionsOpen] = useState(false)
  const {
    backdropStateClass,
    close: closeEditor,
    closing,
    setDialogRef,
  } = useMobileDialogTransition({ onClose, focusOnDesktop: false })

  const savedTiers = selected?.tiers ?? []
  const campaignChanged = selected
    ? title !== selected.title
      || body !== selected.body
      || [...selectedTiers].sort().join(',') !== [...savedTiers].sort().join(',')
    : Boolean(title || body || selectedTiers.length)
  const canSave = editable && campaignChanged && Boolean(title.trim()) && Boolean(body.trim())
  const canOpenDeliveryActions = Boolean(selected)
    && !campaignChanged
    && ['draft', 'scheduled', 'failed'].includes(selected?.status ?? '')
  const stats = selected ?? { recipientCount: 0, sentCount: 0, failedCount: 0 }

  function openSchedule() {
    setScheduleDraft(scheduledFor)
    setScheduleMinimum(localDateTimeMinimum())
    setScheduleOpen(true)
  }

  function openAudience() {
    setAudienceDraft(selectedTiers)
    setAudienceOpen(true)
  }

  return (
    <div className={`dialogBackdrop mobileFullViewBackdrop adminNotificationCampaignMobileBackdrop ${backdropStateClass}`} role="presentation">
      <section
        className="mobileFullView adminNotificationCampaignMobileEditor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-notification-campaign-mobile-title"
        ref={setDialogRef}
      >
        <header className="adminNotificationCampaignMobileHeader">
          <button
            type="button"
            className="adminNotificationCampaignHeaderAction spaceButton"
            aria-label={t('common.back')}
            disabled={busy || closing}
            onClick={closeEditor}
          >
            <Icon name="arrow-left-1" />
          </button>
          <h2 id="admin-notification-campaign-mobile-title">
            {selected?.title || t('admin.campaignNewMailing')}
          </h2>
          <button
            type="button"
            className="adminNotificationCampaignHeaderAction spaceButton"
            title={t('common.save')}
            aria-label={t('common.save')}
            disabled={!canSave || busy || closing}
            onClick={() => void onSave()}
          >
            <Icon name="diskette-light" />
          </button>
        </header>

        <main className="adminNotificationCampaignMobileBody">
          {mode === 'editor' ? (
            <div className="adminNotificationCampaignMobileFields">
              <label>
                <span>{t('admin.campaignTitle')}</span>
                <input
                  value={title}
                  maxLength={120}
                  disabled={!editable || busy}
                  placeholder={t('admin.campaignTitlePlaceholder')}
                  onChange={(event) => onTitleChange(event.currentTarget.value)}
                />
                <small>{title.length}/120</small>
              </label>
              <label className="bodyField">
                <span>{t('admin.campaignBody')}</span>
                <textarea
                  value={body}
                  maxLength={4000}
                  disabled={!editable || busy}
                  placeholder={t('admin.campaignBodyPlaceholder')}
                  onChange={(event) => onBodyChange(event.currentTarget.value)}
                />
                <small>{body.length}/4000</small>
              </label>
            </div>
          ) : (
            <article className="adminNotificationCampaignMobilePreview">
              <h1>{title || t('admin.campaignPreviewTitle')}</h1>
              <SafeNotificationMarkdown source={body || t('admin.campaignPreviewEmpty')} />
            </article>
          )}
        </main>

        <footer className="adminNotificationCampaignMobileFooter">
          <div className="adminNotificationCampaignMobileStats">
            <span>{t('admin.campaignRecipientsShort', { count: stats.recipientCount })}</span>
            <span>{t('admin.campaignSentShort', { count: stats.sentCount })}</span>
            <span className={stats.failedCount ? 'failed' : ''}>{t('admin.campaignFailedShort', { count: stats.failedCount })}</span>
          </div>
          <div className="adminNotificationCampaignMobileToolbar">
            <div className="adminNotificationCampaignModeSwitch" aria-label={t('admin.campaignViewMode')}>
              <button
                type="button"
                className={mode === 'editor' ? 'active' : ''}
                aria-label={t('admin.campaignEditorMode')}
                aria-pressed={mode === 'editor'}
                onClick={() => setMode('editor')}
              >
                <Icon name="edit-light" />
              </button>
              <button
                type="button"
                className={mode === 'preview' ? 'active' : ''}
                aria-label={t('admin.campaignPreviewMode')}
                aria-pressed={mode === 'preview'}
                onClick={() => setMode('preview')}
              >
                <Icon name="eye-light" />
              </button>
            </div>
            <button
              type="button"
              className={`adminNotificationCampaignToolbarAction ${selectedTiers.length ? 'configured' : ''}`.trim()}
              title={t('admin.campaignAudience')}
              aria-label={t('admin.campaignAudience')}
              disabled={!editable || busy}
              onClick={openAudience}
            >
              <Icon name="users-light" />
            </button>
            <button
              type="button"
              className={`adminNotificationCampaignToolbarAction ${scheduledFor ? 'configured' : ''}`.trim()}
              title={t('admin.campaignScheduleSettings')}
              aria-label={t('admin.campaignScheduleSettings')}
              disabled={!selected || !editable || busy}
              onClick={openSchedule}
            >
              <Icon name="calendar-light" />
            </button>
            <button
              type="button"
              className={`adminNotificationCampaignToolbarAction send ${sendActionsOpen ? 'active' : ''}`.trim()}
              title={t('admin.campaignDeliveryActions')}
              aria-label={t('admin.campaignDeliveryActions')}
              aria-haspopup="dialog"
              aria-expanded={sendActionsOpen}
              disabled={!canOpenDeliveryActions || busy}
              onClick={() => setSendActionsOpen(true)}
            >
              <Icon name="plain-light" />
            </button>
          </div>
        </footer>

        {scheduleOpen && (
          <MobileSettingsSheet title={t('admin.campaignScheduleSettings')} onClose={() => setScheduleOpen(false)}>
            {(close) => (
              <form
                className="adminNotificationCampaignMobileSheetForm"
                onSubmit={(event) => {
                  event.preventDefault()
                  onScheduledForChange(scheduleDraft)
                  close()
                }}
              >
                <label>
                  <span>{t('admin.campaignDateTime')}</span>
                  <input
                    type="datetime-local"
                    value={scheduleDraft}
                    min={scheduleMinimum}
                    onChange={(event) => setScheduleDraft(event.currentTarget.value)}
                  />
                </label>
                <p>{t('admin.campaignScheduleHint')}</p>
                <div className="adminNotificationCampaignMobileSheetActions">
                  <button type="button" className="secondary spaceButton" onClick={close}>{t('common.cancel')}</button>
                  <button type="submit" className="spaceButton" disabled={!scheduleDraft}>{t('common.save')}</button>
                </div>
              </form>
            )}
          </MobileSettingsSheet>
        )}

        {audienceOpen && (
          <MobileSettingsSheet title={t('admin.campaignAudience')} onClose={() => setAudienceOpen(false)}>
            {(close) => (
              <form
                className="adminNotificationCampaignMobileSheetForm"
                onSubmit={(event) => {
                  event.preventDefault()
                  onTiersChange(audienceDraft)
                  close()
                }}
              >
                <p>{t('admin.campaignAudienceAllHint')}</p>
                <div className="mobileChoiceList adminNotificationCampaignAudienceList">
                  {tiers.map((tier) => (
                    <label key={tier} className={audienceDraft.includes(tier) ? 'selected' : ''}>
                      <input
                        type="checkbox"
                        checked={audienceDraft.includes(tier)}
                        onChange={() => setAudienceDraft((current) => current.includes(tier)
                          ? current.filter((item) => item !== tier)
                          : [...current, tier])}
                      />
                      <span>{t(`tiers.names.${tier}`)}</span>
                    </label>
                  ))}
                </div>
                <div className="adminNotificationCampaignMobileSheetActions">
                  <button type="button" className="secondary spaceButton" onClick={() => setAudienceDraft([])}>
                    {t('admin.campaignAllActiveUsers')}
                  </button>
                  <button type="submit" className="spaceButton">{t('common.save')}</button>
                </div>
              </form>
            )}
          </MobileSettingsSheet>
        )}

        <MobileLibraryActionSheet
          open={sendActionsOpen}
          title={t('admin.campaignDeliveryActions')}
          dismissOnSelect
          onClose={() => setSendActionsOpen(false)}
          actions={selected ? [
            ...(['draft', 'scheduled'].includes(selected.status) ? [
              {
                key: 'schedule',
                label: t('admin.campaignSchedule'),
                icon: <Icon name="calendar-light" />,
                disabled: !scheduledFor,
                onSelect: () => void onAction('schedule'),
              },
              {
                key: 'send',
                label: t('admin.campaignSend'),
                icon: <Icon name="plain-light" />,
                onSelect: () => void onAction('send'),
              },
              {
                key: 'cancel',
                label: t('admin.campaignCancelDelivery'),
                icon: <Icon name="close-square-light" />,
                danger: true,
                onSelect: () => void onAction('cancel'),
              },
            ] : []),
            ...(selected.status === 'failed' ? [{
              key: 'retry',
              label: t('admin.campaignRetry'),
              icon: <Icon name="restart-light" />,
              onSelect: () => void onAction('retry'),
            }] : []),
          ] : []}
        />
      </section>
    </div>
  )
}

function localDateTimeMinimum() {
  const now = new Date(Date.now() + 60_000)
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 16)
}
