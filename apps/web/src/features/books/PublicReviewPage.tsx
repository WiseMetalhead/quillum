import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { JSONContent } from '@tiptap/core'
import type { TFunction } from 'i18next'
import { TextAlign } from '@tiptap/extension-text-align'
import { EditorContent, useEditor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { useTranslation } from 'react-i18next'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { ThemeToggle } from '../shared/ThemeToggle'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { Brand } from '../shared/Brand'
import type { AnnotationAuthor, DocumentAnnotation } from './Annotations'
import { AnnotationAnchor, setAnnotationPresentation } from './AnnotationAnchor'
import { ResizableIllustration } from './ResizableIllustration'
import { SceneBreak } from './SceneBreak'
import './PublicReviewPage.css'

type ReviewDocument = {
  id: string
  title: string
  content: JSONContent
  schemaVersion: number
  saveGeneration: number
  updatedAt: string
}

type ReviewPayload = {
  locked: boolean
  hasPassword?: boolean
  share?: {
    title: string
    manuscriptTitle: string
    accessLevel: 'view' | 'comment'
    scopeType: 'oneshot' | 'document' | 'folder'
    authorName: string
  }
  participant?: { id: string; displayName: string } | null
  documents?: ReviewDocument[]
  annotations?: DocumentAnnotation[]
}

const publicReviewNavigationMeta = 'publicReviewNavigation'

const reviewErrorKeys: Record<string, string> = {
  review_share_not_found: 'publicReview.shareNotFound',
  review_password_invalid: 'publicReview.passwordInvalid',
  review_password_required: 'publicReview.passwordRequired',
  review_display_name_required: 'publicReview.displayNameRequired',
  annotation_selection_lost: 'publicReview.selectionLost',
  review_selection_required: 'publicReview.selectionRequired',
  review_document_not_found: 'publicReview.documentNotFound',
  review_share_unavailable: 'publicReview.unavailable',
  review_document_text_changed: 'publicReview.documentTextChanged',
  document_save_conflict: 'publicReview.documentConflict',
}

function reviewErrorMessage(error: string, t: TFunction) {
  const key = reviewErrorKeys[error]
  return key ? t(key) : error
}

type AnnotationDraft = {
  documentId: string
  quote: string
}

type ReviewDocumentHandle = {
  applyAnnotation: (annotationId: string) => JSONContent | null
  removeAnnotation: (annotationId: string) => void
  focusAnnotation: (annotationId: string) => void
}

type Props = {
  token: string
}

export function PublicReviewPage({ token }: Props) {
  const { t, i18n } = useTranslation()
  const [payload, setPayload] = useState<ReviewPayload | null>(null)
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([])
  const [draft, setDraft] = useState<AnnotationDraft | null>(null)
  const [commentBody, setCommentBody] = useState('')
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null)
  const [mobileSelection, setMobileSelection] = useState<AnnotationDraft | null>(null)
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false)
  const [mobileCommentsOpen, setMobileCommentsOpen] = useState(false)
  const [mobileCommentTargetId, setMobileCommentTargetId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const documentRefs = useRef<Record<string, ReviewDocumentHandle | null>>({})
  const isMobileViewport = useMobileViewport()

  const loadReview = useCallback(async (active = true) => {
    setLoading(true)
    setError('')
    try {
      const nextPayload = await apiRequest<ReviewPayload>(`/api/manuscripts/review/${token}/`)
      if (active) {
        setPayload(nextPayload)
        setAnnotations(nextPayload.annotations ?? [])
      }
    } catch (err) {
      if (active) {
        setError(err instanceof Error ? err.message : i18n.t('publicReview.openFailed'))
      }
    } finally {
      if (active) {
        setLoading(false)
      }
    }
  }, [i18n, token])

  useEffect(() => {
    let active = true
    async function loadInitialReview() {
      await apiRequest<{ csrfToken: string }>('/api/auth/csrf/')
      await loadReview(active)
    }
    void loadInitialReview()
    return () => {
      active = false
    }
  }, [loadReview])

  async function unlock() {
    if (!password.trim() || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await apiRequest(`/api/manuscripts/review/${token}/unlock/`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      setPassword('')
      await loadReview()
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t('publicReview.unlockFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function ensureParticipant() {
    if (payload?.participant) return payload.participant
    const name = displayName.trim()
    if (!name) {
      setError('review_display_name_required')
      return null
    }
    const nextPayload = await apiRequest<{ participant: { id: string; displayName: string } }>(
      `/api/manuscripts/review/${token}/participant/`,
      {
        method: 'POST',
        body: JSON.stringify({ displayName: name }),
      },
    )
    setPayload((current) => current ? { ...current, participant: nextPayload.participant } : current)
    return nextPayload.participant
  }

  async function createComment(): Promise<boolean> {
    if (!draft || !commentBody.trim() || submitting) return false
    setSubmitting(true)
    setError('')
    try {
      const participant = await ensureParticipant()
      if (!participant) return false
      const created = await apiRequest<{ annotation: DocumentAnnotation }>(
        `/api/manuscripts/review/${token}/documents/${draft.documentId}/annotations/`,
        {
          method: 'POST',
          body: JSON.stringify({ quote: draft.quote, comment: commentBody }),
        },
      )
      const documentHandle = documentRefs.current[draft.documentId]
      const content = documentHandle?.applyAnnotation(created.annotation.id)
      if (!content) throw new Error('annotation_selection_lost')
      const sourceDocument = payload?.documents?.find((document) => document.id === draft.documentId)
      if (!sourceDocument) throw new Error('review_document_not_found')
      const documentPayload = await apiRequest<{ document: ReviewDocument }>(
        `/api/manuscripts/review/${token}/documents/${draft.documentId}/anchors/`,
        {
          method: 'PUT',
          body: JSON.stringify({
            content,
            schemaVersion: sourceDocument.schemaVersion,
            expectedGeneration: sourceDocument.saveGeneration,
          }),
        },
      )
      setPayload((current) => current && current.documents ? {
        ...current,
        participant,
        documents: current.documents.map((document) => (
          document.id === draft.documentId ? { ...document, ...documentPayload.document } : document
        )),
      } : current)
      setAnnotations((current) => [...current, { ...created.annotation, detached: false }])
      setActiveAnnotationId(created.annotation.id)
      setDraft(null)
      setCommentBody('')
      setMobileSelection(null)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t('publicReview.createCommentFailed'))
    } finally {
      setSubmitting(false)
    }
    return false
  }

  async function addReply(annotation: DocumentAnnotation, body: string): Promise<boolean> {
    if (!body.trim() || submitting) return false
    setSubmitting(true)
    setError('')
    try {
      const replyPayload = await apiRequest<{ reply: DocumentAnnotation['replies'][number] }>(
        `/api/manuscripts/review/${token}/annotations/${annotation.id}/replies/`,
        { method: 'POST', body: JSON.stringify({ body }) },
      )
      setAnnotations((current) => current.map((item) => (
        item.id === annotation.id
          ? { ...item, replies: [...item.replies, replyPayload.reply] }
          : item
      )))
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t('publicReview.addReplyFailed'))
    } finally {
      setSubmitting(false)
    }
    return false
  }

  async function deleteComment(annotation: DocumentAnnotation): Promise<boolean> {
    if (submitting) return false
    setSubmitting(true)
    setError('')
    try {
      const response = await apiRequest<{ document: ReviewDocument }>(
        `/api/manuscripts/review/${token}/annotations/${annotation.id}/`,
        { method: 'DELETE' },
      )
      if (annotation.documentId) {
        documentRefs.current[annotation.documentId]?.removeAnnotation(annotation.id)
      }
      setAnnotations((current) => current.filter((item) => item.id !== annotation.id))
      setPayload((current) => current && current.documents ? {
        ...current,
        documents: current.documents.map((document) => (
          document.id === annotation.documentId ? { ...document, ...response.document } : document
        )),
      } : current)
      if (activeAnnotationId === annotation.id) {
        setActiveAnnotationId(null)
      }
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t('publicReview.deleteCommentFailed'))
    } finally {
      setSubmitting(false)
    }
    return false
  }

  const documents = payload?.documents ?? []
  const share = payload?.share
  const commentsEnabled = share?.accessLevel === 'comment'
  const reviewAssetUrl = useCallback(
    (assetId: string) => `${API_BASE}/api/manuscripts/review/${token}/assets/${assetId}/large/`,
    [token],
  )

  if (loading) {
    return <TadpoleLoadingState className="publicReviewState" label={t('publicReview.opening')} />
  }

  if (payload?.locked) {
    return (
      <main className="publicReviewShell">
        <ReviewHeader />
        <section className="reviewPasswordCard">
          <h1>{t('publicReview.protectedLink')}</h1>
          <input
            autoFocus
            value={password}
            type="password"
            placeholder={t('publicReview.password')}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void unlock()
            }}
          />
          <button type="button" className="reviewPrimaryButton spaceButton" disabled={submitting} onClick={() => void unlock()}>
            {t('publicReview.unlock')}
          </button>
          {error && <p className="reviewError">{reviewErrorMessage(error, t)}</p>}
        </section>
      </main>
    )
  }

  if (!share) {
    return (
      <main className="publicReviewShell">
        <ReviewHeader />
        <div className="publicReviewState">
          {reviewErrorMessage(error || 'review_share_unavailable', t)}
        </div>
      </main>
    )
  }

  return (
    <main className="publicReviewShell publicReviewReadingShell">
      <ReviewHeader />
      <section className={`publicReviewWorkspace ${commentsEnabled ? '' : 'noComments'}`}>
        <article className="reviewDocumentCard">
          <header className="publicReviewMobileDocumentHeader">
            <span className="publicReviewMobileHeaderSlot" aria-hidden="true" />
            <h1 className="publicReviewMobileTitle">
              <button
                type="button"
                className="publicReviewMobileTitleButton spaceButton"
                aria-label={t('publicReview.reviewDetails', { title: share.title })}
                aria-haspopup="dialog"
                aria-expanded={mobileInfoOpen}
                onClick={() => setMobileInfoOpen(true)}
              >
                <span>{share.title}</span>
              </button>
            </h1>
            {commentsEnabled ? (
              <button
                type="button"
                className="publicReviewMobileHeaderAction spaceButton"
                aria-label={t('editorShell.comments')}
                onClick={() => {
                  setMobileCommentTargetId(null)
                  setMobileCommentsOpen(true)
                }}
              >
                <Icon name="chat-line-light" />
              </button>
            ) : <span className="publicReviewMobileHeaderSlot" aria-hidden="true" />}
          </header>
          <header className="reviewDocumentHeader">
            <div className="reviewDocumentHeading">
              <span>{share.manuscriptTitle}</span>
            </div>
            <h1>{share.title}</h1>
            <small>{share.authorName}</small>
          </header>
          <div className="reviewTextSurface">
            {documents.map((document, index) => (
              <ReviewDocumentView
                key={document.id}
                ref={(handle) => { documentRefs.current[document.id] = handle }}
                document={document}
                assetUrl={reviewAssetUrl}
                interactiveAnnotations={commentsEnabled}
                activeAnnotationId={activeAnnotationId}
                annotations={commentsEnabled
                  ? annotations.filter((annotation) => annotation.documentId === document.id)
                  : []}
                onDraft={setDraft}
                mobilePresentation={isMobileViewport}
                onMobileSelectionChange={setMobileSelection}
                onActivate={(annotationId) => {
                  setActiveAnnotationId(annotationId)
                  if (isMobileViewport && annotationId) {
                    setMobileCommentTargetId(annotationId)
                    setMobileCommentsOpen(true)
                  }
                }}
              >
                {index > 0 && <div className="reviewSceneSeparator">* * *</div>}
              </ReviewDocumentView>
            ))}
          </div>
        </article>

        {commentsEnabled && (
          <aside className="reviewCommentsPanel">
            <header className="reviewCommentsHeader">
              <button type="button" className="reviewAddCommentButton spaceButton" onClick={() => {
                if (!draft) setError('review_selection_required')
              }}>
                <Icon name="chat-line-light" />
                {t('publicReview.addComment')}
              </button>
            </header>
            {!payload.participant && (
              <label className="reviewNameField">
                <span>{t('publicReview.yourName')}</span>
                <input
                  value={displayName}
                  maxLength={80}
                  placeholder={t('publicReview.namePlaceholder')}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
            )}
            {draft && (
              <div className="reviewComposer">
                <Quote text={draft.quote} />
                <textarea
                  value={commentBody}
                  placeholder={t('publicReview.writeComment')}
                  onChange={(event) => setCommentBody(event.target.value)}
                />
                <div>
                  <button type="button" className="spaceButton" onClick={() => setDraft(null)} disabled={submitting}>
                    {t('common.cancel')}
                  </button>
                  <button type="button" className="reviewPrimaryButton spaceButton" onClick={() => void createComment()} disabled={submitting || !commentBody.trim()}>
                    {t('publicReview.comment')}
                  </button>
                </div>
              </div>
            )}
            <ReviewCommentList
              annotations={annotations}
              activeAnnotationId={activeAnnotationId}
              onActivate={(annotation) => {
                const nextActiveId = activeAnnotationId === annotation.id ? null : annotation.id
                setActiveAnnotationId(nextActiveId)
                if (nextActiveId && annotation.documentId) {
                  documentRefs.current[annotation.documentId]?.focusAnnotation(annotation.id)
                }
              }}
              onReply={addReply}
              onDelete={deleteComment}
            />
            {error && <p className="reviewError">{reviewErrorMessage(error, t)}</p>}
          </aside>
        )}
        {commentsEnabled && isMobileViewport && mobileSelection && !draft && (
          <button
            type="button"
            className="publicReviewMobileCommentButton spaceButton"
            aria-label={t('publicReview.addComment')}
            onClick={() => {
              setDraft(mobileSelection)
              setMobileSelection(null)
              setError('')
            }}
          >
            <Icon name="chat-line-light" />
          </button>
        )}
      </section>
      {isMobileViewport && mobileInfoOpen && (
        <PublicReviewMobileInfoPopup
          title={share.title}
          manuscriptTitle={share.manuscriptTitle}
          authorName={share.authorName}
          onClose={() => setMobileInfoOpen(false)}
        />
      )}
      {commentsEnabled && isMobileViewport && draft && (
        <PublicReviewMobileCommentSheet
          draft={draft}
          displayName={displayName}
          body={commentBody}
          participantExists={Boolean(payload.participant)}
          busy={submitting}
          error={error ? reviewErrorMessage(error, t) : ''}
          onDisplayNameChange={setDisplayName}
          onBodyChange={setCommentBody}
          onClose={() => {
            setDraft(null)
            setCommentBody('')
            setMobileSelection(null)
            window.getSelection()?.removeAllRanges()
          }}
          onSubmit={createComment}
        />
      )}
      {commentsEnabled && isMobileViewport && mobileCommentsOpen && (
        <PublicReviewMobileComments
          open={mobileCommentsOpen}
          annotations={annotations}
          targetId={mobileCommentTargetId}
          busy={submitting}
          error={error ? reviewErrorMessage(error, t) : ''}
          onClose={() => {
            setMobileCommentsOpen(false)
            setMobileCommentTargetId(null)
          }}
          onTargetChange={setMobileCommentTargetId}
          onActivate={(annotation) => {
            setActiveAnnotationId(annotation.id)
            if (annotation.documentId) {
              documentRefs.current[annotation.documentId]?.focusAnnotation(annotation.id)
            }
          }}
          onLocate={(annotation) => {
            setActiveAnnotationId(annotation.id)
            if (annotation.documentId) {
              documentRefs.current[annotation.documentId]?.focusAnnotation(annotation.id)
            }
            setMobileCommentsOpen(false)
            setMobileCommentTargetId(null)
          }}
          onReply={addReply}
          onDelete={deleteComment}
        />
      )}
    </main>
  )
}

