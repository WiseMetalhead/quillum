import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { Manuscript as OneShot } from './ManuscriptTypes'
import { CoverPicker } from './CoverPicker'
import { ManuscriptImportStep } from './ManuscriptImportStep'
import type { ImportSubmission } from './ManuscriptImportStep'
import type { StorageItem } from '../../types'
import { ManuscriptMetadataFields } from './ManuscriptMetadataFields'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'

type CreateOneShotDialogProps = {
  onClose: () => void
  onCreated: (manuscript: OneShot) => void
  onError: (error: string) => void
  coverUploadLimitBytes?: number | null
}

export function CreateOneShotDialog({
  onClose,
  onCreated,
  onError,
  coverUploadLimitBytes = null,
}: CreateOneShotDialogProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [language, setLanguage] = useState('')
  const [genres, setGenres] = useState<string[]>([])
  const [cover, setCover] = useState<File | null>(null)
  const [coverMedia, setCoverMedia] = useState<StorageItem | null>(null)
  const [importing, setImporting] = useState(false)
  const [creationChoiceOpen, setCreationChoiceOpen] = useState(false)
  const [stepDirection, setStepDirection] = useState<'forward' | 'back' | null>(null)
  const [importSubmission, setImportSubmission] = useState<ImportSubmission | null>(null)
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
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
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
    onError('')
    const form = new FormData()
    form.set('title', title.trim())
    form.set('synopsis', synopsis.trim())
    form.set('language', language)
    form.set('genres', JSON.stringify(genres))
    if (cover) form.set('cover', cover)
    if (coverMedia) form.set('coverMediaId', coverMedia.id.replace(/^media:/, ''))
    if (importing && importSubmission) {
      form.set('importManifest', importSubmission.manifest)
      for (const imported of importSubmission.files) form.set(imported.key, imported.file)
    }
    try {
      const payload = await apiUpload<{ manuscript: OneShot }>('/api/manuscripts/oneshots/', form)
      finishAfterExit(() => onCreatedRef.current(payload.manuscript))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('creation.oneShotFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className={`dialogBackdrop mobileFullViewBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) closeDialog()
      }}
    >
      <div className={`createOneShotDialog dialogScrollLayout mobileFullView ${importing ? 'importDialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="create-oneshot-title" ref={setDialogRef}>
        <header>
          <button type="button" className="mobileDialogBack booksButton" aria-label={t('common.back')} onClick={() => importing ? showDetailsStep() : closeDialog()} disabled={submitting || closing}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy">
            <h2 id="create-oneshot-title" className={stepDirection ? `mobileCreationTitle ${stepDirection}` : ''}>
              {t(importing ? 'creation.importOneShot' : 'creation.createOneShot')}
            </h2>
            {importing && <p>{t('creation.importOneShotLead')}</p>}
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('manuscripts.close')} onClick={closeDialog} disabled={submitting}>
            <Icon name="close-square-light" />
          </button>
          <button
            type={importing ? 'submit' : 'button'}
            form="create-oneshot-form"
            className="mobileDialogPrimary booksButton"
            title={t(submitting ? 'creation.importing' : importing ? 'creation.importOneShotAction' : 'common.continue')}
            aria-label={t(submitting ? 'creation.importing' : importing ? 'creation.importOneShotAction' : 'common.continue')}
            disabled={submitting || closing || !title.trim() || !language || (importing && !importSubmission)}
            onClick={importing ? undefined : () => setCreationChoiceOpen(true)}
          >
            <Icon name={importing ? 'check-circle-1-light' : 'arrow-right-1'} />
          </button>
        </header>

        <form id="create-oneshot-form" ref={formRef} className="mobileFullViewForm" onSubmit={(event) => void submit(event)}>
          <div className="dialogScrollBody">
          <div className={`mobileCreationStep ${stepDirection === 'forward' ? 'enterFromRight' : ''}`} hidden={!importing}>
            <ManuscriptImportStep kind="oneshot" onChange={handleImportChange} />
          </div>
          <div className={`dialogDetailsStep mobileCreationStep ${stepDirection === 'back' ? 'enterFromLeft' : ''}`} hidden={importing}>
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

              <ManuscriptMetadataFields language={language} genres={genres} onLanguageChange={setLanguage} onGenresChange={setGenres} disabled={submitting} />

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
              {importing ? <Icon name="archive-up-light" /> : <PlusIcon />}
              {submitting
                ? t(importing ? 'creation.importing' : 'creation.creating')
                : t(importing ? 'creation.importOneShotAction' : 'creation.createOneShotAction')}
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
            label: t('creation.createOneShotAction'),
            icon: <Icon name="file-document-light" />,
            onSelect: () => {
              createWithoutImportRef.current = true
              formRef.current?.requestSubmit()
            },
          },
          {
            key: 'import',
            label: t('creation.importOneShotAction'),
            icon: <Icon name="archive-up-light" />,
            onSelect: showImportStep,
          },
        ]}
      />
    </div>
  )
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}
