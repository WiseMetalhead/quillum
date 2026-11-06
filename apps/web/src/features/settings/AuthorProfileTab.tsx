import type { FormEvent } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { IconName } from '../../icons/Icon'
import type { User } from '../../types'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileViewport } from '../shared/useMobileViewport'

type AuthorProfileField =
  | 'authorName'
  | 'authorEmail'
  | 'authorWebsite'
  | 'authorTodayProfile'
  | 'authorLitresProfile'
  | 'authorProzaProfile'
  | 'authorSamizdatProfile'
  | 'authorCellulosaProfile'
  | 'authorWattpadProfile'

type AuthorProfileDraft = Record<AuthorProfileField, string>

type ProfileFieldConfig = {
  name: AuthorProfileField
  labelKey: string
  type?: 'email' | 'url' | 'text'
  autoComplete?: string
  faviconSrc?: string
  icon?: 'global-light'
}

const BASIC_FIELDS: ProfileFieldConfig[] = [
  { name: 'authorName', labelKey: 'settings.authorName', type: 'text', autoComplete: 'name' },
  { name: 'authorEmail', labelKey: 'settings.emailAddress', type: 'email', autoComplete: 'email' },
]

const LINK_FIELDS: ProfileFieldConfig[] = [
  { name: 'authorWebsite', labelKey: 'settings.website', type: 'url', icon: 'global-light' },
  { name: 'authorTodayProfile', labelKey: 'settings.authorTodayProfile', type: 'url', faviconSrc: '/favicons/author-today.ico' },
  { name: 'authorLitresProfile', labelKey: 'settings.authorLitresProfile', type: 'url', faviconSrc: '/favicons/litres.ico' },
  { name: 'authorProzaProfile', labelKey: 'settings.authorProzaProfile', type: 'url', faviconSrc: '/favicons/proza.ico' },
  { name: 'authorSamizdatProfile', labelKey: 'settings.authorSamizdatProfile', type: 'url', faviconSrc: '/favicons/samizdat.ico' },
  { name: 'authorCellulosaProfile', labelKey: 'settings.authorCellulosaProfile', type: 'url', faviconSrc: '/favicons/cellulosa.ico' },
  { name: 'authorWattpadProfile', labelKey: 'settings.authorWattpadProfile', type: 'url', faviconSrc: '/favicons/wattpad.ico' },
]

function draftFromUser(user: User): AuthorProfileDraft {
  return {
    authorName: user.authorName ?? '',
    authorEmail: user.authorEmail ?? '',
    authorWebsite: user.authorWebsite ?? '',
    authorTodayProfile: user.authorTodayProfile ?? '',
    authorLitresProfile: user.authorLitresProfile ?? '',
    authorProzaProfile: user.authorProzaProfile ?? '',
    authorSamizdatProfile: user.authorSamizdatProfile ?? '',
    authorCellulosaProfile: user.authorCellulosaProfile ?? '',
    authorWattpadProfile: user.authorWattpadProfile ?? '',
  }
}

type AuthorProfileTabProps = {
  user: User
  onUserChange: (user: User) => void
  onMessage: (message: string) => void
  onError: (message: string) => void
}

