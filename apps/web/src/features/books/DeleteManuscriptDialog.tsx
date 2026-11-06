import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { Manuscript } from './ManuscriptTypes'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'

type Props = {
  manuscript: Manuscript
  onClose: () => void
  onDeleted: (manuscript: Manuscript) => void
  onError: (error: string) => void
}

export function DeleteManuscriptDialog({ manuscript, onClose, onDeleted, onError }: Props) {
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
      await apiRequest(`/api/manuscripts/${manuscript.id}/`, { method: 'DELETE' })
      finishAfterExit(() => onDeletedRef.current(manuscript))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('manuscripts.deleteFailed'))
      setSubmitting(false)
    }
  }

  return (
    <div className={`dialogBackdrop mobileBottomSheetBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className="createOneShotDialog manuscriptDeleteDialog mobileBottomSheet" role="alertdialog" aria-modal="true" aria-labelledby="delete-manuscript-title" aria-describedby="delete-manuscript-description" ref={setDialogRef}>
        <header>
          <div>
            <h2 id="delete-manuscript-title">
              {t(manuscript.kind === 'book' ? 'manuscripts.deleteBookTitle' : 'manuscripts.deleteOneShotTitle')}
            </h2>
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('manuscripts.close')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="manuscriptDeleteBody">
          <p id="delete-manuscript-description">
            {t('manuscripts.deleteDescription', { title: manuscript.title })}
          </p>
        </div>
        <footer>
          <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button>
          <button type="button" className="dialogDelete booksButton" onClick={() => void remove()} disabled={submitting}>{submitting ? t('account.deleting') : t('manuscripts.deletePermanently')}</button>
        </footer>
      </div>
    </div>
  )
}