function ReviewHeader() {
  const { t } = useTranslation()
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  return (
    <>
      <header className="publicReviewHeader">
        <Brand />
        <nav>
          <ThemeToggle />
          <div className="publicReviewDesktopAccountLinks">
            <a href="/login">{t('publicReview.logIn')}</a>
            <a className="primaryLink" href="/registration">{t('publicReview.signUp')}</a>
          </div>
          <button
            type="button"
            className={`publicReviewMobileAccountButton spaceButton ${accountMenuOpen ? 'active' : ''}`}
            aria-label={t('publicReview.accountMenu')}
            aria-haspopup="dialog"
            aria-expanded={accountMenuOpen}
            onClick={() => setAccountMenuOpen(true)}
          >
            <Icon name="profile-light" />
          </button>
        </nav>
      </header>
      <MobileLibraryActionSheet
        open={accountMenuOpen}
        title={t('publicReview.accountActions')}
        dismissOnSelect
        onClose={() => setAccountMenuOpen(false)}
        actions={[
          {
            key: 'login',
            label: t('publicReview.logIn'),
            icon: <Icon name="profile-light" />,
            onSelect: () => window.location.assign('/login'),
          },
          {
            key: 'registration',
            label: t('publicReview.signUp'),
            icon: <Icon name="user-light" />,
            onSelect: () => window.location.assign('/registration'),
          },
        ]}
      />
    </>
  )
}

