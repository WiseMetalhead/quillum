import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import * as Y from 'yjs'

import {
  candidateForUpdate,
  closeConnectionsForEpochChange,
  documentToJson,
  jsonToDocument,
  parseRoom,
  requestInternalJson,
} from '../src/collaboration.js'

test('room parser accepts only versioned document rooms', () => {
  assert.deepEqual(
    parseRoom('document:123e4567-e89b-12d3-a456-426614174000:3'),
    { documentId: '123e4567-e89b-12d3-a456-426614174000', epoch: 3 },
  )
  assert.throws(() => parseRoom('document:bad:3'), /collaboration_room_invalid/u)
})

test('internal requests use the public host and scheme over a loopback connection', async (t) => {
  let observed = null
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      observed = {
        host: request.headers.host,
        forwardedProto: request.headers['x-forwarded-proto'],
        secret: request.headers['x-quillum-collaboration-secret'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ context: { room: 'document:test:1' } }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const response = await requestInternalJson({
    url: `http://127.0.0.1:${address.port}/internal`,
    publicOrigin: 'https://quillum.example',
    secret: 'internal-secret',
    payload: { ticket: 'ticket', room: 'document:test:1' },
    timeoutMs: 1_000,
  })

  assert.equal(response.ok, true)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { context: { room: 'document:test:1' } })
  assert.deepEqual(observed, {
    host: 'quillum.example',
    forwardedProto: 'https',
    secret: 'internal-secret',
    body: { ticket: 'ticket', room: 'document:test:1' },
  })
})

test('headless schema preserves manuscript nodes and marks', () => {
  const content = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2, textAlign: 'center' },
        content: [{
          type: 'text',
          text: 'Chapter',
          marks: [
            { type: 'bold' },
            {
              type: 'annotationAnchor',
              attrs: { annotationId: '123e4567-e89b-12d3-a456-426614174001' },
            },
          ],
        }],
      },
      { type: 'sceneBreak' },
      {
        type: 'illustration',
        attrs: {
          assetId: '123e4567-e89b-12d3-a456-426614174000',
          alt: 'Alt',
          caption: 'Caption',
          alignment: 'center',
          displayWidth: 80,
        },
      },
    ],
  }
  const roundTrip = documentToJson(jsonToDocument(content))
  assert.equal(roundTrip.content[0].content[0].text, 'Chapter')
  assert.deepEqual(
    roundTrip.content[0].content[0].marks.map((mark) => mark.type),
    ['bold', 'annotationAnchor'],
  )
  assert.equal(roundTrip.content[0].content[0].marks[0].type, 'bold')
  assert.deepEqual(Object.keys(roundTrip.content[0].content[0].marks[0].attrs), [])
  assert.equal(
    roundTrip.content[0].content[0].marks[1].attrs.annotationId,
    '123e4567-e89b-12d3-a456-426614174001',
  )
  assert.equal(roundTrip.content[1].type, 'sceneBreak')
  assert.deepEqual(roundTrip.content[2].attrs, content.content[2].attrs)
})

test('candidate update is isolated from the active room document', () => {
  const active = jsonToDocument({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
  })
  const changed = jsonToDocument({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
  })
  const update = Y.encodeStateAsUpdate(changed, Y.encodeStateVector(active))
  const candidate = candidateForUpdate(active, update)
  assert.ok(candidate)
  assert.notDeepEqual(documentToJson(candidate.candidate), documentToJson(active))
  candidate.candidate.destroy()
  active.destroy()
  changed.destroy()
})

test('candidate update keeps delete-only changes with an unchanged state vector', () => {
  const active = new Y.Doc()
  active.getText('default').insert(0, 'before')
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(active))
  const serverVector = Y.encodeStateVector(active)
  client.getText('default').delete(0, 1)
  const deletion = Y.encodeStateAsUpdate(client, serverVector)

  assert.deepEqual(Y.encodeStateVector(client), serverVector)
  const candidate = candidateForUpdate(active, deletion)
  assert.ok(candidate)
  assert.equal(candidate.candidate.getText('default').toString(), 'efore')
  assert.equal(active.getText('default').toString(), 'before')

  candidate.candidate.destroy()
  active.destroy()
  client.destroy()
})

test('epoch changes close every connection with the stale-room reason', () => {
  const closeEvents = []
  const document = {
    getConnections() {
      return [
        { close: (event) => closeEvents.push(event) },
        { close: (event) => closeEvents.push(event) },
      ]
    },
  }

  closeConnectionsForEpochChange(document)

  assert.deepEqual(closeEvents, [
    { code: 4409, reason: 'collaboration_epoch_stale' },
    { code: 4409, reason: 'collaboration_epoch_stale' },
  ])
})
