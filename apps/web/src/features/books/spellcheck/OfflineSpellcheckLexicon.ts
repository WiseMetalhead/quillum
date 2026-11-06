import { retiredOfflineStorageCleanup } from '../OfflineStorageCleanup'
import type { SpellcheckLexicon } from './SpellcheckTypes'

const DATABASE_NAME = 'quillum-spellcheck-lexicons-plaintext'
const DATABASE_VERSION = 1
const LEXICON_STORE = 'lexicons'

type StoredLexicon = {
  key: string
  userId: number
  manuscriptId: string
  scopeType: SpellcheckLexicon['scope']['type']
  scopeId: string
  revision: string
  updatedAt: string
  lexicon: SpellcheckLexicon
}

function lexiconKey(userId: number, manuscriptId: string) {
  return `${userId}:${manuscriptId}`
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('spellcheck_cache_failed'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('spellcheck_cache_failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('spellcheck_cache_failed'))
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  await retiredOfflineStorageCleanup
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(LEXICON_STORE)) {
        database.createObjectStore(LEXICON_STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('spellcheck_cache_failed'))
    request.onblocked = () => reject(new Error('spellcheck_cache_failed'))
  })
}

export async function getCachedSpellcheckLexicon(userId: number, manuscriptId: string) {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(LEXICON_STORE, 'readonly')
    const complete = transactionComplete(transaction)
    const stored = await requestResult(
      transaction.objectStore(LEXICON_STORE).get(
        lexiconKey(userId, manuscriptId),
      ) as IDBRequest<StoredLexicon | undefined>,
    )
    await complete
    return stored?.lexicon ?? null
  } finally {
    database.close()
  }
}

export async function putCachedSpellcheckLexicon(
  userId: number,
  manuscriptId: string,
  lexicon: SpellcheckLexicon,
) {
  const database = await openDatabase()
  try {
    const stored: StoredLexicon = {
      key: lexiconKey(userId, manuscriptId),
      userId,
      manuscriptId,
      scopeType: lexicon.scope.type,
      scopeId: lexicon.scope.id,
      revision: lexicon.revision,
      updatedAt: new Date().toISOString(),
      lexicon,
    }
    const transaction = database.transaction(LEXICON_STORE, 'readwrite')
    const complete = transactionComplete(transaction)
    transaction.objectStore(LEXICON_STORE).put(stored)
    await complete
  } finally {
    database.close()
  }
}
