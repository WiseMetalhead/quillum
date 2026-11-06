import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { API_BASE } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { StorageItem } from '../../types'
import { formatBytes } from '../admin/utils'
import { StorageImagePickerDialog } from '../shared/StorageImagePickerDialog'

const ACCEPTED_COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

type Props = {
  cover: File | null
  onChange: (cover: File | null) => void
  media?: StorageItem | null
  onMediaChange?: (media: StorageItem | null) => void
  existingCoverUrl?: string
  existingCoverRemoved?: boolean
  onExistingCoverRemovedChange?: (removed: boolean) => void
  uploadLimitBytes?: number | null
  busy?: boolean
}

export function CoverPicker({
  cover,
  onChange,
  media = null,
  onMediaChange,
  existingCoverUrl = '',
  existingCoverRemoved = false,
  onExistingCoverRemovedChange,
  uploadLimitBytes = null,
  busy = false,
}: Props) {
  const { t, i18n } = useTranslation()
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const previewUrlRef = useRef('')

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  function select(file: File | undefined) {
    setError('')
    if (!file) return
    if (!ACCEPTED_COVER_TYPES.has(file.type)) {
      setError(t('cover.invalidType'))
      return
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = URL.createObjectURL(file)
    setPreview(previewUrlRef.current)
    onExistingCoverRemovedChange?.(false)
    onMediaChange?.(null)
    onChange(file)
  }

  function remove() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = ''
    setPreview('')
    setError('')
    onChange(null)
    onMediaChange?.(null)
    if (existingCoverUrl) onExistingCoverRemovedChange?.(true)
  }

  const displayedPreview = preview || (media ? `${API_BASE}${media.previewUrl}` : '') || (!existingCoverRemoved ? existingCoverUrl : '')
  const hasCover = Boolean(cover || media || displayedPreview)

  return (
    <div className="dialogField">
      <span>{t('cover.label')} <em>{t('manuscripts.optional')}</em></span>
      <div className={`coverPicker ${displayedPreview ? 'hasPreview' : ''}`} aria-busy={busy}>
        {displayedPreview ? <img src={displayedPreview} alt={t('cover.selectedPreview')} /> : (
          <span className="coverPickerIcon" aria-hidden="true">
            <Icon name="gallery-light" />
          </span>
        )}
        <div>
          <strong>
            {cover ? cover.name : media ? media.title : hasCover ? t('cover.current') : t('cover.upload')}
          </strong>
          <small>
            {uploadLimitBytes === null
              ? t('cover.requirements')
              : t('cover.requirementsWithLimit', {
                  size: formatBytes(uploadLimitBytes, i18n.resolvedLanguage ?? 'en'),
                })}
          </small>
          <div className="coverPickerActions">
            <label className="coverFileButton">
              {t('cover.uploadFile')}
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => select(event.target.files?.[0])} />
            </label>
            <button type="button" className="coverFileButton booksButton" disabled={busy} onClick={() => setPickerOpen(true)}>{t('mediaPicker.select')}</button>
            {hasCover && <button type="button" className="removeCoverButton booksButton" disabled={busy} onClick={remove}>{t('cover.remove')}</button>}
          </div>
        </div>
        {busy && (
          <div className="imageUploadOverlay" role="status" aria-live="polite">
            <TadpoleIcon />
            <span>{t('uploads.processingCover')}</span>
          </div>
        )}
      </div>
      {error && <small className="fieldError">{error}</small>}
      <StorageImagePickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={(item) => {
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = ''
        setPreview('')
        onChange(null)
        onMediaChange?.(item)
        onExistingCoverRemovedChange?.(false)
        setPickerOpen(false)
      }} />
    </div>
  )
}
