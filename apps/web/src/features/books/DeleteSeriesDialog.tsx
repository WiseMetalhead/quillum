import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { Manuscript, Series } from './ManuscriptTypes'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'

type Props = {
  series: Series
  onClose: () => void
  onDeleted: (series: Series, books: Manuscript[]) => void
  onError: (error: string) => void
}

export function DeleteSeriesDialog({ series, onClose, onDeleted, onError }: Props) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const onDeletedRef = useRef(onDeleted)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    onDeletedRef.current = onDeleted
  }, [onDeleted])

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
      const payload = await apiRequest<{ books: Manuscript[] }>(
        `/api/manuscripts/series/${series.id}/`,
        { method: 'DELETE' },
      )
      finishAfterExit(() => onDeletedRef.current(series, payload.books))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('series.deleteFailed'))
      setSubmitting(false)
    }
  }

  return (
    <div className={`dialogBackdrop mobileBottomSheetBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className="createOneShotDialog manuscriptDeleteDialog mobileBottomSheet" role="alertdialog" aria-modal="true" aria-labelledby="delete-series-title" aria-describedby="delete-series-description" ref={setDialogRef}>
        <header>
          <div>
            <h2 id="delete-series-title">{t('series.deleteTitle')}</h2>
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('manuscripts.close')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="manuscriptDeleteBody">
          <p id="delete-series-description">
            {t('series.deleteDescription', { title: series.title, count: series.bookCount })}
          </p>
        </div>
        <footer>
          <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button>
          <button type="button" className="dialogDelete booksButton" onClick={() => void remove()} disabled={submitting}>
            {submitting ? t('account.deleting') : t('series.deleteAction')}
          </button>
        </footer>
      </div>
    </div>
  )
}