function PublicReviewMobileInfoPopup({
  title,
  manuscriptTitle,
  authorName,
  onClose,
}: {
  title: string
  manuscriptTitle: string
  authorName: string
  onClose: () => void
}) {
  const titleId = useId()
  const popupRef = useRef<HTMLElement>(null)
  const { backdropStateClass, close, closing, setDialogRef } = useMobileDialogTransition({
    onClose,
    initialFocusRef: popupRef,
  })
  const setPopupRef = useCallback((node: HTMLElement | null) => {
    popupRef.current = node
    setDialogRef(node)
  }, [setDialogRef])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      document.body.style.overflow = previousOverflow
    }
  }, [close])

  return createPortal(
    <div
      className={`publicReviewMobileInfoBackdrop ${backdropStateClass}`}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !closing) close()
      }}
    >
      <section
        className="publicReviewMobileInfoPopup"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={setPopupRef}
      >
        <h2 id={titleId}>{title}</h2>
        <div>
          <strong>{manuscriptTitle}</strong>
          <span>{authorName}</span>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function PublicReviewMobileCommentSheet({
  draft,
  displayName,
  body,
  participantExists,
  busy,
  error,
  onDisplayNameChange,
  onBodyChange,
  onClose,
  onSubmit,
}: {
  draft: AnnotationDraft
  displayName: string
  body: string
  participantExists: boolean
  busy: boolean
  error: string
  onDisplayNameChange: (value: string) => void
  onBodyChange: (value: string) => void
  onClose: () => void
  onSubmit: () => Promise<boolean>
}) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={t('publicReview.addComment')} busy={busy} onClose={onClose}>
      {(close) => (
        <form className="publicReviewMobileCommentForm" onSubmit={(event) => {
          event.preventDefault()
          void onSubmit().then((created) => created && close())
        }}>
          <Quote text={draft.quote} />
          {!participantExists && (
            <label>
              <span>{t('publicReview.yourName')}</span>
              <input
                value={displayName}
                maxLength={80}
                placeholder={t('publicReview.namePlaceholder')}
                onChange={(event) => onDisplayNameChange(event.target.value)}
              />
            </label>
          )}
          <textarea
            value={body}
            maxLength={10_000}
            placeholder={t('publicReview.writeComment')}
            onChange={(event) => onBodyChange(event.target.value)}
          />
          {error && <p className="reviewError">{error}</p>}
          <footer>
            <button type="button" className="dialogCancel spaceButton" disabled={busy} onClick={close}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit spaceButton" disabled={busy || !body.trim() || (!participantExists && !displayName.trim())}>{t('publicReview.comment')}</button>
          </footer>
        </form>
      )}
    </MobileSettingsSheet>
  )
}

