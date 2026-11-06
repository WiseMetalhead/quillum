export type TwoFactorMethod = 'none' | 'totp' | 'email'
export type ThemePreference = 'system' | 'light' | 'dark'
export type WorkspaceKind = 'author' | 'editor'

export type User = {
  id: number
  username: string
  email: string
  displayName: string
  avatarUrl: string
  language: string
  timezone: string
  theme: ThemePreference
  authorName: string
  authorEmail: string
  authorWebsite: string
  authorTodayProfile: string
  authorLitresProfile: string
  authorProzaProfile: string
  authorSamizdatProfile: string
  authorCellulosaProfile: string
  authorWattpadProfile: string
  passwordChangedAt: string
  hasUsablePassword: boolean
  twoFactorMethod: TwoFactorMethod
  tier: TierId
  isSuperuser: boolean
  authorWorkspaceEnabled: boolean
  editorWorkspaceEnabled: boolean
  oidcLinked: boolean
  onboardingCompleted: boolean
  newsEnabled: boolean
  contestsEnabled: boolean
  feedEnabled: boolean
}

export type OnboardingPayload = Pick<
  User,
  | 'language'
  | 'timezone'
  | 'theme'
  | 'displayName'
  | 'authorName'
  | 'authorWebsite'
  | 'authorTodayProfile'
  | 'authorLitresProfile'
  | 'authorProzaProfile'
  | 'authorSamizdatProfile'
  | 'authorCellulosaProfile'
  | 'authorWattpadProfile'
>

export type TierId = 'novice' | 'author' | 'believer' | 'god'

export type QuotaKey =
  | 'oneshots'
  | 'books'
  | 'series'
  | 'drafts_per_document'
  | 'revisions_per_document'
  | 'storage_bytes'
  | 'image_upload_bytes'
  | 'editor_invites'

export type TierQuotaUsage = {
  key: QuotaKey
  label: string
  used: number
  limit: number
}

export type UserTierPayload = {
  tier: TierId
  tierLabel: string
  quotas: TierQuotaUsage[]
  automaticPromotion: TierAutomaticPromotion | null
}

export type TierAutomaticPromotion = {
  nextTier: Extract<TierId, 'author' | 'believer'>
  activeDays: number
  requiredDays: number
  remainingDays: number
}

export type PasskeyCredential = {
  id: number
  name: string
  backupEligible: boolean
  backupState: boolean
  createdAt: string
  lastUsedAt: string | null
}

export type SecurityPayload = {
  twoFactorMethod: TwoFactorMethod
  totpEnabled: boolean
  emailTwoFactorEnabled: boolean
  passkeys: PasskeyCredential[]
  passkeyLimit: number
}

export type SessionPayload = {
  authenticated: boolean
  user: User | null
  activeWorkspace?: WorkspaceKind
  authMode: string
  openRegistration: boolean
  localPasswordLoginEnabled: boolean
  oidcEnabled: boolean
  oidcProviderName: string
}

export type ViewState =
  | 'loading'
  | 'registration'
  | 'login'
  | 'forgotPassword'
  | 'twoFactor'
  | 'servicePage'
  | 'editorInvitation'
  | 'onboarding'
  | 'dashboard'
export type AppSection = 'dashboard' | 'manuscripts' | 'ideas' | 'feed' | 'admin' | 'settings'
export type WorkspaceSearchResult = {
  kind: 'manuscript' | 'document' | 'note' | 'glossaryArticle'
  id: string
  title: string
  manuscriptId: string
  contextTitle: string
  updatedAt: string
  itemId?: string | null
  synopsis?: string
  authorName?: string
}
export type AdminView = 'status' | 'settings' | 'maintenance' | 'audit' | 'users' | 'notifications' | 'servicePages'
export type SettingsView = 'account' | 'editor' | 'security' | 'author' | 'tiers' | 'storage' | 'notifications' | 'feed'

export type EditorIdentity = {
  id: number
  displayName: string
  username: string
  avatarUrl?: string
  connectedAt: string
}

export type EditorInvitation = {
  id: string
  shareUrl: string
  createdAt: string
  expiresAt: string
}

export type EditorSectionPayload = {
  authorWorkspaceEnabled: boolean
  editorWorkspaceEnabled: boolean
  quota: { used: number; limit: number } | null
  pendingInvitations: EditorInvitation[]
  editors: EditorIdentity[]
  writers: EditorIdentity[]
}

export type EditorInvitationClaimPayload = {
  invitation: {
    id: string
    author: Pick<EditorIdentity, 'displayName' | 'username'>
    expiresAt: string
  }
  localPasswordLoginEnabled: boolean
  oidcEnabled: boolean
  oidcProviderName: string
}

