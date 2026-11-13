import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { illustrationProjection } from '../src/features/books/IllustrationProjection.ts'

const repositoryRoot = new URL('../../../', import.meta.url)

async function read(path: string) {
  return readFile(fileURLToPath(new URL(path, repositoryRoot)), 'utf8')
}

test('live collaboration stays server-selected and durable before broadcast', async () => {
  const [django, service, editor, liveClient] = await Promise.all([
    read('apps/api/apps/manuscripts/collaboration.py'),
    read('apps/collaboration/src/collaboration.js'),
    read('apps/web/src/features/books/DocumentEditor.tsx'),
    read('apps/web/src/features/books/LiveCollaboration.ts'),
  ])

  assert.ok(django.includes('if mode == "pilot":'))
  assert.ok(django.includes('"syncMode": "collaborative" if collaborative else "legacy"'))
  assert.ok(editor.includes("initialDocument.syncMode === 'collaborative'"))
  assert.ok(editor.includes('persistent: !registeredEditor'))
  assert.ok(editor.includes("extension.name === (collaborative ? 'collaboration' : 'undoRedo')"))
  assert.ok(editor.includes('if (!historyCommandsReady) return'))
  assert.ok(liveClient.includes('new IndexeddbPersistence('))
  assert.ok(liveClient.includes('new HocuspocusProvider({'))
  assert.ok(liveClient.includes("event.code === 1011"))
  assert.ok(liveClient.includes("onError('collaboration_update_rejected')"))
  assert.ok(liveClient.includes("window.addEventListener('offline', enterOfflineMode)"))
  assert.ok(liveClient.includes('provider?.disconnect()'))
  assert.ok(liveClient.includes("window.addEventListener('online', reconnectOnline)"))
  assert.ok(liveClient.includes('void provider.connect()'))
  assert.ok(liveClient.includes('transportConnected ? number > 0'))
  assert.ok(liveClient.includes('provider?.disconnect()'))
  assert.ok(liveClient.includes('epochStaleHandled = true'))
  assert.ok(editor.includes("connectionStateRef.current === 'offline'"))
  assert.ok(service.includes("internalRequest('documents/initialize/'"))
  assert.ok(service.includes("reason: 'collaboration_epoch_stale'"))
  assert.ok(service.includes('closeConnectionsForEpochChange(document)'))

  const commit = service.indexOf("internalRequest('documents/commit/'")
  const apply = service.indexOf('Y.applyUpdate(document, candidate.incremental')
  assert.notEqual(commit, -1)
  assert.notEqual(apply, -1)
  assert.ok(commit < apply, 'the active room must update only after Django commits')
})

test('illustration conflict checks ignore JSON attribute insertion order', () => {
  const local = {
    type: 'doc',
    content: [{
      type: 'illustration',
      attrs: {
        assetId: 'asset-1',
        alt: 'Alt',
        caption: 'Caption',
        alignment: 'center',
        displayWidth: 43,
      },
    }],
  }
  const server = {
    type: 'doc',
    content: [{
      type: 'illustration',
      attrs: {
        alt: 'Alt',
        assetId: 'asset-1',
        caption: 'Caption',
        alignment: 'center',
        displayWidth: 43,
      },
    }],
  }

  assert.deepEqual(illustrationProjection(local), illustrationProjection(server))
  server.content[0].attrs.displayWidth = 80
  assert.notDeepEqual(illustrationProjection(local), illustrationProjection(server))
})

test('presence labels cannot capture the local text caret', async () => {
  const [editor, styles] = await Promise.all([
    read('apps/web/src/features/books/DocumentEditor.tsx'),
    read('apps/web/src/features/books/DocumentEditor.css'),
  ])

  assert.ok(editor.includes("const COLLABORATION_CARET_GUARD = '\\u2060'"))
  assert.equal(
    editor.match(/document\.createTextNode\(COLLABORATION_CARET_GUARD\)/g)?.length,
    2,
  )
  assert.ok(editor.includes("cursor.contentEditable = 'false'"))
  assert.ok(editor.includes("label.contentEditable = 'false'"))
  assert.ok(editor.includes('render: renderCollaborationCaret'))
  assert.match(
    styles,
    /\.collaboration-carets__caret\s*\{[^}]*pointer-events: none;[^}]*user-select: none;/s,
  )
})

test('presence labels stay beneath editor toolbar popovers', async () => {
  const styles = await read('apps/web/src/features/books/DocumentEditor.css')
  const labelZIndex = styles.match(
    /\.collaboration-carets__label\s*\{[^}]*z-index:\s*(\d+);/s,
  )?.[1]
  const toolbarZIndex = styles.match(/\.editorToolbar\s*\{[^}]*z-index:\s*(\d+);/s)?.[1]

  assert.ok(labelZIndex)
  assert.ok(toolbarZIndex)
  assert.ok(
    Number(labelZIndex) < Number(toolbarZIndex),
    'presence labels must stay below the toolbar stacking context',
  )
})

test('public Docker ships an isolated Node runtime and blocks the internal API', async () => {
  const [dockerfile, compose, nginx] = await Promise.all([
    read('Dockerfile'),
    read('compose.yaml'),
    read('deploy/nginx.conf'),
  ])

  assert.ok(dockerfile.includes('COPY --from=collaboration-build /usr/local/bin/node'))
  assert.ok(compose.includes('QUILLUM_COLLABORATION_MODE: ${QUILLUM_COLLABORATION_MODE:-enabled}'))
  assert.ok(compose.includes('node", "/app/apps/collaboration/src/server.js'))
  assert.ok(nginx.includes('location = /collaboration/ws'))
  assert.ok(nginx.includes('location ^~ /api/internal/collaboration/'))
  assert.ok(nginx.includes('return 404;'))
})
