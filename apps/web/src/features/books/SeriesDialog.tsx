import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { CoverPicker } from './CoverPicker'
import type { Series } from './ManuscriptTypes'
import type { StorageItem } from '../../types'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'

type Props = {
  series?: Series
  onClose: () => void
  onSaved: (series: Series) => void
  onError: (error: string) => void
  coverUploadLimitBytes?: number | null
}

export function SeriesDialog({
  series,
  onClose,
  onSaved,
  onError,
  coverUploadLimitBytes = null,
}: Props) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(series?.title ?? '')
  const [synopsis, setSynopsis] = useState(series?.synopsis ?? '')
  const [cover, setCover] = useState<File | null>(null)
  const [coverMedia, setCoverMedia] = useState<StorageItem | null>(null)
  const [removeCover, setRemoveCover] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const editing = Boolean(series)
  const onSavedRef = useRef(onSaved)
  const {
    backdropStateClass,
    close: closeDialog,
    closing,
    setDialogRef,
    finishAfterExit,
  } = useMobileDialogTransition({ onClose, initialFocusRef: titleRef })

  useEffect(() => {
    onSavedRef.current = onSaved
  }, [onSaved])
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, submitting])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || !title.trim()) return
    setSubmitting(true)
    onError('')
    const form = new FormData()
    form.set('title', title.trim())
    form.set('synopsis', synopsis.trim())
    if (cover) form.set('cover', cover)
    if (coverMedia) form.set('coverMediaId', coverMedia.id.replace(/^media:/, ''))
    if (removeCover) form.set('removeCover', 'true')
    try {
      const payload = await apiUpload<{ series: Series }>(
        series ? `/api/manuscripts/series/${series.id}/` : '/api/manuscripts/series/',
        form,
      )
      finishAfterExit(() => onSavedRef.current(payload.series))
    } catch (err) {
      onError(err instanceof Error
        ? err.message
        : t('series.saveFailed', {
            action: t(editing ? 'series.actionUpdate' : 'series.actionCreate'),
          }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={`dialogBackdrop mobileFullViewBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className="createOneShotDialog dialogScrollLayout mobileFullView" role="dialog" aria-modal="true" aria-labelledby="series-dialog-title" ref={setDialogRef}>
        <header>
          <button type="button" className="mobileDialogBack booksButton" aria-label={t('common.back')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy">
            <h2 id="series-dialog-title">{t(editing ? 'series.edit' : 'series.create')}</h2>
            {!editing && <p>{t('series.createLead')}</p>}
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('manuscripts.close')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="close-square-light" />
          </button>
          <button type="submit" form="series-dialog-form" className="mobileDialogPrimary booksButton" title={t(submitting ? 'common.saving' : editing ? 'common.save' : 'series.createAction')} aria-label={t(submitting ? 'common.saving' : editing ? 'common.save' : 'series.createAction')} disabled={submitting || closing || !title.trim()}>
            <Icon name={editing ? 'diskette-light' : 'check-circle-1-light'} />
          </button>
        </header>
        <form id="series-dialog-form" className="mobileFullViewForm mobileHeaderActionForm" onSubmit={(event) => void submit(event)}>
          <div className="dialogScrollBody">
          <label className="dialogField">
            <span>{t('manuscripts.title')} <strong aria-hidden="true">*</strong></span>
            <input
              ref={titleRef}
              value={title}
              maxLength={240}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="dialogField">
            <span>{t('manuscripts.synopsis')} <em>{t('manuscripts.optional')}</em></span>
            <textarea
              value={synopsis}
              maxLength={5000}
              rows={4}
              onChange={(event) => setSynopsis(event.target.value)}
            />
          </label>
          <CoverPicker
            cover={cover}
            onChange={setCover}
            media={coverMedia}
            onMediaChange={setCoverMedia}
            existingCoverUrl={
              series?.coverThumbnailMediumUrl
                ? `${API_BASE}${series.coverThumbnailMediumUrl}?v=${series.coverVersion}`
                : ''
            }
            existingCoverRemoved={removeCover}
            onExistingCoverRemovedChange={setRemoveCover}
            uploadLimitBytes={coverUploadLimitBytes}
            busy={submitting && Boolean(cover)}
          />
          </div>
          <footer>
            <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit booksButton" disabled={submitting || !title.trim()}>
              {submitting
                ? t(editing ? 'common.saving' : 'series.creating')
                : t(editing ? 'manuscripts.saveChanges' : 'series.createAction')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