export type AdminMaintenanceRunStatus = 'running' | 'succeeded' | 'failed' | 'retrying' | 'revoked'

export type AdminMaintenanceRun = {
  taskId: string
  status: AdminMaintenanceRunStatus
  startedAt: string
  finishedAt: string | null
  errorType: string | null
}

export type AdminMaintenancePayload = {
  actions: {
    news: AdminMaintenanceRun | null
    contests: AdminMaintenanceRun | null
  }
}

export type NewsSource = {
  key: string
  name: string
  websiteUrl: string
  enabled: boolean
  lastSuccessfulSyncAt: string | null
}

export type NewsSourcesPayload = {
  items: NewsSource[]
  newsEnabled: boolean
}

export type NewsItem = {
  id: string
  source: { key: string; name: string }
  title: string
  authorName: string
  summary: string
  publishedAt: string
  sourceUrl: string
}

export type NewsPagePayload = {
  items: NewsItem[]
  nextCursor: string | null
}

export type ContestStatus = 'accepting' | 'preparation' | 'in_progress' | 'finished'
export type ContestActionKind = 'works' | 'results'
export type ContestDetailState = 'ready' | 'pending' | 'unavailable'
export type ContestDatePrecision = 'exact' | 'month' | 'month_range' | 'approximate' | 'unparsed'

export type ContestSource = NewsSource

export type ContestSourcesPayload = {
  items: ContestSource[]
  contestsEnabled: boolean
}

export type ContestItem = {
  id: string
  source: { key: string; name: string }
  title: string
  description: string
  status: ContestStatus
  descriptionUrl: string
  discussionUrl: string | null
  terminalAction: { kind: ContestActionKind; url: string } | null
  detailState: ContestDetailState
}

export type ContestPagePayload = {
  items: ContestItem[]
  nextCursor: string | null
}

export type ContestPhase = {
  key: string
  kind: string
  label: string
  rawText: string
  startsOn: string | null
  endsOn: string | null
  deadlineAt: string | null
  precision: ContestDatePrecision
  sourceSection: string
}

export type ContestConditionSection = {
  kind: string
  title: string
  text: string
  blocks?: ContestConditionBlock[]
}

export type ContestConditionBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }

export type ContestConditionFact = {
  kind: 'form' | 'genre' | 'length' | 'submission_length' | 'age' | 'max_works'
  value?: string | number
  min?: number
  max?: number
  sourceText: string
}

export type ContestRecommendedManuscript = {
  id: string
  kind: 'oneshot' | 'book'
  title: string
  characterCount: number
  coverThumbnailSmallUrl: string
  coverVersion: string
  participating: boolean
  trackingEnabled: boolean
  canParticipate: boolean
}

export type ContestParticipationPayload = {
  participating: boolean
  recommendedManuscripts: ContestRecommendedManuscript[]
}

export type ContestDetailPayload = {
  id: string
  state: ContestDetailState
  isStale?: boolean
  lastSuccessfulSyncAt?: string
  phases: ContestPhase[]
  conditionFacts: ContestConditionFact[]
  conditionsSections: ContestConditionSection[]
  recommendedManuscripts: ContestRecommendedManuscript[]
}

export type ServicePageSlug = 'privacy' | 'terms' | 'contact'

export type ServicePageMetadata = {
  slug: ServicePageSlug
  path: string
  version: number
  publishedAt: string
}

export type ServicePagesPayload = {
  pages: ServicePageMetadata[]
}

export type ServicePageDocument = ServicePageMetadata & {
  markdown: string
}

export type AdminServicePage = {
  slug: ServicePageSlug
  draftMarkdown: string
  published: boolean
  version: number | null
  publishedAt: string | null
  draftUpdatedAt: string
  hasUnpublishedChanges: boolean
}

export type AdminServicePagesPayload = {
  pages: AdminServicePage[]
}

export type AccountExportManuscriptFormat = 'markdown' | 'docx' | 'odt'
export type AccountExportGlossaryFormat = 'markdown' | 'html'
export type AccountExportStatus = 'pending' | 'building' | 'ready' | 'failed' | 'expired'

export type AccountExportJob = {
  id: string
  manuscriptFormat: AccountExportManuscriptFormat
  glossaryFormat: AccountExportGlossaryFormat
  status: AccountExportStatus
  fileName: string
  byteSize: number
  errorCode: string
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  expiresAt: string | null
  downloadUrl: string | null
}

export type AccountExportPayload = {
  export: AccountExportJob | null
}

