import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type {
  NotificationPreferenceManuscript,
  NotificationPreferences,
  NotificationRule,
  NotificationRuleKind,
} from '../../types'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import '../shared/MobileChoiceList.css'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileViewport } from '../shared/useMobileViewport'
import './NotificationSettingsTab.css'

const ruleKinds: NotificationRuleKind[] = [
  'user.manuscript_deadline',
  'user.item_deadline',
  'user.task_deadline',
  'user.review_comment',
  'user.daily_goal',
  'user.manuscript_digest',
]

const icons: Record<NotificationRuleKind, IconName> = {
  'user.manuscript_deadline': 'calendar-light',
  'user.item_deadline': 'calendar-minimalistic-light',
  'user.task_deadline': 'checklist-minimalistic-light',
  'user.review_comment': 'dialog-2-light',
  'user.daily_goal': 'trend-up-light',
  'user.manuscript_digest': 'clipboard-list-light',
}

const timedKinds = new Set<NotificationRuleKind>([
  'user.manuscript_deadline',
  'user.item_deadline',
  'user.task_deadline',
  'user.daily_goal',
  'user.manuscript_digest',
])

const checkpointKinds = new Set<NotificationRuleKind>([
  'user.manuscript_deadline',
  'user.item_deadline',
  'user.task_deadline',
])

type MobileRuleOption = 'time' | 'checkpoints' | 'weekdays'

type Props = {
  onMessage: (message: string) => void
  onError: (message: string) => void
}

function copyRules(rules: NotificationRule[]) {
  return rules.map((rule) => ({
    ...rule,
    weekdays: [...rule.weekdays],
    checkpoints: [...rule.checkpoints],
    manuscriptIds: [...rule.manuscriptIds],
  }))
}

function NotificationTimeSpinner({
  value,
  onChange,
}: {
  value: string | null
  onChange: (value: string | null) => void
}) {
  const { t } = useTranslation()
  const swipeRef = useRef<{
    part: 'hours' | 'minutes'
    pointerId: number
    startY: number
  } | null>(null)
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? '')
  const hours = match ? Number(match[1]) : null
  const minutes = match ? Number(match[2]) : null

  function changePart(part: 'hours' | 'minutes', delta: number) {
    if (hours === null || minutes === null) {
      const initialHours = part === 'hours' && delta < 0 ? 23 : 0
      const initialMinutes = part === 'minutes' && delta < 0 ? 59 : 0
      onChange(
        `${String(initialHours).padStart(2, '0')}:${String(initialMinutes).padStart(2, '0')}`,
      )
      return
    }
    const currentHours = hours ?? 0
    const currentMinutes = minutes ?? 0
    const nextHours = part === 'hours'
      ? (currentHours + delta + 24) % 24
      : currentHours
    const nextMinutes = part === 'minutes'
      ? (currentMinutes + delta + 60) % 60
      : currentMinutes
    onChange(
      `${String(nextHours).padStart(2, '0')}:${String(nextMinutes).padStart(2, '0')}`,
    )
  }

  function renderPart(part: 'hours' | 'minutes') {
    const current = part === 'hours' ? hours : minutes
    const maximum = part === 'hours' ? 23 : 59
    const label = t(
      part === 'hours'
        ? 'notificationSettings.deliveryHours'
        : 'notificationSettings.deliveryMinutes',
    )
    const change = (delta: number) => changePart(part, delta)
    return (
      <div
        className="notificationTimePart"
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={maximum}
        aria-valuenow={current ?? undefined}
        aria-valuetext={current === null ? t('notificationSettings.timeNotSet') : undefined}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            change(1)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            change(-1)
          } else if (event.key === 'PageUp') {
            event.preventDefault()
            change(part === 'hours' ? 6 : 10)
          } else if (event.key === 'PageDown') {
            event.preventDefault()
            change(part === 'hours' ? -6 : -10)
          }
        }}
        onWheel={(event) => {
          if (event.deltaY === 0) return
          event.preventDefault()
          change(event.deltaY > 0 ? 1 : -1)
        }}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' || (event.target as HTMLElement).closest('button')) return
          swipeRef.current = { part, pointerId: event.pointerId, startY: event.clientY }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerUp={(event) => {
          const swipe = swipeRef.current
          if (!swipe || swipe.part !== part || swipe.pointerId !== event.pointerId) return
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          swipeRef.current = null
          const distance = swipe.startY - event.clientY
          if (Math.abs(distance) < 24) return
          const steps = Math.max(1, Math.min(10, Math.round(Math.abs(distance) / 32)))
          change(distance > 0 ? steps : -steps)
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          swipeRef.current = null
        }}
      >
        <button
          type="button"
          className="spaceButton"
          tabIndex={-1}
          title={t('notificationSettings.increaseTimePart', { value: label })}
          aria-label={t('notificationSettings.increaseTimePart', { value: label })}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => change(1)}
        >
          <Icon name="arrow-up-2" />
        </button>
        <strong>{current === null ? (part === 'hours' ? 'HH' : 'MM') : String(current).padStart(2, '0')}</strong>
        <button
          type="button"
          className="spaceButton"
          tabIndex={-1}
          title={t('notificationSettings.decreaseTimePart', { value: label })}
          aria-label={t('notificationSettings.decreaseTimePart', { value: label })}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => change(-1)}
        >
          <Icon name="arrow-down-2" />
        </button>
      </div>
    )
  }

  return (
    <div className={`notificationTimeSpinner ${value ? '' : 'empty'}`.trim()}>
      {renderPart('hours')}
      <span className="notificationTimeSeparator" aria-hidden="true">:</span>
      {renderPart('minutes')}
    </div>
  )
}

