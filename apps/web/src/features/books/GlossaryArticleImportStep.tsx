import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../admin/utils'
import { Icon } from '../../icons/Icon'

const MAX_FILE_BYTES = 4 * 1024 * 1024

type ImportIssue = 'count' | 'folder' | 'type' | 'size'

type Props = {
  file: File | null
  busy: boolean
  onChange: (file: File | null) => void
}

export function GlossaryArticleImportStep({ file, busy, onChange }: Props) {
  const { t, i18n } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dropActive, setDropActive] = useState(false)
  const [issue, setIssue] = useState<ImportIssue | null>(null)

  function selectFile(candidate: File) {
    if (busy) return
    if (!candidate.name.toLowerCase().endsWith('.md')) {
      onChange(null)
      setIssue('type')
      return
    }
    if (candidate.size > MAX_FILE_BYTES) {
      onChange(null)
      setIssue('size')
      return
    }
    setIssue(null)
    onChange(candidate)
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    if (busy) return
    const candidates = Array.from(event.target.files ?? [])
    if (candidates.length === 1) selectFile(candidates[0])
    event.target.value = ''
  }

  function dropFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDropActive(false)
    if (busy) return
    const entries = Array.from(event.dataTransfer.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.webkitGetAsEntry())
      .filter((entry): entry is FileSystemEntry => entry !== null)
    if (entries.some((entry) => entry.isDirectory)) {
      onChange(null)
      setIssue('folder')
      return
    }
    const candidates = Array.from(event.dataTransfer.files)
    if (candidates.length !== 1) {
      onChange(null)
      setIssue('count')
      return
    }
    selectFile(candidates[0])
  }

  return (
    <div className="glossaryImportStep">
      <details className="glossaryImportCallout">
        <summary><Icon name="information-circle-light" /> {t('glossary.importDetails')}</summary>
        <ul>
          <li>{t('glossary.importMarkdownOnly')}</li>
          <li>{t('glossary.importSingleFile')}</li>
          <li>{t('glossary.importImagesAndLinks')}</li>
          <li>{t('glossary.importFormatting')}</li>
          <li>{t('glossary.importSizeLimit')}</li>
        </ul>
      </details>

      <div
        className={`glossaryImportDropZone ${dropActive ? 'active' : ''} ${busy ? 'busy' : ''}`}
        aria-disabled={busy}
        onDragEnter={(event) => { event.preventDefault(); setDropActive(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropActive(false)
        }}
        onDrop={dropFile}
      >
        <Icon name="file-document-light" />
        <strong>{t('glossary.importDropFile')}</strong>
        <span>{t('glossary.importSupportedFormat')}</span>
        <button type="button" className="spaceButton" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Icon name="file-add-light" /> {t('glossary.importChooseFile')}
        </button>
        <input
          ref={inputRef}
          hidden
          type="file"
          disabled={busy}
          accept=".md,text/markdown,text/x-markdown"
          onChange={chooseFile}
        />
      </div>

      {issue && <p className="glossaryImportIssue" role="alert">{t(`glossary.importIssues.${issue}`)}</p>}

      <section className="glossaryImportFile" aria-labelledby="glossary-import-file-heading">
        <header>
          <h3 id="glossary-import-file-heading">{t('glossary.importSelectedFile')}</h3>
        </header>
        {file ? (
          <div>
            <Icon name="file-document-light" />
            <span><strong>{file.name}</strong><small>{formatBytes(file.size, i18n.resolvedLanguage ?? 'en')}</small></span>
            <button type="button" className="spaceButton" disabled={busy} onClick={() => { setIssue(null); onChange(null) }}>
              {t('common.delete')}
            </button>
          </div>
        ) : (
          <p>{t('glossary.importNoFile')}</p>
        )}
      </section>
    </div>
  )
}
