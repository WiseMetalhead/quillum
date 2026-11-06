import { useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  FormEvent,
  MouseEvent,
  ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiRequest, apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { IconName } from '../../icons/Icon'
import type { ServicePageMetadata, User } from '../../types'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { ActionDialog } from '../shared/ActionDialog'
import { CustomSelect } from '../shared/CustomSelect'
import { useMobileViewport } from '../shared/useMobileViewport'
import { servicePageLabelKey } from '../service-pages/servicePages'
import { AccountExportPanel } from './AccountExportPanel'

type AccountTabProps = {
  user: User
  localPasswordLoginEnabled: boolean
  onUserChange: (user: User) => void
  onMessage: (message: string) => void
  onError: (message: string) => void
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
  onAccountDeleted: () => void
  servicePages: ServicePageMetadata[]
  showAccountExport: boolean
}

type AccountChoice = 'language' | 'timezone' | 'theme'

type AccountDialogProps = {
  title: string
  onClose: () => void
  children: ReactNode | ((close: () => void) => ReactNode)
  busy?: boolean
  role?: 'dialog' | 'alertdialog'
}

function AccountDialog({
  title,
  onClose,
  children,
  busy = false,
  role = 'dialog',
}: AccountDialogProps) {
  const isMobile = useMobileViewport()
  const renderChildren = (closeAction: () => void) => (
    typeof children === 'function' ? children(closeAction) : children
  )

  if (!isMobile) {
    return (
      <ActionDialog
        variant="compact"
        title={title}
        closeLabel={title}
        busy={busy}
        onClose={onClose}
        role={role}
      >
        {renderChildren(onClose)}
      </ActionDialog>
    )
  }

  return (
    <MobileSettingsSheet title={title} onClose={onClose} busy={busy} role={role}>
      {(close) => renderChildren(close)}
    </MobileSettingsSheet>
  )
}

type MobileAccountRowProps = {
  icon: IconName
  title: string
  subtitle: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

function MobileAccountRow({
  icon,
  title,
  subtitle,
  danger = false,
  disabled = false,
  onClick,
}: MobileAccountRowProps) {
  return (
    <button
      type="button"
      className={`accountMobileSettingRow spaceButton ${danger ? 'danger' : ''}`.trim()}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="accountMobileSettingIcon"><Icon name={icon} /></span>
      <span className="accountMobileSettingCopy">
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </span>
      <Icon name="arrow-right-2" />
    </button>
  )
}

export function AccountTab({
  user,
  localPasswordLoginEnabled,
  onUserChange,
  onMessage,
  onError,
  onSensitiveAction,
  onAccountDeleted,
  servicePages,
  showAccountExport,
}: AccountTabProps) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [displayNameDraft, setDisplayNameDraft] = useState(user.displayName)
  const [editingEmail, setEditingEmail] = useState(false)
  const [pendingEmail, setPendingEmail] = useState('')
  const [emailCodeRequested, setEmailCodeRequested] = useState(false)
  const [mobileChoice, setMobileChoice] = useState<AccountChoice | null>(null)
  const [timezoneQuery, setTimezoneQuery] = useState('')
  const [isSavingAvatar, setIsSavingAvatar] = useState(false)
  const [isSavingName, setIsSavingName] = useState(false)
  const [isSavingLanguage, setIsSavingLanguage] = useState(false)
  const [isSavingTimezone, setIsSavingTimezone] = useState(false)
  const [isSavingTheme, setIsSavingTheme] = useState(false)
  const [isSavingEmail, setIsSavingEmail] = useState(false)
  const [deleteStep, setDeleteStep] = useState<'warning' | 'password' | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [isDeletingAccount, setIsDeletingAccount] = useState(false)

  const visibleName = user.displayName || user.username
  const accountName = user.displayName ? `${user.displayName} (${user.username})` : user.username
  const avatarInitial = visibleName.trim().charAt(0) || user.username.charAt(0) || 'Q'
  const timezoneOptions = useMemo(() => Array.from(new Set([
    user.timezone,
    'UTC',
    ...(typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : []),
  ])).sort(), [user.timezone])
  const languageLabel = user.language === 'ru' ? 'Русский' : 'English'
  const themeLabel = t(`theme.${user.theme}`)

  function openServicePage(event: MouseEvent<HTMLAnchorElement>, path: string) {
    event.preventDefault()
    window.history.pushState({}, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  const desktopServicePages = servicePages.length > 0 && (
    <section className="settingsPanel accountServicePagesCard">
      <div>
        <h2>{t('account.servicePages')}</h2>
        <p>{t('account.servicePagesLead')}</p>
      </div>
      <nav aria-label={t('servicePages.navigation')}>
        {servicePages.map((page) => (
          <a key={page.slug} href={page.path} onClick={(event) => openServicePage(event, page.path)}>
            {t(servicePageLabelKey(page.slug))}
            <Icon name="arrow-right-2" />
          </a>
        ))}
      </nav>
    </section>
  )

  async function updateProfile(payload: Record<string, unknown>, successMessage: string) {
    const response = await apiRequest<{ user: User }>('/api/auth/profile/', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    onUserChange(response.user)
    onMessage(successMessage)
    return response.user
  }

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    onError('')
    setIsSavingAvatar(true)
    try {
      const form = new FormData()
      form.append('avatar', file)
      const payload = await apiUpload<{ user: User }>('/api/auth/profile/avatar/', form)
      onUserChange(payload.user)
      onMessage(t('account.avatarUpdated'))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('account.avatarFailed'))
    } finally {
      setIsSavingAvatar(false)
      event.currentTarget.value = ''
    }
  }

  function startNameEditing() {
    setDisplayNameDraft(user.displayName)
    setEditingName(true)
  }

  function cancelNameEditing() {
    setDisplayNameDraft(user.displayName)
    setEditingName(false)
  }

  async function handleNameSubmit(
    event: FormEvent<HTMLFormElement>,
    onSaved: () => void = () => setEditingName(false),
  ) {
    event.preventDefault()
    onError('')
    setIsSavingName(true)
    try {
      const updatedUser = await updateProfile(
        { displayName: displayNameDraft },
        t('account.displayNameUpdated'),
      )
      setDisplayNameDraft(updatedUser.displayName)
      onSaved()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('account.displayNameFailed'))
    } finally {
      setIsSavingName(false)
    }
  }

  async function saveLanguage(value: string) {
    onError('')
    setIsSavingLanguage(true)
    try {
      await updateProfile({ language: value }, t('account.languageUpdated'))
      setMobileChoice(null)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('account.languageFailed'))
    } finally {
      setIsSavingLanguage(false)
    }
  }

  async function saveTheme(value: string) {
    onError('')
    setIsSavingTheme(true)
    try {
      await updateProfile({ theme: value }, t('account.themeUpdated'))
      setMobileChoice(null)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('account.themeFailed'))
    } finally {
      setIsSavingTheme(false)
    }
  }

  async function saveTimezone(value: string) {
    onError('')
    setIsSavingTimezone(true)
    try {
      await updateProfile({ timezone: value }, t('account.timezoneUpdated'))
      setMobileChoice(null)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('account.timezoneFailed'))
    } finally {
      setIsSavingTimezone(false)
    }
  }

  function openEmailEditor() {
    setEditingEmail(true)
    setEmailCodeRequested(false)
    setPendingEmail('')
  }

  function closeEmailEditor() {
    if (isSavingEmail) return
    resetEmailEditor()
  }

  function resetEmailEditor() {
    setEditingEmail(false)
    setEmailCodeRequested(false)
    setPendingEmail('')
  }

  async function handleEmailRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onError('')
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') || '').trim()
    setIsSavingEmail(true)
    try {
      await onSensitiveAction(() =>
        apiRequest<{ ok: boolean; expiresAt: string }>(
          '/api/auth/profile/email/request/',
          {
            method: 'POST',
            body: JSON.stringify({ email }),
          },
        ),
      )
      setPendingEmail(email)
      setEmailCodeRequested(true)
      onMessage(t('account.emailCodeSent'))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('account.emailRequestFailed'))
    } finally {
      setIsSavingEmail(false)
    }
  }

  async function handleEmailConfirm(
    event: FormEvent<HTMLFormElement>,
    onConfirmed: () => void = resetEmailEditor,
  ) {
    event.preventDefault()
    onError('')
    const form = new FormData(event.currentTarget)
    setIsSavingEmail(true)
    try {
      const payload = await apiRequest<{ user: User }>('/api/auth/profile/email/confirm/', {
        method: 'POST',
        body: JSON.stringify({ code: form.get('code') }),
      })
      onUserChange(payload.user)
      onConfirmed()
      onMessage(t('account.emailChanged'))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('account.emailConfirmFailed'))
    } finally {
      setIsSavingEmail(false)
    }
  }

  async function deleteAccount(password: string) {
    setDeleteError('')
    setIsDeletingAccount(true)
    try {
      const action = () =>
        apiRequest<{ ok: boolean }>('/api/auth/account/delete/', {
          method: 'POST',
          body: JSON.stringify({ password }),
        })
      await (localPasswordLoginEnabled ? action() : onSensitiveAction(action))
      setDeleteStep(null)
      onAccountDeleted()
    } catch (error) {
      setDeleteError(
        error instanceof Error && error.message === 'current_password_invalid'
          ? t('account.incorrectPassword')
          : error instanceof Error
            ? error.message
            : t('account.deletionFailed'),
      )
    } finally {
      setIsDeletingAccount(false)
    }
  }

  async function handleAccountDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const password = String(new FormData(event.currentTarget).get('password') || '')
    await deleteAccount(password)
  }

  const desktopNameEditor = editingName ? (
    <form className="inlineEditForm accountNameEditForm" onSubmit={(event) => void handleNameSubmit(event)}>
      <input
        name="displayName"
        value={displayNameDraft}
        onChange={(event) => setDisplayNameDraft(event.currentTarget.value)}
        autoComplete="name"
        autoFocus
        placeholder={user.username}
      />
      <button type="submit" className="iconAction saveNameAction" disabled={isSavingName} title={t('common.save')} aria-label={t('common.save')}>
        <Icon name="check-circle-1-light" />
      </button>
      <button type="button" className="iconAction cancelNameAction" disabled={isSavingName} title={t('common.cancel')} aria-label={t('common.cancel')} onClick={cancelNameEditing}>
        <Icon name="close-light" />
      </button>
    </form>
  ) : (
    <div className="accountValueWithAction primary">
      <div className="accountPrimaryText accountDesktopOnly">{accountName}</div>
      <div className="accountPrimaryText accountMobileOnly">{visibleName}</div>
      <button type="button" className="iconAction ghost" onClick={startNameEditing} title={t('account.editDisplayName')} aria-label={t('account.editDisplayName')}>
        <Icon name="edit-light" />
      </button>
    </div>
  )

  function renderMobileNameForm(closeAction: () => void) {
    return (
      <form
        className="accountMobileSheetForm"
        onSubmit={(event) => void handleNameSubmit(event, closeAction)}
      >
        <label className="dialogField">
          <span>{t('account.displayName')}</span>
          <input
            name="displayName"
            value={displayNameDraft}
            onChange={(event) => setDisplayNameDraft(event.currentTarget.value)}
            autoComplete="name"
            autoFocus
            placeholder={user.username}
          />
        </label>
        <div className="dialogActions">
          <button type="button" className="secondary" disabled={isSavingName} onClick={closeAction}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={isSavingName}>
            {isSavingName ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    )
  }

  function renderEmailForm(closeAction: () => void = closeEmailEditor) {
    if (!isMobile) {
      return (
        <form
          className="accountInlinePanel desktopEmailInlinePanel"
          onSubmit={(event) => void (
            emailCodeRequested
              ? handleEmailConfirm(event, closeAction)
              : handleEmailRequest(event)
          )}
        >
          <p>
            {emailCodeRequested
              ? t('account.emailCodeLead', { email: pendingEmail })
              : t('account.emailChangeLead')}
          </p>
          <div className="accountEmailInlineEdit">
            <input
              key={emailCodeRequested ? 'code' : 'email'}
              name={emailCodeRequested ? 'code' : 'email'}
              type={emailCodeRequested ? 'text' : 'email'}
              inputMode={emailCodeRequested ? 'numeric' : undefined}
              autoComplete={emailCodeRequested ? 'one-time-code' : 'email'}
              defaultValue={emailCodeRequested ? '' : user.email}
              aria-label={emailCodeRequested ? t('account.confirmationCode') : t('account.newEmail')}
              autoFocus
              required
            />
            <button
              type="submit"
              className={`iconAction ${emailCodeRequested ? 'emailConfirmAction' : 'emailSendAction'}`}
              disabled={isSavingEmail}
              title={emailCodeRequested ? t('common.confirm') : t('account.sendCode')}
              aria-label={emailCodeRequested ? t('common.confirm') : t('account.sendCode')}
            >
              <Icon name={emailCodeRequested ? 'check-circle-1-light' : 'plain-light'} />
            </button>
            <button
              type="button"
              className="iconAction cancelNameAction"
              disabled={isSavingEmail}
              title={t('common.cancel')}
              aria-label={t('common.cancel')}
              onClick={closeAction}
            >
              <Icon name="close-light" />
            </button>
          </div>
        </form>
      )
    }

    return (
    <form
      className={isMobile ? 'accountMobileSheetForm' : 'accountInlinePanel'}
      onSubmit={(event) => void (
        emailCodeRequested
          ? handleEmailConfirm(event, closeAction)
          : handleEmailRequest(event)
      )}
    >
      <p>
        {emailCodeRequested
          ? t('account.emailCodeLead', { email: pendingEmail })
          : t('account.emailChangeLead')}
      </p>
      <label className="dialogField">
        <span>{emailCodeRequested ? t('account.confirmationCode') : t('account.newEmail')}</span>
        <input
          key={emailCodeRequested ? 'code' : 'email'}
          name={emailCodeRequested ? 'code' : 'email'}
          type={emailCodeRequested ? 'text' : 'email'}
          inputMode={emailCodeRequested ? 'numeric' : undefined}
          autoComplete={emailCodeRequested ? 'one-time-code' : 'email'}
          defaultValue={emailCodeRequested ? '' : user.email}
          autoFocus
          required
        />
      </label>
      <div className="dialogActions">
        <button type="button" className="secondary" disabled={isSavingEmail} onClick={closeAction}>
          {t('common.cancel')}
        </button>
        <button type="submit" disabled={isSavingEmail}>
          {isSavingEmail
            ? t('common.saving')
            : emailCodeRequested
              ? t('common.confirm')
              : t('account.sendCode')}
        </button>
      </div>
    </form>
    )
  }

  const choiceConfig = mobileChoice === 'language'
    ? {
        title: t('common.language'),
        value: user.language,
        busy: isSavingLanguage,
        options: [
          { value: 'en', label: 'English' },
          { value: 'ru', label: 'Русский' },
        ],
        save: saveLanguage,
      }
    : mobileChoice === 'theme'
      ? {
          title: t('theme.label'),
          value: user.theme,
          busy: isSavingTheme,
          options: [
            { value: 'system', label: t('theme.system') },
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ],
          save: saveTheme,
        }
      : mobileChoice === 'timezone'
        ? {
            title: t('account.timezone'),
            value: user.timezone,
            busy: isSavingTimezone,
            options: timezoneOptions
              .filter((timezone) => timezone.toLocaleLowerCase().includes(timezoneQuery.trim().toLocaleLowerCase()))
              .map((timezone) => ({ value: timezone, label: timezone })),
            save: saveTimezone,
          }
        : null

  return (
    <div className="settingsStack accountSettingsStack">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hiddenFileInput"
        onChange={(event) => void handleAvatarChange(event)}
      />

      {!isMobile && <div className="accountDesktopOnly accountDesktopLayout">
        <section className="settingsPanel accountPanel accountSummaryCard">
          <button type="button" className="avatarUploadButton" onClick={() => fileInputRef.current?.click()} disabled={isSavingAvatar} title={t('account.uploadPhoto')} aria-label={t('account.uploadPhoto')}>
            <span className="avatarPreview large">
              {user.avatarUrl ? <img src={`${API_BASE}${user.avatarUrl}`} alt="" /> : avatarInitial}
            </span>
          </button>

          <div className="accountDetails">
            <div className="accountEditableRow nameRow">{desktopNameEditor}</div>
            <div className="accountEditableRow">
              <span className="accountFieldLabel">{t('account.email')}</span>
              <span className="accountValueWithAction">
                <span className="accountFieldValue">{user.email}</span>
                <button type="button" className="iconAction ghost" onClick={editingEmail ? closeEmailEditor : openEmailEditor} title={t('account.editEmail')} aria-label={t('account.editEmail')}>
                  <Icon name={editingEmail ? 'close-light' : 'edit-light'} />
                </button>
              </span>
            </div>
            {editingEmail && renderEmailForm()}

            <label className="accountLanguageRow">
              <span className="accountFieldLabel">{t('common.language')}</span>
              <CustomSelect value={user.language} disabled={isSavingLanguage} onChange={(event) => void saveLanguage(event.currentTarget.value)}>
                <option value="en">English</option>
                <option value="ru">Русский</option>
              </CustomSelect>
              {isSavingLanguage && <small>{t('common.saving')}</small>}
            </label>
            <label className="accountLanguageRow">
              <span className="accountFieldLabel">{t('account.timezone')}</span>
              <CustomSelect value={user.timezone} disabled={isSavingTimezone} onChange={(event) => void saveTimezone(event.currentTarget.value)}>
                {timezoneOptions.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
              </CustomSelect>
              {isSavingTimezone && <small>{t('common.saving')}</small>}
            </label>
            <label className="accountLanguageRow">
              <span className="accountFieldLabel">{t('theme.label')}</span>
              <CustomSelect value={user.theme} disabled={isSavingTheme} onChange={(event) => void saveTheme(event.currentTarget.value)}>
                <option value="system">{t('theme.system')}</option>
                <option value="light">{t('theme.light')}</option>
                <option value="dark">{t('theme.dark')}</option>
              </CustomSelect>
              {isSavingTheme && <small>{t('common.saving')}</small>}
            </label>
          </div>
        </section>

        {desktopServicePages}

        {showAccountExport && (
          <AccountExportPanel
            onSensitiveAction={onSensitiveAction}
            onMessage={onMessage}
            onError={onError}
          />
        )}

        <section className="settingsPanel riskZoneCard accountDesktopRiskZone">
          <div>
            <h2>{t('account.riskZone')}</h2>
            <p>{t('account.riskZoneLead')}</p>
          </div>
          <button type="button" className="dangerButton" onClick={() => { setDeleteError(''); setDeleteStep('warning') }}>
            {t('account.deleteAccount')}
          </button>
        </section>
      </div>}

      {isMobile && <div className="accountMobileOnly accountMobileLayout">
        <section className="accountMobileProfile">
          <button type="button" className="avatarUploadButton" onClick={() => fileInputRef.current?.click()} disabled={isSavingAvatar} title={t('account.uploadPhoto')} aria-label={t('account.uploadPhoto')}>
            <span className="avatarPreview large">
              {user.avatarUrl ? <img src={`${API_BASE}${user.avatarUrl}`} alt="" /> : avatarInitial}
            </span>
          </button>
          <div className="accountMobileName">
            <div className="accountPrimaryText">{visibleName}</div>
          </div>
        </section>

        <section className="accountMobileSettingsList">
          <MobileAccountRow
            icon="user-id-light"
            title={t('account.displayName')}
            subtitle={user.displayName || t('account.displayNameEmptyLead')}
            disabled={isSavingName}
            onClick={startNameEditing}
          />
          <MobileAccountRow icon="email-light" title={t('account.email')} subtitle={user.email} onClick={openEmailEditor} />
          <MobileAccountRow icon="global-light" title={t('common.language')} subtitle={languageLabel} disabled={isSavingLanguage} onClick={() => setMobileChoice('language')} />
          <MobileAccountRow
            icon="clock-circle-light"
            title={t('account.timezone')}
            subtitle={user.timezone}
            disabled={isSavingTimezone}
            onClick={() => {
              setTimezoneQuery('')
              setMobileChoice('timezone')
            }}
          />
          <MobileAccountRow icon="sun-light" title={t('theme.label')} subtitle={themeLabel} disabled={isSavingTheme} onClick={() => setMobileChoice('theme')} />
        </section>

        {servicePages.length > 0 && (
          <section className="accountMobileServicePages">
            <h2>{t('account.servicePages')}</h2>
            <div className="accountMobileSettingsList">
              {servicePages.map((page) => (
                <a
                  key={page.slug}
                  className="accountMobileSettingRow"
                  href={page.path}
                  onClick={(event) => openServicePage(event, page.path)}
                >
                  <span className="accountMobileSettingIcon"><Icon name="file-document-light" /></span>
                  <span className="accountMobileSettingCopy">
                    <strong>{t(servicePageLabelKey(page.slug))}</strong>
                    <small>{t('account.servicePageOpen')}</small>
                  </span>
                  <Icon name="arrow-right-2" />
                </a>
              ))}
            </div>
          </section>
        )}

        {showAccountExport && (
          <AccountExportPanel
            mobile
            onSensitiveAction={onSensitiveAction}
            onMessage={onMessage}
            onError={onError}
          />
        )}

        <section className="accountMobileDangerZone">
          <h2>{t('account.riskZone')}</h2>
          <div className="accountMobileSettingsList">
            <MobileAccountRow
              icon="trash-bin-trash-light"
              title={t('account.deleteAccountShort')}
              subtitle={t('account.riskZoneMobileLead')}
              danger
              onClick={() => {
                setDeleteError('')
                setDeleteStep('warning')
              }}
            />
          </div>
        </section>
      </div>}

      {isMobile && editingName && (
        <AccountDialog
          title={t('account.changeDisplayName')}
          onClose={cancelNameEditing}
          busy={isSavingName}
        >
          {(close) => renderMobileNameForm(close)}
        </AccountDialog>
      )}

      {isMobile && editingEmail && (
        <AccountDialog title={t('account.changeEmail')} onClose={closeEmailEditor} busy={isSavingEmail}>
          {(close) => renderEmailForm(close)}
        </AccountDialog>
      )}

      {choiceConfig && (
        <MobileLibraryActionSheet
          open
          title={choiceConfig.title}
          backdropClassName="accountChoiceSheetBackdrop"
          topContent={mobileChoice === 'timezone' ? (
            <label className="accountTimezoneSearch">
              <Icon name="magnifer-outline" />
              <input
                value={timezoneQuery}
                type="search"
                placeholder={t('account.searchTimezone')}
                aria-label={t('account.searchTimezone')}
                onChange={(event) => setTimezoneQuery(event.currentTarget.value)}
              />
            </label>
          ) : undefined}
          onClose={() => {
            if (!choiceConfig.busy) setMobileChoice(null)
          }}
          actions={choiceConfig.options.map((option) => ({
            key: option.value,
            label: option.label,
            icon: option.value === choiceConfig.value
              ? <Icon name="check-circle-1-light" />
              : <span className="accountChoicePlaceholder" aria-hidden="true" />,
            selected: option.value === choiceConfig.value,
            disabled: choiceConfig.busy,
            onSelect: () => void choiceConfig.save(option.value),
          }))}
        />
      )}

      {deleteStep && (
        <AccountDialog
          title={t('account.deleteAccountShort')}
          onClose={() => {
            if (!isDeletingAccount) setDeleteStep(null)
          }}
          busy={isDeletingAccount}
          role="alertdialog"
        >
          {(close) => deleteStep === 'warning' ? (
            <div className="accountDeleteDialogContent">
              <p>{t('account.deleteWarning')}</p>
              <div className="dialogActions">
                <button type="button" className="secondary" disabled={isDeletingAccount} onClick={close}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="dangerButton"
                  onClick={() => {
                    setDeleteError('')
                    if (localPasswordLoginEnabled) setDeleteStep('password')
                    else void deleteAccount('')
                  }}
                  disabled={isDeletingAccount}
                >
                  {t('common.continue')}
                </button>
              </div>
            </div>
          ) : (
            <form className="actionDialogForm accountDeleteForm" onSubmit={(event) => void handleAccountDelete(event)}>
              <p>{t('account.deleteConfirm')}</p>
              <input name="password" type="password" autoComplete="current-password" autoFocus required />
              {deleteError && <div className="notice error">{deleteError}</div>}
              <div className="dialogActions">
                <button type="button" className="secondary" disabled={isDeletingAccount} onClick={close}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="dangerButton" disabled={isDeletingAccount}>
                  {isDeletingAccount ? t('account.deleting') : t('account.deletePermanently')}
                </button>
              </div>
            </form>
          )}
        </AccountDialog>
      )}
    </div>
  )
}
