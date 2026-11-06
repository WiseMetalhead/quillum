import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { API_BASE } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { PrivateImage } from '../shared/PrivateImage'
import './GlossaryImageLightbox.css'

export type GlossaryLightboxImage = {
  assetId: string
  alt: string
  caption: string
}

type Props = {
  image: GlossaryLightboxImage
  manuscriptId: string
  onClose: () => void
}

export function GlossaryImageLightbox({ image, manuscriptId, onClose }: Props) {
  const { t } = useTranslation()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        closeRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyboard)
    return () => {
      document.removeEventListener('keydown', handleKeyboard)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className="glossaryLightboxBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="glossaryLightbox"
        role="dialog"
        aria-modal="true"
        aria-label={t('glossary.imageLightbox')}
      >
        <button
          ref={closeRef}
          type="button"
          className="glossaryLightboxClose spaceButton"
          aria-label={t('glossary.closeImageLightbox')}
          title={t('glossary.closeImageLightbox')}
          onClick={onClose}
        >
          <Icon name="close-square-light" />
        </button>
        <PrivateImage
          src={`${API_BASE}/api/manuscripts/${manuscriptId}/glossary/assets/${image.assetId}/large/`}
          alt={image.alt}
          decoding="async"
        />
        {image.caption && <p>{image.caption}</p>}
      </section>
    </div>,
    document.body,
  )
}
