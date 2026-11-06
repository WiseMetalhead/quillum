import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { CoverPicker } from './CoverPicker'
import { ManuscriptImportStep } from './ManuscriptImportStep'
import type { ImportSubmission } from './ManuscriptImportStep'
import type { Manuscript } from './ManuscriptTypes'
import type { StorageItem } from '../../types'
import { ManuscriptMetadataFields } from './ManuscriptMetadataFields'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'

type Props = {
  onClose: () => void
  onCreated: (manuscript: Manuscript) => void
  onError: (error: string) => void
  seriesId?: string
  initialSeriesPosition?: number
  coverUploadLimitBytes?: number | null
}

export function CreateBookDialog({
  onClose,
  onCreated,
  onError,
  seriesId,
  initialSeriesPosition = 1,
  coverUploadLimitBytes = null,
}: Props) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [language, setLanguage] = useState('')
  const [genres, setGenres] = useState<string[]>([])
  const [template, setTemplate] = useState<'chapters' | 'scenes'>('chapters')
  const [cover, setCover] = useState<File | null>(null)
  const [coverMedia, setCoverMedia] = useState<StorageItem | null>(null)
  const [importing, setImporting] = useState(false)
  const [creationChoiceOpen, setCreationChoiceOpen] = useState(false)
  const [stepDirection, setStepDirection] = useState<'forward' | 'back' | null>(null)
  const [importSubmission, setImportSubmission] = useState<ImportSubmission | null>(null)
  const [seriesPosition, setSeriesPosition] = useState<number | ''>(initialSeriesPosition)
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const createWithoutImportRef = useRef(false)
  const onCreatedRef = useRef(onCreated)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose, initialFocusRef: titleRef })
  const handleImportChange = useCallback((submission: ImportSubmission | null) => {
    setImportSubmission(submission)
  }, [])

  const resetStepScroll = useCallback(() => {
    if (!window.matchMedia('(max-width: 520px)').matches) return
    window.requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('.dialogScrollBody')?.scrollTo({ top: 0 })
    })
  }, [])

  const showImportStep = useCallback(() => {
    setStepDirection('forward')
    setImporting(true)
    resetStepScroll()
  }, [resetStepScroll])

  const showDetailsStep = useCallback(() => {
    setStepDirection('back')
    setImporting(false)
    resetStepScroll()
  }, [resetStepScroll])

  useEffect(() => {
    onCreatedRef.current = onCreated
  }, [onCreated])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) {
        if (creationChoiceOpen) return
        if (importing) showDetailsStep()
        else closeDialog()
      }
    }
    window.document.addEventListener('keydown', closeOnEscape)
    return () => window.document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, creationChoiceOpen, importing, showDetailsStep, submitting])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || !title.trim() || !language || (importing && !importSubmission)) {
      createWithoutImportRef.current = false
      return
    }
    if (!importing && window.matchMedia('(max-width: 520px)').matches && !createWithoutImportRef.current) {
      setCreationChoiceOpen(true)
      return
    }
    createWithoutImportRef.current = false
    setSubmitting(true)
    try {
      const form = new FormData()
      form.set('title', title.trim())
      form.set('synopsis', synopsis.trim())
      form.set('language', language)
      form.set('genres', JSON.stringify(genres))
      form.set('template', template)
      if (seriesId !== undefined && seriesPosition !== '') {
        form.set('seriesPosition', String(seriesPosition))
      }
      if (cover) form.set('cover', cover)
      if (coverMedia) form.set('coverMediaId', coverMedia.id.replace(/^media:/, ''))
      if (importing && importSubmission) {
        form.set('importManifest', importSubmission.manifest)
        for (const imported of importSubmission.files) form.set(imported.key, imported.file)
      }
      if (seriesId === undefined) {
        const payload = await apiUpload<{ manuscript: Manuscript }>('/api/manuscripts/books/', form)
        finishAfterExit(() => onCreatedRef.current(payload.manuscript))
      } else {
        const payload = await apiUpload<{ book: Manuscript }>(
          `/api/manuscripts/series/${seriesId}/books/`,
          form,
        )
        finishAfterExit(() => onCreatedRef.current(payload.book))
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : t('creation.bookFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={`dialogBackdrop mobileFullViewBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className={`createOneShotDialog dialogScrollLayout mobileFullView ${importing ? 'importDialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="create-book-title" ref={setDialogRef}>
        <header>
          <button type="button" className="mobileDialogBack booksButton" aria-label={t('common.back')} onClick={() => importing ? showDetailsStep() : closeDialog()} disabled={submitting || closing}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy">
            <h2 id="create-book-title" className={stepDirection ? `mobileCreationTitle ${stepDirection}` : ''}>
              {t(importing ? 'creation.importBook' : 'creation.createBook')}
            </h2>
            {importing && <p>{t('creation.importBookLead')}</p>}
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('manuscripts.close')} onClick={closeDialog} disabled={submitting}><Icon name="close-square-light" /></button>
          <button
            type={importing ? 'submit' : 'button'}
            form="create-book-form"
            className="mobileDialogPrimary booksButton"
            title={t(submitting ? 'creation.importing' : importing ? 'creation.importBookAction' : 'common.continue')}
            aria-label={t(submitting ? 'creation.importing' : importing ? 'creation.importBookAction' : 'common.continue')}
            disabled={submitting || closing || !title.trim() || !language || (importing && !importSubmission)}
            onClick={importing ? undefined : () => setCreationChoiceOpen(true)}
          >
            <Icon name={importing ? 'check-circle-1-light' : 'arrow-right-1'} />
          </button>
        </header>
        <form id="create-book-form" ref={formRef} className="mobileFullViewForm" onSubmit={(event) => void submit(event)}>
          <div className="dialogScrollBody">
          <div className={`mobileCreationStep ${stepDirection === 'forward' ? 'enterFromRight' : ''}`} hidden={!importing}>
            <ManuscriptImportStep kind="book" onChange={handleImportChange} />
          </div>
          <div className={`dialogDetailsStep mobileCreationStep ${stepDirection === 'back' ? 'enterFromLeft' : ''}`} hidden={importing}>
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
                value={seriesPosition}
                onChange={(event) => setSeriesPosition(
                  event.target.value === '' ? '' : Number(event.target.value),
                )}
              />
              <small>{t('manuscripts.orderHint')}</small>
            </label>
          )}
          <fieldset className="bookTemplatePicker">
            <legend>{t('creation.startingStructure')}</legend>
            <label className={template === 'chapters' ? 'selected' : ''}>
              <input type="radio" name="template" value="chapters" checked={template === 'chapters'} onChange={() => setTemplate('chapters')} />
              <strong>{t('creation.chaptersAsDocuments')}</strong>
              <small>{t('creation.chaptersAsDocumentsLead')}</small>
            </label>
            <label className={template === 'scenes' ? 'selected' : ''}>
              <input type="radio" name="template" value="scenes" checked={template === 'scenes'} onChange={() => setTemplate('scenes')} />
              <strong>{t('creation.scenesAsDocuments')}</strong>
              <small>{t('creation.scenesAsDocumentsLead')}</small>
            </label>
          </fieldset>
          <CoverPicker cover={cover} onChange={setCover} media={coverMedia} onMediaChange={setCoverMedia} uploadLimitBytes={coverUploadLimitBytes} busy={submitting && Boolean(cover)} />
          </div>
          </div>
          <footer className="dialogThreeActionFooter mobileCreationFooter">
            {importing ? (
              <button type="button" className="dialogImportButton booksButton" onClick={showDetailsStep} disabled={submitting}>
                <Icon name="arrow-left-1" /> {t('creation.back')}
              </button>
            ) : (
              <button type="button" className="dialogImportButton booksButton" onClick={showImportStep} disabled={submitting || !title.trim() || !language}>
                <Icon name="archive-up-light" /> {t('creation.import')}
              </button>
            )}
            <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit booksButton" disabled={submitting || !title.trim() || !language || (importing && !importSubmission)}>
              {importing && <Icon name="archive-up-light" />}
              {submitting
                ? t(importing ? 'creation.importing' : 'creation.creating')
                : t(importing ? 'creation.importBookAction' : 'creation.createBookAction')}
            </button>
          </footer>
        </form>
      </div>
      <MobileLibraryActionSheet
        open={creationChoiceOpen}
        title={t('creation.chooseCreationPath')}
        dismissOnSelect
        onClose={() => setCreationChoiceOpen(false)}
        actions={[
          {
            key: 'create',
            label: t('creation.createBookAction'),
            icon: <Icon name="books-light" />,
            onSelect: () => {
              createWithoutImportRef.current = true
              formRef.current?.requestSubmit()
            },
          },
          {
            key: 'import',
            label: t('creation.importBookAction'),
            icon: <Icon name="archive-up-light" />,
            onSelect: showImportStep,
          },
        ]}
      />
    </div>
  )
}
