import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Server } from '@hocuspocus/server'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { createClient } from 'redis'
import * as Y from 'yjs'
import { createHeadlessEditorExtensions } from '@quillum/editor-schema'

const CONTROL_CHANNEL = 'quillum:collaboration:control:v1'
const FIELD_NAME = 'default'
const MAX_UPDATE_BYTES = 2 * 1024 * 1024
const MAX_STATE_BYTES = 20 * 1024 * 1024
const EPOCH_STALE_CLOSE_EVENT = Object.freeze({
  code: 4409,
  reason: 'collaboration_epoch_stale',
})

export class CollaborationServiceError extends Error {
  constructor(reason, status = 500) {
    super(reason)
    this.reason = reason
    this.status = status
    this.code = status === 403 || status === 404
      ? 4403
      : status === 409
        ? 4409
        : 1011
  }
}

export function parseRoom(room) {
  const match = /^document:([0-9a-f-]{36}):(\d+)$/iu.exec(room)
  if (!match) throw new CollaborationServiceError('collaboration_room_invalid', 400)
  const epoch = Number(match[2])
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new CollaborationServiceError('collaboration_room_invalid', 400)
  }
  return { documentId: match[1], epoch }
}

export function documentToJson(document) {
  return TiptapTransformer.fromYdoc(document, FIELD_NAME)
}

export function jsonToDocument(content) {
  return TiptapTransformer.toYdoc(
    content,
    FIELD_NAME,
    createHeadlessEditorExtensions(),
  )
}

function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right))
}

export function candidateForUpdate(document, update) {
  if (!(update instanceof Uint8Array) || update.byteLength > MAX_UPDATE_BYTES) {
    throw new CollaborationServiceError('collaboration_update_invalid', 400)
  }
  const candidate = new Y.Doc()
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
  const beforeState = Y.encodeStateAsUpdate(candidate)
  const beforeVector = Y.encodeStateVector(candidate)
  Y.applyUpdate(candidate, update)
  const state = Y.encodeStateAsUpdate(candidate)
  // A pure Yjs deletion changes the DeleteSet without advancing the state vector.
  // Comparing full states keeps delete-only text and mark updates on the durable path.
  if (sameBytes(beforeState, state)) {
    candidate.destroy()
    return null
  }
  const incremental = Y.encodeStateAsUpdate(candidate, beforeVector)
  if (state.byteLength > MAX_STATE_BYTES) {
    candidate.destroy()
    throw new CollaborationServiceError('collaboration_state_invalid', 400)
  }
  return { candidate, incremental, state }
}

export function closeConnectionsForEpochChange(document) {
  for (const connection of document.getConnections()) {
    connection.close(EPOCH_STALE_CLOSE_EVENT)
  }
}

async function secretFromEnvironment(environment) {
  if (environment.QUILLUM_COLLABORATION_INTERNAL_SECRET) {
    return environment.QUILLUM_COLLABORATION_INTERNAL_SECRET.trim()
  }
  const path = environment.QUILLUM_COLLABORATION_INTERNAL_SECRET_FILE
  if (path) return (await readFile(path, 'utf8')).trim()
  if ((environment.QUILLUM_ENVIRONMENT ?? 'development') !== 'production') {
    return 'dev-collaboration-secret'
  }
  throw new Error('QUILLUM_COLLABORATION_INTERNAL_SECRET is required')
}

function normalizedOrigin(value) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

