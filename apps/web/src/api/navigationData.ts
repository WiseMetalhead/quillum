import { prefetchApiQuery } from './client'

export function prefetchDashboardData(timezone: string) {
  prefetchApiQuery(`/api/manuscripts/dashboard/stats/?timezone=${encodeURIComponent(timezone)}`)
  prefetchApiQuery('/api/manuscripts/dashboard/useful-links/')
}

export function prefetchLibraryData() {
  prefetchApiQuery('/api/manuscripts/oneshots/')
  prefetchApiQuery('/api/manuscripts/books/')
  prefetchApiQuery('/api/manuscripts/series/')
  prefetchApiQuery('/api/auth/tier/')
}

export function prefetchAvailableManuscripts() {
  prefetchApiQuery('/api/editor/manuscripts/')
}

export function prefetchFeedData() {
  prefetchApiQuery('/api/news/sources/')
  prefetchApiQuery('/api/news/')
  prefetchApiQuery('/api/contests/sources/')
  prefetchApiQuery('/api/contests/')
}

export function prefetchIdeasData() {
  prefetchApiQuery('/api/ideas/?kind=all')
}

export function prefetchManuscriptData(manuscriptId: string) {
  prefetchApiQuery(`/api/manuscripts/${manuscriptId}/`)
}

export function prefetchSeriesData(seriesId: string) {
  prefetchApiQuery(`/api/manuscripts/series/${seriesId}/`)
  prefetchApiQuery('/api/auth/tier/')
}
