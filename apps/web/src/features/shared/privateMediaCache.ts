const MAX_CACHE_ENTRIES = 128
const MAX_CACHE_BYTES = 48 * 1024 * 1024

type CacheEntry = {
  promise: Promise<string>
  objectUrl: string | null
  byteSize: number
  lastUsed: number
}

const entries = new Map<string, CacheEntry>()

function trimCache() {
  const completed = Array.from(entries.entries())
    .filter(([, entry]) => entry.objectUrl !== null)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
  let totalBytes = completed.reduce((total, [, entry]) => total + entry.byteSize, 0)
  let totalEntries = completed.length

  for (const [source, entry] of completed) {
    if (totalEntries <= MAX_CACHE_ENTRIES && totalBytes <= MAX_CACHE_BYTES) break
    entries.delete(source)
    URL.revokeObjectURL(entry.objectUrl!)
    totalEntries -= 1
    totalBytes -= entry.byteSize
  }
}

export function cachedPrivateMediaUrl(source: string): string | null {
  const entry = entries.get(source)
  if (!entry?.objectUrl) return null
  entry.lastUsed = Date.now()
  return entry.objectUrl
}

export function loadPrivateMedia(source: string): Promise<string> {
  const existing = entries.get(source)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.promise
  }

  const entry: CacheEntry = {
    promise: Promise.resolve(''),
    objectUrl: null,
    byteSize: 0,
    lastUsed: Date.now(),
  }
  entry.promise = fetch(source, {
    credentials: 'include',
    cache: 'no-store',
  })
    .then((response) => {
      if (!response.ok) throw new Error(`private_media_${response.status}`)
      return response.blob()
    })
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob)
      if (entries.get(source) !== entry) {
        URL.revokeObjectURL(objectUrl)
        return source
      }
      entry.objectUrl = objectUrl
      entry.byteSize = blob.size
      entry.lastUsed = Date.now()
      trimCache()
      return objectUrl
    })
    .catch((error) => {
      if (entries.get(source) === entry) entries.delete(source)
      throw error
    })
  entries.set(source, entry)
  return entry.promise
}

export function clearPrivateMediaCache() {
  for (const entry of entries.values()) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl)
  }
  entries.clear()
}
