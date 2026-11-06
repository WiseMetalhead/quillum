import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, apiRequest } from '../../api/client'
import type { ServicePageDocument, ServicePageMetadata, ServicePageSlug } from '../../types'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { SafeServicePageMarkdown } from './SafeServicePageMarkdown'
import { PublicFooter } from './PublicFooter'
import { servicePageLabelKey } from './servicePages'
import './ServicePageView.css'

type Props = {
  slug: ServicePageSlug
  pages: ServicePageMetadata[]
  onUnavailable: () => void
  onError: (message: string) => void
}

export function ServicePageView({ slug, pages, onUnavailable, onError }: Props) {
  const { t, i18n } = useTranslation()
  const [serviceDocument, setServiceDocument] = useState<ServicePageDocument | null>(null)

  useEffect(() => {
    let active = true
    window.document.title = `${t(servicePageLabelKey(slug))} — Quillum`
    void apiRequest<ServicePageDocument>(`/api/service-pages/${slug}/`)
      .then((payload) => {
        if (active) setServiceDocument(payload)
      })
      .catch((error) => {
        if (!active) return
        if (
          error instanceof ApiError
          && (error.code === 'service_page_not_published' || error.code === 'service_page_not_found')
        ) {
          onUnavailable()
          return
        }
        onError(error instanceof Error ? error.message : t('servicePages.loadFailed'))
      })
    return () => {
      active = false
      window.document.title = 'Quillum'
    }
  }, [onError, onUnavailable, slug, t])

  return (
    <div className="servicePageLayout">
      <div className="servicePageContentScroller">
        <article className="servicePageArticle" aria-label={t(servicePageLabelKey(slug))}>
          <header className="servicePageDocumentHeader">
            <h1>{t(servicePageLabelKey(slug))}</h1>
            {serviceDocument && (
              <p>
                {t('servicePages.publicationMeta', {
                  version: serviceDocument.version,
                  date: new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
                    dateStyle: 'long',
                  }).format(new Date(serviceDocument.publishedAt)),
                })}
              </p>
            )}
          </header>
          {serviceDocument ? (
            <SafeServicePageMarkdown source={serviceDocument.markdown} />
          ) : (
            <TadpoleLoadingState label={t('servicePages.loading')} />
          )}
        </article>
      </div>
      <PublicFooter pages={pages} />
    </div>
  )
}
