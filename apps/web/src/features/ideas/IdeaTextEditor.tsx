import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { IdeaItem, IdeaTarget } from '../../types'
import { BoardsSaveStatusIndicator } from '../books/BoardsSaveStatusIndicator'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { LibraryAction } from '../shared/MobileLibraryActionSheet'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import './IdeaTextEditor.css'

export type IdeaTextDraft = {
  title: string
  text: string
}

type Props = {
  item: IdeaItem | null
  onClose: () => void
  onSave: (draft: IdeaTextDraft, item: IdeaItem | null) => Promise<IdeaItem>
  onDelete: (item: IdeaItem) => void
  onAttach: (item: IdeaItem, target: IdeaTarget) => Promise<void>
  onError: (message: string) => void
  suspended?: boolean
}

type SaveState = 'empty' | 'dirty' | 'saving' | 'saved' | 'error'

export function IdeaTextEditor({ item, onClose, onSave, onDelete, onAttach, onError, suspended = false }: Props) {
  const { t } = useTranslation()
  const titleInputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const [title, setTitle] = useState(item?.title ?? '')
  const [text, setText] = useState(item?.text ?? '')
  const [currentItem, setCurrentItem] = useState(item)
  const [editingTitle, setEditingTitle] = useState(() => item === null)
  const [savedSignature, setSavedSignature] = useState(() => signature({
    title: item?.title ?? '',
    text: item?.text ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [conflictGeneration, setConflictGeneration] = useState<number | null>(null)
  const [targetsOpen, setTargetsOpen] = useState(false)
  const saveTimerRef = useRef<number | null>(null)
  const savePromiseRef = useRef<Promise<IdeaItem> | null>(null)
  const draftRef = useRef<IdeaTextDraft>({ title, text })
  const savedSignatureRef = useRef(savedSignature)
  const currentItemRef = useRef(currentItem)
  const { backdropStateClass, close, closing, setDialogRef } = useMobileDialogTransition({
    onClose,
    initialFocusRef: titleInputRef,
    focusOnDesktop: true,
  })

  const draft = { title, text }
  const draftSignature = signature(draft)
  const meaningful = Boolean(title.trim() || text.trim())
  const persistable = meaningful || currentItem !== null
  const saveState: SaveState = saveFailed
    ? 'error'
    : saving
      ? 'saving'
      : !persistable
        ? 'empty'
        : draftSignature !== savedSignature
          ? 'dirty'
          : 'saved'
  const indicatorStatus = saveState === 'empty' ? 'saved' : saveState
  const displayedTitle = title.trim() || t(currentItem ? 'ideas.untitled' : 'ideas.textEditor')
  const blocked = saving || closing || suspended

  draftRef.current = draft
  savedSignatureRef.current = savedSignature
  currentItemRef.current = currentItem

  const persistLatest = useCallback(async (expectedGeneration?: number): Promise<IdeaItem | null> => {
    if (savePromiseRef.current) {
      await savePromiseRef.current
      if (signature(draftRef.current) !== savedSignatureRef.current) {
        return persistLatest(expectedGeneration)
      }
      return currentItemRef.current
    }
    const snapshot = draftRef.current
    const snapshotSignature = signature(snapshot)
    const existing = currentItemRef.current
    if (!existing && !snapshot.title.trim() && !snapshot.text.trim()) return null
    if (existing && snapshotSignature === savedSignatureRef.current) return existing

    setSaving(true)
    setSaveFailed(false)
    setConflictGeneration(null)
    const saveBase = existing && expectedGeneration !== undefined
      ? { ...existing, saveGeneration: expectedGeneration }
      : existing
    const pending = onSave(snapshot, saveBase)
    savePromiseRef.current = pending
    try {
      const saved = await pending
      currentItemRef.current = saved
      savedSignatureRef.current = snapshotSignature
      setCurrentItem(saved)
      setSavedSignature(snapshotSignature)
      return saved
    } catch (error) {
      if (
        error instanceof ApiError
        && error.code === 'idea_update_conflict'
        && typeof error.details.saveGeneration === 'number'
      ) {
        setConflictGeneration(error.details.saveGeneration)
      }
      setSaveFailed(true)
      onError(error instanceof Error ? error.message : t('ideas.textSaveFailed'))
      throw error
    } finally {
      if (savePromiseRef.current === pending) savePromiseRef.current = null
      setSaving(false)
    }
  }, [onError, onSave, t])

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select()
  }, [editingTitle])

  useEffect(() => {
    const previousFocus = previousFocusRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      previousFocus?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    if (!persistable || saveFailed || draftSignature === savedSignature) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void persistLatest().catch(() => undefined)
    }, 800)
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [draftSignature, persistLatest, persistable, saveFailed, savedSignature])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !blocked && !targetsOpen) void requestClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  function markEdited() {
    setSaveFailed(false)
    setConflictGeneration(null)
  }

  async function requestClose() {
    if (closing) return
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    try {
      await persistLatest()
      close()
    } catch {
      // Persistence already exposes the localized error and the editor stays open.
    }
  }

  async function openTargets() {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    try {
      const saved = await persistLatest()
      if (saved) setTargetsOpen(true)
    } catch {
      // The editor remains open so the user can retry saving.
    }
  }

  async function requestDelete() {
    try {
      const saved = await persistLatest()
      if (saved) onDelete(saved)
    } catch {
      // Deletion must not discard an unsaved change.
    }
  }

  return createPortal(
    <div
      className={`standardDialogBackdrop ideasTextEditorBackdrop mobileFullViewBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !blocked) void requestClose()
      }}
    >
      <section
        className="standardActionDialog ideasTextEditor mobileFullView"
        role="dialog"
        aria-modal="true"
        aria-label={t('ideas.textEditor')}
        ref={setDialogRef}
      >
        <header>
          <button type="button" className="standardDialogMobileBack mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={blocked} onClick={() => void requestClose()}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="ideasTextTitleLine">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className="ideasTextTitleInput"
                type="text"
                value={title}
                maxLength={240}
                placeholder={t('ideas.textTitlePlaceholder')}
                aria-label={t('ideas.textTitle')}
                onChange={(event) => {
                  markEdited()
                  setTitle(event.currentTarget.value)
                }}
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'Escape') {
                    if (event.key === 'Escape') event.stopPropagation()
                    event.currentTarget.blur()
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="ideasTextTitleButton spaceButton"
                title={t('ideas.textTitle')}
                onClick={() => setEditingTitle(true)}
              >
                {displayedTitle}
              </button>
            )}
          </div>
          <button type="button" className="standardDialogClose spaceButton" aria-label={t('common.close')} disabled={blocked} onClick={() => void requestClose()}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="standardDialogContent ideasTextEditorContent">
          <div className="ideasTextFields">
            <div className="ideasTextBodyField">
              <textarea
                value={text}
                aria-label={t('ideas.textBody')}
                placeholder={t('ideas.textBodyPlaceholder')}
                onChange={(event) => {
                  markEdited()
                  setText(event.currentTarget.value)
                }}
              />
            </div>
          </div>
          <div className={`ideasTextSaveState ${saveState}`} role="status" aria-live="polite">
            <Icon name={saveState === 'error' ? 'cloud-no' : saveState === 'saved' ? 'cloud-yes' : 'cloud-upload'} />
            <span>{t(`ideas.textSaveState.${saveState}`)}</span>
            {saveState === 'error' && (
              <button type="button" className="spaceButton" disabled={saving} onClick={() => void persistLatest(conflictGeneration ?? undefined).catch(() => undefined)}>
                {t('ideas.retrySave')}
              </button>
            )}
          </div>
          <footer className="ideasTextEditorActions standardDialogFooter mobileFullViewFooter">
            <div className="ideasTextEditorActionGroup">
              <button type="button" className="dialogSubmit danger spaceButton" title={t('ideas.delete')} aria-label={t('ideas.delete')} disabled={!currentItem || blocked} onClick={() => void requestDelete()}>
                <Icon name="trash-bin-trash-light" /><span>{t('ideas.delete')}</span>
              </button>
              <button type="button" className="dialogSubmit spaceButton" title={t('ideas.attachToManuscript')} aria-label={t('ideas.attachToManuscript')} disabled={!meaningful || blocked} onClick={() => void openTargets()}>
                <Icon name="widget-light" /><span>{t('ideas.attachToManuscript')}</span>
              </button>
            </div>
            <BoardsSaveStatusIndicator
              status={indicatorStatus}
              className="ideasTextEditorMobileSaveStatus"
              retryLabel={t('ideas.retrySave')}
              onRetry={saveState === 'error'
                ? () => void persistLatest(conflictGeneration ?? undefined).catch(() => undefined)
                : undefined}
            />
          </footer>
        </div>
      </section>
      {targetsOpen && (
        <IdeaTargetDialog
          open
          busy={blocked}
          onClose={() => setTargetsOpen(false)}
          onSelect={async (target) => {
            const saved = currentItemRef.current
            if (!saved) return
            await onAttach(saved, target)
          }}
          onError={onError}
        />
      )}
    </div>,
    document.body,
  )
}

export type TargetDialogProps = {
  open: boolean
  busy: boolean
  onClose: () => void
  onSelect: (target: IdeaTarget) => Promise<void>
  onError: (message: string) => void
}

export function IdeaTargetDialog({ open, busy, onClose, onSelect, onError }: TargetDialogProps) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const [targets, setTargets] = useState<IdeaTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [attachingId, setAttachingId] = useState('')

  useEffect(() => {
    if (!open) return
    let active = true
    void apiRequest<{ items: IdeaTarget[] }>('/api/ideas/targets/', { invalidateQueryCache: false })
      .then((payload) => {
        if (active) setTargets(payload.items)
      })
      .catch((error) => {
        if (active) onError(error instanceof Error ? error.message : t('ideas.targetsLoadFailed'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [onError, open, t])

  async function attach(target: IdeaTarget) {
    if (attachingId || busy) return
    setAttachingId(target.id)
    try {
      await onSelect(target)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('ideas.attachFailed'))
      setAttachingId('')
    }
  }

  const actions: LibraryAction[] = targets.map((target) => ({
    key: target.id,
    label: targetLabel(target, t),
    icon: <Icon name={target.kind === 'book' ? 'books-light' : 'file-document-light'} />,
    disabled: Boolean(attachingId) || busy,
    onSelect: () => void attach(target),
  }))

  if (!open) return null
  if (isMobile) {
    return (
      <MobileLibraryActionSheet
        open
        title={t('ideas.chooseManuscript')}
        actions={actions}
        onClose={onClose}
        backdropClassName="ideasTargetBackdrop"
        topContent={loading
          ? <TadpoleLoadingState className="ideasTargetLoading" label={t('ideas.targetsLoading')} />
          : !targets.length ? <p className="ideasTargetEmpty">{t('ideas.targetsEmpty')}</p> : undefined}
      />
    )
  }
  return (
    <ActionDialog
      variant="structured"
      title={t('ideas.chooseManuscript')}
      closeLabel={t('common.close')}
      busy={Boolean(attachingId) || busy}
      backdropClassName="ideasTargetBackdrop"
      className="ideasTargetDialog"
      onClose={onClose}
    >
      <div className="ideasTargetList">
        {loading ? (
          <TadpoleLoadingState className="ideasTargetLoading" label={t('ideas.targetsLoading')} />
        ) : targets.length ? targets.map((target) => (
          <button type="button" className="ideasTargetOption spaceButton" disabled={Boolean(attachingId) || busy} key={target.id} onClick={() => void attach(target)}>
            <Icon name={target.kind === 'book' ? 'books-light' : 'file-document-light'} />
            <span><strong>{target.title}</strong><small>{targetContext(target, t)}</small></span>
            {attachingId === target.id && <Icon name="cloud-upload" />}
          </button>
        )) : (
          <p className="ideasTargetEmpty">{t('ideas.targetsEmpty')}</p>
        )}
      </div>
    </ActionDialog>
  )
}

function targetContext(target: IdeaTarget, t: TFunction) {
  const kind = t(target.kind === 'book' ? 'manuscripts.book' : 'manuscripts.oneShot')
  const series = target.series ? t('ideas.targetSeries', { series: target.series.title }) : ''
  const drawer = target.inDrawer ? t('manuscripts.drawer') : ''
  return [kind, series, drawer].filter(Boolean).join(' · ')
}

function targetLabel(target: IdeaTarget, t: TFunction) {
  return `${target.title} — ${targetContext(target, t)}`
}

function signature(draft: IdeaTextDraft) {
  return JSON.stringify([draft.title, draft.text])
}
