import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'

export type ReviewShareScopeOption = {
  scopeType: 'oneshot' | 'document' | 'folder'
  itemId: string | null
  label: string
  description: string
  recommended?: boolean
}

type ReviewShare = {
  id: string
  accessLevel: 'view' | 'comment'
  scopeType: 'oneshot' | 'document' | 'folder'
  authorDisplay: 'account' | 'pen_name'
  itemId: string | null
  itemTitle: string
  hasPassword: boolean
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
  lastUsedAt: string | null
  urlToken?: string
}

type Props = {
  manuscriptId: string
  scopeOptions: ReviewShareScopeOption[]
  onClose: () => void
  onError: (error: string) => void
  onMessage: (message: string) => void
}

type MobileShareField = 'access' | 'scope' | 'author' | 'password' | 'expires'

function MobileReviewCreateDialog({ title, actionLabel, busy, actionDisabled, nestedOpen, onBack, onCreate, children }: {
  title: string
  actionLabel: string
  busy: boolean
  actionDisabled: boolean
  nestedOpen: boolean
  onBack: () => void
  onCreate: (afterCreate: () => void) => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const { backdropStateClass, close, closing } = useMobileDialogTransition({ onClose: onBack })

  return createPortal(
    <ActionDialog
      variant="structured"
      title={title}
      closeLabel={t('common.close')}
      mobileBackLabel={t('common.back')}
      mobileBackAction={close}
      mobilePrimaryAction={{
        label: actionLabel,
        icon: <Icon name="check-circle-1-light" />,
        onClick: () => onCreate(close),
        disabled: actionDisabled || closing,
      }}
      busy={busy || closing}
      className="reviewShareCreateMobileDialog mobileFullView"
      backdropClassName={`reviewShareCreateMobileBackdrop mobileFullViewBackdrop ${backdropStateClass}`}
      escapeAction={nestedOpen ? () => undefined : undefined}
      onClose={close}
    >
      {children}
    </ActionDialog>,
    document.body,
  )
}

function useMobileShareLongPress(enabled: boolean, onLongPress: () => void) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const onLongPressRef = useRef(onLongPress)

  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])

  function cancel() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (!enabled || event.pointerType === 'mouse' || event.button !== 0) return
      cancel()
      startRef.current = { x: event.clientX, y: event.clientY }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        startRef.current = null
        onLongPressRef.current()
      }, 520)
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      if (!startRef.current) return
      if (Math.hypot(event.clientX - startRef.current.x, event.clientY - startRef.current.y) > 10) cancel()
    },
    cancel,
    onContextMenu(event: ReactMouseEvent<HTMLElement>) {
      if (!enabled) return
      event.preventDefault()
      cancel()
      onLongPressRef.current()
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
      if (!enabled || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return
      event.preventDefault()
      cancel()
      onLongPressRef.current()
    },
  }
}

function MobileReviewShareRow({ share, locale, onActions }: {
  share: ReviewShare
  locale: string
  onActions: () => void
}) {
  const { t } = useTranslation()
  const longPress = useMobileShareLongPress(true, onActions)

  return (
    <li
      className="reviewShareMobileListItem"
      tabIndex={0}
      aria-label={t('reviewShare.actionsForLink')}
      aria-haspopup="dialog"
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.cancel}
      onPointerCancel={longPress.cancel}
      onPointerLeave={longPress.cancel}
      onContextMenu={longPress.onContextMenu}
      onKeyDown={longPress.onKeyDown}
    >
      <strong>{t(share.accessLevel === 'comment' ? 'reviewShare.viewComments' : 'reviewShare.viewOnly')}</strong>
      <small>
        {t(`reviewShare.scope${share.scopeType[0].toUpperCase()}${share.scopeType.slice(1)}`)}
        {share.hasPassword ? ` · ${t('reviewShare.passwordProtected')}` : ''}
        {share.expiresAt ? ` · ${t('reviewShare.expiresAt', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(share.expiresAt)) })}` : ''}
      </small>
    </li>
  )
}

