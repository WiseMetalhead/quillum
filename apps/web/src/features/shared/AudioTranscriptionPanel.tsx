import { useCallback, useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { ApiError, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { AudioTranscription } from '../../types'
import { ActionDialog } from './ActionDialog'
import './AudioTranscriptionPanel.css'

type Props = {
  noteId?: string
  endpoint?: string
  controls?: boolean
  trashed?: boolean
  onError?: (message: string) => void
}

type TranscriptionResponse = { transcription: AudioTranscription }

const activeStatuses = new Set<AudioTranscription['status']>(['queued', 'processing'])

export function AudioTranscriptionPanel({
  noteId,
  endpoint,
  controls = true,
  trashed = false,
  onError,
}: Props) {
  const { t } = useTranslation()
  const [transcription, setTranscription] = useState<AudioTranscription | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [requestError, setRequestError] = useState('')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const transcriptionEndpoint = endpoint
    ?? `/api/manuscripts/notes/${encodeURIComponent(noteId ?? '')}/transcription/`

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const payload = await apiRequest<TranscriptionResponse>(
        transcriptionEndpoint,
        { invalidateQueryCache: false },
      )
      setTranscription(payload.transcription)
      setRequestError('')
    } catch (error) {
      const message = transcriptionErrorMessage(error, t)
      setRequestError(message)
      onError?.(message)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [onError, t, transcriptionEndpoint])

  useEffect(() => {
    let active = true
    async function loadInitial() {
      setLoading(true)
      setTranscription(null)
      setRequestError('')
      try {
        const payload = await apiRequest<TranscriptionResponse>(
          transcriptionEndpoint,
          { invalidateQueryCache: false },
        )
        if (active) setTranscription(payload.transcription)
      } catch (error) {
        if (!active) return
        const message = transcriptionErrorMessage(error, t)
        setRequestError(message)
        onError?.(message)
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadInitial()
    return () => { active = false }
  }, [onError, t, transcriptionEndpoint])

  useEffect(() => {
    if (!transcription || !activeStatuses.has(transcription.status)) return
    const timer = window.setInterval(() => void load(), 1000)
    return () => window.clearInterval(timer)
  }, [load, transcription])

  async function requestTranscription() {
    if (busy) return
    setBusy(true)
    setRequestError('')
    try {
      const payload = await apiRequest<TranscriptionResponse>(
        transcriptionEndpoint,
        { method: 'POST' },
      )
      setTranscription(payload.transcription)
    } catch (error) {
      const message = transcriptionErrorMessage(error, t)
      setRequestError(message)
      onError?.(message)
    } finally {
      setBusy(false)
    }
  }

  async function deleteTranscription() {
    if (busy) return
    setBusy(true)
    setRequestError('')
    try {
      const payload = await apiRequest<TranscriptionResponse>(
        transcriptionEndpoint,
        { method: 'DELETE' },
      )
      setTranscription(payload.transcription)
      setDeleteConfirmOpen(false)
    } catch (error) {
      const message = transcriptionErrorMessage(error, t)
      setRequestError(message)
      onError?.(message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return controls ? (
      <section className="audioTranscriptionPanel empty loading" aria-label={t('audioTranscription.title')}>
        <PanelHeader title={t('audioTranscription.emptyTitle')} centered />
        <TadpoleIcon />
      </section>
    ) : null
  }
  if (!transcription) return requestError ? (
    <section className="audioTranscriptionPanel empty" aria-label={t('audioTranscription.title')}>
      <PanelHeader title={t('audioTranscription.emptyTitle')} centered />
      <p className="audioTranscriptionError">{requestError}</p>
    </section>
  ) : null

  const active = activeStatuses.has(transcription.status)
  const canRequest = controls && transcription.featureEnabled && !trashed && !active
  const showEmptyAction = !transcription.hasText && transcription.status === 'none' && canRequest
  const errorCode = transcription.errorCode ?? 'transcription_failed'
  const panelClassName = [
    'audioTranscriptionPanel',
    transcription.hasText ? 'hasText' : 'empty',
    active ? 'active' : '',
    transcription.status === 'failed' ? 'failed' : '',
  ].filter(Boolean).join(' ')

  if (!transcription.hasText && !active && !showEmptyAction && transcription.status !== 'failed') {
    return requestError ? <p className="audioTranscriptionError">{requestError}</p> : null
  }

  return (<>
    <section className={panelClassName} aria-label={t('audioTranscription.title')}>
      <PanelHeader
        title={t(transcription.hasText
          ? 'audioTranscription.readyTitle'
          : active
            ? 'audioTranscription.processingTitle'
            : 'audioTranscription.emptyTitle')}
        language={transcription.hasText ? transcription.language : null}
        centered={!transcription.hasText}
      />
      {showEmptyAction && <p className="audioTranscriptionLead">{t('audioTranscription.emptyDescription')}</p>}
      {showEmptyAction && (
        <button type="button" className="audioTranscriptionStart spaceButton" disabled={busy} onClick={() => void requestTranscription()}>
          <Icon name="soundwave-linear" />
          {t('audioTranscription.recognize')}
        </button>
      )}

      {transcription.hasText && (
        <div className="audioTranscriptionText" tabIndex={0}>
          <p>{transcription.text}</p>
        </div>
      )}

      {active && (
        <div className="audioTranscriptionProgress" role="status">
          <TadpoleIcon />
          <span>{t(transcription.status === 'queued' ? 'audioTranscription.queued' : 'audioTranscription.processing')}</span>
        </div>
      )}

      {transcription.status === 'failed' && (
        <p className="audioTranscriptionFailure" role="status">
          {t(`audioTranscription.errors.${errorCode}`, {
            defaultValue: t('audioTranscription.errors.transcription_failed'),
          })}
        </p>
      )}

      {requestError && <p className="audioTranscriptionError">{requestError}</p>}

      {controls && transcription.hasText && !active && (
        <div className="audioTranscriptionActions">
          <button type="button" className="spaceButton danger" disabled={busy} onClick={() => setDeleteConfirmOpen(true)}>
            <Icon name="trash-bin-trash-light" />
            {t('audioTranscription.delete')}
          </button>
          {canRequest && (
            <button type="button" className="spaceButton" disabled={busy} onClick={() => void requestTranscription()}>
              <Icon name="restart-light" />
              {t('audioTranscription.recognizeAgain')}
            </button>
          )}
        </div>
      )}

      {controls && !transcription.hasText && transcription.status === 'failed' && canRequest && (
        <button type="button" className="audioTranscriptionRetry spaceButton" disabled={busy} onClick={() => void requestTranscription()}>
          <Icon name="restart-light" />
          {t('audioTranscription.retry')}
        </button>
      )}
    </section>
    {deleteConfirmOpen && (
      <ActionDialog
        variant="structured"
        role="alertdialog"
        title={t('audioTranscription.deleteTitle')}
        closeLabel={t('common.cancel')}
        busy={busy}
        className="audioTranscriptionDeleteDialog"
        onClose={() => setDeleteConfirmOpen(false)}
      >
        <div className="standardDialogSection">
          <p>{t('audioTranscription.confirmDelete')}</p>
          <footer className="standardDialogFooter">
            <button type="button" className="dialogCancel booksButton" disabled={busy} onClick={() => setDeleteConfirmOpen(false)}>{t('common.cancel')}</button>
            <button type="button" className="dialogSubmit danger booksButton" disabled={busy} onClick={() => void deleteTranscription()}>{t('audioTranscription.delete')}</button>
          </footer>
        </div>
      </ActionDialog>
    )}
  </>)
}

function PanelHeader({
  title,
  language,
  centered = false,
}: {
  title: string
  language?: string | null
  centered?: boolean
}) {
  return (
    <header className={`audioTranscriptionHeader ${centered ? 'centered' : ''}`}>
      <span><Icon name="soundwave-linear" /><strong>{title}</strong></span>
      {language && <small>{language.toUpperCase()}</small>}
    </header>
  )
}

function transcriptionErrorMessage(error: unknown, t: TFunction) {
  if (error instanceof ApiError) {
    return t(`audioTranscription.apiErrors.${error.code}`, {
      defaultValue: t('audioTranscription.apiErrors.requestFailed'),
    })
  }
  return error instanceof Error ? error.message : t('audioTranscription.apiErrors.requestFailed')
}