function PublicReviewMobileComments({
  open,
  annotations,
  targetId,
  busy,
  error,
  onClose,
  onTargetChange,
  onActivate,
  onLocate,
  onReply,
  onDelete,
}: {
  open: boolean
  annotations: DocumentAnnotation[]
  targetId: string | null
  busy: boolean
  error: string
  onClose: () => void
  onTargetChange: (annotationId: string | null) => void
  onActivate: (annotation: DocumentAnnotation) => void
  onLocate: (annotation: DocumentAnnotation) => void
  onReply: (annotation: DocumentAnnotation, body: string) => Promise<boolean>
  onDelete: (annotation: DocumentAnnotation) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const initialTarget = targetId
    ? annotations.find((annotation) => annotation.id === targetId) ?? null
    : null
  const [filter, setFilter] = useState<'open' | 'resolved'>(initialTarget?.status ?? 'open')
  const [menuTarget, setMenuTarget] = useState<DocumentAnnotation | null>(null)
  const [replyTarget, setReplyTarget] = useState<DocumentAnnotation | null>(null)
  const [replyBody, setReplyBody] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<DocumentAnnotation | null>(null)
  const titleId = useId()
  const backRef = useRef<HTMLButtonElement>(null)
  const {
    backdropStateClass,
    close,
    closing,
    setDialogRef,
  } = useMobileDialogTransition({ onClose, initialFocusRef: backRef })
  const target = targetId
    ? annotations.find((annotation) => annotation.id === targetId) ?? null
    : null
  const visibleAnnotations = annotations.filter((annotation) => annotation.status === filter)

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  useEffect(() => {
    if (!open || targetId || menuTarget || replyTarget || deleteTarget) return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [close, deleteTarget, menuTarget, open, replyTarget, targetId])

  return (
    <>
      {open && createPortal(
        <div className={`dialogBackdrop publicReviewMobileCommentsBackdrop mobileFullViewBackdrop ${backdropStateClass}`} role="presentation">
          <section className="publicReviewMobileCommentsView mobileFullView" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={setDialogRef}>
            <header>
              <button ref={backRef} type="button" className="mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={closing} onClick={close}>
                <Icon name="arrow-left-1" />
              </button>
              <div className="mobileDialogHeaderCopy"><h2 id={titleId}>{t('editorShell.comments')}</h2></div>
            </header>
            <div className="publicReviewMobileCommentsBody">
              {error && <p className="publicReviewMobileCommentsError">{error}</p>}
              {visibleAnnotations.length === 0 ? (
                <div className="publicReviewMobileCommentsEmpty">
                  <strong>{t(filter === 'open' ? 'comments.noOpen' : 'comments.noResolved')}</strong>
                  <span>{t('publicReview.noCommentsLead')}</span>
                </div>
              ) : (
                <ul className="publicReviewMobileCommentList">
                  {visibleAnnotations.map((annotation) => (
                    <li key={annotation.id}>
                      <button
                        type="button"
                        className="publicReviewMobileCommentRow spaceButton"
                        disabled={busy}
                        onClick={() => {
                          onActivate(annotation)
                          onTargetChange(annotation.id)
                        }}
                      >
                        <strong>{reviewAuthorName(annotation.author, t('publicReview.reviewer'))}</strong>
                        <span>{annotation.comment}</span>
                        {annotation.detached && <small>{t('comments.textDeleted')}</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <nav className="publicReviewMobileCommentsBottomBar" role="tablist" aria-label={t('comments.status')}>
              <button type="button" role="tab" className={`spaceButton ${filter === 'open' ? 'active' : ''}`} aria-selected={filter === 'open'} onClick={() => setFilter('open')}>
                <Icon name="dialog-2-light" /><span>{t('comments.open')}</span>
              </button>
              <button type="button" role="tab" className={`spaceButton ${filter === 'resolved' ? 'active' : ''}`} aria-selected={filter === 'resolved'} onClick={() => setFilter('resolved')}>
                <Icon name="check-read-light" /><span>{t('comments.resolved')}</span>
              </button>
            </nav>
          </section>
        </div>,
        document.body,
      )}

      {open && target && (
        <PublicReviewMobileCommentDetail
          annotation={target}
          busy={busy}
          actionsOpen={menuTarget?.id === target.id}
          onClose={() => onTargetChange(null)}
          onActions={() => setMenuTarget(target)}
          onLocate={() => onLocate(target)}
          onReply={() => setReplyTarget(target)}
        />
      )}

      <MobileLibraryActionSheet
        open={menuTarget !== null}
        title={menuTarget ? reviewAuthorName(menuTarget.author, t('publicReview.reviewer')) : t('comments.actions')}
        dismissOnSelect
        backdropClassName="publicReviewMobileCommentActionBackdrop"
        onClose={() => setMenuTarget(null)}
        actions={menuTarget?.canDelete ? [{
          key: 'delete',
          label: t('common.delete'),
          icon: <Icon name="trash-bin-trash-light" />,
          danger: true,
          disabled: busy,
          onSelect: () => setDeleteTarget(menuTarget),
        }] : []}
      />

      {replyTarget && (
        <PublicReviewMobileReplySheet
          body={replyBody}
          busy={busy}
          error={error}
          onBodyChange={setReplyBody}
          onClose={() => {
            setReplyTarget(null)
            setReplyBody('')
          }}
          onSubmit={async () => {
            const replied = await onReply(replyTarget, replyBody)
            if (replied) setReplyBody('')
            return replied
          }}
        />
      )}

      {deleteTarget && (
        <PublicReviewMobileDeleteSheet
          busy={busy}
          error={error}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const deleted = await onDelete(deleteTarget)
            if (deleted) onTargetChange(null)
            return deleted
          }}
        />
      )}
    </>
  )
}

function PublicReviewMobileCommentDetail({
  annotation,
  busy,
  actionsOpen,
  onClose,
  onActions,
  onLocate,
  onReply,
}: {
  annotation: DocumentAnnotation
  busy: boolean
  actionsOpen: boolean
  onClose: () => void
  onActions: () => void
  onLocate: () => void
  onReply: () => void
}) {
  const { t, i18n } = useTranslation()
  const titleId = useId()
  const backRef = useRef<HTMLButtonElement>(null)
  const { backdropStateClass, close, closing, setDialogRef } = useMobileDialogTransition({
    onClose,
    initialFocusRef: backRef,
  })
  const locale = i18n.resolvedLanguage ?? 'en'
  useEffect(() => {
    if (actionsOpen) return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [actionsOpen, close])

  return createPortal(
    <div className={`dialogBackdrop publicReviewMobileCommentDetailBackdrop mobileFullViewBackdrop ${backdropStateClass}`} role="presentation">
      <section className="publicReviewMobileCommentDetailView mobileFullView" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={setDialogRef}>
        <header>
          <button ref={backRef} type="button" className="mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={closing} onClick={close}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy"><h2 id={titleId}>{t('comments.detailTitle')}</h2></div>
          {annotation.canDelete && (
            <button type="button" className={`publicReviewMobileCommentActions spaceButton ${actionsOpen ? 'active' : ''}`} aria-label={t('comments.actions')} aria-haspopup="dialog" aria-expanded={actionsOpen} disabled={busy || closing} onClick={onActions}>
              <Icon name="menu-dots-light" />
            </button>
          )}
        </header>
        <div className="publicReviewMobileCommentDetailBody">
          <Quote text={annotation.quote} />
          <article className="publicReviewMobileCommentMessage root">
            <PublicReviewMobileCommentAuthor author={annotation.author} createdAt={annotation.createdAt} locale={locale} />
            <p>{annotation.comment}</p>
          </article>
          {annotation.replies.length > 0 && (
            <section className="publicReviewMobileCommentReplies" aria-label={t('comments.replies')}>
              {annotation.replies.map((reply) => (
                <article key={reply.id} className="publicReviewMobileCommentMessage reply">
                  <PublicReviewMobileCommentAuthor author={reply.author} createdAt={reply.createdAt} locale={locale} />
                  <p>{reply.body}</p>
                </article>
              ))}
            </section>
          )}
        </div>
        <nav className="publicReviewMobileCommentDetailBottomBar" aria-label={t('comments.detailActions')}>
          <button type="button" className="spaceButton" aria-label={t('publicReview.showInText')} title={t('publicReview.showInText')} disabled={busy} onClick={onLocate}>
            <Icon name="arrow-to-top-left-light" />
          </button>
          <button type="button" className="spaceButton" aria-label={t('comments.reply')} title={t('comments.reply')} disabled={busy} onClick={onReply}>
            <Icon name="chat-line-light" />
          </button>
        </nav>
      </section>
    </div>,
    document.body,
  )
}

function PublicReviewMobileCommentAuthor({
  author,
  createdAt,
  locale,
}: {
  author: AnnotationAuthor
  createdAt: string
  locale: string
}) {
  const { t } = useTranslation()
  const name = reviewAuthorName(author, t('publicReview.reviewer'))
  return (
    <header className="publicReviewMobileCommentAuthor">
      <span className="reviewCommentAvatar">{name.charAt(0)}</span>
      <span>
        <strong>{name}</strong>
        <time dateTime={createdAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(createdAt))}</time>
      </span>
    </header>
  )
}

function PublicReviewMobileReplySheet({
  body,
  busy,
  error,
  onBodyChange,
  onClose,
  onSubmit,
}: {
  body: string
  busy: boolean
  error: string
  onBodyChange: (value: string) => void
  onClose: () => void
  onSubmit: () => Promise<boolean>
}) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={t('comments.reply')} busy={busy} onClose={onClose}>
      {(close) => (
        <form className="publicReviewMobileCommentForm" onSubmit={(event) => {
          event.preventDefault()
          void onSubmit().then((replied) => replied && close())
        }}>
          <textarea value={body} maxLength={10_000} placeholder={t('comments.replyPlaceholder')} onChange={(event) => onBodyChange(event.target.value)} />
          {error && <p className="reviewError">{error}</p>}
          <footer>
            <button type="button" className="dialogCancel spaceButton" disabled={busy} onClick={close}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit spaceButton" disabled={busy || !body.trim()}>{t('comments.reply')}</button>
          </footer>
        </form>
      )}
    </MobileSettingsSheet>
  )
}

function PublicReviewMobileDeleteSheet({
  busy,
  error,
  onClose,
  onConfirm,
}: {
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: () => Promise<boolean>
}) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={t('comments.deleteTitle')} role="alertdialog" initialFocus="dialog" busy={busy} onClose={onClose}>
      {(close) => (
        <div className="publicReviewMobileDeleteComment">
          <p>{t('comments.deleteDiscussionLead')}</p>
          {error && <p className="reviewError">{error}</p>}
          <footer>
            <button type="button" className="dialogCancel spaceButton" disabled={busy} onClick={close}>{t('common.cancel')}</button>
            <button type="button" className="dialogSubmit danger spaceButton" disabled={busy} onClick={() => void onConfirm().then((deleted) => deleted && close())}>{t('common.delete')}</button>
          </footer>
        </div>
      )}
    </MobileSettingsSheet>
  )
}

function reviewAuthorName(author: AnnotationAuthor, fallback: string) {
  return author?.displayName || author?.username || fallback
}

const ReviewDocumentView = forwardRef<ReviewDocumentHandle, {
  document: ReviewDocument
  assetUrl: (assetId: string) => string
  interactiveAnnotations: boolean
  annotations: DocumentAnnotation[]
  activeAnnotationId: string | null
  children?: ReactNode
  onDraft: (draft: AnnotationDraft | null) => void
  mobilePresentation: boolean
  onMobileSelectionChange: (draft: AnnotationDraft | null) => void
  onActivate: (annotationId: string | null) => void
}>(function ReviewDocumentView({
  document,
  assetUrl,
  interactiveAnnotations,
  annotations,
  activeAnnotationId,
  children,
  onDraft,
  mobilePresentation,
  onMobileSelectionChange,
  onActivate,
}, ref) {
  const { t, i18n } = useTranslation()
  const selectionRef = useRef<{ from: number; to: number; quote: string } | null>(null)
  const annotationIds = useMemo(
    () => new Set(annotations.map((annotation) => annotation.id)),
    [annotations],
  )
  const annotationIdsRef = useRef(annotationIds)
  const mobilePresentationRef = useRef(mobilePresentation)
  const onActivateRef = useRef(onActivate)
  const onDraftRef = useRef(onDraft)
  const onMobileSelectionChangeRef = useRef(onMobileSelectionChange)
  useEffect(() => {
    annotationIdsRef.current = annotationIds
  }, [annotationIds])
  useEffect(() => {
    mobilePresentationRef.current = mobilePresentation
    onActivateRef.current = onActivate
    onDraftRef.current = onDraft
    onMobileSelectionChangeRef.current = onMobileSelectionChange
  }, [mobilePresentation, onActivate, onDraft, onMobileSelectionChange])
  const extensions = useMemo(() => [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: { levels: [1, 2, 3] },
      horizontalRule: false,
      link: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      trailingNode: false,
      underline: false,
    }),
    TextAlign.configure({
      types: ['paragraph', 'heading'],
      alignments: ['left', 'center', 'right'],
      defaultAlignment: 'left',
    }),
    SceneBreak,
    ResizableIllustration.configure({ assetUrl }),
    AnnotationAnchor,
  ], [assetUrl])
  const editor = useEditor({
    injectCSS: false,
    extensions,
    content: document.content,
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'tiptapEditor publicReviewEditor',
        'aria-label': t('publicReview.reviewText', { title: document.title }),
      },
      handleClick: (_view, _position, event) => {
        if (!interactiveAnnotations) return false
        const element = (event.target as HTMLElement).closest<HTMLElement>('[data-annotation-id]')
        const annotationId = element?.dataset.annotationId
        if (!annotationId) {
          onActivateRef.current(null)
          return false
        }
        if (!annotationIdsRef.current.has(annotationId)) return false
        onActivateRef.current(annotationId)
        return false
      },
    },
    onSelectionUpdate: ({ editor: currentEditor, transaction }) => {
      if (!interactiveAnnotations) return
      if (transaction.getMeta(publicReviewNavigationMeta)) return
      const selection = currentEditor.state.selection
      if (selection.empty) {
        selectionRef.current = null
        if (mobilePresentationRef.current) onMobileSelectionChangeRef.current(null)
        return
      }
      const quote = currentEditor.state.doc.textBetween(selection.from, selection.to, '\n').trim()
      if (!quote) {
        selectionRef.current = null
        if (mobilePresentationRef.current) onMobileSelectionChangeRef.current(null)
        return
      }
      selectionRef.current = { from: selection.from, to: selection.to, quote }
      if (mobilePresentationRef.current) {
        onMobileSelectionChangeRef.current({ documentId: document.id, quote })
      } else {
        onDraftRef.current({ documentId: document.id, quote })
      }
    },
  })

  useEffect(() => {
    editor?.setOptions({
      editorProps: {
        attributes: {
          class: 'tiptapEditor publicReviewEditor',
          'aria-label': t('publicReview.reviewText', { title: document.title }),
        },
      },
    })
  }, [document.title, editor, i18n.resolvedLanguage, t])

  useEffect(() => {
    if (!editor) return
    setAnnotationPresentation(
      editor,
      activeAnnotationId,
      annotations.filter((annotation) => annotation.status === 'resolved').map((annotation) => annotation.id),
    )
  }, [activeAnnotationId, annotations, editor])

  useImperativeHandle(ref, () => ({
    applyAnnotation(annotationId: string) {
      if (!editor || !selectionRef.current) return null
      const { from, to, quote } = selectionRef.current
      if (from >= to || to > editor.state.doc.content.size) return null
      if (editor.state.doc.textBetween(from, to, '\n').trim() !== quote) return null
      const mark = editor.schema.marks.annotationAnchor.create({ annotationId })
      let transaction = editor.state.tr
      editor.state.doc.nodesBetween(from, to, (node, position) => {
        if (!node.isText) return
        const markFrom = Math.max(from, position)
        const markTo = Math.min(to, position + node.nodeSize)
        if (markFrom < markTo) transaction = transaction.addMark(markFrom, markTo, mark)
      })
      transaction = transaction.setSelection(TextSelection.create(transaction.doc, from, to))
        .setMeta(publicReviewNavigationMeta, true)
      editor.view.dispatch(transaction)
      setAnnotationPresentation(editor, annotationId, [])
      window.getSelection()?.removeAllRanges()
      editor.view.dom.blur()
      selectionRef.current = null
      onMobileSelectionChangeRef.current(null)
      return editor.getJSON()
    },
    removeAnnotation(annotationId: string) {
      if (!editor) return
      let transaction = editor.state.tr
      editor.state.doc.descendants((node, position) => {
        if (!node.isText) return
        for (const mark of node.marks) {
          if (mark.type.name === 'annotationAnchor' && mark.attrs.annotationId === annotationId) {
            transaction = transaction.removeMark(position, position + node.nodeSize, mark)
          }
        }
      })
      if (transaction.docChanged) editor.view.dispatch(transaction)
      setAnnotationPresentation(editor, null, [])
    },
    focusAnnotation(annotationId: string) {
      if (!editor || !annotationIdsRef.current.has(annotationId)) return
      let from: number | null = null
      let to: number | null = null
      editor.state.doc.descendants((node, position) => {
        if (!node.isText || from !== null) return
        if (node.marks.some((mark) => mark.type.name === 'annotationAnchor' && mark.attrs.annotationId === annotationId)) {
          from = position
          to = position + node.nodeSize
        }
      })
      if (from === null || to === null) return
      editor.view.dispatch(
        editor.state.tr
          .setSelection(TextSelection.create(editor.state.doc, from, to))
          .setMeta(publicReviewNavigationMeta, true),
      )
      editor.view.dom.querySelector(`[data-annotation-id="${CSS.escape(annotationId)}"]`)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      })
    },
  }), [editor])

  return (
    <section className="reviewDocumentSegment">
      {children}
      <EditorContent editor={editor} />
    </section>
  )
})

