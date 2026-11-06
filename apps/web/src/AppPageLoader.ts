type AdminPageModule = {
  default: typeof import('./features/admin/AdminPage')['AdminPage']
}

type DashboardPageModule = {
  default: typeof import('./features/dashboard/DashboardPage')['DashboardPage']
}

type ManuscriptsPageModule = {
  default: typeof import('./features/books/ManuscriptsPage')['ManuscriptsPage']
}

type FeedPageModule = {
  default: typeof import('./features/feed/FeedPage')['FeedPage']
}

type IdeasPageModule = {
  default: typeof import('./features/ideas/IdeasPage')['IdeasPage']
}

type ManuscriptSpaceModule = {
  default: typeof import('./features/books/ManuscriptSpace')['ManuscriptSpace']
}

type PublicReviewPageModule = {
  default: typeof import('./features/books/PublicReviewPage')['PublicReviewPage']
}

type SeriesPageModule = {
  default: typeof import('./features/books/SeriesPage')['SeriesPage']
}

type SettingsPageModule = {
  default: typeof import('./features/settings/SettingsPage')['SettingsPage']
}

let adminPagePromise: Promise<AdminPageModule> | null = null
let dashboardPagePromise: Promise<DashboardPageModule> | null = null
let manuscriptsPagePromise: Promise<ManuscriptsPageModule> | null = null
let feedPagePromise: Promise<FeedPageModule> | null = null
let ideasPagePromise: Promise<IdeasPageModule> | null = null
let manuscriptSpacePromise: Promise<ManuscriptSpaceModule> | null = null
let publicReviewPagePromise: Promise<PublicReviewPageModule> | null = null
let seriesPagePromise: Promise<SeriesPageModule> | null = null
let settingsPagePromise: Promise<SettingsPageModule> | null = null

export function loadAdminPage(): Promise<AdminPageModule> {
  adminPagePromise ??= import('./features/admin/AdminPage').then((module) => ({
    default: module.AdminPage,
  }))
  return adminPagePromise
}

export function loadDashboardPage(): Promise<DashboardPageModule> {
  dashboardPagePromise ??= import('./features/dashboard/DashboardPage').then((module) => ({
    default: module.DashboardPage,
  }))
  return dashboardPagePromise
}

export function loadManuscriptsPage(): Promise<ManuscriptsPageModule> {
  manuscriptsPagePromise ??= import('./features/books/ManuscriptsPage').then((module) => ({
    default: module.ManuscriptsPage,
  }))
  return manuscriptsPagePromise
}

export function loadFeedPage(): Promise<FeedPageModule> {
  feedPagePromise ??= import('./features/feed/FeedPage').then((module) => ({
    default: module.FeedPage,
  }))
  return feedPagePromise
}

export function loadIdeasPage(): Promise<IdeasPageModule> {
  ideasPagePromise ??= import('./features/ideas/IdeasPage').then((module) => ({
    default: module.IdeasPage,
  }))
  return ideasPagePromise
}

export function loadManuscriptSpace(): Promise<ManuscriptSpaceModule> {
  manuscriptSpacePromise ??= import('./features/books/ManuscriptSpace').then((module) => ({
    default: module.ManuscriptSpace,
  }))
  return manuscriptSpacePromise
}

export function loadPublicReviewPage(): Promise<PublicReviewPageModule> {
  publicReviewPagePromise ??= import('./features/books/PublicReviewPage').then((module) => ({
    default: module.PublicReviewPage,
  }))
  return publicReviewPagePromise
}

export function loadSeriesPage(): Promise<SeriesPageModule> {
  seriesPagePromise ??= import('./features/books/SeriesPage').then((module) => ({
    default: module.SeriesPage,
  }))
  return seriesPagePromise
}

export function loadSettingsPage(): Promise<SettingsPageModule> {
  settingsPagePromise ??= import('./features/settings/SettingsPage').then((module) => ({
    default: module.SettingsPage,
  }))
  return settingsPagePromise
}

export function preloadAdminPage() {
  void loadAdminPage()
}

export function preloadDashboardPage() {
  void loadDashboardPage()
}

export function preloadManuscriptsPage() {
  void loadManuscriptsPage()
}

export function preloadFeedPage() {
  void loadFeedPage()
}

export function preloadIdeasPage() {
  void loadIdeasPage()
}

export function preloadManuscriptSpace() {
  void loadManuscriptSpace()
}

export function preloadPublicReviewPage() {
  void loadPublicReviewPage()
}

export function preloadSeriesPage() {
  void loadSeriesPage()
}

export function preloadSettingsPage() {
  void loadSettingsPage()
}
