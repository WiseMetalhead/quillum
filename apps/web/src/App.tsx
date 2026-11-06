import { lazy, startTransition, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  API_BASE,
  apiRequest,
  clearApiQueryCache,
  consumeLastApiErrorSupport,
} from './api/client'
import type { ApiSupportContext } from './api/client'
import {
  prefetchDashboardData,
  prefetchAvailableManuscripts,
  prefetchLibraryData,
  prefetchManuscriptData,
  prefetchFeedData,
  prefetchIdeasData,
  prefetchSeriesData,
} from './api/navigationData'
import {
  loadAdminPage,
  loadDashboardPage,
  loadManuscriptsPage,
  loadFeedPage,
  loadIdeasPage,
  loadManuscriptSpace,
  loadPublicReviewPage,
  loadSeriesPage,
  loadSettingsPage,
  preloadAdminPage,
  preloadDashboardPage,
  preloadManuscriptsPage,
  preloadFeedPage,
  preloadIdeasPage,
  preloadManuscriptSpace,
  preloadPublicReviewPage,
  preloadSeriesPage,
  preloadSettingsPage,
} from './AppPageLoader'
import { setInterfaceLanguage } from './i18n'
import './App.css'
import { AuthViews } from './features/auth/AuthViews'
import { EditorInvitationPage } from './features/auth/EditorInvitationPage'
import { parseRequestOptions, serializeCredential } from './features/auth/webauthn'
import { preloadManuscriptEditor } from './features/books/ManuscriptEditorLoader'
import type { ManuscriptLibrarySection } from './features/books/manuscriptLibraryNavigation'
import type { ManuscriptSpaceView } from './features/books/ManuscriptSpace'
import { NotificationPanel } from './features/notifications/NotificationPanel'
import { OnboardingFlow } from './features/onboarding/OnboardingFlow'
import { EditorDashboardPage } from './features/dashboard/EditorDashboardPage'
import { HeaderWorkspaceSearch } from './features/dashboard/HeaderWorkspaceSearch'
import {
  AUTHOR_WORKSPACE_SEARCH_KINDS,
  EDITOR_WORKSPACE_SEARCH_KINDS,
} from './features/dashboard/workspaceSearchConfig'
import { PWA_UPDATE_EVENT } from './pwa/registerPwa'
import { Brand } from './features/shared/Brand'
import { CookieConsent } from './features/shared/CookieConsent'
import { clearPrivateMediaCache } from './features/shared/privateMediaCache'
import { TadpoleLoadingState } from './features/shared/TadpoleLoadingState'
import { ThemeToggle } from './features/shared/ThemeToggle'
import { ServicePageView } from './features/service-pages/ServicePageView'
import { servicePageSlugFromPath } from './features/service-pages/servicePages'
import { Icon } from './icons/Icon'
import { applyThemePreference, getThemePreference, subscribeThemeChange } from './theme'
import type {
  AppSection,
  NotificationKind,
  ServicePageMetadata,
  ServicePagesPayload,
  SessionPayload,
  TwoFactorMethod,
  User,
  ViewState,
  WorkspaceKind,
  WorkspaceSearchResult,
} from './types'

const AdminPage = lazy(loadAdminPage)
const DashboardPage = lazy(loadDashboardPage)
const ManuscriptsPage = lazy(loadManuscriptsPage)
const FeedPage = lazy(loadFeedPage)
const IdeasPage = lazy(loadIdeasPage)
const ManuscriptSpace = lazy(loadManuscriptSpace)
const PublicReviewPage = lazy(loadPublicReviewPage)
const SeriesPage = lazy(loadSeriesPage)
const SettingsPage = lazy(loadSettingsPage)

function sectionPath(nextSection: AppSection) {
  return nextSection === 'dashboard' ? '/workspace' : `/${nextSection}`
}

function sectionFromPath(
  path: string,
  currentUser: User | null,
  activeWorkspace: WorkspaceKind,
): AppSection {
  if (path === '/settings') {
    return 'settings'
  }
  if (path === '/admin' && currentUser?.isSuperuser) {
    return 'admin'
  }
  if (currentUser && activeWorkspace === 'editor') {
    return path === '/manuscripts' || path === '/books' || manuscriptRouteFromPath(path)
      ? 'manuscripts'
      : 'dashboard'
  }
  if (path === '/feed' && currentUser?.feedEnabled) {
    return 'feed'
  }
  if (path === '/ideas') {
    return 'ideas'
  }
  if (
    path === '/manuscripts'
    || path === '/books'
    || manuscriptRouteFromPath(path)
    || seriesRouteFromPath(path)
  ) {
    return 'manuscripts'
  }
  return 'dashboard'
}

function manuscriptRouteFromPath(path: string) {
  const match = path.match(/^\/(?:manuscripts|books)\/([0-9a-f-]{36})(?:\/(planner|boards|glossary|editor))?\/?$/i)
  if (!match) {
    return null
  }
  return {
    manuscriptId: match[1],
    view: (match[2] || 'dashboard') as ManuscriptSpaceView,
  }
}

function seriesRouteFromPath(path: string) {
  const match = path.match(/^\/manuscripts\/series\/([0-9a-f-]{36})\/?$/i)
  return match ? { seriesId: match[1] } : null
}

function canonicalAppPath(path: string) {
  if (path === '/books' || path.startsWith('/books/')) {
    return path.replace(/^\/books/, '/manuscripts')
  }
  return path
}

function editorWorkspacePath(path: string) {
  const route = manuscriptRouteFromPath(path)
  if (route) return `/manuscripts/${route.manuscriptId}/editor`
  if (seriesRouteFromPath(path)) return '/manuscripts'
  if (['/manuscripts', '/settings', '/admin', '/workspace'].includes(path)) return path
  return '/workspace'
}

function authorWorkspaceRequiredForPath(path: string) {
  if (path === '/ideas' || path === '/feed' || seriesRouteFromPath(path)) return true
  const route = manuscriptRouteFromPath(path)
  return Boolean(route && route.view !== 'editor')
}

function reviewTokenFromPath(path: string) {
  const match = path.match(/^\/review\/([^/]+)\/?$/)
  return match?.[1] ?? null
}

function preloadPath(path: string) {
  if (reviewTokenFromPath(path)) {
    preloadPublicReviewPage()
  } else if (seriesRouteFromPath(path)) {
    preloadSeriesPage()
  } else if (manuscriptRouteFromPath(path)) {
    preloadManuscriptSpace()
  } else if (path === '/manuscripts' || path === '/books') {
    preloadManuscriptsPage()
  } else if (path === '/feed') {
    preloadFeedPage()
  } else if (path === '/ideas') {
    preloadIdeasPage()
  } else if (path === '/settings') {
    preloadSettingsPage()
  } else if (path === '/admin') {
    preloadAdminPage()
  } else if (path === '/' || path === '/workspace') {
    preloadDashboardPage()
  }
}

preloadPath(window.location.pathname)

