import type { JSONContent } from '@tiptap/core'

import { retiredOfflineStorageCleanup } from './OfflineStorageCleanup'

const DATABASE_NAME = 'quillum-offline-glossary-plaintext'
const DATABASE_VERSION = 1
const ARTICLE_STORE = 'articles'

export type OfflineGlossaryArticle = {
  key: string
  userId: number
  manuscriptId: string
  articleId: string
  schemaVersion: number
  title: string
  synopsis: string
  content: JSONContent
  localRevision: number
  confirmedGeneration: number
  updatedAt: string
}

function articleKey(userId: number, manuscriptId: string, articleId: string) {
  return `${userId}:${manuscriptId}:${articleId}`
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('offline_storage_failed'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('offline_storage_failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('offline_storage_failed'))
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  await retiredOfflineStorageCleanup
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(ARTICLE_STORE)) {
        database.createObjectStore(ARTICLE_STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('offline_storage_failed'))
    request.onblocked = () => reject(new Error('offline_storage_failed'))
  })
}

export async function getOfflineGlossaryArticle(
  userId: number,
  manuscriptId: string,
  articleId: string,
): Promise<OfflineGlossaryArticle | null> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(ARTICLE_STORE, 'readonly')
    const complete = transactionComplete(transaction)
    const stored = await requestResult(
      transaction.objectStore(ARTICLE_STORE).get(
        articleKey(userId, manuscriptId, articleId),
      ) as IDBRequest<OfflineGlossaryArticle | undefined>,
    )
    await complete
    return stored ?? null
  } finally {
    database.close()
  }
}

export async function putOfflineGlossaryArticle(
  article: OfflineGlossaryArticle,
): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(ARTICLE_STORE, 'readwrite')
    const complete = transactionComplete(transaction)
    transaction.objectStore(ARTICLE_STORE).put(article)
    await complete
  } finally {
    database.close()
  }
}

export async function deleteOfflineGlossaryArticle(
  userId: number,
  manuscriptId: string,
  articleId: string,
): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(ARTICLE_STORE, 'readwrite')
    const complete = transactionComplete(transaction)
    transaction.objectStore(ARTICLE_STORE).delete(articleKey(userId, manuscriptId, articleId))
    await complete
  } finally {
    database.close()
  }
}

export function createOfflineGlossaryArticle(
  userId: number,
  manuscriptId: string,
  articleId: string,
  schemaVersion: number,
  title: string,
  synopsis: string,
  content: JSONContent,
  localRevision: number,
  confirmedGeneration: number,
): OfflineGlossaryArticle {
  return {
    key: articleKey(userId, manuscriptId, articleId),
    userId,
    manuscriptId,
    articleId,
    schemaVersion,
    title,
    synopsis,
    content,
    localRevision,
    confirmedGeneration,
    updatedAt: new Date().toISOString(),
  }
}