export type NotificationCategory = 'service' | 'admin' | 'user'
export type NotificationKind =
  | 'service.password_stale'
  | 'service.two_factor_missing'
  | 'service.review_share_expired'
  | 'service.export_expiring'
  | 'service.storage_near_limit'
  | 'service.tier_changed'
  | 'service.new_login'
  | 'service.account_export_ready'
  | 'service.audio_transcription_ready'
  | 'service.audio_transcription_failed'
  | 'service.editor_manuscript_access_granted'
  | 'service.editor_manuscript_access_revoked'
  | 'admin.announcement'
  | 'user.manuscript_deadline'
  | 'user.item_deadline'
  | 'user.task_deadline'
  | 'user.review_comment'
  | 'user.daily_goal'
  | 'user.manuscript_digest'

export type NotificationRuleKind = Extract<NotificationKind, `user.${string}`>

export type NotificationRule = {
  kind: NotificationRuleKind
  enabled: boolean
  emailEnabled: boolean
  time: string | null
  weekdays: number[]
  checkpoints: number[]
  manuscriptIds: string[]
}

export type NotificationPreferenceManuscript = {
  id: string
  title: string
  kind: 'oneshot' | 'book'
}

export type NotificationPreferences = {
  timezone: string
  rules: NotificationRule[]
  manuscripts: NotificationPreferenceManuscript[]
}

export type NotificationItem = {
  id: string
  category: NotificationCategory
  kind: NotificationKind
  payload: Record<string, unknown>
  readAt: string | null
  createdAt: string
}

export type NotificationPage = {
  items: NotificationItem[]
  nextCursor: string | null
  unreadCount: number
}

export type AdminNotificationCampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'processing'
  | 'sent'
  | 'canceled'
  | 'failed'

export type AdminNotificationCampaign = {
  id: string
  title: string
  body: string
  tiers: TierId[]
  status: AdminNotificationCampaignStatus
  scheduledFor: string | null
  author: string | null
  recipientCount: number
  sentCount: number
  failedCount: number
  createdAt: string
  updatedAt: string
}

export type StorageGroupKey = 'all' | 'covers' | 'illustrations' | 'notes' | 'audioNotes' | 'glossary' | 'ideas' | 'other'

export type IdeaKind = 'image' | 'text' | 'audio'

export type IdeaItem = {
  id: string
  kind: IdeaKind
  title: string
  preview: string
  text?: string
  image: {
    mediaId: string
    previewUrl: string
    displayUrl: string
    width: number
    height: number
  } | null
  audio: {
    contentType: 'audio/webm' | 'audio/ogg' | 'audio/mp4'
    codec: 'opus' | 'aac'
    byteSize: number
    durationMs: number
    waveform: number[]
    playbackUrl: string
    downloadUrl: string
    transcriptionUrl: string
  } | null
  saveGeneration: number
  createdAt: string
  updatedAt: string
}

export type IdeasPayload = {
  items: IdeaItem[]
  counts: Record<'all' | IdeaKind, number>
  nextCursor: string | null
}

export type IdeaTarget = {
  id: string
  title: string
  kind: 'oneshot' | 'book'
  inDrawer: boolean
  series: {
    id: string
    title: string
    position: number | null
  } | null
}

export type IdeaAttachResult = {
  note: {
    id: string
    manuscriptId: string
  }
  alreadyAttached: boolean
}

export type StorageUsageLocation = {
  kind: string
  label: string
  detail: string
  url: string
}

export type StorageItem = {
  id: string
  group: Exclude<StorageGroupKey, 'all'>
  mediaType: string
  title: string
  subtitle: string
  previewUrl: string
  displayUrl: string
  downloadUrl: string
  contentType: string
  width: number | null
  height: number | null
  originalBytes: number
  variantBytes: number
  totalBytes: number
  createdAt: string
  updatedAt: string
  usages: StorageUsageLocation[]
  deletable: boolean
  deleteReason: string
  audio: {
    locationId: string
    noteId: string | null
    codec: 'opus' | 'aac'
    durationMs: number
    waveform: number[]
    playbackUrl: string
    transcriptionUrl: string
  } | null
}

export type AudioTranscriptionStatus = 'none' | 'queued' | 'processing' | 'ready' | 'failed'

export type AudioTranscription = {
  featureEnabled: boolean
  status: AudioTranscriptionStatus
  text: string | null
  hasText: boolean
  language: 'en' | 'ru' | null
  errorCode: string | null
  requestedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  textUpdatedAt: string | null
}

export type StorageGroupSummary = {
  key: StorageGroupKey
  count: number
  totalBytes: number
}