function allowedOrigins(environment) {
  const configured = (environment.QUILLUM_COLLABORATION_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => normalizedOrigin(value.trim()))
    .filter(Boolean)
  const publicOrigin = normalizedOrigin(environment.QUILLUM_PUBLIC_ORIGIN ?? '')
  if (publicOrigin) configured.push(publicOrigin)
  if ((environment.QUILLUM_ENVIRONMENT ?? 'development') !== 'production') {
    configured.push('http://localhost:5173', 'http://127.0.0.1:5173')
  }
  return new Set(configured)
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'collaboration',
    event,
    ...fields,
  })}\n`)
}

export function requestInternalJson({ url, publicOrigin, secret, payload, timeoutMs }) {
  const target = new URL(url)
  const external = new URL(publicOrigin)
  const transport = target.protocol === 'http:'
    ? httpRequest
    : target.protocol === 'https:'
      ? httpsRequest
      : null
  if (!transport) {
    return Promise.reject(new Error('Unsupported collaboration API protocol'))
  }
  const requestBody = Buffer.from(JSON.stringify(payload))

  return new Promise((resolve, reject) => {
    const request = transport(target, {
      method: 'POST',
      headers: {
        Host: external.host,
        'X-Forwarded-Proto': external.protocol.slice(0, -1),
        'Content-Type': 'application/json',
        'Content-Length': requestBody.byteLength,
        'X-Quillum-Collaboration-Secret': secret,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          // The caller maps malformed internal responses to a stable service error.
        }
        const status = response.statusCode ?? 500
        resolve({
          ok: status >= 200 && status < 300,
          status,
          body,
        })
      })
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('collaboration_internal_request_timeout'))
    })
    request.on('error', reject)
    request.end(requestBody)
  })
}

export async function createCollaborationServer(environment = process.env) {
  const secret = await secretFromEnvironment(environment)
  if (!secret) throw new Error('Empty collaboration internal secret')
  const apiOrigin = (
    environment.QUILLUM_COLLABORATION_API_ORIGIN ?? 'http://127.0.0.1:8000'
  ).replace(/\/$/u, '')
  const publicOrigin = normalizedOrigin(
    environment.QUILLUM_PUBLIC_ORIGIN ?? 'http://localhost:5173',
  )
  if (!publicOrigin) throw new Error('Invalid collaboration public origin')
  const origins = allowedOrigins(environment)
  const expectedPath = environment.QUILLUM_COLLABORATION_PUBLIC_PATH ?? '/collaboration/ws'
  const timeoutMs = Number(environment.QUILLUM_COLLABORATION_API_TIMEOUT_MS ?? 5000)
  const documentMutationQueues = new Map()

  async function serializeDocumentMutation(documentName, callback) {
    const previous = documentMutationQueues.get(documentName) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(callback)
    documentMutationQueues.set(documentName, operation)
    try {
      return await operation
    } finally {
      if (documentMutationQueues.get(documentName) === operation) {
        documentMutationQueues.delete(documentName)
      }
    }
  }

  async function internalRequest(path, payload, attempts = 3) {
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await requestInternalJson({
          url: `${apiOrigin}/api/internal/collaboration/${path}`,
          publicOrigin,
          secret,
          payload,
          timeoutMs,
        })
        const body = response.body
        if (response.ok) return body
        const reason = typeof body.error === 'string'
          ? body.error
          : 'collaboration_internal_request_failed'
        const error = new CollaborationServiceError(reason, response.status)
        if (response.status < 500 || attempt === attempts) throw error
        lastError = error
      } catch (error) {
        lastError = error
        if (error instanceof CollaborationServiceError && error.status < 500) throw error
        if (attempt === attempts) break
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
    throw lastError instanceof Error
      ? lastError
      : new CollaborationServiceError('collaboration_internal_request_failed')
  }

  const server = new Server({
    name: 'quillum',
    address: environment.QUILLUM_COLLABORATION_BIND ?? '127.0.0.1',
    port: Number(environment.QUILLUM_COLLABORATION_PORT ?? 8003),
    quiet: true,
    timeout: 30_000,
    debounce: 500,
    maxDebounce: 2_000,
    unloadImmediately: true,
    flushDelay: 0,
    maxUnauthenticatedQueueSize: MAX_UPDATE_BYTES,
    maxUnauthenticatedQueueMessages: 32,
    maxPendingDocuments: 1,
    websocketOptions: {
      maxPayload: MAX_UPDATE_BYTES,
      maxFragments: 64,
      maxBufferedChunks: 64,
    },

    async onUpgrade({ request }) {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost')
      const origin = request.headers?.origin ?? request.headers?.get?.('origin') ?? ''
      if (requestUrl.pathname !== expectedPath || !origins.has(normalizedOrigin(origin))) {
        throw new CollaborationServiceError('collaboration_origin_forbidden', 403)
      }
    },

    async onAuthenticate({ documentName, token }) {
      const response = await internalRequest('tickets/consume/', {
        ticket: token,
        room: documentName,
      }, 1)
      const context = response.context
      if (!context || context.room !== documentName) {
        throw new CollaborationServiceError('collaboration_ticket_invalid', 403)
      }
      context.awarenessClientIds = []
      return context
    },

    async onLoadDocument({ documentName }) {
      const { documentId, epoch } = parseRoom(documentName)
      const response = await internalRequest('documents/load/', { documentId, epoch })
      const stored = response.collaboration
      if (!stored || stored.epoch !== epoch) {
        throw new CollaborationServiceError('collaboration_epoch_stale', 409)
      }
      let loaded
      try {
        if (stored.snapshot) {
          loaded = new Y.Doc()
          Y.applyUpdate(loaded, Buffer.from(stored.snapshot, 'base64'))
        } else {
          loaded = jsonToDocument(stored.content)
        }
        for (const item of stored.updates ?? []) {
          Y.applyUpdate(loaded, Buffer.from(item.data, 'base64'))
        }
        if (!stored.snapshot) {
          const initialized = await internalRequest('documents/initialize/', {
            documentId,
            epoch,
            state: Buffer.from(Y.encodeStateAsUpdate(loaded)).toString('base64'),
          })
          loaded.destroy()
          loaded = new Y.Doc()
          Y.applyUpdate(
            loaded,
            Buffer.from(initialized.collaboration.snapshot, 'base64'),
          )
        }
      } catch {
        loaded?.destroy()
        await internalRequest('documents/fail/', {
          documentId,
          epoch,
          code: 'ydoc_load_failed',
        }, 1).catch(() => undefined)
        throw new CollaborationServiceError('collaboration_materialization_failed', 503)
      }
      log('document.loaded', {
        documentId,
        epoch,
        sequence: stored.latestSequence,
      })
      return loaded
    },

    async beforeSync({ type, payload, document, documentName, context, connection }) {
      if (type !== 1 && type !== 2) return
      await serializeDocumentMutation(documentName, async () => {
        const candidate = candidateForUpdate(document, payload)
        if (!candidate) return
        const { documentId, epoch } = parseRoom(documentName)
        const startedAt = performance.now()
        const updateId = crypto.randomUUID()
        try {
          const content = documentToJson(candidate.candidate)
          const response = await internalRequest('documents/commit/', {
            documentId,
            epoch,
            updateId,
            update: Buffer.from(candidate.incremental).toString('base64'),
            state: Buffer.from(candidate.state).toString('base64'),
            content,
            actorId: context.userId,
            role: context.role,
            timezone: context.timezone,
          })
          // Apply only after the durable commit. Hocuspocus will apply the same update again
          // after this hook, which is idempotent; doing it here keeps concurrent clients from
          // building their durable candidates from the same stale document state.
          Y.applyUpdate(document, candidate.incremental, {
            source: 'connection',
            connection,
          })
          log('update.committed', {
            documentId,
            epoch,
            sequence: response.commit?.sequence,
            actorId: context.userId,
            role: context.role,
            latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
          })
        } finally {
          candidate.candidate.destroy()
        }
      })
    },

    async beforeHandleAwareness({ states, removedClients, context }) {
      if (!context) throw new CollaborationServiceError('collaboration_access_revoked', 403)
      const owned = new Set(context.awarenessClientIds ?? [])
      for (const [clientId, state] of states) {
        if (!owned.has(clientId) && owned.size >= 1) {
          states.delete(clientId)
          continue
        }
        owned.add(clientId)
        const cursor = state && typeof state.cursor === 'object' ? state.cursor : null
        states.set(clientId, {
          user: context.identity,
          ...(cursor ? { cursor } : {}),
        })
      }
      for (const clientId of [...removedClients]) {
        if (!owned.has(clientId)) removedClients.delete(clientId)
      }
      context.awarenessClientIds = [...owned]
    },

    async onStateless({ connection, payload }) {
      if (payload !== 'flush') return
      connection.sendStateless(JSON.stringify({ type: 'flush.ack' }))
    },

    async onRequest({ request, response, instance }) {
      if (request.url === '/healthz') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({
          status: 'ok',
          documents: instance.getDocumentsCount(),
          connections: instance.getConnectionsCount(),
        }))
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: 'not_found' }))
      }
      throw null
    },

    async onConnect({ documentName, socketId }) {
      const { documentId, epoch } = parseRoom(documentName)
      log('connection.opened', { documentId, epoch, socketId })
    },

    async onDisconnect({ documentName, context, socketId }) {
      const { documentId, epoch } = parseRoom(documentName)
      log('connection.closed', {
        documentId,
        epoch,
        socketId,
        actorId: context?.userId,
      })
    },
  })

  let subscriber = null
  const redisUrl = environment.REDIS_URL
  if (redisUrl) {
    subscriber = createClient({ url: redisUrl })
    subscriber.on('error', (error) => {
      log('redis.error', { error: error?.constructor?.name ?? 'Error' })
    })
    await subscriber.connect()
    await subscriber.subscribe(CONTROL_CHANNEL, (message) => {
      let event
      try {
        event = JSON.parse(message)
      } catch {
        return
      }
      for (const [room, document] of server.hocuspocus.documents.entries()) {
        const parsed = parseRoom(room)
        if (event.type === 'annotations.changed' && parsed.documentId === event.documentId) {
          document.broadcastStateless(JSON.stringify({ type: event.type }))
        } else if (event.type === 'epoch.changed' && parsed.documentId === event.documentId) {
          closeConnectionsForEpochChange(document)
        } else if (event.type === 'access.revoked') {
          for (const connection of document.getConnections()) {
            if (
              connection.context?.manuscriptId === event.manuscriptId
              && connection.context?.userId === event.userId
            ) {
              connection.close({ code: 4403, reason: 'collaboration_access_revoked' })
            }
          }
        }
      }
    })
  }

  return {
    server,
    async destroy() {
      if (subscriber) await subscriber.quit()
      await server.destroy()
    },
  }
}
