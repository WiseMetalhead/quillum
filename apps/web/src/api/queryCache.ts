export type QueryCacheOptions<T> = {
  maxAgeMs?: number
  staleWhileRevalidateMs?: number
  onBackgroundUpdate?: (value: T) => void
}

type QueryEntry = {
  hasValue: boolean
  value: unknown
  updatedAt: number
  lastUsed: number
  promise: Promise<unknown> | null
  controller: AbortController | null
}

const DEFAULT_MAX_AGE_MS = 15_000
const DEFAULT_STALE_WHILE_REVALIDATE_MS = 90_000

export function shouldInvalidateQueryCache(
  method: string | undefined,
  invalidateQueryCache = true,
): boolean {
  return invalidateQueryCache && (method ?? 'GET').toUpperCase() !== 'GET'
}

export class QueryCache {
  private readonly entries = new Map<string, QueryEntry>()
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(maxEntries = 64, now: () => number = Date.now) {
    this.maxEntries = maxEntries
    this.now = now
  }

  query<T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    options: QueryCacheOptions<T> = {},
  ): Promise<T> {
    const now = this.now()
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    const staleWhileRevalidateMs = (
      options.staleWhileRevalidateMs ?? DEFAULT_STALE_WHILE_REVALIDATE_MS
    )
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        hasValue: false,
        value: undefined,
        updatedAt: 0,
        lastUsed: now,
        promise: null,
        controller: null,
      }
      this.entries.set(key, entry)
    }
    entry.lastUsed = now

    if (entry.hasValue) {
      const age = now - entry.updatedAt
      if (age <= maxAgeMs) return Promise.resolve(entry.value as T)
      if (age <= maxAgeMs + staleWhileRevalidateMs) {
        const refresh = this.load(key, entry, load)
        if (options.onBackgroundUpdate) {
          void refresh.then(options.onBackgroundUpdate).catch(() => undefined)
        } else {
          void refresh.catch(() => undefined)
        }
        return Promise.resolve(entry.value as T)
      }
    }

    return this.load(key, entry, load)
  }

  clear() {
    for (const entry of this.entries.values()) entry.controller?.abort()
    this.entries.clear()
  }

  invalidate(prefix = '') {
    for (const [key, entry] of this.entries) {
      if (!prefix || key.startsWith(prefix)) {
        entry.controller?.abort()
        this.entries.delete(key)
      }
    }
  }

  private load<T>(
    key: string,
    entry: QueryEntry,
    load: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (entry.promise) return entry.promise as Promise<T>
    const controller = new AbortController()
    entry.controller = controller
    const promise = load(controller.signal)
      .then((value) => {
        if (this.entries.get(key) === entry) {
          entry.hasValue = true
          entry.value = value
          entry.updatedAt = this.now()
          entry.lastUsed = entry.updatedAt
          entry.promise = null
          entry.controller = null
          this.trim()
        }
        return value
      })
      .catch((error: unknown) => {
        if (this.entries.get(key) === entry) {
          entry.promise = null
          entry.controller = null
          if (!entry.hasValue) this.entries.delete(key)
        }
        throw error
      })
    entry.promise = promise
    return promise
  }

  private trim() {
    const completed = Array.from(this.entries.entries())
      .filter(([, entry]) => entry.promise === null)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
    for (const [key] of completed) {
      if (this.entries.size <= this.maxEntries) break
      this.entries.delete(key)
    }
  }
}
