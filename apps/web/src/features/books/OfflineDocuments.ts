import type { JSONContent } from '@tiptap/core'

import { retiredOfflineStorageCleanup } from './OfflineStorageCleanup'

const DATABASE_NAME = 'quillum-offline-documents-plaintext'
const DATABASE_VERSION = 1
const DOCUMENT_STORE = 'documents'

export type OfflineDocument = {
  key: string
  userId: number
  manuscriptId: string
  documentId?: string | null
  schemaVersion: number
  content: JSONContent
  localRevision: number
  confirmedGeneration: number
  lastAttemptHash: string | null
  updatedAt: string
}

export type EditorConnectionState =
  | 'online'
  | 'offline'
  | 'syncing'
  | 'conflict'
  | 'local-error'

function documentKey(userId: number, manuscriptId: string, documentId?: string | null) {
  return documentId ? `${userId}:${manuscriptId}:${documentId}` : `${userId}:${manuscriptId}`
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
      if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
        database.createObjectStore(DOCUMENT_STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('offline_storage_failed'))
    request.onblocked = () => reject(new Error('offline_storage_failed'))
  })
}

export async function contentHash(content: JSONContent): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(content))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export async function getOfflineDocument(
  userId: number,
  manuscriptId: string,
  documentId?: string | null,
): Promise<OfflineDocument | null> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(DOCUMENT_STORE, 'readonly')
    const complete = transactionComplete(transaction)
    const stored = await requestResult(
      transaction.objectStore(DOCUMENT_STORE).get(
        documentKey(userId, manuscriptId, documentId),
      ) as IDBRequest<OfflineDocument | undefined>,
    )
    await complete
    return stored ?? null
  } finally {
    database.close()
  }
}

export async function putOfflineDocument(document: OfflineDocument): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(DOCUMENT_STORE, 'readwrite')
    const complete = transactionComplete(transaction)
    transaction.objectStore(DOCUMENT_STORE).put(document)
    await complete
  } finally {
    database.close()
  }
}

export async function deleteOfflineDocument(
  userId: number,
  manuscriptId: string,
  documentId?: string | null,
): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(DOCUMENT_STORE, 'readwrite')
    const complete = transactionComplete(transaction)
    transaction.objectStore(DOCUMENT_STORE).delete(documentKey(userId, manuscriptId, documentId))
    await complete
  } finally {
    database.close()
  }
}

export function createOfflineDocument(
  userId: number,
  manuscriptId: string,
  documentId: string | null,
  schemaVersion: number,
  content: JSONContent,
  localRevision: number,
  confirmedGeneration: number,
  lastAttemptHash: string | null = null,
): OfflineDocument {
  return {
    key: documentKey(userId, manuscriptId, documentId),
    userId,
    manuscriptId,
    documentId,
    schemaVersion,
    content,
    localRevision,
    confirmedGeneration,
    lastAttemptHash,
    updatedAt: new Date().toISOString(),
  }
}
