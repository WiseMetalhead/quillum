import type { ServicePageMetadata, ServicePageSlug } from '../../types'

export const SERVICE_PAGE_SLUGS: ServicePageSlug[] = ['privacy', 'terms', 'contact']

export function servicePageSlugFromPath(path: string): ServicePageSlug | null {
  const candidate = path.replace(/^\//, '').replace(/\/$/, '')
  return SERVICE_PAGE_SLUGS.includes(candidate as ServicePageSlug)
    ? candidate as ServicePageSlug
    : null
}

export function servicePageLabelKey(slug: ServicePageSlug) {
  return `servicePages.pages.${slug}` as const
}

export function servicePageShortLabelKey(slug: ServicePageSlug) {
  return `servicePages.shortPages.${slug}` as const
}

export function publishedServicePage(
  pages: ServicePageMetadata[],
  slug: ServicePageSlug,
) {
  return pages.find((page) => page.slug === slug) ?? null
}
