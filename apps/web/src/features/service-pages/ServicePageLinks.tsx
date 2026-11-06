import { useTranslation } from 'react-i18next'
import type { ServicePageMetadata } from '../../types'
import { servicePageLabelKey, servicePageShortLabelKey } from './servicePages'

type Props = {
  pages: ServicePageMetadata[]
  className?: string
  newTab?: boolean
  shortLabels?: boolean
}

export function ServicePageLinks({
  pages,
  className = '',
  newTab = false,
  shortLabels = false,
}: Props) {
  const { t } = useTranslation()
  if (pages.length === 0) return null

  return (
    <nav className={className} aria-label={t('servicePages.navigation')}>
      {pages.map((page) => (
        <a
          key={page.slug}
          href={page.path}
          target={newTab ? '_blank' : undefined}
          rel={newTab ? 'noreferrer' : undefined}
        >
          {t(shortLabels
            ? servicePageShortLabelKey(page.slug)
            : servicePageLabelKey(page.slug))}
        </a>
      ))}
    </nav>
  )
}
