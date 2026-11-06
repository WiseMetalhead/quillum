import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { Manuscript, SeriesBook } from './ManuscriptTypes'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'

type Props = {
  book: SeriesBook
  seriesTitle: string
  onClose: () => void
  onRemoved: (book: Manuscript) => void
  onError: (error: string) => void
}

export function RemoveFromSeriesDialog({
  book,
  seriesTitle,
  onClose,
  onRemoved,
  onError,
}: Props) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const onRemovedRef = useRef(onRemoved)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    onRemovedRef.current = onRemoved
  }, [onRemoved])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, submitting])

  async function remove() {
    if (submitting) return
    setSubmitting(true)
    onError('')
    try {
      const payload = await apiRequest<{ book: Manuscript }>(
        `/api/manuscripts/books/${book.id}/series-membership/`,
        { method: 'DELETE' },
      )
      finishAfterExit(() => onRemovedRef.current(payload.book))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('series.removeFailed'))
      setSubmitting(false)
    }
  }

  return (
    <div className={`dialogBackdrop mobileBottomSheetBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className="createOneShotDialog manuscriptDeleteDialog mobileBottomSheet" role="alertdialog" aria-modal="true" aria-labelledby="remove-from-series-title" aria-describedby="remove-from-series-description" ref={setDialogRef}>
        <header>
          <div>
            <h2 id="remove-from-series-title">{t('series.removeTitle')}</h2>
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('manuscripts.close')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="manuscriptDeleteBody">
          <p id="remove-from-series-description">
            {t('series.removeDescription', { book: book.title, series: seriesTitle })}
          </p>
        </div>
        <footer>
          <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button>
          <button type="button" className="dialogSubmit booksButton" onClick={() => void remove()} disabled={submitting}>
            {submitting ? t('series.removing') : t('series.removeFromSeries')}
          </button>
        </footer>
      </div>
    </div>
  )
}
