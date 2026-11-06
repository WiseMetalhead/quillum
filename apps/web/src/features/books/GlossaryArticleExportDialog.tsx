import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'

export type GlossaryArticleExportFormat = 'markdown' | 'html'

type Props = {
  busy: boolean
  error: string
  onClose: () => void
  onExport: (format: GlossaryArticleExportFormat) => Promise<boolean>
}

type ExportFormProps = Pick<Props, 'busy' | 'error' | 'onExport'> & {
  format: GlossaryArticleExportFormat
  closing?: boolean
  mobile?: boolean
  close: () => void
  onFormatChange: (format: GlossaryArticleExportFormat) => void
}

function ExportForm({ busy, error, onExport, format, closing = false, mobile = false, close, onFormatChange }: ExportFormProps) {
  const { t } = useTranslation()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || closing) return
    if (await onExport(format)) close()
  }

  return (
    <form className={mobile ? 'glossaryExportMobileForm' : undefined} onSubmit={(event) => void submit(event)}>
      <fieldset className="glossaryExportFormats" disabled={busy || closing}>
        <legend>{t('glossary.exportFormat')}</legend>
        {(['markdown', 'html'] as const).map((candidate) => (
          <label key={candidate} className={format === candidate ? 'active' : ''}>
            <input
              type="radio"
              name="glossary-export-format"
              value={candidate}
              checked={format === candidate}
              onChange={() => onFormatChange(candidate)}
            />
            <span>
              <strong>{t(`glossary.exportFormats.${candidate}.label`)}</strong>
              <small>{t(`glossary.exportFormats.${candidate}.description`)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="glossaryExportNotice">{t('glossary.exportNotice')}</p>
      {error && <div className="notice error inline" role="alert">{error}</div>}
      <footer>
        <button
          type="button"
          className="dialogCancel spaceButton"
          disabled={busy || closing}
          onClick={close}
        >
          {t('common.cancel')}
        </button>
        <button type="submit" className="dialogSubmit spaceButton" disabled={busy || closing}>
          <Icon name="download-minimalistic-light" />
          {t(busy ? 'glossary.exporting' : 'glossary.exportConfirm')}
        </button>
      </footer>
    </form>
  )
}

type ExportPresentationProps = Props & {
  format: GlossaryArticleExportFormat
  onFormatChange: (format: GlossaryArticleExportFormat) => void
}

function DesktopExportDialog({ busy, error, onClose, onExport, format, onFormatChange }: ExportPresentationProps) {
  const { t } = useTranslation()
  const { backdropStateClass, close: closeDialog, closing } = useMobileDialogTransition({ onClose })
  return (
    <ActionDialog
      variant="structured"
      title={t('glossary.exportTitle')}
      description={t('glossary.exportLead')}
      closeLabel={t('common.close')}
      busy={busy || closing}
      className="glossaryExportDialog glossaryArticleBottomSheet"
      backdropClassName={`glossaryArticleBottomSheetBackdrop ${backdropStateClass}`}
      onClose={closeDialog}
    >
      <ExportForm busy={busy} error={error} onExport={onExport} format={format} closing={closing} close={closeDialog} onFormatChange={onFormatChange} />
    </ActionDialog>
  )
}

function MobileExportDialog({ busy, error, onClose, onExport, format, onFormatChange }: ExportPresentationProps) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={t('glossary.exportTitle')} busy={busy} onClose={onClose}>
      {(close) => <ExportForm mobile busy={busy} error={error} onExport={onExport} format={format} close={close} onFormatChange={onFormatChange} />}
    </MobileSettingsSheet>
  )
}

export function GlossaryArticleExportDialog(props: Props) {
  const mobile = useMobileViewport()
  const [format, setFormat] = useState<GlossaryArticleExportFormat>('markdown')
  const presentationProps = { ...props, format, onFormatChange: setFormat }
  return mobile
    ? <MobileExportDialog {...presentationProps} />
    : <DesktopExportDialog {...presentationProps} />
}
