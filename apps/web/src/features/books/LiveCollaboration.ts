import { useEffect, useRef, useState } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { apiRequest } from '../../api/client'
import type { EditorConnectionState } from './OfflineDocuments'
import type { EditorDocument } from './ManuscriptEditorPage'

export type CollaborationIdentity = {
  id: string
  name: string
  color: string
}

type CollaborationTicket = {
  ticket: string
  room: string
  epoch: number
  url: string
  user: CollaborationIdentity
  expiresIn: number
}

type UseLiveCollaborationOptions = {
  enabled: boolean
  userId: number
  document: EditorDocument
  persistent: boolean
  ticketEndpoint: string
  onConnectionState: (state: EditorConnectionState) => void
  onSaveStatus: (status: 'saved' | 'dirty' | 'saving' | 'offline' | 'error') => void
  onError: (error: string) => void
  onAccessLost?: () => void
  onAnnotationsChanged: () => void
  onEpochStale: (hasUnsyncedChanges: boolean) => void
}

type LiveCollaborationSession = {
  ydoc: Y.Doc | null
  provider: HocuspocusProvider | null
  identity: CollaborationIdentity | null
  ready: boolean
}

type LiveCollaborationSessionState = LiveCollaborationSession & {
  key: string | null
}

export function useLiveCollaboration({
  enabled,
  userId,
  document,
  persistent,
  ticketEndpoint,
  onConnectionState,
  onSaveStatus,
  onError,
  onAccessLost,
  onAnnotationsChanged,
  onEpochStale,
}: UseLiveCollaborationOptions): LiveCollaborationSession {
  const sessionKey = `${document.id}:${document.collaborationEpoch ?? 'legacy'}`
  const [session, setSession] = useState<LiveCollaborationSessionState>({
    ydoc: null,
    provider: null,
    identity: null,
    ready: !enabled,
    key: null,
  })
  const callbacksRef = useRef({
    onConnectionState,
    onSaveStatus,
    onError,
    onAccessLost,
    onAnnotationsChanged,
    onEpochStale,
  })

  useEffect(() => {
    callbacksRef.current = {
      onConnectionState,
      onSaveStatus,
      onError,
      onAccessLost,
      onAnnotationsChanged,
      onEpochStale,
    }
  }, [onAccessLost, onAnnotationsChanged, onConnectionState, onEpochStale, onError, onSaveStatus])

  useEffect(() => {
    if (!enabled) {
      return
    }
    if (!document.collaborationRoom || !document.collaborationEpoch) {
      callbacksRef.current.onConnectionState('local-error')
      callbacksRef.current.onSaveStatus('error')
      callbacksRef.current.onError('collaboration_unavailable')
      return
    }

    let active = true
    let provider: HocuspocusProvider | null = null
    let indexeddb: IndexeddbPersistence | null = null
    let transportConnected = false
    let epochStaleHandled = false
    const ydoc = new Y.Doc()
    const expectedRoom = document.collaborationRoom
    callbacksRef.current.onConnectionState('syncing')
    callbacksRef.current.onSaveStatus('saving')

    function enterOfflineMode() {
      if (!active || epochStaleHandled) return
      transportConnected = false
      provider?.disconnect()
      callbacksRef.current.onConnectionState('offline')
      callbacksRef.current.onSaveStatus('offline')
    }

    function reconnectOnline() {
      if (!active || epochStaleHandled || !provider) return
      transportConnected = false
      callbacksRef.current.onConnectionState('syncing')
      callbacksRef.current.onSaveStatus(
        provider.hasUnsyncedChanges ? 'saving' : 'saved',
      )
      void provider.connect()
    }

    function handleEpochStale() {
      if (!active || epochStaleHandled) return
      epochStaleHandled = true
      transportConnected = false
      const hasUnsyncedChanges = provider?.hasUnsyncedChanges ?? false
      provider?.disconnect()
      callbacksRef.current.onEpochStale(hasUnsyncedChanges)
    }

    window.addEventListener('offline', enterOfflineMode)
    window.addEventListener('online', reconnectOnline)

    async function requestTicket() {
      const payload = await apiRequest<{ collaboration: CollaborationTicket }>(ticketEndpoint, {
        method: 'POST',
        invalidateQueryCache: false,
        body: JSON.stringify({
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      })
      if (payload.collaboration.room !== expectedRoom) {
        handleEpochStale()
        throw new Error('collaboration_epoch_stale')
      }
      return payload.collaboration
    }

    async function initialize() {
      if (persistent) {
        indexeddb = new IndexeddbPersistence(
          `quillum-collaboration:${userId}:${document.id}:${document.collaborationEpoch}`,
          ydoc,
        )
        await indexeddb.whenSynced
      }
      const initialTicket = await requestTicket()
      if (!active) return
      let pendingTicket: CollaborationTicket | null = initialTicket
      provider = new HocuspocusProvider({
        url: initialTicket.url,
        name: expectedRoom,
        document: ydoc,
        flushDelay: 50,
        token: async () => {
          if (pendingTicket) {
            const ticket = pendingTicket.ticket
            pendingTicket = null
            return ticket
          }
          return (await requestTicket()).ticket
        },
        onStatus: ({ status }) => {
          if (!active || epochStaleHandled) return
          if (status === 'connected') {
            transportConnected = true
            callbacksRef.current.onConnectionState('syncing')
          } else if (status === 'disconnected') {
            transportConnected = false
            callbacksRef.current.onConnectionState('offline')
            callbacksRef.current.onSaveStatus('offline')
          }
        },
        onSynced: ({ state }) => {
          if (!active || epochStaleHandled || !state || !provider) return
          transportConnected = true
          callbacksRef.current.onConnectionState('online')
          callbacksRef.current.onSaveStatus(
            provider.hasUnsyncedChanges ? 'saving' : 'saved',
          )
          setSession({
            ydoc,
            provider,
            identity: initialTicket.user,
            ready: true,
            key: sessionKey,
          })
        },
        onUnsyncedChanges: ({ number }) => {
          if (!active || epochStaleHandled) return
          callbacksRef.current.onSaveStatus(
            transportConnected ? number > 0 ? 'saving' : 'saved' : 'offline',
          )
        },
        onAuthenticationFailed: ({ reason }) => {
          if (!active) return
          if (reason === 'collaboration_access_revoked') {
            callbacksRef.current.onAccessLost?.()
            return
          }
          if (reason === 'collaboration_epoch_stale') {
            handleEpochStale()
            return
          }
          callbacksRef.current.onConnectionState('local-error')
          callbacksRef.current.onSaveStatus('error')
          callbacksRef.current.onError(reason || 'collaboration_unavailable')
        },
        onClose: ({ event }) => {
          if (!active) return
          if (event.reason === 'collaboration_access_revoked') {
            callbacksRef.current.onAccessLost?.()
          } else if (event.reason === 'collaboration_epoch_stale') {
            handleEpochStale()
          } else if (event.code === 1011) {
            provider?.disconnect()
            callbacksRef.current.onConnectionState('local-error')
            callbacksRef.current.onSaveStatus('error')
            callbacksRef.current.onError('collaboration_update_rejected')
          }
        },
        onStateless: ({ payload }) => {
          if (!active) return
          try {
            if (JSON.parse(payload).type === 'annotations.changed') {
              callbacksRef.current.onAnnotationsChanged()
            }
          } catch {
            // Ignore unknown server events; they never contain document content.
          }
        },
      })
      if (!navigator.onLine) enterOfflineMode()
      setSession({
        ydoc,
        provider,
        identity: initialTicket.user,
        ready: false,
        key: sessionKey,
      })
    }

    void initialize().catch((error) => {
      if (!active) return
      const code = error instanceof Error ? error.message : 'collaboration_unavailable'
      if (code === 'collaboration_epoch_stale') return
      callbacksRef.current.onConnectionState('local-error')
      callbacksRef.current.onSaveStatus('error')
      callbacksRef.current.onError(code)
    })

    return () => {
      active = false
      window.removeEventListener('offline', enterOfflineMode)
      window.removeEventListener('online', reconnectOnline)
      provider?.destroy()
      void indexeddb?.destroy()
      ydoc.destroy()
    }
  }, [document.collaborationEpoch, document.collaborationRoom, document.id, enabled, persistent, sessionKey, ticketEndpoint, userId])

  return enabled
    ? session.key === sessionKey
      ? session
      : { ydoc: null, provider: null, identity: null, ready: false }
    : { ydoc: null, provider: null, identity: null, ready: true }
}

export async function waitForCollaborationSync(provider: HocuspocusProvider) {
  provider.flushPendingUpdates()
  provider.forceSync()
  const deadline = Date.now() + 5_000
  while (provider.hasUnsyncedChanges && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 25))
  }
  if (provider.hasUnsyncedChanges) throw new Error('collaboration_sync_timeout')
}
