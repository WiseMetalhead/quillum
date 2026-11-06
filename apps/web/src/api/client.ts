import { resolveApiBase } from './resolveApiBase'
import { QueryCache, shouldInvalidateQueryCache } from './queryCache'
import type { QueryCacheOptions } from './queryCache'

export const API_BASE = resolveApiBase(
  import.meta.env.VITE_API_BASE,
  import.meta.env.DEV,
  window.location.hostname,
)

export type ApiSupportContext = {
  occurredAt: string
  username: string | null
  userId: number | null
  ipAddress: string | null
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: ApiPayload

  constructor(code: string, message: string, status: number, details: ApiPayload = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

type ApiPayload = {
  error?: string
  messages?: string[]
  quotaKey?: string
  used?: number
  limit?: number
  saveGeneration?: number
  tier?: string
  support?: ApiSupportContext
  reauthenticationMethod?: 'password' | 'oidc' | 'passkey'
}

let lastApiErrorSupport: ApiSupportContext | null = null
const queryCache = new QueryCache()
const API_REQUEST_CACHE: RequestCache = 'no-store'

export type ApiRequestInit = RequestInit & {
  invalidateQueryCache?: boolean
}

export function consumeLastApiErrorSupport(): ApiSupportContext | null {
  const support = lastApiErrorSupport
  lastApiErrorSupport = null
  return support
}

function getCookie(name: string): string {
  const value = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`))
    ?.split('=')[1]
  return value ? decodeURIComponent(value) : ''
}

async function parseApiPayload<T>(response: Response): Promise<T & ApiPayload> {
  const body = await response.text()
  if (!body) {
    throw new ApiError(
      response.ok ? 'invalid_response' : 'request_failed',
      response.ok
        ? `API returned an empty response with status ${response.status}`
        : `Request failed with ${response.status}`,
      response.status,
    )
  }
  try {
    return JSON.parse(body) as T & ApiPayload
  } catch {
    throw new ApiError(
      'invalid_response',
      `API returned a non-JSON response with status ${response.status}`,
      response.status,
    )
  }
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  lastApiErrorSupport = null
  const { invalidateQueryCache = true, ...requestInit } = init
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...requestInit,
    cache: API_REQUEST_CACHE,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': getCookie('csrftoken'),
      ...requestInit.headers,
    },
  })

  const payload = await parseApiPayload<T>(response)
  if (!response.ok) {
    lastApiErrorSupport = payload.support ?? null
    throw new ApiError(
      payload.error || 'request_failed',
      errorMessage(payload, response.status),
      response.status,
      payload,
    )
  }
  if (shouldInvalidateQueryCache(requestInit.method, invalidateQueryCache)) queryCache.clear()
  return payload
}

export function apiQuery<T>(
  path: string,
  options: QueryCacheOptions<T> = {},
): Promise<T> {
  return queryCache.query(path, (signal) => apiRequest<T>(path, { signal }), options)
}

export function prefetchApiQuery(path: string) {
  void apiQuery(path).catch(() => undefined)
}

export function clearApiQueryCache() {
  queryCache.clear()
}

export function invalidateApiQueries(prefix = '') {
  queryCache.invalidate(prefix)
}

export async function apiUpload<T>(path: string, body: FormData): Promise<T> {
  lastApiErrorSupport = null
  const response = await fetch(`${API_BASE}${path}`, {
    cache: API_REQUEST_CACHE,
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-CSRFToken': getCookie('csrftoken'),
    },
    body,
  })

  const payload = await parseApiPayload<T>(response)
  if (!response.ok) {
    lastApiErrorSupport = payload.support ?? null
    throw new ApiError(
      payload.error || 'request_failed',
      errorMessage(payload, response.status),
      response.status,
      payload,
    )
  }
  queryCache.clear()
  return payload
}

export type ApiDownload = {
  blob: Blob
  fileName: string
}

export async function apiDownload(
  path: string,
  body: Record<string, unknown> = {},
): Promise<ApiDownload> {
  lastApiErrorSupport = null
  const response = await fetch(`${API_BASE}${path}`, {
    cache: API_REQUEST_CACHE,
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': getCookie('csrftoken'),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await parseApiPayload<ApiPayload>(response)
    lastApiErrorSupport = payload.support ?? null
    throw new ApiError(
      payload.error || 'request_failed',
      errorMessage(payload, response.status),
      response.status,
      payload,
    )
  }
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const fallbackName = disposition.match(/filename="([^"]+)"/i)?.[1]
  let fileName = fallbackName ?? 'download'
  if (utf8Name) {
    try {
      fileName = decodeURIComponent(utf8Name)
    } catch {
      // Keep the ASCII fallback when a malformed header cannot be decoded.
    }
  }
  return { blob: await response.blob(), fileName }
}

function errorMessage(payload: { error?: string; messages?: string[] }, status: number): string {
  if (payload.messages?.length) {
    return payload.messages.join(' ')
  }
  return payload.error || `Request failed with ${status}`
}