export function AuthorProfileTab({
  user,
  onUserChange,
  onMessage,
  onError,
}: AuthorProfileTabProps) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const [draft, setDraft] = useState<AuthorProfileDraft>(() => draftFromUser(user))
  const [editingField, setEditingField] = useState<AuthorProfileField | null>(null)
  const [savingField, setSavingField] = useState<AuthorProfileField | null>(null)

  function closeEditor(field: AuthorProfileField) {
    if (savingField === field) return
    setDraft((current) => ({ ...current, [field]: draftFromUser(user)[field] }))
    setEditingField(null)
  }

  function openEditor(field: AuthorProfileField) {
    setDraft((current) => ({ ...current, [field]: draftFromUser(user)[field] }))
    setEditingField(field)
  }

  async function handleAuthorProfileSubmit(event: FormEvent<HTMLFormElement>, field: AuthorProfileField) {
    event.preventDefault()
    onError('')
    setSavingField(field)
    try {
      const payload = await apiRequest<{ user: User }>('/api/auth/profile/', {
        method: 'PATCH',
        body: JSON.stringify({ ...draftFromUser(user), [field]: draft[field] }),
      })
      onUserChange(payload.user)
      setEditingField(null)
      onMessage(t('settings.authorProfileUpdated'))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('settings.authorProfileFailed'))
    } finally {
      setSavingField(null)
    }
  }

  function renderField(field: ProfileFieldConfig) {
    const label = t(field.labelKey)
    const isEditing = editingField === field.name
    const value = (isEditing ? draft[field.name] : draftFromUser(user)[field.name]).trim()

    return (
      <div className={`authorProfileRow ${field.faviconSrc || field.icon ? '' : 'noIcon'}`} key={field.name}>
        {(field.faviconSrc || field.icon) && (
          <span className="authorProfileFieldIcon">
            {field.faviconSrc ? (
              <img src={field.faviconSrc} alt="" aria-hidden="true" />
            ) : (
              <Icon name={field.icon ?? 'global-light'} />
            )}
          </span>
        )}
        <span className="accountFieldLabel">{label}</span>
        {isEditing ? (
          <form className="inlineEditForm authorProfileInlineForm" onSubmit={(event) => void handleAuthorProfileSubmit(event, field.name)}>
            <input
              name={field.name}
              type={field.type ?? 'text'}
              value={draft[field.name]}
              onChange={(event) => {
                const nextValue = event.currentTarget.value
                setDraft((current) => ({ ...current, [field.name]: nextValue }))
              }}
              autoComplete={field.autoComplete}
              autoFocus
            />
            <button
              type="submit"
              className="iconAction"
              disabled={savingField === field.name}
              title={t('common.save')}
              aria-label={t('settings.saveAuthorProfileField', { field: label })}
            >
              <Icon name="check-circle-1-light" />
            </button>
            <button
              type="button"
              className="iconAction cancelNameAction"
              disabled={savingField === field.name}
              title={t('common.cancel')}
              aria-label={t('common.cancel')}
              onClick={() => closeEditor(field.name)}
            >
              <Icon name="close-light" />
            </button>
          </form>
        ) : (
          <span className="accountValueWithAction authorProfileValue">
            <span className={`accountFieldValue ${value ? '' : 'emptyValue'}`}>
              {value || t('settings.notProvided')}
            </span>
            <button
              type="button"
              className="iconAction ghost"
              onClick={() => openEditor(field.name)}
              title={t('settings.editAuthorProfileField', { field: label })}
              aria-label={t('settings.editAuthorProfileField', { field: label })}
            >
              <Icon name="edit-light" />
            </button>
          </span>
        )}
      </div>
    )
  }

  function renderMobileField(field: ProfileFieldConfig) {
    const label = t(field.labelKey)
    const value = draftFromUser(user)[field.name].trim()
    const fallbackIcons: Partial<Record<AuthorProfileField, IconName>> = {
      authorName: 'user-id-light',
      authorEmail: 'email-light',
    }

    return (
      <button
        type="button"
        className="accountMobileSettingRow authorProfileMobileRow spaceButton"
        key={field.name}
        disabled={savingField !== null}
        onClick={() => openEditor(field.name)}
      >
        <span className="accountMobileSettingIcon authorProfileMobileIcon">
          {field.faviconSrc ? (
            <img src={field.faviconSrc} alt="" aria-hidden="true" />
          ) : (
            <Icon name={field.icon ?? fallbackIcons[field.name] ?? 'global-light'} />
          )}
        </span>
        <span className="accountMobileSettingCopy">
          <strong>{label}</strong>
          <small>{value || t('settings.notProvided')}</small>
        </span>
        <Icon name="arrow-right-2" />
      </button>
    )
  }

  const activeField = [...BASIC_FIELDS, ...LINK_FIELDS].find((field) => field.name === editingField)

  return (
    <div className="settingsStack authorProfileStack">
      {!isMobile && <><section className="settingsPanel authorProfilePanel">
        <div className="authorProfileSectionHeader">
          <Icon name="profile-light" />
          <h3>{t('settings.authorProfile')}</h3>
        </div>
        <div className="authorProfileRows">
          {BASIC_FIELDS.map(renderField)}
        </div>
      </section>

      <section className="settingsPanel authorProfilePanel">
        <div className="authorProfileSectionHeader">
          <Icon name="link-minimalistic-light" />
          <h3>{t('settings.authorProfileLinks')}</h3>
        </div>
        <div className="authorProfileRows links">
          {LINK_FIELDS.map(renderField)}
        </div>
      </section>

      <p className="authorProfileDisclaimer">
        <Icon name="information-circle-light" />
        <span>{t('settings.authorProfileDisclaimer')}</span>
      </p>
      </>}

      {isMobile && <div className="authorProfileMobileLayout">
        <div className="accountMobileSettingsList">
          {BASIC_FIELDS.map(renderMobileField)}
        </div>
        <section className="authorProfileMobileSection">
          <h2>{t('settings.authorProfileLinks')}</h2>
          <div className="accountMobileSettingsList">
            {LINK_FIELDS.map(renderMobileField)}
          </div>
        </section>
        <p className="authorProfileDisclaimer">
          <Icon name="information-circle-light" />
          <span>{t('settings.authorProfileDisclaimer')}</span>
        </p>
      </div>}

      {isMobile && activeField && (
        <MobileSettingsSheet
          title={t(activeField.labelKey)}
          busy={savingField === activeField.name}
          onClose={() => closeEditor(activeField.name)}
        >
          {(close) => (
            <form
              className="accountMobileSheetForm authorProfileMobileSheetForm"
              onSubmit={(event) => void handleAuthorProfileSubmit(event, activeField.name)}
            >
              <input
                name={activeField.name}
                type={activeField.type ?? 'text'}
                value={draft[activeField.name]}
                aria-label={t(activeField.labelKey)}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value
                  setDraft((current) => ({ ...current, [activeField.name]: nextValue }))
                }}
                autoComplete={activeField.autoComplete}
                autoFocus
              />
              <div className="dialogActions">
                <button type="button" className="secondary" disabled={savingField !== null} onClick={close}>
                  {t('common.cancel')}
                </button>
                <button type="submit" disabled={savingField !== null}>
                  {t(savingField === activeField.name ? 'common.saving' : 'common.save')}
                </button>
              </div>
            </form>
          )}
        </MobileSettingsSheet>
      )}
    </div>
  )
}