function App() {
  const { t, i18n } = useTranslation()
  const reviewToken = reviewTokenFromPath(window.location.pathname)
  const [view, setView] = useState<ViewState>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceKind>('author')
  const [openRegistration, setOpenRegistration] = useState(false)
  const [servicePages, setServicePages] = useState<ServicePageMetadata[]>([])
  const [localPasswordLoginEnabled, setLocalPasswordLoginEnabled] = useState(true)
  const [oidcEnabled, setOidcEnabled] = useState(false)
  const [oidcProviderName, setOidcProviderName] = useState('OpenID Connect')
  const [message, setMessage] = useState('')
  const [messageAction, setMessageAction] = useState<{
    message: string
    label: string
    path: string
  } | null>(null)
  const [error, setError] = useState(
    () => new URLSearchParams(window.location.search).get('oidcError') ?? '',
  )
  const [errorSupport, setErrorSupport] = useState<ApiSupportContext | null>(null)
  const [errorOccurredAt, setErrorOccurredAt] = useState<string | null>(null)
  const [section, setSection] = useState<AppSection>('dashboard')
  const [authSubmitting, setAuthSubmitting] = useState(false)
  const [twoFactorMethod, setTwoFactorMethod] = useState<TwoFactorMethod | null>(null)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [manuscriptId, setManuscriptId] = useState<string | null>(null)
  const [seriesId, setSeriesId] = useState<string | null>(null)
  const [manuscriptLibrarySection, setManuscriptLibrarySection] =
    useState<ManuscriptLibrarySection>('all')
  const [manuscriptView, setManuscriptView] = useState<ManuscriptSpaceView>('dashboard')
  const [routeSearch, setRouteSearch] = useState(window.location.search)
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false)
  const [editorOfflineMode, setEditorOfflineMode] = useState(false)
  const sectionMenuRef = useRef<HTMLDivElement>(null)
  const profileMenuRef = useRef<HTMLDivElement>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const privateMediaUserIdRef = useRef<number | null>(null)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const authorWorkspaceActive = activeWorkspace === 'author'

  const dismissMobileMenu = useCallback(() => {
    const focusedElement = document.activeElement
    if (
      focusedElement instanceof Node
      && mobileMenuRef.current?.contains(focusedElement)
    ) {
      mobileMenuButtonRef.current?.focus({ preventScroll: true })
    }
    setMobileMenuOpen(false)
    setMobileAccountOpen(false)
  }, [])

  useEffect(() => subscribeThemeChange(() => undefined), [])

  useEffect(() => {
    const announcePwaUpdate = () => setMessage(t('app.updateAvailable'))
    window.addEventListener(PWA_UPDATE_EVENT, announcePwaUpdate)
    return () => window.removeEventListener(PWA_UPDATE_EVENT, announcePwaUpdate)
  }, [t])

  useEffect(() => {
    if (user) {
      applyThemePreference(user.theme)
    }
  }, [user])

  const clearError = useCallback(() => {
    consumeLastApiErrorSupport()
    setError('')
    setErrorSupport(null)
    setErrorOccurredAt(null)
  }, [])

  const reportError = useCallback((nextError: string) => {
    if (!nextError) {
      clearError()
      return
    }
    const support = consumeLastApiErrorSupport()
    setError(nextError)
    setErrorSupport(support)
    setErrorOccurredAt(support?.occurredAt ?? new Date().toISOString())
  }, [clearError])

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search)
    const oidcError = parameters.get('oidcError')
    if (!oidcError) return
    if (window.location.pathname === '/editor-invitation') return
    parameters.delete('oidcError')
    const search = parameters.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
  }, [])

  const refreshServicePages = useCallback(async () => {
    const payload = await apiRequest<ServicePagesPayload>('/api/service-pages/')
    setServicePages(payload.pages)
  }, [])

  const refreshSession = useCallback(async (): Promise<SessionPayload> => {
    clearError()
    await apiRequest<{ csrfToken: string }>('/api/auth/csrf/')
    const [session] = await Promise.all([
      apiRequest<SessionPayload>('/api/auth/session/'),
      refreshServicePages().catch(() => setServicePages([])),
    ])
    return session
  }, [clearError, refreshServicePages])

  const applySession = useCallback((session: SessionPayload) => {
    const sessionUserId = session.user?.id ?? null
    if (privateMediaUserIdRef.current !== sessionUserId) {
      clearPrivateMediaCache()
      clearApiQueryCache()
      privateMediaUserIdRef.current = sessionUserId
    }
    setOpenRegistration(session.openRegistration)
    setLocalPasswordLoginEnabled(session.localPasswordLoginEnabled)
    setOidcEnabled(session.oidcEnabled)
    setOidcProviderName(session.oidcProviderName)
    setUser(session.user)
    const sessionWorkspace = session.activeWorkspace
      ?? (session.user?.authorWorkspaceEnabled ? 'author' : 'editor')
    setActiveWorkspace(sessionWorkspace)
    if (session.user?.onboardingCompleted) {
      void setInterfaceLanguage(session.user.language)
    }

    const requestedServicePage = servicePageSlugFromPath(window.location.pathname)
    const invitationReturn = new URLSearchParams(window.location.search).get('returnTo') === '/editor-invitation'
    if (window.location.pathname === '/editor-invitation' || invitationReturn) {
      if (invitationReturn) window.history.replaceState({}, '', '/editor-invitation')
      setSection('dashboard')
      setManuscriptId(null)
      setSeriesId(null)
      setRouteSearch('')
      setView('editorInvitation')
    } else if (requestedServicePage) {
      setSection('dashboard')
      setManuscriptId(null)
      setSeriesId(null)
      setRouteSearch('')
      setView('servicePage')
    } else if (session.authenticated && session.user && !session.user.onboardingCompleted) {
      setSection('dashboard')
      setManuscriptId(null)
      setSeriesId(null)
      setRouteSearch('')
      setView('onboarding')
    } else if (session.authenticated) {
      const currentPath = window.location.pathname
      const currentSearch = window.location.search
      const canonicalPath = canonicalAppPath(currentPath)
      const accessiblePath = session.user && sessionWorkspace === 'editor'
        ? editorWorkspacePath(canonicalPath)
        : canonicalPath === '/feed' && !session.user?.feedEnabled
          ? '/workspace'
          : canonicalPath
      if (accessiblePath !== currentPath) {
        window.history.replaceState({}, '', `${accessiblePath}${currentSearch}`)
      }
      const manuscriptRoute = manuscriptRouteFromPath(accessiblePath)
      const seriesRoute = seriesRouteFromPath(accessiblePath)
      const initialSection = sectionFromPath(accessiblePath, session.user, sessionWorkspace)
      if (sessionWorkspace === 'editor') {
        if (initialSection === 'manuscripts') prefetchAvailableManuscripts()
      } else if (manuscriptRoute) {
        prefetchManuscriptData(manuscriptRoute.manuscriptId)
      } else if (seriesRoute) {
        prefetchSeriesData(seriesRoute.seriesId)
      } else if (initialSection === 'dashboard') {
        prefetchDashboardData(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
      } else if (initialSection === 'manuscripts') {
        prefetchLibraryData()
      } else if (initialSection === 'feed') {
        prefetchFeedData()
      } else if (initialSection === 'ideas') {
        prefetchIdeasData()
      }
      setSection(initialSection)
      setManuscriptId(manuscriptRoute?.manuscriptId ?? null)
      setSeriesId(seriesRoute?.seriesId ?? null)
      setManuscriptView(manuscriptRoute?.view ?? 'dashboard')
      setRouteSearch(currentSearch)
      setView('dashboard')
      if (
        window.location.pathname === '/login' ||
        window.location.pathname === '/registration' ||
        window.location.pathname === '/forgot-password'
      ) {
        window.history.replaceState({}, '', '/workspace')
      }
    } else if (
      window.location.pathname === '/registration'
      && session.openRegistration
      && session.localPasswordLoginEnabled
    ) {
      setView('registration')
    } else if (window.location.pathname === '/registration') {
      reportError(i18n.t('app.registrationClosed'))
      setView('login')
    } else if (window.location.pathname === '/forgot-password' && session.localPasswordLoginEnabled) {
      setView('forgotPassword')
    } else {
      setView('login')
    }
  }, [i18n, reportError])

  useEffect(() => {
    if (reviewToken) return
    let active = true

    async function loadSession() {
      try {
        let session = await refreshSession()
        if (
          session.authenticated
          && session.user?.authorWorkspaceEnabled
          && session.user.editorWorkspaceEnabled
          && session.activeWorkspace === 'editor'
          && authorWorkspaceRequiredForPath(canonicalAppPath(window.location.pathname))
        ) {
          const switched = await apiRequest<{ user: User; activeWorkspace: WorkspaceKind }>(
            '/api/auth/workspace/switch/',
            { method: 'POST', body: JSON.stringify({ workspace: 'author' }) },
          )
          session = { ...session, user: switched.user, activeWorkspace: switched.activeWorkspace }
        }
        if (active) {
          applySession(session)
        }
      } catch (err) {
        if (active) {
          reportError(err instanceof Error ? err.message : i18n.t('app.connectFailed'))
          setView(
            servicePageSlugFromPath(window.location.pathname)
              ? 'servicePage'
              : window.location.pathname === '/registration'
              ? 'registration'
              : window.location.pathname === '/forgot-password'
                ? 'forgotPassword'
                : 'login',
          )
        }
      }
    }

    void loadSession()

    return () => {
      active = false
    }
  }, [applySession, i18n, refreshSession, reportError, reviewToken])

  useEffect(() => {
    async function handlePopState() {
      if (editorOfflineMode && manuscriptId !== null) {
        window.history.pushState({}, '', `/manuscripts/${manuscriptId}/editor`)
        return
      }
      const currentPath = window.location.pathname
      const currentSearch = window.location.search
      const canonicalPath = canonicalAppPath(currentPath)
      if (canonicalPath !== currentPath) {
        window.history.replaceState({}, '', `${canonicalPath}${currentSearch}`)
      }
      const servicePageSlug = servicePageSlugFromPath(canonicalPath)
      if (servicePageSlug) {
        setView('servicePage')
        setSection('dashboard')
        setManuscriptId(null)
        setSeriesId(null)
        setRouteSearch('')
        setSectionMenuOpen(false)
        setProfileMenuOpen(false)
        dismissMobileMenu()
        return
      }
      if (!user) {
        if (canonicalPath === '/editor-invitation') {
          setView('editorInvitation')
          setManuscriptId(null)
          setSeriesId(null)
          setRouteSearch(currentSearch)
          return
        }
        setView(
          canonicalPath === '/registration' && openRegistration && localPasswordLoginEnabled
            ? 'registration'
            : canonicalPath === '/forgot-password' && localPasswordLoginEnabled
              ? 'forgotPassword'
              : 'login',
        )
        setManuscriptId(null)
        setSeriesId(null)
        setRouteSearch(currentSearch)
        setSectionMenuOpen(false)
        setProfileMenuOpen(false)
        dismissMobileMenu()
        return
      }
      if (!user.onboardingCompleted) {
        setView('onboarding')
        setSection('dashboard')
        setManuscriptId(null)
        setSeriesId(null)
        setRouteSearch('')
        setSectionMenuOpen(false)
        setProfileMenuOpen(false)
        dismissMobileMenu()
        return
      }
      if (canonicalPath === '/editor-invitation') {
        setView('editorInvitation')
        setSection('dashboard')
        setManuscriptId(null)
        setSeriesId(null)
        setRouteSearch(currentSearch)
        setSectionMenuOpen(false)
        setProfileMenuOpen(false)
        dismissMobileMenu()
        return
      }
      let routeWorkspace = activeWorkspace
      if (
        routeWorkspace === 'editor'
        && user.authorWorkspaceEnabled
        && authorWorkspaceRequiredForPath(canonicalPath)
      ) {
        try {
          const switched = await apiRequest<{ user: User; activeWorkspace: WorkspaceKind }>(
            '/api/auth/workspace/switch/',
            { method: 'POST', body: JSON.stringify({ workspace: 'author' }) },
          )
          clearPrivateMediaCache()
          clearApiQueryCache()
          setUser(switched.user)
          setActiveWorkspace(switched.activeWorkspace)
          routeWorkspace = switched.activeWorkspace
        } catch (caught) {
          reportError(caught instanceof Error ? caught.message : t('workspaceSwitcher.failed'))
          return
        }
      }
      setView('dashboard')
      const accessiblePath = routeWorkspace === 'editor'
        && canonicalPath !== '/editor-invitation'
        ? editorWorkspacePath(canonicalPath)
        : canonicalPath === '/feed' && !user.feedEnabled
          ? '/workspace'
          : canonicalPath
      if (accessiblePath !== canonicalPath) {
        window.history.replaceState({}, '', accessiblePath)
      }
      const manuscriptRoute = manuscriptRouteFromPath(accessiblePath)
      const seriesRoute = seriesRouteFromPath(accessiblePath)
      setSection(sectionFromPath(accessiblePath, user, routeWorkspace))
      setManuscriptId(manuscriptRoute?.manuscriptId ?? null)
      setSeriesId(seriesRoute?.seriesId ?? null)
      setManuscriptView(manuscriptRoute?.view ?? 'dashboard')
      setRouteSearch(currentSearch)
      setSectionMenuOpen(false)
      setProfileMenuOpen(false)
      dismissMobileMenu()
    }
    const onPopState = () => void handlePopState()
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [
    activeWorkspace,
    dismissMobileMenu,
    editorOfflineMode,
    localPasswordLoginEnabled,
    manuscriptId,
    openRegistration,
    reportError,
    t,
    user,
  ])

  const handleEditorOfflineModeChange = useCallback((offline: boolean) => {
    setEditorOfflineMode(offline)
    if (offline) {
      setSectionMenuOpen(false)
      setProfileMenuOpen(false)
      dismissMobileMenu()
    }
  }, [dismissMobileMenu])

  const handleEditorAccessLost = useCallback(() => {
    clearPrivateMediaCache()
    setEditorOfflineMode(false)
    setSection('manuscripts')
    setManuscriptId(null)
    setSeriesId(null)
    setManuscriptView('dashboard')
    setRouteSearch('')
    window.history.replaceState({}, '', '/manuscripts')
  }, [])

  const handleOnboardingComplete = useCallback((nextUser: User) => {
    setUser(nextUser)
    setSection(activeWorkspace === 'author' ? 'dashboard' : 'manuscripts')
    setManuscriptId(null)
    setSeriesId(null)
    setRouteSearch('')
    setMessage('')
    clearError()
    if (activeWorkspace === 'author') {
      prefetchDashboardData(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    } else {
      prefetchAvailableManuscripts()
    }
    window.history.replaceState({}, '', activeWorkspace === 'author' ? '/workspace' : '/manuscripts')
    setView('dashboard')
  }, [activeWorkspace, clearError])

  useEffect(() => {
    if (!sectionMenuOpen) {
      return
    }
    function closeSectionMenu(event: MouseEvent) {
      if (!sectionMenuRef.current?.contains(event.target as Node)) {
        setSectionMenuOpen(false)
      }
    }
    function closeSectionMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSectionMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', closeSectionMenu)
    document.addEventListener('keydown', closeSectionMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeSectionMenu)
      document.removeEventListener('keydown', closeSectionMenuOnEscape)
    }
  }, [sectionMenuOpen])

  useEffect(() => {
    if (!profileMenuOpen) {
      return
    }
    function closeProfileMenu(event: MouseEvent) {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setProfileMenuOpen(false)
      }
    }
    function closeProfileMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setProfileMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', closeProfileMenu)
    document.addEventListener('keydown', closeProfileMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeProfileMenu)
      document.removeEventListener('keydown', closeProfileMenuOnEscape)
    }
  }, [profileMenuOpen])

  useEffect(() => {
    if (!mobileMenuOpen) {
      return
    }
    function closeMobileMenu(event: MouseEvent) {
      if (!mobileMenuRef.current?.contains(event.target as Node)) {
        dismissMobileMenu()
      }
    }
    function closeMobileMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        dismissMobileMenu()
      }
    }
    document.addEventListener('mousedown', closeMobileMenu)
    document.addEventListener('keydown', closeMobileMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMobileMenu)
      document.removeEventListener('keydown', closeMobileMenuOnEscape)
    }
  }, [dismissMobileMenu, mobileMenuOpen])

  useEffect(() => {
    if (!message || (messageAction && messageAction.message !== message)) {
      const clearActionId = window.setTimeout(() => setMessageAction(null), 0)
      return () => window.clearTimeout(clearActionId)
    }
    const timeoutId = window.setTimeout(() => {
      setMessage('')
      setMessageAction(null)
    }, 5000)
    return () => window.clearTimeout(timeoutId)
  }, [message, messageAction])

  useEffect(() => {
    if (!error) {
      return
    }
    const timeoutId = window.setTimeout(clearError, 5000)
    return () => window.clearTimeout(timeoutId)
  }, [clearError, error])

  function navigate(path: string) {
    window.history.pushState({}, '', path)
    if (path === '/registration') {
      setView('registration')
    } else if (path === '/forgot-password') {
      setTwoFactorMethod(null)
      setView('forgotPassword')
    } else if (path === '/login' || path.startsWith('/login?')) {
      setTwoFactorMethod(null)
      setView('login')
    }
  }

  function applyAuthenticatedUser(
    nextUser: User,
    allowInvitationReturn = true,
    nextWorkspace?: WorkspaceKind,
  ) {
    const authenticatedWorkspace = nextWorkspace
      ?? (nextUser.authorWorkspaceEnabled ? 'author' : 'editor')
    setUser(nextUser)
    setActiveWorkspace(authenticatedWorkspace)
    if (nextUser.onboardingCompleted) {
      void setInterfaceLanguage(nextUser.language)
    }
    setMessage('')
    setSection('dashboard')
    setManuscriptId(null)
    setSeriesId(null)
    const invitationReturn = allowInvitationReturn
      && new URLSearchParams(window.location.search).get('returnTo') === '/editor-invitation'
    if (invitationReturn) {
      setRouteSearch('')
      setView('editorInvitation')
      window.history.replaceState({}, '', '/editor-invitation')
      return
    }
    setView(nextUser.onboardingCompleted ? 'dashboard' : 'onboarding')
    if (nextUser.onboardingCompleted && authenticatedWorkspace === 'editor' && !allowInvitationReturn) {
      setSection('manuscripts')
      prefetchAvailableManuscripts()
      window.history.replaceState({}, '', '/manuscripts')
    } else {
      window.history.replaceState({}, '', '/workspace')
    }
  }

  async function navigateNotification(path: string, kind: NotificationKind) {
    const url = new URL(path, window.location.origin)
    const explicitWorkspace = url.searchParams.get('workspace')
    url.searchParams.delete('workspace')
    const destination = `${url.pathname}${url.search}${url.hash}`
    let targetWorkspace: WorkspaceKind | null = explicitWorkspace === 'author' || explicitWorkspace === 'editor'
      ? explicitWorkspace
      : null
    if (!targetWorkspace && kind.startsWith('service.editor_manuscript_access_')) {
      targetWorkspace = 'editor'
    } else if (
      !targetWorkspace
      && (
        kind.startsWith('user.')
        || kind.startsWith('service.audio_transcription_')
        || kind === 'service.review_share_expired'
      )
    ) {
      targetWorkspace = 'author'
    } else if (!targetWorkspace && authorWorkspaceRequiredForPath(url.pathname)) {
      targetWorkspace = 'author'
    }
    const targetAvailable = targetWorkspace === 'author'
      ? user?.authorWorkspaceEnabled
      : targetWorkspace === 'editor'
        ? user?.editorWorkspaceEnabled
        : false
    if (targetWorkspace && targetAvailable && targetWorkspace !== activeWorkspace) {
      await switchWorkspace(targetWorkspace, destination)
      return
    }
    window.history.pushState({}, '', destination)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  async function switchWorkspace(nextWorkspace: WorkspaceKind, destination = '/workspace') {
    if (editorOfflineMode || nextWorkspace === activeWorkspace) return
    clearError()
    try {
      const payload = await apiRequest<{ user: User; activeWorkspace: WorkspaceKind }>(
        '/api/auth/workspace/switch/',
        { method: 'POST', body: JSON.stringify({ workspace: nextWorkspace }) },
      )
      clearPrivateMediaCache()
      clearApiQueryCache()
      setUser(payload.user)
      setActiveWorkspace(payload.activeWorkspace)
      setProfileMenuOpen(false)
      setSectionMenuOpen(false)
      dismissMobileMenu()
      const destinationUrl = new URL(destination, window.location.origin)
      const targetPath = canonicalAppPath(destinationUrl.pathname)
      const targetManuscript = manuscriptRouteFromPath(targetPath)
      const targetSeries = seriesRouteFromPath(targetPath)
      setSection(sectionFromPath(targetPath, payload.user, payload.activeWorkspace))
      setManuscriptId(targetManuscript?.manuscriptId ?? null)
      setSeriesId(targetSeries?.seriesId ?? null)
      setManuscriptView(targetManuscript?.view ?? (payload.activeWorkspace === 'author' ? 'dashboard' : 'editor'))
      setRouteSearch(destinationUrl.search)
      setView('dashboard')
      if (payload.activeWorkspace === 'author') {
        prefetchDashboardData(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
      } else {
        prefetchAvailableManuscripts()
      }
      window.history.pushState({}, '', destination)
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : t('workspaceSwitcher.failed'))
    }
  }

  async function handleRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (authSubmitting) {
      return
    }
    clearError()
    setAuthSubmitting(true)
    const form = new FormData(event.currentTarget)
    try {
      const payload = await apiRequest<{ user: User }>('/api/auth/register/', {
        method: 'POST',
        body: JSON.stringify({
          username: form.get('username'),
          email: form.get('email'),
          password: form.get('password'),
          language: i18n.resolvedLanguage,
          theme: getThemePreference(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      })
      applyAuthenticatedUser(payload.user, false)
    } catch (err) {
      reportError(err instanceof Error ? err.message : t('app.registrationFailed'))
    } finally {
      setAuthSubmitting(false)
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (authSubmitting) {
      return
    }
    clearError()
    setAuthSubmitting(true)
    const form = new FormData(event.currentTarget)
    try {
      const payload = await apiRequest<
        { user: User } | { twoFactorRequired: true; method: TwoFactorMethod }
      >('/api/auth/login/', {
        method: 'POST',
        body: JSON.stringify({
          username: form.get('username'),
          password: form.get('password'),
          remember: form.get('remember') === 'on',
        }),
      })
      if ('twoFactorRequired' in payload) {
        setTwoFactorMethod(payload.method)
        setView('twoFactor')
        setMessage('')
      } else {
        applyAuthenticatedUser(payload.user)
      }
    } catch (err) {
      reportError(err instanceof Error ? err.message : t('app.loginFailed'))
    } finally {
      setAuthSubmitting(false)
    }
  }

  function handleOidcLogin() {
    const parameters = new URLSearchParams({
      language: i18n.resolvedLanguage || 'en',
      theme: getThemePreference(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    })
    window.location.assign(`${API_BASE}/api/auth/oidc/login/?${parameters.toString()}`)
  }

  async function handleTwoFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (authSubmitting) {
      return
    }
    clearError()
    setAuthSubmitting(true)
    const form = new FormData(event.currentTarget)
    try {
      const payload = await apiRequest<{ user: User }>('/api/auth/login/2fa/', {
        method: 'POST',
        body: JSON.stringify({ code: form.get('code') }),
      })
      applyAuthenticatedUser(payload.user)
      setTwoFactorMethod(null)
    } catch (err) {
      reportError(err instanceof Error ? err.message : t('app.verificationFailed'))
    } finally {
      setAuthSubmitting(false)
    }
  }

  async function handlePasskeyLogin(username: string) {
    if (authSubmitting) {
      return
    }
    clearError()
    setAuthSubmitting(true)
    try {
      if (!window.PublicKeyCredential) {
        throw new Error(t('app.passkeyUnsupported'))
      }
      const optionsPayload = await apiRequest<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        '/api/auth/login/passkey/start/',
        {
          method: 'POST',
          body: JSON.stringify({ username }),
        },
      )
      const credential = await navigator.credentials.get({
        publicKey: parseRequestOptions(optionsPayload.options),
      })
      const payload = await apiRequest<{ user: User }>('/api/auth/login/passkey/finish/', {
        method: 'POST',
        body: JSON.stringify({ credential: serializeCredential(credential) }),
      })
      applyAuthenticatedUser(payload.user)
      setTwoFactorMethod(null)
    } catch (err) {
      reportError(err instanceof Error ? err.message : t('app.passkeyLoginFailed'))
    } finally {
      setAuthSubmitting(false)
    }
  }

  async function handlePasswordResetRequest(email: string) {
    clearError()
    try {
      return await apiRequest<{ ok: boolean }>('/api/auth/password-reset/request/', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
    } catch (err) {
      reportError(err instanceof Error ? err.message : t('app.passwordResetRequestFailed'))
      return { ok: false }
    }
  }

  async function handlePasswordResetVerify(email: string, code: string): Promise<boolean> {
    clearError()
    try {
      await apiRequest<{ ok: boolean }>('/api/auth/password-reset/verify/', {
        method: 'POST',
        body: JSON.stringify({ email, code }),
      })
      return true
    } catch (err) {
      reportError(err instanceof Error ? err.message : t('app.passwordResetCodeInvalid'))
      return false
    }
  }

  async function handlePasswordResetConfirm(
    email: string,
    code: string,
    newPassword: string,
  ): Promise<boolean> {
    clearError()
    try {
      await apiRequest<{ ok: boolean }>('/api/auth/password-reset/confirm/', {
        method: 'POST',
        body: JSON.stringify({ email, code, newPassword }),
      })
      setMessage(t('app.passwordUpdated'))
      navigate('/login')
      return true
    } catch (err) {
      reportError(err instanceof Error ? err.message : t('app.passwordResetFailed'))
      return false
    }
  }

  async function handleLogout() {
    clearError()
    try {
      await apiRequest<{ ok: boolean }>('/api/auth/logout/', { method: 'POST', body: '{}' })
      clearPrivateMediaCache()
      clearApiQueryCache()
      privateMediaUserIdRef.current = null
      setUser(null)
      setProfileMenuOpen(false)
      setSectionMenuOpen(false)
      dismissMobileMenu()
      setManuscriptId(null)
      setSeriesId(null)
      setView('login')
      window.history.pushState({}, '', '/login')
    } catch (err) {
      reportError(err instanceof Error ? err.message : t('app.logoutFailed'))
    }
  }

  function handleAccountDeleted() {
    clearPrivateMediaCache()
    clearApiQueryCache()
    privateMediaUserIdRef.current = null
    setUser(null)
    clearError()
    setMessage(t('app.accountDeleted'))
    setProfileMenuOpen(false)
    dismissMobileMenu()
    setSection('dashboard')
    setManuscriptId(null)
    setSeriesId(null)
    setView('login')
    window.history.pushState({}, '', '/login')
  }

  function openSection(nextSection: AppSection) {
    if (editorOfflineMode) return
    if (
      activeWorkspace === 'editor'
      && (nextSection === 'ideas' || nextSection === 'feed')
      && user?.authorWorkspaceEnabled
    ) {
      void switchWorkspace('author', sectionPath(nextSection))
      return
    }
    if (activeWorkspace === 'editor' && !['dashboard', 'manuscripts', 'settings', 'admin'].includes(nextSection)) {
      nextSection = 'dashboard'
    }
    if (nextSection === 'dashboard') {
      if (authorWorkspaceActive) {
        preloadDashboardPage()
        prefetchDashboardData(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
      }
    } else if (nextSection === 'manuscripts') {
      preloadManuscriptsPage()
      if (authorWorkspaceActive) prefetchLibraryData()
      else prefetchAvailableManuscripts()
    } else if (nextSection === 'feed') {
      preloadFeedPage()
      prefetchFeedData()
    } else if (nextSection === 'ideas') {
      preloadIdeasPage()
      prefetchIdeasData()
    } else if (nextSection === 'settings') preloadSettingsPage()
    else if (nextSection === 'admin') preloadAdminPage()
    const completeNavigation = () => {
      setProfileMenuOpen(false)
      setSectionMenuOpen(false)
      dismissMobileMenu()
      setManuscriptId(null)
      setSeriesId(null)
      setSection(nextSection)
      setView('dashboard')
      setRouteSearch('')
      window.history.pushState({}, '', sectionPath(nextSection))
    }
    if (
      window.matchMedia('(min-width: 861px)').matches
      && (nextSection === 'dashboard' || nextSection === 'manuscripts' || nextSection === 'ideas' || nextSection === 'feed')
    ) {
      startTransition(completeNavigation)
      return
    }
    completeNavigation()
  }

  function openManuscript(nextManuscriptId: string) {
    preloadManuscriptSpace()
    if (authorWorkspaceActive) prefetchManuscriptData(nextManuscriptId)
    setProfileMenuOpen(false)
    setSectionMenuOpen(false)
    dismissMobileMenu()
    setSection('manuscripts')
    setSeriesId(null)
    setManuscriptId(nextManuscriptId)
    const nextView: ManuscriptSpaceView = authorWorkspaceActive ? 'dashboard' : 'editor'
    setManuscriptView(nextView)
    setRouteSearch('')
    window.history.pushState({}, '', `/manuscripts/${nextManuscriptId}${nextView === 'editor' ? '/editor' : ''}`)
  }

  function openManuscriptLibrarySection(nextSection: ManuscriptLibrarySection) {
    setManuscriptLibrarySection(nextSection)
    openSection('manuscripts')
  }

  function openEditorDocument(nextManuscriptId: string, itemId: string | null) {
    preloadManuscriptSpace()
    preloadManuscriptEditor()
    if (authorWorkspaceActive) prefetchManuscriptData(nextManuscriptId)
    setProfileMenuOpen(false)
    setSectionMenuOpen(false)
    dismissMobileMenu()
    setSection('manuscripts')
    setSeriesId(null)
    setManuscriptId(nextManuscriptId)
    setManuscriptView('editor')
    const query = itemId ? `?item=${encodeURIComponent(itemId)}` : ''
    setRouteSearch(query)
    window.history.pushState({}, '', `/manuscripts/${nextManuscriptId}/editor${query}`)
  }

  function openWorkspaceSearchResult(result: WorkspaceSearchResult) {
    if (result.kind === 'manuscript') {
      openManuscript(result.manuscriptId)
      return
    }
    if (result.kind === 'document') {
      openEditorDocument(result.manuscriptId, result.itemId ?? null)
      return
    }
    preloadManuscriptSpace()
    prefetchManuscriptData(result.manuscriptId)
    setProfileMenuOpen(false)
    setSectionMenuOpen(false)
    dismissMobileMenu()
    setSection('manuscripts')
    setSeriesId(null)
    setManuscriptId(result.manuscriptId)
    const nextView = result.kind === 'note' ? 'boards' : 'glossary'
    const parameter = result.kind === 'note' ? 'note' : 'article'
    const query = `?${parameter}=${encodeURIComponent(result.id)}`
    setManuscriptView(nextView)
    setRouteSearch(query)
    window.history.pushState(
      {},
      '',
      `/manuscripts/${result.manuscriptId}/${nextView}${query}`,
    )
  }

  function openSeries(nextSeriesId: string) {
    preloadSeriesPage()
    prefetchSeriesData(nextSeriesId)
    setProfileMenuOpen(false)
    setSectionMenuOpen(false)
    dismissMobileMenu()
    setSection('manuscripts')
    setManuscriptLibrarySection('series')
    setManuscriptId(null)
    setSeriesId(nextSeriesId)
    setRouteSearch('')
    window.history.pushState({}, '', `/manuscripts/series/${nextSeriesId}`)
  }

  function openManuscriptView(nextView: ManuscriptSpaceView) {
    if (manuscriptId === null || editorOfflineMode) {
      return
    }
    setSectionMenuOpen(false)
    dismissMobileMenu()
    if (!authorWorkspaceActive) nextView = 'editor'
    setManuscriptView(nextView)
    const path = nextView === 'dashboard'
      ? `/manuscripts/${manuscriptId}`
      : `/manuscripts/${manuscriptId}/${nextView}`
    setRouteSearch('')
    window.history.pushState({}, '', path)
  }

  const hasDisplayName = Boolean(user?.displayName.trim())
  const displayName = user?.displayName.trim() || user?.username || t('common.user')
  const avatarInitial = displayName.trim().charAt(0) || 'Q'
  const avatarSrc = user?.avatarUrl ? `${API_BASE}${user.avatarUrl}` : ''
  const servicePageSlug = servicePageSlugFromPath(window.location.pathname)
  const authenticatedShell = Boolean(user?.onboardingCompleted)
    && (view === 'dashboard' || view === 'servicePage')
  const workspaceHomeActive = view === 'dashboard'
    && section === 'dashboard'
    && manuscriptId === null
    && seriesId === null
  const returnToRegistration =
    new URLSearchParams(window.location.search).get('returnTo') === 'registration'
    && openRegistration
    && localPasswordLoginEnabled

  const redirectUnavailableServicePage = useCallback(() => {
    const destination = user ? '/workspace' : '/login'
    window.history.replaceState({}, '', destination)
    setManuscriptId(null)
    setSeriesId(null)
    setSection('dashboard')
    setRouteSearch('')
    setView(user ? (user.onboardingCompleted ? 'dashboard' : 'onboarding') : 'login')
  }, [user])

  async function copyErrorToClipboard() {
    const unavailable = t('app.errorReportUnavailable')
    const supportValue = (value: string | number | null | undefined) => value ?? unavailable
    const report = [
      `${t('app.errorReportCode')}: ${error}`,
      `${t('app.errorReportTime')}: ${errorOccurredAt ?? new Date().toISOString()}`,
      `${t('app.errorReportUsername')}: ${supportValue(errorSupport?.username ?? user?.username)}`,
      `${t('app.errorReportUserId')}: ${supportValue(errorSupport?.userId ?? user?.id)}`,
      `${t('app.errorReportIp')}: ${supportValue(errorSupport?.ipAddress)}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(report)
    } catch {
      setMessage(t('app.errorCopyFailed'))
    }
  }

  if (reviewToken) {
    return (
      <>
        <Suspense fallback={<TadpoleLoadingState className="appRouteLoadingState" label={t('common.loading')} />}>
          <PublicReviewPage token={reviewToken} />
        </Suspense>
        <CookieConsent />
      </>
    )
  }

  return (
    <main className={`shell ${view !== 'dashboard' && view !== 'servicePage' ? 'authShell' : ''}`}>
      <header className={`appHeader ${mobileMenuOpen ? 'mobileMenuOpen' : ''}`}>
        <Brand
          onActivate={authenticatedShell && user ? () => openSection('dashboard') : undefined}
          disabled={editorOfflineMode}
        />

        {!authenticatedShell && view !== 'onboarding' && (
          <div className="guestHeaderActions">
            {view === 'servicePage' && !user && (
              <button
                type="button"
                className="guestServicePageReturn spaceButton"
                onClick={() => navigate(returnToRegistration ? '/registration' : '/login')}
              >
                <Icon name="arrow-left-1" />
                <span>{t(returnToRegistration
                  ? 'servicePages.backToRegistration'
                  : 'servicePages.backToLogin')}</span>
              </button>
            )}
            <ThemeToggle />
          </div>
        )}

        {authenticatedShell && user && (
          <>
            <span className="headerDivider headerNavDivider" aria-hidden="true" />
            {manuscriptId === null ? (
              <nav className="primaryNav" aria-label={t('app.primaryNavigation')}>
                <button
                  type="button"
                  className={`navItem ${view === 'dashboard' && section === 'dashboard' ? 'active' : ''}`}
                  onMouseEnter={preloadDashboardPage}
                  onFocus={preloadDashboardPage}
                  onClick={() => openSection('dashboard')}
                >
                  <Icon name="workspace-light" className="navIcon" />
                  {t('app.workspace')}
                </button>
                <button
                  type="button"
                  className={`navItem ${view === 'dashboard' && section === 'manuscripts' ? 'active' : ''}`}
                  onMouseEnter={preloadManuscriptsPage}
                  onFocus={preloadManuscriptsPage}
                  onClick={() => openSection('manuscripts')}
                >
                  <Icon name="documents-light" className="navIcon" />
                  {t(authorWorkspaceActive ? 'app.manuscripts' : 'editorManuscripts.title')}
                </button>
                {authorWorkspaceActive && (
                  <>
                    <button
                      type="button"
                      className={`navItem ${view === 'dashboard' && section === 'ideas' ? 'active' : ''}`}
                      onMouseEnter={preloadIdeasPage}
                      onFocus={preloadIdeasPage}
                      onClick={() => openSection('ideas')}
                    >
                      <Icon name="lightbulb-light" className="navIcon" />
                      {t('app.ideas')}
                    </button>
                    {user.feedEnabled && (
                      <button
                        type="button"
                        className={`navItem ${view === 'dashboard' && section === 'feed' ? 'active' : ''}`}
                        onMouseEnter={preloadFeedPage}
                        onFocus={preloadFeedPage}
                        onClick={() => openSection('feed')}
                      >
                        <Icon name="cheque-light" className="navIcon" />
                        {t('app.feed')}
                      </button>
                    )}
                  </>
                )}
              </nav>
            ) : (
              <nav className="primaryNav manuscriptNav" aria-label={t('app.manuscriptNavigation')}>
                <div className="sectionMenu" ref={sectionMenuRef}>
                  <button
                    type="button"
                    className="sectionMenuButton spaceButton"
                    aria-label={t('app.openMainNavigation')}
                    aria-haspopup="menu"
                    aria-expanded={sectionMenuOpen}
                    disabled={editorOfflineMode}
                    onClick={() => {
                      setProfileMenuOpen(false)
                      setSectionMenuOpen((isOpen) => !isOpen)
                    }}
                  >
                    <Icon name="arrow-left-1" />
                  </button>
                  {sectionMenuOpen && (
                    <div className="sectionDropdown" role="menu">
                      <button
                        type="button"
                        className="dropdownItem"
                        role="menuitem"
                        onMouseEnter={preloadDashboardPage}
                        onFocus={preloadDashboardPage}
                        onClick={() => openSection('dashboard')}
                      >
                        <Icon name="workspace-light" className="navIcon" />
                        {t('app.workspace')}
                      </button>
                      <button
                        type="button"
                        className="dropdownItem"
                        role="menuitem"
                        onMouseEnter={preloadManuscriptsPage}
                        onFocus={preloadManuscriptsPage}
                        onClick={() => openSection('manuscripts')}
                      >
                        <Icon name="documents-light" className="navIcon" />
                        {t(authorWorkspaceActive ? 'app.manuscripts' : 'editorManuscripts.title')}
                      </button>
                      {authorWorkspaceActive && (
                        <>
                          <button
                            type="button"
                            className="dropdownItem"
                            role="menuitem"
                            onMouseEnter={preloadIdeasPage}
                            onFocus={preloadIdeasPage}
                            onClick={() => openSection('ideas')}
                          >
                            <Icon name="lightbulb-light" className="navIcon" />
                            {t('app.ideas')}
                          </button>
                          {user.feedEnabled && (
                            <button
                              type="button"
                              className="dropdownItem"
                              role="menuitem"
                              onMouseEnter={preloadFeedPage}
                              onFocus={preloadFeedPage}
                              onClick={() => openSection('feed')}
                            >
                              <Icon name="cheque-light" className="navIcon" />
                              {t('app.feed')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                {authorWorkspaceActive && <>
                <button
                  type="button"
                  className={`navItem ${manuscriptView === 'dashboard' ? 'active' : ''}`}
                  onClick={() => openManuscriptView('dashboard')}
                  disabled={editorOfflineMode}
                >
                  <Icon name="dashboard-light" className="navIcon" />
                  {t('app.dashboard')}
                </button>
                <button
                  type="button"
                  className={`navItem ${manuscriptView === 'planner' ? 'active' : ''}`}
                  onClick={() => openManuscriptView('planner')}
                  disabled={editorOfflineMode}
                >
                  <Icon name="planner-light" className="navIcon" />
                  {t('app.planner')}
                </button>
                <button
                  type="button"
                  className={`navItem ${manuscriptView === 'boards' ? 'active' : ''}`}
                  onClick={() => openManuscriptView('boards')}
                  disabled={editorOfflineMode}
                >
                  <Icon name="boards-light" className="navIcon" />
                  {t('app.boards')}
                </button>
                <button
                  type="button"
                  className={`navItem ${manuscriptView === 'glossary' ? 'active' : ''}`}
                  onClick={() => openManuscriptView('glossary')}
                  disabled={editorOfflineMode}
                >
                  <Icon name="notebook-light" className="navIcon" />
                  {t('app.glossary')}
                </button>
                </>}
                <button
                  type="button"
                  className={`navItem ${manuscriptView === 'editor' ? 'active' : ''}`}
                  onMouseEnter={preloadManuscriptEditor}
                  onFocus={preloadManuscriptEditor}
                  onClick={() => openManuscriptView('editor')}
                  disabled={editorOfflineMode}
                >
                  <Icon name="edit-light" className="navIcon" />
                  {t('app.editor')}
                </button>
              </nav>
            )}

            <div className="headerActions">
              {!workspaceHomeActive && (
                <>
                  <HeaderWorkspaceSearch
                    key={authorWorkspaceActive ? 'author-search' : 'editor-search'}
                    endpoint={authorWorkspaceActive
                      ? '/api/manuscripts/dashboard/search/'
                      : '/api/editor/workspace/search/'}
                    kinds={authorWorkspaceActive
                      ? AUTHOR_WORKSPACE_SEARCH_KINDS
                      : EDITOR_WORKSPACE_SEARCH_KINDS}
                    placeholder={t(authorWorkspaceActive
                      ? 'dashboard.searchPlaceholder'
                      : 'editorDashboard.searchPlaceholder')}
                    emptyMessage={t(authorWorkspaceActive
                      ? 'dashboard.searchEmpty'
                      : 'editorDashboard.searchEmpty')}
                    showAuthor={!authorWorkspaceActive}
                    disabled={editorOfflineMode}
                    onOpen={() => {
                      setSectionMenuOpen(false)
                      setProfileMenuOpen(false)
                      dismissMobileMenu()
                    }}
                    onSelect={openWorkspaceSearchResult}
                  />
                  <span className="headerDivider searchDivider" aria-hidden="true" />
                </>
              )}
              <NotificationPanel
                disabled={editorOfflineMode}
                onNavigate={navigateNotification}
                onError={reportError}
              />
              <span className="headerDivider profileDivider" aria-hidden="true" />

              <div className="profileMenu" ref={profileMenuRef}>
                <button
                  type="button"
                  className="profileButton"
                  onClick={() => {
                    setSectionMenuOpen(false)
                    setProfileMenuOpen((isOpen) => !isOpen)
                  }}
                  aria-label={t('app.openAccountMenu')}
                  aria-haspopup="menu"
                  aria-expanded={profileMenuOpen}
                  disabled={editorOfflineMode}
                >
                  <span className="avatar" aria-hidden="true">
                    {avatarSrc ? <img src={avatarSrc} alt="" /> : avatarInitial}
                  </span>
                </button>

                  <div
                    className={`profileDropdown ${profileMenuOpen ? 'open' : ''}`}
                    role="menu"
                    aria-hidden={!profileMenuOpen}
                    inert={profileMenuOpen ? undefined : true}
                  >
                    <div className="profileSummary">
                      <span>{displayName}</span>
                      {hasDisplayName && <small>{user.username}</small>}
                    </div>
                    {user.authorWorkspaceEnabled && user.editorWorkspaceEnabled && (
                      <>
                        <button
                          type="button"
                          className="dropdownItem workspaceSwitcherItem"
                          onClick={() => void switchWorkspace(authorWorkspaceActive ? 'editor' : 'author')}
                        >
                          <Icon
                            name={authorWorkspaceActive ? 'mynaui-pen' : 'books-light'}
                            className="menuIcon"
                          />
                          {t(authorWorkspaceActive
                            ? 'workspaceSwitcher.toEditor'
                            : 'workspaceSwitcher.toAuthor')}
                        </button>
                        <div className="profileDropdownDivider" role="separator" />
                      </>
                    )}
                    <button
                      type="button"
                      className="dropdownItem"
                      onClick={() => openSection('settings')}
                    >
                      <Icon name="settings-light" className="menuIcon" />
                      {t('app.settings')}
                    </button>
                    {user.isSuperuser && (
                      <button type="button" className="dropdownItem" onClick={() => openSection('admin')}>
                        <Icon name="shield-user-light" className="menuIcon" />
                        {t('app.admin')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="dropdownItem"
                      onClick={() => void handleLogout()}
                    >
                      <Icon name="exit-light" className="menuIcon" />
                      {t('app.logout')}
                    </button>
                  </div>
              </div>

              <div className="mobileNavigation" ref={mobileMenuRef}>
                <button
                  ref={mobileMenuButtonRef}
                  type="button"
                  className="mobileNavigationButton spaceButton"
                  aria-label={t('app.openMainNavigation')}
                  aria-haspopup="menu"
                  aria-expanded={mobileMenuOpen}
                  disabled={editorOfflineMode}
                  onClick={() => {
                    setSectionMenuOpen(false)
                    setProfileMenuOpen(false)
                    if (mobileMenuOpen) dismissMobileMenu()
                    else setMobileMenuOpen(true)
                  }}
                >
                  <Icon name="hamburger-menu-light" />
                </button>

                <div
                  className={`mobileNavigationPopover ${mobileMenuOpen ? 'open' : ''}`}
                  role="menu"
                  inert={mobileMenuOpen ? undefined : true}
                >
                    <div className="mobileNavigationGroup">
                      <button
                        type="button"
                        className={`mobileNavigationItem spaceButton ${section === 'dashboard' ? 'active' : ''}`}
                        role="menuitem"
                        onClick={() => openSection('dashboard')}
                      >
                        <Icon name="workspace-light" />
                        <span>{t('app.workspace')}</span>
                      </button>
                      <button
                        type="button"
                        className={`mobileNavigationItem spaceButton ${section === 'manuscripts' && manuscriptId === null ? 'active' : ''}`}
                        role="menuitem"
                        onClick={() => openSection('manuscripts')}
                      >
                        <Icon name="documents-light" />
                        <span>{t(authorWorkspaceActive ? 'app.manuscripts' : 'editorManuscripts.title')}</span>
                      </button>
                      {authorWorkspaceActive && (
                        <>
                          <button
                            type="button"
                            className={`mobileNavigationItem spaceButton ${section === 'ideas' ? 'active' : ''}`}
                            role="menuitem"
                            onClick={() => openSection('ideas')}
                          >
                            <Icon name="lightbulb-light" />
                            <span>{t('app.ideas')}</span>
                          </button>
                          {user.feedEnabled && (
                            <button
                              type="button"
                              className={`mobileNavigationItem spaceButton ${section === 'feed' ? 'active' : ''}`}
                              role="menuitem"
                              onClick={() => openSection('feed')}
                            >
                              <Icon name="cheque-light" />
                              <span>{t('app.feed')}</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    {manuscriptId !== null && (
                      <>
                        <div className="mobileNavigationDivider" role="separator" />
                        <div className="mobileNavigationGroup">
                          {authorWorkspaceActive && <>
                          <button
                            type="button"
                            className={`mobileNavigationItem spaceButton ${manuscriptView === 'dashboard' ? 'active' : ''}`}
                            role="menuitem"
                            disabled={editorOfflineMode}
                            onClick={() => openManuscriptView('dashboard')}
                          >
                            <Icon name="dashboard-light" />
                            <span>{t('app.dashboard')}</span>
                          </button>
                          <button
                            type="button"
                            className={`mobileNavigationItem spaceButton ${manuscriptView === 'planner' ? 'active' : ''}`}
                            role="menuitem"
                            disabled={editorOfflineMode}
                            onClick={() => openManuscriptView('planner')}
                          >
                            <Icon name="planner-light" />
                            <span>{t('app.planner')}</span>
                          </button>
                          <button
                            type="button"
                            className={`mobileNavigationItem spaceButton ${manuscriptView === 'boards' ? 'active' : ''}`}
                            role="menuitem"
                            disabled={editorOfflineMode}
                            onClick={() => openManuscriptView('boards')}
                          >
                            <Icon name="boards-light" />
                            <span>{t('app.boards')}</span>
                          </button>
                          <button
                            type="button"
                            className={`mobileNavigationItem spaceButton ${manuscriptView === 'glossary' ? 'active' : ''}`}
                            role="menuitem"
                            disabled={editorOfflineMode}
                            onClick={() => openManuscriptView('glossary')}
                          >
                            <Icon name="notebook-light" />
                            <span>{t('app.glossary')}</span>
                          </button>
                          </>}
                          <button
                            type="button"
                            className={`mobileNavigationItem spaceButton ${manuscriptView === 'editor' ? 'active' : ''}`}
                            role="menuitem"
                            disabled={editorOfflineMode}
                            onMouseEnter={preloadManuscriptEditor}
                            onFocus={preloadManuscriptEditor}
                            onClick={() => openManuscriptView('editor')}
                          >
                            <Icon name="edit-light" />
                            <span>{t('app.editor')}</span>
                          </button>
                        </div>
                      </>
                    )}

                    <div className="mobileNavigationDivider" role="separator" />
                    <button
                      type="button"
                      className="mobileNavigationUser spaceButton"
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={mobileAccountOpen}
                      onClick={() => setMobileAccountOpen((open) => !open)}
                    >
                      <span className="avatar" aria-hidden="true">
                        {avatarSrc ? <img src={avatarSrc} alt="" /> : avatarInitial}
                      </span>
                      <strong>{displayName}</strong>
                      <Icon name="arrow-down-2" className={mobileAccountOpen ? 'open' : ''} />
                    </button>

                    <div
                      className={`mobileNavigationAccountActions ${mobileAccountOpen ? 'open' : ''}`}
                      role="group"
                      inert={mobileAccountOpen ? undefined : true}
                    >
                        {user.authorWorkspaceEnabled && user.editorWorkspaceEnabled && (
                          <>
                            <button
                              type="button"
                              className="mobileNavigationItem mobileWorkspaceSwitcherItem spaceButton"
                              role="menuitem"
                              onClick={() => void switchWorkspace(authorWorkspaceActive ? 'editor' : 'author')}
                            >
                              <Icon name={authorWorkspaceActive ? 'mynaui-pen' : 'books-light'} />
                              <span>{t(authorWorkspaceActive
                                ? 'workspaceSwitcher.toEditor'
                                : 'workspaceSwitcher.toAuthor')}</span>
                            </button>
                            <div className="mobileAccountDivider" role="separator" />
                          </>
                        )}
                        <button
                          type="button"
                          className={`mobileNavigationItem spaceButton ${section === 'settings' ? 'active' : ''}`}
                          role="menuitem"
                          onClick={() => openSection('settings')}
                        >
                          <Icon name="settings-light" />
                          <span>{t('app.settings')}</span>
                        </button>
                        {user.isSuperuser && (
                          <button
                            type="button"
                            className={`mobileNavigationItem spaceButton ${section === 'admin' ? 'active' : ''}`}
                            role="menuitem"
                            onClick={() => openSection('admin')}
                          >
                            <Icon name="shield-user-light" />
                            <span>{t('app.admin')}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="mobileNavigationItem spaceButton"
                          role="menuitem"
                          onClick={() => void handleLogout()}
                        >
                          <Icon name="exit-light" />
                          <span>{t('app.logout')}</span>
                        </button>
                    </div>
                  </div>
              </div>
            </div>
          </>
        )}
      </header>

      <section
        className={`workspace ${view !== 'dashboard' && view !== 'servicePage' ? 'authWorkspace' : ''} ${view === 'servicePage' ? 'servicePageWorkspace' : ''} ${view === 'dashboard' && user && section === 'dashboard' && authorWorkspaceActive ? 'workspaceHomeWorkspace' : ''} ${view === 'dashboard' && user && section === 'dashboard' && !authorWorkspaceActive ? 'editorWorkspaceHomeWorkspace' : ''} ${view === 'dashboard' && user && section === 'manuscripts' && manuscriptId === null ? 'manuscriptLibraryWorkspace' : ''} ${view === 'dashboard' && user && section === 'feed' ? 'feedWorkspace' : ''} ${view === 'dashboard' && user && section === 'ideas' ? 'ideasWorkspace' : ''} ${manuscriptId !== null ? 'manuscriptWorkspace' : ''} ${manuscriptId !== null && manuscriptView === 'dashboard' ? 'manuscriptDashboardWorkspace' : ''} ${manuscriptId !== null && (manuscriptView === 'planner' || manuscriptView === 'boards' || manuscriptView === 'glossary') ? 'fixedManuscriptWorkspace' : ''} ${view === 'dashboard' && (section === 'feed' || section === 'settings' || (section === 'admin' && user?.isSuperuser)) ? 'sidebarWorkspace' : ''}`}
        id="workspace"
      >
        <div className="workspaceInner">
          <Suspense fallback={<TadpoleLoadingState className="appRouteLoadingState" label={t('common.loading')} />}>
            {view !== 'dashboard'
              && view !== 'servicePage'
              && view !== 'onboarding'
              && view !== 'editorInvitation' && (
              <AuthViews
                view={view}
                openRegistration={openRegistration}
                localPasswordLoginEnabled={localPasswordLoginEnabled}
                oidcEnabled={oidcEnabled}
                oidcProviderName={oidcProviderName}
                onRegistration={handleRegistration}
                onLogin={handleLogin}
                onPasskeyLogin={handlePasskeyLogin}
                onOidcLogin={handleOidcLogin}
                onPasswordResetRequest={handlePasswordResetRequest}
                onPasswordResetVerify={handlePasswordResetVerify}
                onPasswordResetConfirm={handlePasswordResetConfirm}
                onTwoFactor={handleTwoFactor}
                onNavigate={navigate}
                isSubmitting={authSubmitting}
                twoFactorMethod={twoFactorMethod}
                servicePages={servicePages}
              />
            )}

            {view === 'editorInvitation' && (
              <EditorInvitationPage
                user={user}
                servicePages={servicePages}
                onAuthenticated={(nextUser, nextWorkspace) => applyAuthenticatedUser(nextUser, false, nextWorkspace)}
              />
            )}

            {view === 'onboarding' && user && (
              <OnboardingFlow user={user} onComplete={handleOnboardingComplete} />
            )}

            {view === 'servicePage' && servicePageSlug && (
              <ServicePageView
                key={servicePageSlug}
                slug={servicePageSlug}
                pages={servicePages}
                onUnavailable={redirectUnavailableServicePage}
                onError={reportError}
              />
            )}

            {view === 'dashboard' && user && section === 'dashboard' && (
              authorWorkspaceActive ? (
                <DashboardPage
                  user={user}
                  onOpenSearchResult={openWorkspaceSearchResult}
                />
              ) : (
                <EditorDashboardPage
                  user={user}
                  onOpenSearchResult={openWorkspaceSearchResult}
                />
              )
            )}

            {view === 'dashboard' && user && section === 'manuscripts' && manuscriptId === null && seriesId === null && (
              <ManuscriptsPage
                mode={authorWorkspaceActive ? 'owner' : 'editor'}
                onMessage={setMessage}
                onError={reportError}
                onOpen={openManuscript}
                onOpenSeries={openSeries}
                activeSection={manuscriptLibrarySection}
                onSelectSection={setManuscriptLibrarySection}
              />
            )}

            {view === 'dashboard' && user && section === 'feed' && user.feedEnabled && (
              <FeedPage user={user} onError={reportError} />
            )}

            {view === 'dashboard' && user && section === 'ideas' && (
              <IdeasPage
                initialItemId={new URLSearchParams(routeSearch).get('item')}
                onError={reportError}
                onMessage={setMessage}
                onActionMessage={(nextMessage, label, path) => {
                  setMessageAction({ message: nextMessage, label, path })
                  setMessage(nextMessage)
                }}
              />
            )}

            {view === 'dashboard' && user && section === 'manuscripts' && seriesId !== null && (
              <SeriesPage
                seriesId={seriesId}
                onBack={() => openManuscriptLibrarySection('series')}
                onSelectSection={openManuscriptLibrarySection}
                onOpenBook={openManuscript}
                onOpenSeries={openSeries}
                onMessage={setMessage}
                onError={reportError}
              />
            )}

            {view === 'dashboard' && user && manuscriptId !== null && (
              <ManuscriptSpace
                userId={user.id}
                manuscriptId={manuscriptId}
                view={manuscriptView}
                routeSearch={routeSearch}
                onError={reportError}
                onMessage={setMessage}
                onViewChange={openManuscriptView}
                onOfflineModeChange={handleEditorOfflineModeChange}
                accessMode={authorWorkspaceActive ? 'owner' : 'editor'}
                onAccessLost={handleEditorAccessLost}
              />
            )}

            {view === 'dashboard' && user && section === 'admin' && (
              <AdminPage
                user={user}
                onMessage={setMessage}
                onError={reportError}
                onServicePagesChange={refreshServicePages}
              />
            )}

            {view === 'dashboard' && user && section === 'settings' && (
              <SettingsPage
                user={user}
                localPasswordLoginEnabled={localPasswordLoginEnabled}
                routeSearch={routeSearch}
                onUserChange={(nextUser) => {
                  setUser(nextUser)
                  void setInterfaceLanguage(nextUser.language)
                }}
                onMessage={setMessage}
                onError={reportError}
                onAccountDeleted={handleAccountDeleted}
                servicePages={servicePages}
              />
            )}
          </Suspense>
        </div>
      </section>

      {(message || error) && (
        <div className="toastRegion" role="status" aria-live="polite">
          {message && (
            <div className="toast success">
              <span>{message}</span>
              {messageAction?.message === message && (
                <button
                  type="button"
                  onClick={() => {
                    setMessage('')
                    setMessageAction(null)
                    window.history.pushState({}, '', messageAction.path)
                    window.dispatchEvent(new PopStateEvent('popstate'))
                  }}
                >
                  {messageAction.label}
                </button>
              )}
            </div>
          )}
          {error && (
            <div className="toast error" role="alert">
              <span>
                {t(`errors.${error}`, {
                  defaultValue: error,
                })}
              </span>
              <button type="button" onClick={() => void copyErrorToClipboard()}>
                {t('app.copyError')}
              </button>
            </div>
          )}
        </div>
      )}
      <CookieConsent />
    </main>
  )
}

export default App
