import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type {
  ContestParticipationPayload,
  ContestRecommendedManuscript,
} from '../../types'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileViewport } from '../shared/useMobileViewport'

type Props = {
  contestId: string
  manuscript: ContestRecommendedManuscript
  onClose: () => void
  onSaved: (payload: ContestParticipationPayload) => void
}

export function ContestTrackingDialog({ contestId, manuscript, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const titleId = useId()
  const [enabled, setEnabled] = useState(manuscript.trackingEnabled)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isMobile) return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [isMobile, onClose, saving])

  async function save(close?: () => void) {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      const payload = await apiRequest<ContestParticipationPayload>(
        `/api/contests/${contestId}/participation/${manuscript.id}/`,
        {
          method: 'PATCH',
          body: JSON.stringify({ trackDeadlines: enabled }),
        },
      )
      onSaved(payload)
      if (close) close()
      else onClose()
    } catch {
      setError(t('contests.details.trackingUpdateFailed'))
      setSaving(false)
    }
  }

  const option = (
    <div className="contestTrackingOption">
      <label htmlFor={`contest-tracking-${manuscript.id}`}>
        {t('contests.details.trackDeadlines')}
      </label>
      <button
        id={`contest-tracking-${manuscript.id}`}
        type="button"
        className="contestTrackingSwitch"
        role="switch"
        aria-checked={enabled}
        disabled={saving}
        onClick={() => setEnabled((current) => !current)}
      >
        <span />
      </button>
    </div>
  )

  if (isMobile) {
    return (
      <MobileSettingsSheet
        title={t('contests.details.trackingSettings')}
        busy={saving}
        onClose={onClose}
      >
        {(close) => (
          <div className="contestTrackingSheetBody">
            {option}
            {error && <p className="contestTrackingError" role="alert">{error}</p>}
            <div className="contestTrackingSheetActions">
              <button type="button" className="secondary" disabled={saving} onClick={close}>
                {t('common.cancel')}
              </button>
              <button type="button" disabled={saving} onClick={() => void save(close)}>
                {t(saving ? 'common.saving' : 'common.save')}
              </button>
            </div>
          </div>
        )}
      </MobileSettingsSheet>
    )
  }

  return createPortal(
    <div
      className="dialogBackdrop contestTrackingBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <div
        className="createOneShotDialog contestTrackingDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <div><h2 id={titleId}>{t('contests.details.trackingSettings')}</h2></div>
          <button
            type="button"
            className="dialogClose booksButton"
            aria-label={t('common.close')}
            disabled={saving}
            onClick={onClose}
          >
            <Icon name="close-square-light" />
          </button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); void save() }}>
          {option}
          {error && <p className="contestTrackingError" role="alert">{error}</p>}
          <footer>
            <button type="button" className="dialogCancel booksButton" disabled={saving} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="dialogSubmit booksButton" disabled={saving}>
              {t(saving ? 'common.saving' : 'common.save')}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  )
}
