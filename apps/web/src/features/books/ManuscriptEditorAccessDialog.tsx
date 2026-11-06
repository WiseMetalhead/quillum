import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { API_BASE, apiQuery, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { CustomSelect } from '../shared/CustomSelect'
import { PrivateImage } from '../shared/PrivateImage'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import type {
  EditorGrantIdentity,
  Manuscript,
  ManuscriptEditorGrantState,
} from './ManuscriptTypes'

type Props = {
  manuscript: Manuscript
  onClose: () => void
  onError: (error: string) => void
  onMessage: (message: string) => void
}

function identityName(identity: EditorGrantIdentity) {
  return identity.displayName.trim() || identity.username
}

function identityInitial(identity: EditorGrantIdentity) {
  return identityName(identity).slice(0, 1).toLocaleUpperCase() || '?'
}

export function ManuscriptEditorAccessDialog({
  manuscript,
  onClose,
  onError,
  onMessage,
}: Props) {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<ManuscriptEditorGrantState | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const busy = submitting || revokingId !== null
  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' })
  const {
    backdropStateClass,
    close: closeDialog,
    closing,
    setDialogRef,
  } = useMobileDialogTransition({ onClose })

  function applyState(next: ManuscriptEditorGrantState) {
    setState(next)
    setConnectionId((current) => (
      next.eligibleEditors.some((editor) => String(editor.connectionId) === current)
        ? current
        : next.eligibleEditors[0]
          ? String(next.eligibleEditors[0].connectionId)
          : ''
    ))
  }

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const payload = await apiQuery<ManuscriptEditorGrantState>(
          `/api/manuscripts/${manuscript.id}/editor-grants/`,
          {
            onBackgroundUpdate: (next) => {
              if (active) applyState(next)
            },
          },
        )
        if (active) applyState(payload)
      } catch (error) {
        if (active) {
          onError(error instanceof Error ? error.message : i18n.t('editorAccess.loadFailed'))
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [i18n, manuscript.id, onError])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [busy, closeDialog])

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connectionId || busy) return
    setSubmitting(true)
    onError('')
    try {
      const payload = await apiRequest<ManuscriptEditorGrantState>(
        `/api/manuscripts/${manuscript.id}/editor-grants/`,
        {
          method: 'POST',
          body: JSON.stringify({ connectionId: Number(connectionId) }),
        },
      )
      applyState(payload)
      onMessage(t('editorAccess.granted'))
    } catch (error) {
      onError(error instanceof Error ? error.message : t('editorAccess.grantFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function revoke(grantId: string) {
    if (busy) return
    setRevokingId(grantId)
    onError('')
    try {
      const payload = await apiRequest<ManuscriptEditorGrantState>(
        `/api/manuscripts/${manuscript.id}/editor-grants/${grantId}/`,
        { method: 'DELETE' },
      )
      applyState(payload)
      onMessage(t('editorAccess.revoked'))
    } catch (error) {
      onError(error instanceof Error ? error.message : t('editorAccess.revokeFailed'))
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div
      className={`dialogBackdrop mobileFullViewBackdrop editorAccessBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) closeDialog()
      }}
    >
      <div
        className="createOneShotDialog dialogScrollLayout mobileFullView editorAccessDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-access-title"
        ref={setDialogRef}
      >
        <header>
          <button
            type="button"
            className="mobileDialogBack booksButton"
            aria-label={t('common.back')}
            onClick={closeDialog}
            disabled={busy || closing}
          >
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy">
            <h2 id="editor-access-title">{t('editorAccess.title')}</h2>
            <p>{t('editorAccess.lead', { title: manuscript.title })}</p>
          </div>
          <button
            type="button"
            className="dialogClose booksButton"
            aria-label={t('common.close')}
            onClick={closeDialog}
            disabled={busy || closing}
          >
            <Icon name="close-square-light" />
          </button>
          <button
            type="submit"
            form="editor-access-form"
            className="mobileDialogPrimary booksButton"
            title={t(submitting ? 'editorAccess.granting' : 'editorAccess.grant')}
            aria-label={t(submitting ? 'editorAccess.granting' : 'editorAccess.grant')}
            disabled={loading || busy || closing || !connectionId}
          >
            <Icon name="link-circle-linear" />
          </button>
        </header>
        <form
          id="editor-access-form"
          className="mobileFullViewForm mobileHeaderActionForm editorAccessForm"
          onSubmit={(event) => void grant(event)}
        >
          <div className="dialogScrollBody editorAccessScrollBody">
            {loading ? (
              <TadpoleLoadingState className="editorAccessLoading" label={t('editorAccess.loading')} />
            ) : state ? (
              <div className="editorAccessContent">
                {state.eligibleEditors.length ? (
                  <label className="dialogField editorAccessGrantField">
                    <span>{t('editorAccess.chooseEditor')}</span>
                    <CustomSelect
                      required
                      value={connectionId}
                      disabled={busy}
                      onChange={(event) => setConnectionId(event.target.value)}
                    >
                      {state.eligibleEditors.map((editor) => (
                        <option key={editor.connectionId} value={editor.connectionId}>
                          {identityName(editor)}
                        </option>
                      ))}
                    </CustomSelect>
                  </label>
                ) : state.grants.length ? (
                  <p className="editorAccessHint">{t('editorAccess.allEditorsGranted')}</p>
                ) : (
                  <p className="editorAccessHint">{t('editorAccess.noConnectedEditors')}</p>
                )}

                <section className="editorAccessGranted" aria-labelledby="editor-access-granted-title">
                  <h3 id="editor-access-granted-title">{t('editorAccess.grantedTitle')}</h3>
                  {state.grants.length ? (
                    <div className="editorAccessGrantedList">
                      {state.grants.map((grantItem) => {
                        const editor = grantItem.editor
                        return (
                          <div className="editorAccessEditorRow" key={grantItem.id}>
                            <span className="editorAccessAvatar" aria-hidden="true">
                              {editor.avatarUrl ? (
                                <PrivateImage src={`${API_BASE}${editor.avatarUrl}`} alt="" />
                              ) : identityInitial(editor)}
                            </span>
                            <div>
                              <strong>{identityName(editor)}</strong>
                              <small>{t('editorAccess.grantedAt', {
                                date: dateFormatter.format(new Date(grantItem.grantedAt)),
                              })}</small>
                            </div>
                            <button
                              type="button"
                              className="editorAccessRevoke booksButton"
                              disabled={busy}
                              onClick={() => void revoke(grantItem.id)}
                            >
                              <Icon name="sign-minus-light" />
                              <span>{revokingId === grantItem.id
                                ? t('editorAccess.revoking')
                                : t('editorAccess.revoke')}</span>
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : <p className="editorAccessHint">{t('editorAccess.noGrants')}</p>}
                </section>
              </div>
            ) : (
              <p className="editorAccessHint">{t('editorAccess.loadFailed')}</p>
            )}
          </div>
          <footer>
            <button
              type="button"
              className="dialogCancel booksButton"
              onClick={closeDialog}
              disabled={busy || closing}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="dialogSubmit editorAccessGrantButton booksButton"
              disabled={loading || busy || !connectionId}
            >
              <Icon name="link-circle-linear" />
              {submitting ? t('editorAccess.granting') : t('editorAccess.grant')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