export type StoragePayload = {
  summary: {
    usedBytes: number
    limitBytes: number
    tier: TierId
  }
  groups: StorageGroupSummary[]
  items: StorageItem[]
  pagination: Pagination
}

export type ServiceCheck = {
  ok: boolean
  error?: string
  latencyMs: number | null
}

export type AdminStatus = {
  status: 'ok' | 'degraded'
  checkedAt: string
  app: {
    name: string
    version: string
    debug: boolean
    environment: string
  }
  auth: {
    mode: string
    oidcEnabled: boolean
  }
  services: {
    database: ServiceCheck & {
      version: string | null
      sizeBytes: number | null
      activeConnections: number | null
    }
    redis: ServiceCheck & {
      version: string | null
      usedMemoryBytes: number | null
      maxMemoryBytes: number | null
      keys: number | null
      metricsError?: string
      keysError?: string
    }
    celery: ServiceCheck & {
      configured: boolean
      broker: string
      workers: string[]
      workerCount: number
    }
    storage: {
      ok: boolean
      provider: string
      usedBytes: number | null
      error?: string
    }
    collaboration: ServiceCheck & {
      configured: boolean
      mode: 'disabled' | 'pilot' | 'enabled'
      documents: number | null
      connections: number | null
    }
  }
  usage: {
    users: number
    administrators: number
    auditEvents: number
  }
  latestAuditEvent: {
    id: number
    event: string
    actor: string | null
    subject: string
    createdAt: string
  } | null
  taskActivity: {
    queueState: 'healthy' | 'degraded' | 'unavailable'
    queued: number | null
    running: number
    failedLast24Hours: number
    queueError: string | null
    scheduler: {
      configured: boolean
      online: boolean
      lastRunAt: string | null
    }
    lastTask: {
      id: string
      name: string
      status: 'running' | 'succeeded' | 'failed' | 'retrying' | 'revoked'
      worker: string
      startedAt: string
      finishedAt: string | null
      durationMs: number | null
      errorType: string | null
    } | null
  }
}

export type AdminSettingType =
  | 'boolean'
  | 'choice'
  | 'email'
  | 'integer'
  | 'rate'
  | 'secret'
  | 'string'

export type AdminSetting = {
  key: string
  label: string
  section: 'primary' | 'advanced'
  type: AdminSettingType
  value: boolean | number | string | null
  configured: boolean | null
  secret: boolean
  source: 'default' | 'database' | 'environment'
  locked: boolean
  editable: boolean
  minimum: number | null
  maximum: number | null
  maxLength: number | null
  choices: string[]
}

export type AdminSettingsPayload = {
  items: AdminSetting[]
  oidc: {
    enabled: boolean
    configured: boolean
    providerName: string
    issuer: string
    discoveryUrl: string
    callbackPath: string
  }
  transcription: {
    engine: string
    model: string
    languages: string[]
    ready: boolean
  }
}

export type AdminTierQuota = {
  key: QuotaKey
  label: string
  default: number
  value: number
  source: 'default' | 'database'
  minimum: number
  maximum: number
}

export type AdminTierQuotaGroup = {
  id: TierId
  label: string
  quotas: AdminTierQuota[]
}

export type AdminTierQuotasPayload = {
  tiers: AdminTierQuotaGroup[]
}

export type AdminTierProgressionPayload = {
  enabled: boolean
  noviceToAuthorDays: number
  authorToBelieverDays: number
  minimumDays: number
  maximumDays: number
}

export type AuditFilters = {
  event: string
  actor: string
  subject: string
  ip: string
  dateFrom: string
  dateTo: string
}

export type AuditEventRow = {
  id: number
  event: string
  actor: string | null
  actorId: number | null
  subject: string
  ipAddress: string | null
  userAgent: string
  payload: Record<string, unknown>
  createdAt: string
}

export type AuditEventsPayload = {
  items: AuditEventRow[]
  pagination: Pagination
  filters: AuditFilters
}

export type UserFilters = {
  search: string
  role: string
  active: string
}

export type AdminUserRow = {
  id: number
  username: string
  email: string
  displayName: string
  avatarUrl: string
  firstName: string
  lastName: string
  isActive: boolean
  isSuperuser: boolean
  authorWorkspaceEnabled: boolean
  editorWorkspaceEnabled: boolean
  tier: TierId
  tierLabel: string
  lastActivity: string | null
  dateJoined: string
  usage: {
    books: number
    storageBytes: number
  }
}

export type AdminUsersPayload = {
  items: AdminUserRow[]
  stats: {
    registered: number
    active: number
    blocked: number
  }
  pagination: Pagination
  filters: UserFilters
}

export type Pagination = {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  hasNext: boolean
  hasPrevious: boolean
}
