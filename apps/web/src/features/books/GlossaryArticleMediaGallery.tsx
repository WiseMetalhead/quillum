import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { PrivateImage } from '../shared/PrivateImage'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import type { GlossaryAsset } from './GlossaryTypes'
import './GlossaryArticleMediaGallery.css'

type Props = {
  manuscriptId: string
  articleId: string
  onClose: () => void
}

export function GlossaryArticleMediaGallery({ manuscriptId, articleId, onClose }: Props) {
  const { t } = useTranslation()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const [assets, setAssets] = useState<GlossaryAsset[]>([])
  const [selected, setSelected] = useState<GlossaryAsset | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const { backdropStateClass, close, closing, setDialogRef } = useMobileDialogTransition({
    onClose,
    initialFocusRef: closeRef,
  })

  useEffect(() => {
    const previousFocus = previousFocusRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      previousFocus?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    let active = true
    void apiRequest<{ assets: GlossaryAsset[] }>(
      `/api/manuscripts/${manuscriptId}/glossary/articles/${articleId}/assets/`,
    )
      .then((payload) => {
        if (!active) return
        setAssets(payload.assets)
        setSelected(payload.assets[0] ?? null)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [articleId, manuscriptId])

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = document.querySelector<HTMLElement>(`[data-gallery-dialog="${titleId}"]`)
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1) ?? first
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyboard, true)
    return () => document.removeEventListener('keydown', handleKeyboard, true)
  }, [close, titleId])

  return createPortal(
    <div
      className={`glossaryMediaGalleryBackdrop mobileFullViewBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closing) close()
      }}
    >
      <section
        className="glossaryMediaGalleryDialog mobileFullView"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-gallery-dialog={titleId}
        ref={setDialogRef}
      >
        <header>
          <button ref={closeRef} type="button" className="mobileDialogBack spaceButton" aria-label={t('common.back')} disabled={closing} onClick={close}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy">
            <h2 id={titleId}>{t('glossary.mediaGallery')}</h2>
          </div>
          <button type="button" className="glossaryMediaGalleryClose spaceButton" aria-label={t('common.close')} disabled={closing} onClick={close}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="glossaryMediaGalleryBody" aria-busy={loading}>
          {loading && <div className="glossaryMediaGalleryState" role="status" aria-label={t('glossary.mediaLoading')}><TadpoleIcon /><span>{t('glossary.mediaLoading')}</span></div>}
          {!loading && failed && <div className="glossaryMediaGalleryState"><Icon name="danger-light" /><span>{t('glossary.mediaLoadFailed')}</span></div>}
          {!loading && !failed && assets.length === 0 && <div className="glossaryMediaGalleryState"><Icon name="gallery-light" /><span>{t('glossary.noMedia')}</span></div>}
          {!loading && !failed && assets.length > 0 && <>
            <div className="glossaryMediaGalleryGrid" aria-label={t('glossary.mediaItems')}>
              {assets.map((asset, index) => (
                <button
                  key={asset.id}
                  type="button"
                  className={`glossaryMediaGalleryTile spaceButton ${selected?.id === asset.id ? 'active' : ''}`}
                  aria-label={t('glossary.openMediaItem', { type: t(`glossary.mediaTypes.${asset.kind}`), number: index + 1 })}
                  aria-pressed={selected?.id === asset.id}
                  onClick={() => setSelected(asset)}
                >
                  <PrivateImage src={`${API_BASE}${asset.mediumUrl}`} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
            {selected && (
              <div className="glossaryMediaGalleryPreview">
                <div className="glossaryMediaGalleryPreviewImage">
                  <PrivateImage src={`${API_BASE}${selected.largeUrl}`} alt={selected.alt} decoding="async" />
                </div>
              </div>
            )}
          </>}
        </div>
      </section>
    </div>,
    document.body,
  )
}
