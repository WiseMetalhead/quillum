import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { CoverPicker } from './CoverPicker'
import type { Manuscript } from './ManuscriptTypes'
import type { StorageItem } from '../../types'
import { ManuscriptMetadataFields } from './ManuscriptMetadataFields'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'

type Props = {
  manuscript: Manuscript
  onClose: () => void
  onSaved: (manuscript: Manuscript) => void
  onError: (error: string) => void
  seriesId?: string
  seriesPosition?: number | null
  coverUploadLimitBytes?: number | null
}

export function EditManuscriptDialog({
  manuscript,
  onClose,
  onSaved,
  onError,
  seriesId,
  seriesPosition = null,
  coverUploadLimitBytes = null,
}: Props) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(manuscript.title)
  const [synopsis, setSynopsis] = useState(manuscript.synopsis)
  const [language, setLanguage] = useState(manuscript.language)
  const [genres, setGenres] = useState<string[]>(manuscript.genres)
  const [cover, setCover] = useState<File | null>(null)
  const [coverMedia, setCoverMedia] = useState<StorageItem | null>(null)
  const [removeCover, setRemoveCover] = useState(false)
  const [position, setPosition] = useState<number | ''>(seriesPosition ?? '')
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
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
    if (submitting || !title.trim() || !language) return
    setSubmitting(true)
    onError('')
    const form = new FormData()
    form.set('title', title.trim())
    form.set('synopsis', synopsis.trim())
    form.set('language', language)
    form.set('genres', JSON.stringify(genres))
    if (cover) form.set('cover', cover)
    if (coverMedia) form.set('coverMediaId', coverMedia.id.replace(/^media:/, ''))
    if (removeCover) form.set('removeCover', 'true')
    if (seriesId !== undefined && position !== '') {
      form.set('seriesPosition', String(position))
    }
    try {
      const payload = await apiUpload<{ manuscript: Manuscript } | { book: Manuscript }>(
        seriesId === undefined
          ? `/api/manuscripts/${manuscript.id}/`
          : `/api/manuscripts/series/${seriesId}/books/${manuscript.id}/`,
        form,
      )
      const saved = 'manuscript' in payload ? payload.manuscript : payload.book
      finishAfterExit(() => onSavedRef.current(saved))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('manuscripts.updateFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={`dialogBackdrop mobileFullViewBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className="createOneShotDialog dialogScrollLayout mobileFullView editManuscriptView" role="dialog" aria-modal="true" aria-labelledby="edit-manuscript-title" ref={setDialogRef}>
        <header>
          <button type="button" className="mobileDialogBack editManuscriptBack booksButton" aria-label={t('common.back')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy editManuscriptHeaderCopy">
            <h2 id="edit-manuscript-title">
              {t(manuscript.kind === 'book' ? 'manuscripts.editBook' : 'manuscripts.editOneShot')}
            </h2>
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('manuscripts.close')} onClick={closeDialog} disabled={submitting || closing}><Icon name="close-square-light" /></button>
          <button
            type="submit"
            form="edit-manuscript-form"
            className="mobileDialogPrimary editManuscriptSave booksButton"
            title={t(submitting ? 'common.saving' : 'common.save')}
            aria-label={t(submitting ? 'common.saving' : 'common.save')}
            disabled={submitting || closing}
          >
            <Icon name="diskette-light" />
          </button>
        </header>
        <form id="edit-manuscript-form" className="mobileFullViewForm mobileHeaderActionForm editManuscriptForm" onSubmit={(event) => void submit(event)}>
          <div className="dialogScrollBody">
          <label className="dialogField">
            <span>{t('manuscripts.title')} <strong aria-hidden="true">*</strong></span>
            <input ref={titleRef} value={title} maxLength={240} required onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="dialogField">
            <span>{t('manuscripts.synopsis')} <em>{t('manuscripts.optional')}</em></span>
            <textarea value={synopsis} maxLength={5000} rows={4} onChange={(event) => setSynopsis(event.target.value)} />
          </label>
          <ManuscriptMetadataFields language={language} genres={genres} onLanguageChange={setLanguage} onGenresChange={setGenres} disabled={submitting} />
          {seriesId !== undefined && (
            <label className="dialogField">
              <span>{t('manuscripts.orderInSeries')} <em>{t('manuscripts.optional')}</em></span>
              <input
                type="number"
                min={1}
                step={1}
                value={position}
                placeholder={t('manuscripts.noOrder')}
                onChange={(event) => setPosition(
                  event.target.value === '' ? '' : Number(event.target.value),
                )}
              />
              <small>{t('manuscripts.orderHint')}</small>
            </label>
          )}
          <CoverPicker
            cover={cover}
            onChange={setCover}
            media={coverMedia}
            onMediaChange={setCoverMedia}
            existingCoverUrl={manuscript.coverThumbnailMediumUrl ? `${API_BASE}${manuscript.coverThumbnailMediumUrl}?v=${manuscript.coverVersion}` : ''}
            existingCoverRemoved={removeCover}
            onExistingCoverRemovedChange={setRemoveCover}
            uploadLimitBytes={coverUploadLimitBytes}
            busy={submitting && Boolean(cover)}
          />
          </div>
          <footer>
            <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit booksButton" disabled={submitting}>{submitting ? t('common.saving') : t('manuscripts.saveChanges')}</button>
          </footer>
        </form>
      </div>
    </div>
  )
}