export function ReviewShareDialog({
  manuscriptId,
  scopeOptions,
  onClose,
  onError,
  onMessage,
}: Props) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const [shares, setShares] = useState<ReviewShare[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [accessLevel, setAccessLevel] = useState<'view' | 'comment'>('comment')
  const [authorDisplay, setAuthorDisplay] = useState<'account' | 'pen_name'>('account')
  const [scopeIndex, setScopeIndex] = useState(() => {
    const recommended = scopeOptions.findIndex((option) => option.recommended)
    return recommended >= 0 ? recommended : 0
  })
  const [password, setPassword] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [newShareUrl, setNewShareUrl] = useState('')
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false)
  const [mobileFieldSheet, setMobileFieldSheet] = useState<MobileShareField | null>(null)
  const [mobileActionShare, setMobileActionShare] = useState<ReviewShare | null>(null)
  const [passwordDraft, setPasswordDraft] = useState('')
  const [expiresAtDraft, setExpiresAtDraft] = useState('')
  const { backdropStateClass, close: closeDialog, closing, setDialogRef } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !creating && !mobileCreateOpen && mobileFieldSheet === null && mobileActionShare === null) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, creating, mobileActionShare, mobileCreateOpen, mobileFieldSheet])

  useEffect(() => {
    let active = true
    async function loadShares() {
      setLoading(true)
      try {
        const payload = await apiRequest<{ items: ReviewShare[] }>(
          `/api/manuscripts/${manuscriptId}/review-shares/`,
        )
        if (active) setShares(payload.items)
      } catch (err) {
        onError(err instanceof Error ? err.message : i18n.t('reviewShare.loadFailed'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadShares()
    return () => {
      active = false
    }
  }, [i18n, manuscriptId, onError])

  const selectedScope = scopeOptions[Math.min(scopeIndex, scopeOptions.length - 1)]
  const activeShares = useMemo(
    () => shares.filter((share) => !share.revokedAt),
    [shares],
  )

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      onMessage(t('reviewShare.copied'))
    } catch {
      onMessage(url)
    }
  }

  async function createShare(afterCreate?: () => void) {
    if (!selectedScope || creating) return
    setCreating(true)
    setNewShareUrl('')
    try {
      const payload = await apiRequest<{ share: ReviewShare }>(
        `/api/manuscripts/${manuscriptId}/review-shares/`,
        {
          method: 'POST',
          body: JSON.stringify({
            accessLevel,
            authorDisplay,
            scopeType: selectedScope.scopeType,
            itemId: selectedScope.itemId,
            password,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          }),
        },
      )
      const url = `${window.location.origin}/review/${payload.share.urlToken}`
      setShares((current) => [payload.share, ...current])
      if (!isMobile) setNewShareUrl(url)
      await copyUrl(url)
      setPassword('')
      setExpiresAt('')
      onError('')
      afterCreate?.()
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n.t('reviewShare.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  async function revokeShare(share: ReviewShare) {
    try {
      const payload = await apiRequest<{ share: ReviewShare }>(
        `/api/manuscripts/review-shares/${share.id}/`,
        { method: 'DELETE' },
      )
      setShares((current) => current.map((item) => item.id === share.id ? payload.share : item))
      onMessage(t('reviewShare.revoked'))
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n.t('reviewShare.revokeFailed'))
    }
  }

  return (
    <div
      className={`dialogBackdrop mobileFullViewBackdrop reviewShareDialogBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creating) closeDialog()
      }}
    >
      <div className="createOneShotDialog reviewShareDialog mobileFullView" role="dialog" aria-modal="true" aria-labelledby="review-share-title" ref={setDialogRef}>
        <header>
          <button type="button" className="mobileDialogBack booksButton" aria-label={t('common.back')} onClick={closeDialog} disabled={creating || closing}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy">
            <h2 id="review-share-title">{t('reviewShare.title')}</h2>
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('reviewShare.close')} onClick={closeDialog} disabled={creating || closing}>
            <Icon name="close-square-light" />
          </button>
        </header>

        <div className="reviewShareDialogBody">
          {isMobile ? (
            <>
              <button type="button" className="reviewShareMobileCreateLink spaceButton" onClick={() => setMobileCreateOpen(true)}>
                <span>{t('reviewShare.createLink')}</span>
                <Icon name="arrow-right-2" />
              </button>
              <section className="reviewShareMobileList">
                <h3>{t('reviewShare.existingLinks')}</h3>
                {loading ? (
                  <TadpoleLoadingState className="reviewShareLoading" label={t('reviewShare.loading')} />
                ) : activeShares.length === 0 ? (
                  <p>{t('reviewShare.noActive')}</p>
                ) : (
                  <ul>
                    {activeShares.map((share) => (
                      <MobileReviewShareRow
                        key={share.id}
                        share={share}
                        locale={i18n.resolvedLanguage ?? 'en'}
                        onActions={() => setMobileActionShare(share)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <>
          <section className="reviewShareCreate">
            <div className="reviewShareModes" role="group" aria-label={t('reviewShare.accessLevel')}>
              <button
                type="button"
                className={`spaceButton ${accessLevel === 'comment' ? 'active' : ''}`}
                onClick={() => setAccessLevel('comment')}
              >
                {t('reviewShare.viewComments')}
              </button>
              <button
                type="button"
                className={`spaceButton ${accessLevel === 'view' ? 'active' : ''}`}
                onClick={() => setAccessLevel('view')}
              >
                {t('reviewShare.viewOnly')}
              </button>
            </div>

          <fieldset className="reviewShareScopes">
            <legend>{t('reviewShare.sharedText')}</legend>
            {scopeOptions.map((option, index) => (
              <label key={`${option.scopeType}:${option.itemId ?? 'none'}`}>
                <input
                  type="radio"
                  name="review-share-scope"
                  checked={scopeIndex === index}
                  onChange={() => setScopeIndex(index)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="reviewShareAuthorDisplay">
            <legend>{t('reviewShare.authorPreview')}</legend>
            <label>
              <input
                type="radio"
                name="review-author-display"
                checked={authorDisplay === 'account'}
                onChange={() => setAuthorDisplay('account')}
              />
              <span>{t('reviewShare.displayName')}</span>
            </label>
            <label>
              <input
                type="radio"
                name="review-author-display"
                checked={authorDisplay === 'pen_name'}
                onChange={() => setAuthorDisplay('pen_name')}
              />
              <span>{t('reviewShare.penName')}</span>
            </label>
          </fieldset>

          <div className="reviewShareFields">
            <label>
              <span>{t('reviewShare.password')}</span>
              <input
                value={password}
                maxLength={256}
                placeholder={t('reviewShare.optional')}
                type="password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              <span>{t('reviewShare.expires')}</span>
              <input
                value={expiresAt}
                type="datetime-local"
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            className="primary spaceButton"
            onClick={() => void createShare()}
            disabled={creating || !selectedScope}
          >
            {t(creating ? 'reviewShare.creating' : 'reviewShare.createCopy')}
          </button>

          {newShareUrl && (
            <div className="reviewShareNewLink">
              <input value={newShareUrl} readOnly />
              <button type="button" className="spaceButton" onClick={() => void copyUrl(newShareUrl)}>
                {t('reviewShare.copy')}
              </button>
            </div>
          )}
        </section>

        <section className="reviewShareList">
          <h3>{t('reviewShare.existingLinks')}</h3>
          {loading ? (
            <TadpoleLoadingState className="reviewShareLoading" label={t('reviewShare.loading')} />
          ) : activeShares.length === 0 ? (
            <p>{t('reviewShare.noActive')}</p>
          ) : (
            <ul>
              {activeShares.map((share) => (
                <li key={share.id}>
                  <div>
                    <strong>{t(share.accessLevel === 'comment' ? 'reviewShare.viewComments' : 'reviewShare.viewOnly')}</strong>
                    <small>
                      {t(`reviewShare.scope${share.scopeType[0].toUpperCase()}${share.scopeType.slice(1)}`)}
                      {share.hasPassword ? ` · ${t('reviewShare.passwordProtected')}` : ''}
                      {share.expiresAt ? ` · ${t('reviewShare.expiresAt', { date: new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(share.expiresAt)) })}` : ''}
                    </small>
                  </div>
                  <div className="reviewShareListActions">
                    <button
                      type="button"
                      className="spaceButton iconOnly"
                      disabled={!share.urlToken}
                      title={t('reviewShare.copy')}
                      aria-label={t('reviewShare.copy')}
                      onClick={() => share.urlToken && void copyUrl(`${window.location.origin}/review/${share.urlToken}`)}
                    >
                      <Icon name="clipboard-list-light" />
                    </button>
                    <button type="button" className="spaceButton iconOnly danger" title={t('reviewShare.revoke')} aria-label={t('reviewShare.revoke')} onClick={() => void revokeShare(share)}>
                      <Icon name="trash-bin-trash-light" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
            </>
          )}
        </div>
      </div>

      {isMobile && mobileCreateOpen && (
        <MobileReviewCreateDialog
          title={t('reviewShare.newLink')}
          actionLabel={t('reviewShare.createCopy')}
          busy={creating}
          actionDisabled={!selectedScope}
          nestedOpen={mobileFieldSheet !== null}
          onBack={() => {
            setMobileFieldSheet(null)
            setMobileCreateOpen(false)
          }}
          onCreate={(afterCreate) => void createShare(afterCreate)}
        >
          <div className="reviewShareMobileCreateBody">
            <button type="button" className="reviewShareMobileSettingLink spaceButton" onClick={() => setMobileFieldSheet('access')}>
              <span>
                <strong>{t('reviewShare.accessLevel')}</strong>
                <small>{t(accessLevel === 'comment' ? 'reviewShare.viewComments' : 'reviewShare.viewOnly')}</small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
            <button type="button" className="reviewShareMobileSettingLink spaceButton" onClick={() => setMobileFieldSheet('scope')}>
              <span>
                <strong>{t('reviewShare.sharedText')}</strong>
                <small>{selectedScope?.label}</small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
            <button type="button" className="reviewShareMobileSettingLink spaceButton" onClick={() => setMobileFieldSheet('author')}>
              <span>
                <strong>{t('reviewShare.authorPreview')}</strong>
                <small>{t(authorDisplay === 'account' ? 'reviewShare.displayName' : 'reviewShare.penName')}</small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
            <button
              type="button"
              className="reviewShareMobileSettingLink spaceButton"
              onClick={() => {
                setPasswordDraft(password)
                setMobileFieldSheet('password')
              }}
            >
              <span>
                <strong>{t('reviewShare.password')}</strong>
                <small>{t(password ? 'reviewShare.passwordProtected' : 'reviewShare.optional')}</small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
            <button
              type="button"
              className="reviewShareMobileSettingLink spaceButton"
              onClick={() => {
                setExpiresAtDraft(expiresAt)
                setMobileFieldSheet('expires')
              }}
            >
              <span>
                <strong>{t('reviewShare.expires')}</strong>
                <small>
                  {expiresAt
                    ? new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(expiresAt))
                    : t('reviewShare.optional')}
                </small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
          </div>
        </MobileReviewCreateDialog>
      )}

      <MobileLibraryActionSheet
        open={mobileFieldSheet === 'access'}
        title={t('reviewShare.accessLevel')}
        dismissOnSelect
        backdropClassName="reviewShareFieldSheetBackdrop"
        onClose={() => setMobileFieldSheet(null)}
        actions={[
          {
            key: 'comment',
            label: t('reviewShare.viewComments'),
            icon: accessLevel === 'comment' ? <Icon name="check-circle-1-light" /> : <span className="reviewShareChoicePlaceholder" aria-hidden="true" />,
            selected: accessLevel === 'comment',
            onSelect: () => setAccessLevel('comment'),
          },
          {
            key: 'view',
            label: t('reviewShare.viewOnly'),
            icon: accessLevel === 'view' ? <Icon name="check-circle-1-light" /> : <span className="reviewShareChoicePlaceholder" aria-hidden="true" />,
            selected: accessLevel === 'view',
            onSelect: () => setAccessLevel('view'),
          },
        ]}
      />

      <MobileLibraryActionSheet
        open={mobileFieldSheet === 'scope'}
        title={t('reviewShare.sharedText')}
        dismissOnSelect
        backdropClassName="reviewShareFieldSheetBackdrop"
        onClose={() => setMobileFieldSheet(null)}
        actions={scopeOptions.map((option, index) => ({
          key: `${option.scopeType}:${option.itemId ?? 'none'}`,
          label: option.label,
          icon: scopeIndex === index ? <Icon name="check-circle-1-light" /> : <span className="reviewShareChoicePlaceholder" aria-hidden="true" />,
          selected: scopeIndex === index,
          onSelect: () => setScopeIndex(index),
        }))}
      />

      <MobileLibraryActionSheet
        open={mobileFieldSheet === 'author'}
        title={t('reviewShare.authorPreview')}
        dismissOnSelect
        backdropClassName="reviewShareFieldSheetBackdrop"
        onClose={() => setMobileFieldSheet(null)}
        actions={[
          {
            key: 'account',
            label: t('reviewShare.displayName'),
            icon: authorDisplay === 'account' ? <Icon name="check-circle-1-light" /> : <span className="reviewShareChoicePlaceholder" aria-hidden="true" />,
            selected: authorDisplay === 'account',
            onSelect: () => setAuthorDisplay('account'),
          },
          {
            key: 'pen-name',
            label: t('reviewShare.penName'),
            icon: authorDisplay === 'pen_name' ? <Icon name="check-circle-1-light" /> : <span className="reviewShareChoicePlaceholder" aria-hidden="true" />,
            selected: authorDisplay === 'pen_name',
            onSelect: () => setAuthorDisplay('pen_name'),
          },
        ]}
      />

      <MobileLibraryActionSheet
        open={mobileFieldSheet === 'password'}
        title={t('reviewShare.password')}
        dismissOnSelect
        backdropClassName="reviewShareFieldSheetBackdrop"
        onClose={() => setMobileFieldSheet(null)}
        topContent={(
          <label className="reviewShareMobileSheetField">
            <span>{t('reviewShare.password')}</span>
            <input
              type="password"
              value={passwordDraft}
              maxLength={256}
              placeholder={t('reviewShare.optional')}
              onChange={(event) => setPasswordDraft(event.target.value)}
            />
          </label>
        )}
        actions={[{
          key: 'save',
          label: t('common.save'),
          icon: <Icon name="check-circle-1-light" />,
          onSelect: () => setPassword(passwordDraft),
        }]}
      />

      <MobileLibraryActionSheet
        open={mobileFieldSheet === 'expires'}
        title={t('reviewShare.expires')}
        dismissOnSelect
        backdropClassName="reviewShareFieldSheetBackdrop"
        onClose={() => setMobileFieldSheet(null)}
        topContent={(
          <label className="reviewShareMobileSheetField">
            <span>{t('reviewShare.expires')}</span>
            <input type="datetime-local" value={expiresAtDraft} onChange={(event) => setExpiresAtDraft(event.target.value)} />
          </label>
        )}
        actions={[{
          key: 'save',
          label: t('common.save'),
          icon: <Icon name="check-circle-1-light" />,
          onSelect: () => setExpiresAt(expiresAtDraft),
        }]}
      />

      <MobileLibraryActionSheet
        open={mobileActionShare !== null}
        title={mobileActionShare ? t(mobileActionShare.accessLevel === 'comment' ? 'reviewShare.viewComments' : 'reviewShare.viewOnly') : t('reviewShare.existingLinks')}
        dismissOnSelect
        backdropClassName="reviewShareActionsSheetBackdrop"
        onClose={() => setMobileActionShare(null)}
        actions={[
          {
            key: 'copy',
            label: t('reviewShare.copy'),
            icon: <Icon name="clipboard-list-light" />,
            disabled: !mobileActionShare?.urlToken,
            onSelect: () => {
              if (mobileActionShare?.urlToken) void copyUrl(`${window.location.origin}/review/${mobileActionShare.urlToken}`)
            },
          },
          {
            key: 'revoke',
            label: t('reviewShare.revoke'),
            icon: <Icon name="trash-bin-trash-light" />,
            danger: true,
            onSelect: () => {
              if (mobileActionShare) void revokeShare(mobileActionShare)
            },
          },
        ]}
      />
    </div>
  )
}