function ruleFingerprint(rule: NotificationRule | undefined) {
  if (!rule) return ''
  return JSON.stringify({
    ...rule,
    weekdays: [...rule.weekdays].sort((left, right) => left - right),
    checkpoints: [...rule.checkpoints].sort((left, right) => left - right),
    manuscriptIds: [...rule.manuscriptIds].sort(),
  })
}

export function NotificationSettingsTab({ onMessage, onError }: Props) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null)
  const [rules, setRules] = useState<NotificationRule[]>([])
  const [searches, setSearches] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [savingTarget, setSavingTarget] = useState<NotificationRuleKind | 'all' | null>(null)
  const [mobileRuleKind, setMobileRuleKind] = useState<NotificationRuleKind | null>(null)
  const [mobileRuleOption, setMobileRuleOption] = useState<{
    kind: NotificationRuleKind
    option: MobileRuleOption
  } | null>(null)
  const preserveMobileRuleRef = useRef(false)

  useEffect(() => {
    let active = true
    void apiRequest<{ preferences: NotificationPreferences }>(
      '/api/notifications/preferences/',
    ).then((payload) => {
      if (!active) return
      setPreferences(payload.preferences)
      setRules(copyRules(payload.preferences.rules))
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : t('notificationSettings.loadFailed'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [onError, t])

  const manuscriptsById = useMemo(() => new Map(
    (preferences?.manuscripts ?? []).map((manuscript) => [manuscript.id, manuscript]),
  ), [preferences])

  function updateRule(kind: NotificationRuleKind, update: Partial<NotificationRule>) {
    setRules((current) => current.map((rule) => (
      rule.kind === kind ? { ...rule, ...update } : rule
    )))
  }

  function toggleList(kind: NotificationRuleKind, field: 'checkpoints' | 'weekdays', value: number) {
    const rule = rules.find((item) => item.kind === kind)
    if (!rule) return
    const values = rule[field]
    updateRule(kind, {
      [field]: values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value].sort((left, right) => left - right),
    })
  }

  function toggleManuscript(rule: NotificationRule, manuscriptId: string) {
    updateRule(rule.kind, {
      manuscriptIds: rule.manuscriptIds.includes(manuscriptId)
        ? rule.manuscriptIds.filter((item) => item !== manuscriptId)
        : [...rule.manuscriptIds, manuscriptId],
    })
  }

  async function save(kind?: NotificationRuleKind): Promise<boolean> {
    if (!preferences) return false
    const nextRules = kind
      ? preferences.rules.map((savedRule) => (
          savedRule.kind === kind
            ? rules.find((rule) => rule.kind === kind) ?? savedRule
            : savedRule
        ))
      : rules
    const submittedRule = kind
      ? nextRules.find((rule) => rule.kind === kind)
      : undefined
    setSavingTarget(kind ?? 'all')
    try {
      const payload = await apiRequest<{ preferences: NotificationPreferences }>(
        '/api/notifications/preferences/',
        { method: 'PATCH', body: JSON.stringify({ rules: nextRules }) },
      )
      setPreferences(payload.preferences)
      if (kind) {
        const savedRule = payload.preferences.rules.find((rule) => rule.kind === kind)
        if (savedRule) {
          setRules((current) => current.map((rule) => (
            rule.kind === kind && ruleFingerprint(rule) === ruleFingerprint(submittedRule)
              ? copyRules([savedRule])[0]
              : rule
          )))
        }
      } else {
        setRules(copyRules(payload.preferences.rules))
      }
      onMessage(t('notificationSettings.saved'))
      return true
    } catch (error) {
      onError(error instanceof Error ? error.message : t('notificationSettings.saveFailed'))
      return false
    } finally {
      setSavingTarget(null)
    }
  }

  function closeMobileRule() {
    if (!mobileRuleKind || !preferences) {
      setMobileRuleKind(null)
      return
    }
    if (!preserveMobileRuleRef.current) {
      const savedRule = preferences.rules.find((rule) => rule.kind === mobileRuleKind)
      if (savedRule) {
        setRules((current) => current.map((rule) => (
          rule.kind === mobileRuleKind
            ? copyRules([savedRule])[0]
            : rule
        )))
      }
    }
    setSearches((current) => ({ ...current, [mobileRuleKind]: '' }))
    preserveMobileRuleRef.current = false
    setMobileRuleOption(null)
    setMobileRuleKind(null)
  }

  function renderRuleOptions(rule: NotificationRule) {
    const kind = rule.kind
    const query = searches[kind]?.trim().toLocaleLowerCase() ?? ''
    const matching = query
      ? preferences?.manuscripts.filter((item) => item.title.toLocaleLowerCase().includes(query)) ?? []
      : []
    const selected = rule.manuscriptIds
      .map((id) => manuscriptsById.get(id))
      .filter((item): item is NotificationPreferenceManuscript => Boolean(item))

    return (
      <>
        <div className="notificationRuleEnabledOption">
          <span>{t('notificationSettings.ruleStatus')}</span>
          <div className="notificationRuleSwitch">
            <button
              type="button"
              role="switch"
              className="securityToggle"
              aria-checked={rule.enabled}
              aria-label={t('notificationSettings.toggleRule', {
                rule: t(`notificationSettings.rules.${kind}.title`),
              })}
              onClick={() => updateRule(kind, { enabled: !rule.enabled })}
            >
              <span />
            </button>
          </div>
        </div>

        {timedKinds.has(kind) && (
          isMobile ? (
            <button
              type="button"
              className="notificationMobileNestedSetting spaceButton"
              onClick={() => setMobileRuleOption({ kind, option: 'time' })}
            >
              <span className="notificationMobileNestedSettingCopy">
                <strong>{t('notificationSettings.deliveryTime')}</strong>
                <small>{rule.time ?? t('notificationSettings.deliveryTimeNotSet')}</small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
          ) : (
            <div className="notificationRuleField">
              <span>{t('notificationSettings.deliveryTime')}</span>
              <NotificationTimeSpinner
                value={rule.time}
                onChange={(time) => updateRule(kind, { time })}
              />
            </div>
          )
        )}

        {checkpointKinds.has(kind) && (
          isMobile ? (
            <button
              type="button"
              className="notificationMobileNestedSetting spaceButton"
              onClick={() => setMobileRuleOption({ kind, option: 'checkpoints' })}
            >
              <span className="notificationMobileNestedSettingCopy">
                <strong>{t('notificationSettings.checkpoints')}</strong>
                <small>
                  {(kind === 'user.manuscript_deadline'
                    ? [100, 60, 30, 15, 5, 1]
                    : kind === 'user.item_deadline'
                      ? [30, 15, 5, 1]
                      : [3, 1, 0]
                  ).filter((value) => rule.checkpoints.includes(value)).map((value) => (
                    value === 0
                      ? t('notificationSettings.dueDate')
                      : t('notificationSettings.daysBefore', { count: value })
                  )).join(', ') || t('notificationSettings.selectionNotSet')}
                </small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
          ) : (
            <fieldset className="notificationChoiceGroup">
              <legend>{t('notificationSettings.checkpoints')}</legend>
              <div>
                {(kind === 'user.manuscript_deadline'
                  ? [100, 60, 30, 15, 5, 1]
                  : kind === 'user.item_deadline'
                    ? [30, 15, 5, 1]
                    : [3, 1, 0]).map((value) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={rule.checkpoints.includes(value)}
                    onChange={() => toggleList(kind, 'checkpoints', value)}
                  />
                  {value === 0
                    ? t('notificationSettings.dueDate')
                    : t('notificationSettings.daysBefore', { count: value })}
                </label>
                ))}
              </div>
            </fieldset>
          )
        )}

        {kind === 'user.manuscript_digest' && (
          isMobile ? (
            <button
              type="button"
              className="notificationMobileNestedSetting spaceButton"
              onClick={() => setMobileRuleOption({ kind, option: 'weekdays' })}
            >
              <span className="notificationMobileNestedSettingCopy">
                <strong>{t('notificationSettings.weekdays')}</strong>
                <small>
                  {[0, 1, 2, 3, 4, 5, 6]
                    .filter((value) => rule.weekdays.includes(value))
                    .map((value) => t(`notificationSettings.weekday_${value}`))
                    .join(', ') || t('notificationSettings.selectionNotSet')}
                </small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
          ) : (
            <fieldset className="notificationChoiceGroup">
              <legend>{t('notificationSettings.weekdays')}</legend>
              <div>
                {[0, 1, 2, 3, 4, 5, 6].map((value) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={rule.weekdays.includes(value)}
                    onChange={() => toggleList(kind, 'weekdays', value)}
                  />
                  {t(`notificationSettings.weekday_${value}`)}
                </label>
                ))}
              </div>
            </fieldset>
          )
        )}

        <div className="notificationManuscripts">
          <span>{t('notificationSettings.manuscripts')}</span>
          {selected.length > 0 && (
            <div className="notificationSelectedManuscripts">
              {selected.map((manuscript) => (
                <button
                  key={manuscript.id}
                  type="button"
                  className="spaceButton"
                  onClick={() => toggleManuscript(rule, manuscript.id)}
                  title={t('notificationSettings.removeManuscript')}
                >
                  {manuscript.title}<Icon name="close-light" />
                </button>
              ))}
            </div>
          )}
          <input
            type="search"
            value={searches[kind] ?? ''}
            placeholder={t('notificationSettings.searchManuscripts')}
            onChange={(event) => {
              const value = event.currentTarget.value
              setSearches((current) => ({ ...current, [kind]: value }))
            }}
          />
          {query && (
            <div className="notificationManuscriptResults">
              {matching.length === 0 && <p>{t('notificationSettings.noManuscripts')}</p>}
              {matching.map((manuscript) => (
                <label key={manuscript.id}>
                  <input
                    type="checkbox"
                    checked={rule.manuscriptIds.includes(manuscript.id)}
                    onChange={() => toggleManuscript(rule, manuscript.id)}
                  />
                  <span>{manuscript.title}</span>
                  <small>{t(manuscript.kind === 'book' ? 'manuscripts.book' : 'manuscripts.oneShot')}</small>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="notificationEmailOption">
          <span>{t('notificationSettings.emailCopy')}</span>
          <button
            type="button"
            role="switch"
            className="securityToggle"
            aria-checked={rule.emailEnabled}
            aria-label={t('notificationSettings.toggleEmail', {
              rule: t(`notificationSettings.rules.${kind}.title`),
            })}
            onClick={() => updateRule(kind, { emailEnabled: !rule.emailEnabled })}
          >
            <span />
          </button>
        </div>
      </>
    )
  }

  if (loading) {
    return <TadpoleLoadingState className="settingsLoadingState" label={t('notificationSettings.loading')} />
  }
  if (!preferences) return null

  const mobileRule = mobileRuleKind
    ? rules.find((rule) => rule.kind === mobileRuleKind)
    : undefined

  return (
    <div className="settingsStack notificationSettingsStack">
      {!isMobile && (
        <>
          <section className="settingsPanel notificationSettingsIntro">
            <div className="authorProfileSectionHeader notificationSettingsHeading">
              <Icon name="bell-light" />
              <h2>{t('notificationSettings.title')}</h2>
            </div>
            <div className="notificationTimezone">
              <Icon name="global-light" />
              <span>{t('notificationSettings.timezone', { value: preferences.timezone })}</span>
            </div>
          </section>

          {ruleKinds.map((kind) => {
            const rule = rules.find((item) => item.kind === kind)
            if (!rule) return null
            const savedRule = preferences.rules.find((item) => item.kind === kind)
            const dirty = ruleFingerprint(rule) !== ruleFingerprint(savedRule)
            return (
              <section className="settingsPanel notificationRuleCard" key={kind}>
                <header>
                  <span className="notificationRuleIcon"><Icon name={icons[kind]} /></span>
                  <div>
                    <h3>{t(`notificationSettings.rules.${kind}.title`)}</h3>
                    <p>{t(`notificationSettings.rules.${kind}.description`)}</p>
                  </div>
                  <button
                    type="button"
                    className="notificationRuleSaveButton"
                    disabled={!dirty || savingTarget !== null}
                    onClick={() => void save(kind)}
                  >
                    {t(savingTarget === kind ? 'common.saving' : 'common.save')}
                  </button>
                </header>

                <div className="notificationRuleOptions">
                  {renderRuleOptions(rule)}
                </div>
              </section>
            )
          })}
        </>
      )}

      {isMobile && (
        <section className="accountMobileSettingsList notificationMobileSettingsList">
          {ruleKinds.map((kind) => {
            const rule = rules.find((item) => item.kind === kind)
            if (!rule) return null
            return (
              <button
                type="button"
                className="accountMobileSettingRow notificationMobileSettingRow spaceButton"
                key={kind}
                disabled={savingTarget !== null}
                onClick={() => {
                  preserveMobileRuleRef.current = false
                  setMobileRuleKind(kind)
                }}
              >
                <span className="accountMobileSettingIcon"><Icon name={icons[kind]} /></span>
                <span className="accountMobileSettingCopy">
                  <strong>{t(`notificationSettings.rules.${kind}.title`)}</strong>
                  <small>{t(rule.enabled ? 'common.enabled' : 'common.disabled')}</small>
                </span>
                <Icon name="arrow-right-2" />
              </button>
            )
          })}
        </section>
      )}

      {isMobile && mobileRule && (
        <MobileSettingsSheet
          title={t(`notificationSettings.rules.${mobileRule.kind}.title`)}
          busy={savingTarget === mobileRule.kind}
          onClose={closeMobileRule}
        >
          {(close) => {
            const savedRule = preferences.rules.find((rule) => rule.kind === mobileRule.kind)
            const dirty = ruleFingerprint(mobileRule) !== ruleFingerprint(savedRule)
            return (
              <div className="notificationMobileSheetLayout">
                <div className="notificationMobileRuleOptions">
                  {renderRuleOptions(mobileRule)}
                </div>
                <div className="notificationMobileSheetActions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={savingTarget !== null}
                    onClick={close}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || savingTarget !== null}
                    onClick={() => {
                      void save(mobileRule.kind).then((saved) => {
                        if (saved) {
                          preserveMobileRuleRef.current = true
                          close()
                        }
                      })
                    }}
                  >
                    {t(savingTarget === mobileRule.kind ? 'common.saving' : 'common.save')}
                  </button>
                </div>
              </div>
            )
          }}
        </MobileSettingsSheet>
      )}

      {isMobile && mobileRule && mobileRuleOption?.kind === mobileRule.kind && mobileRuleOption.option === 'time' && (
        <MobileSettingsSheet
          title={t('notificationSettings.deliveryTime')}
          onClose={() => setMobileRuleOption(null)}
        >
          <div className="notificationMobileTimeSheet">
            <NotificationTimeSpinner
              value={mobileRule.time}
              onChange={(time) => updateRule(mobileRule.kind, { time })}
            />
          </div>
        </MobileSettingsSheet>
      )}

      {isMobile && mobileRule && mobileRuleOption?.kind === mobileRule.kind && mobileRuleOption.option === 'checkpoints' && (
        <MobileSettingsSheet
          title={t('notificationSettings.checkpoints')}
          onClose={() => setMobileRuleOption(null)}
          initialFocus="dialog"
        >
          <div className="mobileChoiceList notificationMobileChoiceSheet">
            {(mobileRule.kind === 'user.manuscript_deadline'
              ? [100, 60, 30, 15, 5, 1]
              : mobileRule.kind === 'user.item_deadline'
                ? [30, 15, 5, 1]
                : [3, 1, 0]).map((value) => (
              <label key={value} className={mobileRule.checkpoints.includes(value) ? 'selected' : ''}>
                <input
                  type="checkbox"
                  checked={mobileRule.checkpoints.includes(value)}
                  onChange={() => toggleList(mobileRule.kind, 'checkpoints', value)}
                />
                <span>
                  {value === 0
                    ? t('notificationSettings.dueDate')
                    : t('notificationSettings.daysBefore', { count: value })}
                </span>
              </label>
            ))}
          </div>
        </MobileSettingsSheet>
      )}

      {isMobile && mobileRule && mobileRuleOption?.kind === mobileRule.kind && mobileRuleOption.option === 'weekdays' && (
        <MobileSettingsSheet
          title={t('notificationSettings.weekdays')}
          onClose={() => setMobileRuleOption(null)}
          initialFocus="dialog"
        >
          <div className="mobileChoiceList notificationMobileChoiceSheet">
            {[0, 1, 2, 3, 4, 5, 6].map((value) => (
              <label key={value} className={mobileRule.weekdays.includes(value) ? 'selected' : ''}>
                <input
                  type="checkbox"
                  checked={mobileRule.weekdays.includes(value)}
                  onChange={() => toggleList(mobileRule.kind, 'weekdays', value)}
                />
                <span>{t(`notificationSettings.weekday_${value}`)}</span>
              </label>
            ))}
          </div>
        </MobileSettingsSheet>
      )}
    </div>
  )
}
