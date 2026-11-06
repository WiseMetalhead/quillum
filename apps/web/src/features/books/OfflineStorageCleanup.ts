const RETIRED_DATABASES = [
  'quillum-offline-documents',
  'quillum-offline-glossary',
  'quillum-spellcheck-lexicons',
]

function deleteRetiredDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

export const retiredOfflineStorageCleanup = Promise.all(
  RETIRED_DATABASES.map(deleteRetiredDatabase),
).then(() => undefined)