function ReviewCommentList({
  annotations,
  activeAnnotationId,
  onActivate,
  onReply,
  onDelete,
}: {
  annotations: DocumentAnnotation[]
  activeAnnotationId: string | null
  onActivate: (annotation: DocumentAnnotation) => void
  onReply: (annotation: DocumentAnnotation, body: string) => Promise<boolean>
  onDelete: (annotation: DocumentAnnotation) => Promise<boolean>
}) {
  const { t, i18n } = useTranslation()
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({})
  return (
    <div className="reviewCommentList">
      {annotations.length === 0 ? (
        <div className="reviewCommentsEmptyState">
          <strong>{t('publicReview.noComments')}</strong>
          <span>{t('publicReview.noCommentsLead')}</span>
        </div>
      ) : annotations.map((annotation) => (
        <article
          key={annotation.id}
          className={`reviewCommentCard ${activeAnnotationId === annotation.id ? 'active' : ''}`}
          onClick={() => onActivate(annotation)}
        >
          <Quote text={annotation.quote} />
          <div className="reviewCommentMeta">
            <span className="reviewCommentAvatar">{(annotation.author?.displayName || '?').charAt(0)}</span>
            <div>
              <strong>{annotation.author?.displayName || t('publicReview.reviewer')}</strong>
              <small>{new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(annotation.createdAt))}</small>
            </div>
            {annotation.canDelete && (
              <button
                type="button"
                className="reviewCommentDelete spaceButton"
                onClick={(event) => {
                  event.stopPropagation()
                  void onDelete(annotation)
                }}
              >
                {t('publicReview.delete')}
              </button>
            )}
          </div>
          <p className="reviewCommentBody">{annotation.comment}</p>
          {annotation.replies.map((reply) => (
            <div key={reply.id} className="reviewCommentReply">
              <strong>{reply.author?.displayName || t('publicReview.reviewer')}</strong>
              <p>{reply.body}</p>
            </div>
          ))}
          <div className="reviewReplyComposer">
            <input
              value={replyBodies[annotation.id] ?? ''}
              placeholder={t('publicReview.replyPlaceholder')}
              onChange={(event) => setReplyBodies((current) => ({ ...current, [annotation.id]: event.target.value }))}
            />
            <button
              type="button"
              className="spaceButton"
              disabled={!replyBodies[annotation.id]?.trim()}
              onClick={(event) => {
                event.stopPropagation()
                const body = replyBodies[annotation.id] ?? ''
                void onReply(annotation, body).then(() => {
                  setReplyBodies((current) => ({ ...current, [annotation.id]: '' }))
                })
              }}
            >
              {t('publicReview.reply')}
            </button>
          </div>
        </article>
      ))}
    </div>
  )
}

function Quote({ text }: { text: string }) {
  return <blockquote className="reviewCommentQuote"><span>{text}</span></blockquote>
}
