import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { IdeaItem, IdeaTarget } from '../../types'
import { BoardsSaveStatusIndicator } from '../books/BoardsSaveStatusIndicator'
import { formatAudioDuration } from '../books/audioNoteRecording'
import { AudioNotePlayer, AudioWaveform } from '../shared/AudioNotePlayer'
import { AudioTranscriptionPanel } from '../shared/AudioTranscriptionPanel'
import { ResponsiveConfirmationDialog } from '../shared/ResponsiveConfirmationDialog'
import { useAudioRecorder } from '../shared/useAudioRecorder'
import type { AudioRecorderError, AudioRecordingResult } from '../shared/useAudioRecorder'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { IdeaTargetDialog } from './IdeaTextEditor'
import './IdeaAudioEditor.css'

type Props = {
  item: IdeaItem | null
  onClose: () => void
  onCreate: (result: AudioRecordingResult, title: string) => Promise<IdeaItem>
  onSave: (title: string, item: IdeaItem, expectedGeneration?: number) => Promise<IdeaItem>
  onDelete: (item: IdeaItem) => void
  onAttach: (item: IdeaItem, target: IdeaTarget) => Promise<void>
  onError: (message: string) => void
  suspended?: boolean
}

export function IdeaAudioEditor({ item, onClose, onCreate, onSave, onDelete, onAttach, onError, suspended = false }: Props) {
  const { t } = useTranslation()
  const titleInputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const [title, setTitle] = useState(item?.title ?? '')
  const [currentItem, setCurrentItem] = useState(item)
  const [savedTitle, setSavedTitle] = useState(item?.title ?? '')
  const [editingTitle, setEditingTitle] = useState(() => item === null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [uploadFailed, setUploadFailed] = useState(false)
  const [conflictGeneration, setConflictGeneration] = useState<number | null>(null)
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)
  const [targetsOpen, setTargetsOpen] = useState(false)
  const titleRef = useRef(title)
  const currentItemRef = useRef(currentItem)
  const savedTitleRef = useRef(savedTitle)
  const saveTimerRef = useRef<number | null>(null)
  const savePromiseRef = useRef<Promise<IdeaItem> | null>(null)
  const { backdropStateClass, close, closing, setDialogRef } = useMobileDialogTransition({
    onClose,
    initialFocusRef: titleInputRef,
    focusOnDesktop: true,
  })

  const recorder = useAudioRecorder({
    onStopped: (result) => void uploadRecording(result),
    onError: (code) => {
      setUploadFailed(false)
      onError(t(`audioNotes.errors.${audioErrorKey(code)}`))
    },
  })

  useEffect(() => {
    titleRef.current = title
    currentItemRef.current = currentItem
    savedTitleRef.current = savedTitle
  }, [currentItem, savedTitle, title])

  const saveTitle = useCallback(async (expectedGeneration?: number) => {
    if (savePromiseRef.current) return savePromiseRef.current
    const existing = currentItemRef.current
    const nextTitle = titleRef.current.trim()
    if (!existing || nextTitle === savedTitleRef.current) return existing
    setSaving(true)
    setSaveFailed(false)
    setConflictGeneration(null)
    const pending = onSave(nextTitle, existing, expectedGeneration)
    savePromiseRef.current = pending
    try {
      const saved = await pending
      currentItemRef.current = saved
      savedTitleRef.current = saved.title
      setCurrentItem(saved)
      setSavedTitle(saved.title)
      return saved
    } catch (error) {
      if (error instanceof ApiError && error.code === 'idea_update_conflict' && typeof error.details.saveGeneration === 'number') {
        setConflictGeneration(error.details.saveGeneration)
      }
      setSaveFailed(true)
      onError(error instanceof Error ? error.message : t('ideas.audioSaveFailed'))
      throw error
    } finally {
      if (savePromiseRef.current === pending) savePromiseRef.current = null
      setSaving(false)
    }
  }, [onError, onSave, t])

  async function uploadRecording(result = recorder.result) {
    if (!result || uploading) return
    setUploading(true)
    setUploadFailed(false)
    setSaveFailed(false)
    const uploadedTitle = titleRef.current.trim()
    try {
      const saved = await onCreate(result, uploadedTitle)
      currentItemRef.current = saved
      savedTitleRef.current = uploadedTitle
      setCurrentItem(saved)
      setSavedTitle(uploadedTitle)
    } catch (error) {
      setUploadFailed(true)
      onError(error instanceof Error ? error.message : t('audioNotes.errors.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  useEffect(() => {
    if (item) return
    void recorder.start()
    return () => recorder.discard()
    // The recorder owns StrictMode-safe attempt cancellation and all capture resources.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item])

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
    if (!currentItem || title.trim() === savedTitle || saveFailed) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void saveTitle().catch(() => undefined)
    }, 800)
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [currentItem, saveFailed, saveTitle, savedTitle, title])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !blocked && !targetsOpen && !discardConfirmOpen) void requestClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  const activeRecording = recorder.state === 'requesting' || recorder.state === 'recording' || recorder.state === 'paused'
  const hasUnuploadedRecording = Boolean(recorder.result && !currentItem)
  const blocked = uploading || saving || closing || suspended
  const dirty = Boolean(currentItem && title.trim() !== savedTitle)
  const saveStatus = saveFailed || uploadFailed ? 'error' : uploading || saving ? 'saving' : dirty ? 'dirty' : 'saved'
  const displayedTitle = title.trim() || t('ideas.untitled')
  const audio = currentItem?.audio ?? (recorder.result ? {
    contentType: recorder.result.blob.type as 'audio/webm' | 'audio/ogg' | 'audio/mp4',
    codec: recorder.result.blob.type.startsWith('audio/mp4') ? 'aac' as const : 'opus' as const,
    byteSize: recorder.result.blob.size,
    durationMs: recorder.result.durationMs,
    waveform: recorder.result.waveform,
    playbackUrl: '',
    downloadUrl: '',
    transcriptionUrl: '',
  } : null)

  async function flushTitle() {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    return saveTitle()
  }

  async function requestClose() {
    if (blocked) return
    if (activeRecording || hasUnuploadedRecording) {
      setDiscardConfirmOpen(true)
      return
    }
    try {
      await flushTitle()
      recorder.discard()
      close()
    } catch {
      // The localized save error is already visible and the editor remains open.
    }
  }

  async function openTargets() {
    try {
      const saved = await flushTitle()
      if (saved) setTargetsOpen(true)
    } catch {
      // The editor remains open for a retry.
    }
  }

  async function requestDelete() {
    try {
      const saved = await flushTitle()
      if (saved) onDelete(saved)
    } catch {
      // Deletion must not discard a pending title change.
    }
  }

  function retry() {
    if (uploadFailed && recorder.result) {
      void uploadRecording()
    } else if (saveFailed) {
      void saveTitle(conflictGeneration ?? undefined).catch(() => undefined)
    } else {
      void recorder.start()
    }
  }

  return createPortal(
    <div
      className={`standardDialogBackdrop ideasAudioEditorBackdrop mobileFullViewBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !blocked) void requestClose()
      }}
    >
      <section className="standardActionDialog ideasAudioEditor mobileFullView" role="dialog" aria-modal="true" aria-label={t('ideas.audioEditor')} ref={setDialogRef}>
        <header>
          <button type="button" className="standardDialogMobileBack mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={blocked} onClick={() => void requestClose()}><Icon name="arrow-left-1" /></button>
          <div className="ideasAudioTitleLine">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className="ideasAudioTitleInput"
                value={title}
                maxLength={240}
                placeholder={t('ideas.audioTitlePlaceholder')}
                aria-label={t('ideas.audioTitle')}
                onChange={(event) => { setSaveFailed(false); setTitle(event.currentTarget.value) }}
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'Escape') {
                    if (event.key === 'Escape') event.stopPropagation()
                    event.currentTarget.blur()
                  }
                }}
              />
            ) : (
              <button type="button" className="ideasAudioTitleButton spaceButton" title={t('ideas.audioTitle')} onClick={() => setEditingTitle(true)}>{displayedTitle}</button>
            )}
          </div>
          <button type="button" className="standardDialogClose spaceButton" aria-label={t('common.close')} disabled={blocked} onClick={() => void requestClose()}><Icon name="close-square-light" /></button>
        </header>
        <div className="standardDialogContent ideasAudioEditorContent">
          <section className="ideasAudioCapturePanel" aria-label={t('ideas.audioRecordingPanel')}>
            {recorder.state === 'requesting' && <div className="ideasAudioState"><Icon name="microphone-3-linear" /><strong>{t('audioNotes.requestingPermission')}</strong></div>}
            {(recorder.state === 'recording' || recorder.state === 'paused') && <>
              <div className={`ideasAudioRecordingMark ${recorder.state}`}><Icon name="microphone-3-linear" /><strong>{formatAudioDuration(recorder.elapsedMs)}</strong><span>{t(recorder.state === 'paused' ? 'audioNotes.paused' : 'audioNotes.recording')}</span></div>
              <AudioWaveform values={recorder.waveform} live />
              <div className="ideasAudioRecordActions">
                <button type="button" className="spaceButton" onClick={recorder.state === 'paused' ? recorder.resume : recorder.pause}><Icon name={recorder.state === 'paused' ? 'play-light' : 'pause-light'} />{t(recorder.state === 'paused' ? 'audioNotes.resume' : 'audioNotes.pause')}</button>
                <button type="button" className="spaceButton stop" onClick={recorder.stop}><Icon name="stop-light" />{t('audioNotes.stop')}</button>
              </div>
            </>}
            {audio && !activeRecording && <AudioNotePlayer audio={audio} source={recorder.result?.source || undefined} />}
            {uploading && <p className="ideasAudioHint" role="status">{t('audioNotes.uploading')}</p>}
            {(uploadFailed || recorder.state === 'error') && <div className="ideasAudioError"><p>{t(uploadFailed ? 'audioNotes.errors.uploadFailed' : 'audioNotes.errors.recordingFailed')}</p><button type="button" className="spaceButton" onClick={retry}>{t(uploadFailed ? 'audioNotes.retryUpload' : 'audioNotes.retryPermission')}</button></div>}
          </section>
          {currentItem?.audio ? (
            <AudioTranscriptionPanel endpoint={currentItem.audio.transcriptionUrl} onError={onError} />
          ) : (
            <section className="ideasAudioTranscriptionPending" aria-label={t('audioTranscription.title')}>
              <Icon name="soundwave-linear" />
              <strong>{t('audioTranscription.emptyTitle')}</strong>
              <p>{t('ideas.audioTranscriptionPending')}</p>
            </section>
          )}
          <footer className="ideasAudioEditorActions standardDialogFooter mobileFullViewFooter">
            <div className="ideasAudioEditorActionGroup">
              <button type="button" className="dialogSubmit danger spaceButton" title={t('ideas.delete')} aria-label={t('ideas.delete')} disabled={!currentItem || blocked} onClick={() => void requestDelete()}><Icon name="trash-bin-trash-light" /><span>{t('ideas.delete')}</span></button>
              <button type="button" className="dialogSubmit spaceButton" title={t('ideas.attachToManuscript')} aria-label={t('ideas.attachToManuscript')} disabled={!currentItem || blocked} onClick={() => void openTargets()}><Icon name="widget-light" /><span>{t('ideas.attachToManuscript')}</span></button>
            </div>
            <BoardsSaveStatusIndicator status={saveStatus} className="ideasAudioEditorMobileSaveStatus" retryLabel={t('ideas.retrySave')} onRetry={saveStatus === 'error' ? retry : undefined} />
          </footer>
        </div>
      </section>
      {targetsOpen && <IdeaTargetDialog open busy={blocked} onClose={() => setTargetsOpen(false)} onSelect={async (target) => { const saved = currentItemRef.current; if (saved) await onAttach(saved, target) }} onError={onError} />}
      {discardConfirmOpen && (
        <ResponsiveConfirmationDialog
          title={t('audioNotes.discardTitle')}
          description={<p>{t('audioNotes.confirmDiscard')}</p>}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('audioNotes.discardAction')}
          busyLabel={t('audioNotes.discardAction')}
          closeLabel={t('common.close')}
          onClose={() => setDiscardConfirmOpen(false)}
          onConfirm={async () => { recorder.discard(); return true }}
          onConfirmed={close}
        />
      )}
    </div>,
    document.body,
  )
}

function audioErrorKey(code: AudioRecorderError) {
  return code
}
