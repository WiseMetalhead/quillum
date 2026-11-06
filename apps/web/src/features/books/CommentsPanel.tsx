import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { API_BASE, ApiError, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import type {
  AnnotationAuthor,
  AnnotationDraft,
  AnnotationReply,
  DocumentAnnotation,
} from './Annotations'
import { annotationsEndpoint, type ManuscriptAccessMode } from './ManuscriptEndpoints'

type DeleteTarget =
  | { kind: 'annotation'; annotationId: string }
  | { kind: 'reply'; annotationId: string; replyId: string }

type CommentsPanelProps = {
  mobilePresentation?: boolean
  mobileOpen?: boolean
  mobileTargetId?: string | null
  manuscriptId: string
  manuscriptKind: 'oneshot' | 'book'
  documentItemId: string | null
  annotations: DocumentAnnotation[]
  activeAnnotationId: string | null
  draft: AnnotationDraft | null
  onStartAnnotation: () => void
  onCancelDraft: () => void
  onCreated: (annotation: DocumentAnnotation) => boolean
  onAnnotationChange: (annotation: DocumentAnnotation) => void
  onDeleteAnnotation: (annotationId: string) => Promise<boolean>
  onActivate: (annotationId: string) => void
  onError: (error: string) => void
  onMobileTargetChange?: (annotationId: string | null) => void
  onMobileClose?: () => void
  accessMode?: ManuscriptAccessMode
  onAccessLost?: () => void
}

export function CommentsPanel({
  mobilePresentation = false,
  mobileOpen = false,
  mobileTargetId = null,
  manuscriptId,
  manuscriptKind,
  documentItemId,
  annotations,
  activeAnnotationId,
  draft,
  onStartAnnotation,
  onCancelDraft,
  onCreated,
  onAnnotationChange,
  onDeleteAnnotation,
  onActivate,
  onError,
  onMobileTargetChange,
  onMobileClose,
  accessMode = 'owner',
  onAccessLost,
}: CommentsPanelProps) {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState<'open' | 'resolved'>('open')
  const [draftBody, setDraftBody] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingBody, setEditingBody] = useState('')
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [mobileMenuTarget, setMobileMenuTarget] = useState<DeleteTarget | null>(null)
  const [mobileReplyId, setMobileReplyId] = useState<string | null>(null)
  const activeCardRef = useRef<HTMLElement>(null)
  const mobileTitleId = useId()
  const mobileBackRef = useRef<HTMLButtonElement>(null)
  const {
    backdropStateClass: mobileBackdropStateClass,
    close: closeMobileView,
    closing: mobileViewClosing,
    setDialogRef: setMobileViewRef,
  } = useMobileDialogTransition({
    onClose: onMobileClose ?? (() => undefined),
    initialFocusRef: mobileBackRef,
  })

  useEffect(() => {
    const card = activeCardRef.current
    const container = card?.closest<HTMLElement>('.commentCardList')
    if (!card || !container) return
    const cardRect = card.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    if (cardRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - cardRect.top
    } else if (cardRect.bottom > containerRect.bottom) {
      container.scrollTop += cardRect.bottom - containerRect.bottom
    }
  }, [activeAnnotationId])

  useEffect(() => {
    if (!menuId) return
    function closeMenu(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.commentMenu')) {
        setMenuId(null)
      }
    }
    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuId(null)
    }
    window.document.addEventListener('mousedown', closeMenu)
    window.document.addEventListener('keydown', closeMenuOnEscape)
    return () => {
      window.document.removeEventListener('mousedown', closeMenu)
      window.document.removeEventListener('keydown', closeMenuOnEscape)
    }
  }, [menuId])

  const visibleAnnotations = annotations.filter((annotation) => annotation.status === filter)

  function reportFailure(error: unknown, fallback: string) {
    if (accessMode === 'editor' && error instanceof ApiError && error.status === 404) {
      onAccessLost?.()
      return
    }
    onError(error instanceof Error ? error.message : fallback)
  }

  async function createAnnotation() {
    if (!draft || !draftBody.trim() || submitting) return false
    setSubmitting(true)
    try {
      const payload = await apiRequest<{ annotation: DocumentAnnotation }>(
        annotationsEndpoint({ id: manuscriptId, kind: manuscriptKind }, documentItemId, accessMode),
        {
          method: 'POST',
          body: JSON.stringify({ quote: draft.quote, comment: draftBody }),
        },
      )
      if (!onCreated({ ...payload.annotation, detached: false })) {
        throw new Error('annotation_selection_lost')
      }
      setDraftBody('')
      onError('')
      return true
    } catch (err) {
      reportFailure(err, i18n.t('comments.createFailed'))
    } finally {
      setSubmitting(false)
    }
    return false
  }

  async function updateAnnotation(annotation: DocumentAnnotation, patch: object) {
    setSubmitting(true)
    try {
      const payload = await apiRequest<{ annotation: DocumentAnnotation }>(
        accessMode === 'editor'
          ? `/api/editor/manuscripts/${manuscriptId}/annotations/${annotation.id}/`
          : `/api/manuscripts/annotations/${annotation.id}/`,
        {
          method: 'PATCH',
          body: JSON.stringify({ ...patch, expectedVersion: annotation.version }),
        },
      )
      onAnnotationChange(payload.annotation)
      onError('')
      return true
    } catch (err) {
      reportFailure(err, i18n.t('comments.updateFailed'))
    } finally {
      setSubmitting(false)
    }
    return false
  }

  async function addReply(annotation: DocumentAnnotation) {
    const body = replyBodies[annotation.id]?.trim()
    if (!body || submitting) return false
    setSubmitting(true)
    try {
      const payload = await apiRequest<{ reply: AnnotationReply }>(
        accessMode === 'editor'
          ? `/api/editor/manuscripts/${manuscriptId}/annotations/${annotation.id}/replies/`
          : `/api/manuscripts/annotations/${annotation.id}/replies/`,
        { method: 'POST', body: JSON.stringify({ body }) },
      )
      onAnnotationChange({
        ...annotation,
        replies: [...annotation.replies, payload.reply],
      })
      setReplyBodies((current) => ({ ...current, [annotation.id]: '' }))
      onError('')
      return true
    } catch (err) {
      reportFailure(err, i18n.t('comments.addReplyFailed'))
    } finally {
      setSubmitting(false)
    }
    return false
  }

  async function updateReply(annotation: DocumentAnnotation, reply: AnnotationReply) {
    if (!editingBody.trim() || submitting) return false
    setSubmitting(true)
    try {
      const payload = await apiRequest<{ reply: AnnotationReply }>(
        accessMode === 'editor'
          ? `/api/editor/manuscripts/${manuscriptId}/annotation-replies/${reply.id}/`
          : `/api/manuscripts/annotation-replies/${reply.id}/`,
        {
          method: 'PATCH',
          body: JSON.stringify({ body: editingBody, expectedVersion: reply.version }),
        },
      )
      onAnnotationChange({
        ...annotation,
        replies: annotation.replies.map((item) => item.id === reply.id ? payload.reply : item),
      })
      onError('')
      return true
    } catch (err) {
      reportFailure(err, i18n.t('comments.updateReplyFailed'))
    } finally {
      setSubmitting(false)
    }
    return false
  }

  async function confirmDelete() {
    if (!deleteTarget || submitting) return false
    setSubmitting(true)
    try {
      if (deleteTarget.kind === 'annotation') {
        if (!(await onDeleteAnnotation(deleteTarget.annotationId))) return false
      } else {
        const annotation = annotations.find((item) => item.id === deleteTarget.annotationId)
        if (annotation) {
          await apiRequest(accessMode === 'editor'
            ? `/api/editor/manuscripts/${manuscriptId}/annotation-replies/${deleteTarget.replyId}/`
            : `/api/manuscripts/annotation-replies/${deleteTarget.replyId}/`, {
            method: 'DELETE',
          })
          onAnnotationChange({
            ...annotation,
            replies: annotation.replies.filter((reply) => reply.id !== deleteTarget.replyId),
          })
        }
      }
      onError('')
      if (deleteTarget.kind === 'annotation') onMobileTargetChange?.(null)
      return true
    } catch (err) {
      reportFailure(err, i18n.t('comments.deleteFailed'))
    } finally {
      setSubmitting(false)
    }
    return false
  }

  function beginEdit(id: string, body: string) {
    setEditingId(id)
    setEditingBody(body)
    setMenuId(null)
  }

  const mobileAnnotation = mobileTargetId
    ? annotations.find((annotation) => annotation.id === mobileTargetId) ?? null
    : null
  const mobileMenuAnnotation = mobileMenuTarget?.kind === 'annotation'
    ? annotations.find((annotation) => annotation.id === mobileMenuTarget.annotationId) ?? null
    : mobileMenuTarget?.kind === 'reply'
      ? annotations.find((annotation) => annotation.id === mobileMenuTarget.annotationId) ?? null
      : null
  const mobileMenuReply = mobileMenuTarget?.kind === 'reply'
    ? mobileMenuAnnotation?.replies.find((reply) => reply.id === mobileMenuTarget.replyId) ?? null
    : null
  const editingAnnotation = editingId
    ? annotations.find((annotation) => annotation.id === editingId) ?? null
    : null
  const editingReplyContext = editingId
    ? annotations.map((annotation) => ({
        annotation,
        reply: annotation.replies.find((reply) => reply.id === editingId) ?? null,
      })).find((entry) => entry.reply !== null) ?? null
    : null
  const mobileReplyAnnotation = mobileReplyId
    ? annotations.find((annotation) => annotation.id === mobileReplyId) ?? null
    : null

  useEffect(() => {
    if (!mobilePresentation || !mobileOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      previousFocus?.focus({ preventScroll: true })
    }
  }, [mobileOpen, mobilePresentation])

  useEffect(() => {
    if (
      !mobilePresentation
      || !mobileOpen
      || mobileTargetId
      || mobileMenuTarget
      || draft
      || editingId
      || mobileReplyId
      || deleteTarget
    ) return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeMobileView()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [
    closeMobileView,
    deleteTarget,
    draft,
    editingId,
    mobileMenuTarget,
    mobileOpen,
    mobilePresentation,
    mobileReplyId,
    mobileTargetId,
  ])

  if (mobilePresentation) {
    const menuAuthor = mobileMenuReply?.author ?? mobileMenuAnnotation?.author ?? null
    const menuTitle = authorName(menuAuthor, t('comments.deletedUser'))
    return (
      <>
        {mobileOpen && createPortal(
          <div className={`dialogBackdrop mobileCommentsBackdrop mobileFullViewBackdrop ${mobileBackdropStateClass}`} role="presentation">
            <section className="mobileCommentsView mobileFullView" role="dialog" aria-modal="true" aria-labelledby={mobileTitleId} ref={setMobileViewRef}>
              <header>
                <button ref={mobileBackRef} type="button" className="mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={mobileViewClosing} onClick={closeMobileView}>
                  <Icon name="arrow-left-1" />
                </button>
                <div className="mobileDialogHeaderCopy"><h2 id={mobileTitleId}>{t('editorShell.comments')}</h2></div>
              </header>
              <div className="mobileCommentsBody">
                {visibleAnnotations.length === 0 ? (
                  <div className="mobileCommentsEmpty">
                    <strong>{t(filter === 'open' ? 'comments.noOpen' : 'comments.noResolved')}</strong>
                    <span>{t('comments.emptyLead')}</span>
                  </div>
                ) : (
                  <ul className="mobileCommentList">
                    {visibleAnnotations.map((annotation) => (
                      <li key={annotation.id}>
                        <button
                          type="button"
                          className="mobileCommentRow spaceButton"
                          disabled={submitting}
                          onClick={() => {
                            onActivate(annotation.id)
                            onMobileTargetChange?.(annotation.id)
                          }}
                        >
                          <strong>{authorName(annotation.author, t('comments.deletedUser'))}</strong>
                          <span>{annotation.comment}</span>
                          {annotation.detached && <small>{t('comments.textDeleted')}</small>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <nav className="mobileCommentsBottomBar" role="tablist" aria-label={t('comments.status')}>
                <button type="button" role="tab" className={`spaceButton ${filter === 'open' ? 'active' : ''}`} aria-selected={filter === 'open'} onClick={() => setFilter('open')}>
                  <Icon name="dialog-2-light" />
                  <span>{t('comments.open')}</span>
                </button>
                <button type="button" role="tab" className={`spaceButton ${filter === 'resolved' ? 'active' : ''}`} aria-selected={filter === 'resolved'} onClick={() => setFilter('resolved')}>
                  <Icon name="check-read-light" />
                  <span>{t('comments.resolved')}</span>
                </button>
              </nav>
            </section>
          </div>,
          document.body,
        )}

        {mobileOpen && mobileAnnotation && (
          <MobileCommentDetailView
            annotation={mobileAnnotation}
            busy={submitting}
            actionsOpen={mobileMenuTarget?.kind === 'annotation'
              && mobileMenuTarget.annotationId === mobileAnnotation.id}
            onClose={() => onMobileTargetChange?.(null)}
            onActions={() => setMobileMenuTarget({ kind: 'annotation', annotationId: mobileAnnotation.id })}
            onResolve={() => void updateAnnotation(mobileAnnotation, {
              status: mobileAnnotation.status === 'open' ? 'resolved' : 'open',
            })}
            onReply={() => setMobileReplyId(mobileAnnotation.id)}
            onReplyActions={(replyId) => setMobileMenuTarget({
              kind: 'reply',
              annotationId: mobileAnnotation.id,
              replyId,
            })}
          />
        )}

        <MobileLibraryActionSheet
          open={mobileMenuTarget !== null}
          title={menuTitle}
          dismissOnSelect
          backdropClassName="mobileCommentActionSheetBackdrop"
          onClose={() => setMobileMenuTarget(null)}
          actions={mobileMenuTarget ? [
            ...((mobileMenuReply?.canEdit ?? mobileMenuAnnotation?.canEdit) ? [{
              key: 'edit',
              label: t('comments.edit'),
              icon: <Icon name="edit-light" />,
              disabled: submitting,
              onSelect: () => beginEdit(
                mobileMenuReply?.id ?? mobileMenuAnnotation!.id,
                mobileMenuReply?.body ?? mobileMenuAnnotation!.comment,
              ),
            }] : []),
            ...((mobileMenuReply?.canDelete ?? mobileMenuAnnotation?.canDelete) ? [{
              key: 'delete',
              label: t('common.delete'),
              icon: <Icon name="trash-bin-trash-light" />,
              danger: true,
              disabled: submitting,
              onSelect: () => setDeleteTarget(mobileMenuTarget),
            }] : []),
          ] : []}
        />

        {draft && (
          <MobileCommentMessageSheet
            title={t('comments.addComment')}
            value={draftBody}
            placeholder={t('comments.writeComment')}
            submitLabel={t('comments.comment')}
            busy={submitting}
            quote={draft.quote}
            onChange={setDraftBody}
            onClose={() => {
              setDraftBody('')
              onCancelDraft()
            }}
            onSubmit={createAnnotation}
          />
        )}

        {mobileReplyAnnotation && (
          <MobileCommentMessageSheet
            title={t('comments.reply')}
            value={replyBodies[mobileReplyAnnotation.id] ?? ''}
            placeholder={t('comments.replyPlaceholder')}
            submitLabel={t('comments.reply')}
            busy={submitting}
            onChange={(value) => setReplyBodies((current) => ({
              ...current,
              [mobileReplyAnnotation.id]: value,
            }))}
            onClose={() => setMobileReplyId(null)}
            onSubmit={() => addReply(mobileReplyAnnotation)}
          />
        )}

        {(editingAnnotation || editingReplyContext?.reply) && (
          <MobileCommentMessageSheet
            title={t('comments.edit')}
            value={editingBody}
            submitLabel={t('common.save')}
            busy={submitting}
            onChange={setEditingBody}
            onClose={() => setEditingId(null)}
            onSubmit={() => editingAnnotation
              ? updateAnnotation(editingAnnotation, { comment: editingBody })
              : updateReply(editingReplyContext!.annotation, editingReplyContext!.reply!)}
          />
        )}

        {deleteTarget && (
          <MobileCommentDeleteSheet
            target={deleteTarget}
            busy={submitting}
            onClose={() => setDeleteTarget(null)}
            onConfirm={confirmDelete}
          />
        )}
      </>
    )
  }

  return (
    <div className="commentsPanel">
      <header className="commentsPanelHeader">
        <div className="commentFilters" role="group" aria-label={t('comments.status')}>
          <button
            type="button"
            className={`spaceButton ${filter === 'open' ? 'active' : ''}`}
            onClick={() => setFilter('open')}
          >
            {t('comments.open')}
          </button>
          <button
            type="button"
            className={`spaceButton ${filter === 'resolved' ? 'active' : ''}`}
            onClick={() => setFilter('resolved')}
          >
            {t('comments.resolved')}
          </button>
        </div>
        <button type="button" className="addCommentButton spaceButton" onClick={onStartAnnotation}>
          <Icon name="chat-line-light" />{t('comments.addComment')}
        </button>
      </header>

      {draft && (
        <section className="commentComposer">
          <Quote text={draft.quote} />
          <textarea
            value={draftBody}
            maxLength={10_000}
            placeholder={t('comments.writeComment')}
            autoFocus
            onChange={(event) => setDraftBody(event.target.value)}
          />
          <div>
            <button
              type="button"
              className="spaceButton"
              onClick={() => {
                setDraftBody('')
                onCancelDraft()
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primaryCommentButton spaceButton"
              disabled={!draftBody.trim() || submitting}
              onClick={() => void createAnnotation().then((created) => created && onCancelDraft())}
            >
              {t('comments.comment')}
            </button>
          </div>
        </section>
      )}

      <div className="commentCardList">
        {visibleAnnotations.length === 0 && !draft && (
          <div className="commentsEmptyState">
            <strong>{t(filter === 'open' ? 'comments.noOpen' : 'comments.noResolved')}</strong>
            <span>{t('comments.emptyLead')}</span>
          </div>
        )}
        {visibleAnnotations.map((annotation) => (
          <article
            key={annotation.id}
            ref={activeAnnotationId === annotation.id ? activeCardRef : undefined}
            className={`commentCard ${activeAnnotationId === annotation.id ? 'active' : ''}`}
            onClick={() => onActivate(annotation.id)}
          >
            <Quote text={annotation.quote} detached={annotation.detached} />
            <CommentHeader
              author={annotation.author}
              createdAt={annotation.createdAt}
              updatedAt={annotation.updatedAt}
              menuOpen={menuId === annotation.id}
              canEdit={annotation.canEdit}
              canDelete={annotation.canDelete}
              onToggleMenu={() => setMenuId(menuId === annotation.id ? null : annotation.id)}
              onEdit={() => beginEdit(annotation.id, annotation.comment)}
              onDelete={() => {
                setMenuId(null)
                setDeleteTarget({ kind: 'annotation', annotationId: annotation.id })
              }}
              resolveAction={annotation.canResolve ? {
                label: t(annotation.status === 'open' ? 'comments.resolve' : 'comments.reopen'),
                disabled: submitting,
                onClick: () => void updateAnnotation(annotation, {
                  status: annotation.status === 'open' ? 'resolved' : 'open',
                }),
              } : undefined}
            />
            {editingId === annotation.id ? (
              <EditMessage
                value={editingBody}
                submitting={submitting}
                onChange={setEditingBody}
                onCancel={() => setEditingId(null)}
                onSave={() => void updateAnnotation(annotation, { comment: editingBody }).then((updated) => updated && setEditingId(null))}
              />
            ) : (
              <p className="commentBody">{annotation.comment}</p>
            )}

            {annotation.replies.map((reply) => (
              <div key={reply.id} className="commentReply">
                <CommentHeader
                  author={reply.author}
                  createdAt={reply.createdAt}
                  updatedAt={reply.updatedAt}
                  menuOpen={menuId === reply.id}
                  canEdit={reply.canEdit}
                  canDelete={reply.canDelete}
                  onToggleMenu={() => setMenuId(menuId === reply.id ? null : reply.id)}
                  onEdit={() => beginEdit(reply.id, reply.body)}
                  onDelete={() => {
                    setMenuId(null)
                    setDeleteTarget({
                      kind: 'reply',
                      annotationId: annotation.id,
                      replyId: reply.id,
                    })
                  }}
                />
                {editingId === reply.id ? (
                  <EditMessage
                    value={editingBody}
                    submitting={submitting}
                    onChange={setEditingBody}
                    onCancel={() => setEditingId(null)}
                    onSave={() => void updateReply(annotation, reply).then((updated) => updated && setEditingId(null))}
                  />
                ) : (
                  <p className="commentBody">{reply.body}</p>
                )}
              </div>
            ))}

            <div className="replyComposer" onClick={(event) => event.stopPropagation()}>
              <textarea
                value={replyBodies[annotation.id] ?? ''}
                maxLength={10_000}
                placeholder={t('comments.replyPlaceholder')}
                onChange={(event) => setReplyBodies((current) => ({
                  ...current,
                  [annotation.id]: event.target.value,
                }))}
              />
              <div className="replyComposerActions">
                <button
                  type="button"
                  className="spaceButton"
                  onClick={(event) => {
                    setReplyBodies((current) => ({ ...current, [annotation.id]: '' }))
                    event.currentTarget.closest('.replyComposer')?.querySelector<HTMLTextAreaElement>('textarea')?.blur()
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="primaryCommentButton spaceButton"
                  disabled={!replyBodies[annotation.id]?.trim() || submitting}
                  onClick={() => void addReply(annotation)}
                >
                  {t('comments.reply')}
                </button>
              </div>
            </div>

          </article>
        ))}
      </div>

      {deleteTarget && (
        <ActionDialog title={t('comments.deleteTitle')} onClose={() => setDeleteTarget(null)}>
          <p>
            {deleteTarget.kind === 'annotation'
              ? t('comments.deleteDiscussionLead')
              : t('comments.deleteReplyLead')}
          </p>
          <div className="commentDeleteActions">
            <button type="button" className="spaceButton" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="dangerCommentButton spaceButton"
              disabled={submitting}
              onClick={() => void confirmDelete().then((deleted) => deleted && setDeleteTarget(null))}
            >
              {t('common.delete')}
            </button>
          </div>
        </ActionDialog>
      )}
    </div>
  )
}

function MobileCommentDetailView({
  annotation,
  busy,
  actionsOpen,
  onClose,
  onActions,
  onResolve,
  onReply,
  onReplyActions,
}: {
  annotation: DocumentAnnotation
  busy: boolean
  actionsOpen: boolean
  onClose: () => void
  onActions: () => void
  onResolve: () => void
  onReply: () => void
  onReplyActions: (replyId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const titleId = useId()
  const backRef = useRef<HTMLButtonElement>(null)
  const { backdropStateClass, close, closing, setDialogRef } = useMobileDialogTransition({
    onClose,
    initialFocusRef: backRef,
  })

  const locale = i18n.resolvedLanguage ?? 'en'
  return createPortal(
    <div className={`dialogBackdrop mobileCommentDetailBackdrop mobileFullViewBackdrop ${backdropStateClass}`} role="presentation">
      <section className="mobileCommentDetailView mobileFullView" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={setDialogRef}>
        <header>
          <button ref={backRef} type="button" className="mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={closing} onClick={close}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy"><h2 id={titleId}>{t('comments.detailTitle')}</h2></div>
          {(annotation.canEdit || annotation.canDelete) && (
            <button type="button" className={`mobileCommentHeaderActionsButton spaceButton ${actionsOpen ? 'active' : ''}`} aria-label={t('comments.actions')} aria-haspopup="dialog" aria-expanded={actionsOpen} disabled={busy || closing} onClick={onActions}>
              <Icon name="menu-dots-light" />
            </button>
          )}
        </header>
        <div className="mobileCommentDetailBody">
          <Quote text={annotation.quote} detached={annotation.detached} />
          <article className="mobileCommentMessage root">
            <MobileCommentAuthor author={annotation.author} createdAt={annotation.createdAt} updatedAt={annotation.updatedAt} locale={locale} />
            <p>{annotation.comment}</p>
          </article>
          {annotation.replies.length > 0 && (
            <section className="mobileCommentReplies" aria-label={t('comments.replies')}>
              {annotation.replies.map((reply) => (
                <article key={reply.id} className="mobileCommentMessage reply">
                  <MobileCommentAuthor
                    author={reply.author}
                    createdAt={reply.createdAt}
                    updatedAt={reply.updatedAt}
                    locale={locale}
                    action={reply.canEdit || reply.canDelete ? {
                      label: t('comments.replyActions'),
                      onClick: () => onReplyActions(reply.id),
                    } : undefined}
                  />
                  <p>{reply.body}</p>
                </article>
              ))}
            </section>
          )}
        </div>
        <nav className="mobileCommentDetailBottomBar" aria-label={t('comments.detailActions')}>
          {annotation.canResolve && (
            <button type="button" className="spaceButton" aria-label={t(annotation.status === 'open' ? 'comments.resolve' : 'comments.reopen')} title={t(annotation.status === 'open' ? 'comments.resolve' : 'comments.reopen')} disabled={busy} onClick={onResolve}>
              <Icon name={annotation.status === 'open' ? 'check-read-light' : 'restart-light'} />
            </button>
          )}
          <button type="button" className="spaceButton" aria-label={t('comments.reply')} title={t('comments.reply')} disabled={busy} onClick={onReply}>
            <Icon name="chat-line-light" />
          </button>
        </nav>
      </section>
    </div>,
    document.body,
  )
}

function MobileCommentAuthor({
  author,
  createdAt,
  updatedAt,
  locale,
  action,
}: {
  author: AnnotationAuthor
  createdAt: string
  updatedAt: string
  locale: string
  action?: { label: string; onClick: () => void }
}) {
  const { t } = useTranslation()
  const name = authorName(author, t('comments.deletedUser'))
  const edited = updatedAt !== createdAt
  const date = formatDate(edited ? updatedAt : createdAt, locale)
  return (
    <header className="mobileCommentAuthor">
      <span className="commentAvatar">
        {author?.avatarUrl ? <img src={`${API_BASE}${author.avatarUrl}`} alt="" /> : name.charAt(0)}
      </span>
      <span>
        <strong>{name}</strong>
        <time dateTime={edited ? updatedAt : createdAt}>{edited ? t('comments.editedAt', { date }) : date}</time>
      </span>
      {action && (
        <button type="button" className="spaceButton" aria-label={action.label} onClick={action.onClick}>
          <Icon name="menu-kebab-vertical-light" />
        </button>
      )}
    </header>
  )
}

function MobileCommentMessageSheet({
  title,
  value,
  placeholder,
  submitLabel,
  busy,
  quote,
  onChange,
  onClose,
  onSubmit,
}: {
  title: string
  value: string
  placeholder?: string
  submitLabel: string
  busy: boolean
  quote?: string
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => Promise<boolean>
}) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={title} busy={busy} onClose={onClose}>
      {(close) => (
        <form className="mobileCommentForm" onSubmit={(event) => {
          event.preventDefault()
          void onSubmit().then((saved) => saved && close())
        }}>
          {quote && <Quote text={quote} />}
          <textarea value={value} maxLength={10_000} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
          <footer>
            <button type="button" className="dialogCancel spaceButton" disabled={busy} onClick={close}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit spaceButton" disabled={!value.trim() || busy}>{submitLabel}</button>
          </footer>
        </form>
      )}
    </MobileSettingsSheet>
  )
}

function MobileCommentDeleteSheet({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: DeleteTarget
  busy: boolean
  onClose: () => void
  onConfirm: () => Promise<boolean>
}) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={t('comments.deleteTitle')} role="alertdialog" initialFocus="dialog" busy={busy} onClose={onClose}>
      {(close) => (
        <div className="mobileCommentDelete">
          <p>{t(target.kind === 'annotation' ? 'comments.deleteDiscussionLead' : 'comments.deleteReplyLead')}</p>
          <footer>
            <button type="button" className="dialogCancel spaceButton" disabled={busy} onClick={close}>{t('common.cancel')}</button>
            <button type="button" className="dialogSubmit danger spaceButton" disabled={busy} onClick={() => void onConfirm().then((deleted) => deleted && close())}>{t('common.delete')}</button>
          </footer>
        </div>
      )}
    </MobileSettingsSheet>
  )
}

function authorName(author: AnnotationAuthor | null, fallback: string) {
  return author?.displayName || author?.username || fallback
}

function Quote({ text, detached = false }: { text: string; detached?: boolean }) {
  const { t } = useTranslation()
  return (
    <blockquote className={detached ? 'detached' : ''}>
      {detached && <strong>{t('comments.textDeleted')}</strong>}
      <span>{text}</span>
    </blockquote>
  )
}

function CommentHeader({
  author,
  createdAt,
  updatedAt,
  menuOpen,
  canEdit,
  canDelete,
  onToggleMenu,
  onEdit,
  onDelete,
  resolveAction,
}: {
  author: AnnotationAuthor
  createdAt: string
  updatedAt: string
  menuOpen: boolean
  canEdit: boolean
  canDelete: boolean
  onToggleMenu: () => void
  onEdit: () => void
  onDelete: () => void
  resolveAction?: {
    label: string
    disabled: boolean
    onClick: () => void
  }
}) {
  const { t, i18n } = useTranslation()
  const name = author?.displayName || author?.username || t('comments.deletedUser')
  const edited = updatedAt !== createdAt
  const formattedDate = formatDate(edited ? updatedAt : createdAt, i18n.resolvedLanguage ?? 'en')
  return (
    <header className="commentAuthorRow" onClick={(event) => event.stopPropagation()}>
      <span className="commentAvatar">
        {author?.avatarUrl ? <img src={`${API_BASE}${author.avatarUrl}`} alt="" /> : name.charAt(0)}
      </span>
      <span className="commentAuthorDetails">
        <strong>{name}</strong>
        <time dateTime={edited ? updatedAt : createdAt}>
          {edited ? t('comments.editedAt', { date: formattedDate }) : formattedDate}
        </time>
      </span>
      <div className="commentHeaderActions">
        {resolveAction && (
          <button
            type="button"
            className="resolveCommentButton spaceButton"
            aria-label={resolveAction.label}
            title={resolveAction.label}
            disabled={resolveAction.disabled}
            onClick={resolveAction.onClick}
          >
            <Icon name="check-read-light" />
          </button>
        )}
        {(canEdit || canDelete) && (
          <div className="commentMenu">
            <button
              type="button"
              className="commentMenuButton spaceButton"
              aria-label={t('comments.actions')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={onToggleMenu}
            >
              <Icon name="menu-kebab-vertical-light" />
            </button>
            {menuOpen && (
              <div className="commentMenuPopover" role="menu">
                {canEdit && <button type="button" className="spaceButton" role="menuitem" onClick={onEdit}><Icon name="edit-light" />{t('comments.edit')}</button>}
                {canDelete && <button type="button" className="spaceButton danger" role="menuitem" onClick={onDelete}><Icon name="trash-bin-trash-light" />{t('common.delete')}</button>}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  )
}

function EditMessage({
  value,
  submitting,
  onChange,
  onCancel,
  onSave,
}: {
  value: string
  submitting: boolean
  onChange: (value: string) => void
  onCancel: () => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="commentEditForm" onClick={(event) => event.stopPropagation()}>
      <textarea value={value} maxLength={10_000} onChange={(event) => onChange(event.target.value)} />
      <div>
        <button type="button" className="spaceButton" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          type="button"
          className="primaryCommentButton spaceButton"
          disabled={!value.trim() || submitting}
          onClick={onSave}
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  )
}

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
