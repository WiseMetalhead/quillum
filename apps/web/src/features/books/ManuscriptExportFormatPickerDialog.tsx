import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import type { ManuscriptExportFormat } from './ManuscriptExports'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'

const EXPORT_FORMATS: ManuscriptExportFormat[] = [
  'markdown',
  'epub2',
  'epub3',
  'docx',
  'odt',
  'fb2',
]

type Props = {
  format: ManuscriptExportFormat
  onSelect: (format: ManuscriptExportFormat) => void
  onClose: () => void
}

export function ManuscriptExportFormatPickerDialog({ format, onSelect, onClose }: Props) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(format)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') closeDialog()
    }
    window.document.addEventListener('keydown', closeOnEscape)
    return () => window.document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog])

  return createPortal(
    <div className={`exportFormatPickerBackdrop mobileBottomSheetBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeDialog()
    }}>
      <section className="exportFormatPickerDialog mobileBottomSheet" role="dialog" aria-modal="true" aria-labelledby="export-format-picker-title" ref={setDialogRef}>
        <header>
          <div>
            <h2 id="export-format-picker-title">{t('exports.formatPickerTitle')}</h2>
            <p>{t('exports.formatPickerLead')}</p>
          </div>
          <button type="button" className="exportFormatPickerClose spaceButton" aria-label={t('common.close')} onClick={closeDialog} disabled={closing}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="exportFormatPickerGrid" role="radiogroup" aria-label={t('exports.formatLabel')}>
          {EXPORT_FORMATS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={`exportFormatPickerTile spaceButton ${selected === candidate ? 'active' : ''}`}
              role="radio"
              aria-checked={selected === candidate}
              onClick={() => setSelected(candidate)}
            >
              <strong>{t(`exports.formats.${candidate}.label`)}</strong>
              <small>{t(`exports.formats.${candidate}.description`)}</small>
            </button>
          ))}
        </div>
        <footer>
          <button type="button" className="exportFormatPickerSecondaryAction spaceButton" onClick={closeDialog} disabled={closing}>{t('common.cancel')}</button>
          <button type="button" className="exportFormatPickerPrimaryAction spaceButton" disabled={closing} onClick={() => finishAfterExit(() => onSelect(selected))}>
            <Icon name="check-circle-1-light" /> {t('exports.useFormat')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
