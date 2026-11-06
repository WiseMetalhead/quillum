import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { assetReferences, renderServiceWorker } from '../scripts/generate-pwa.mjs'

test('finds hashed shell assets in HTML and CSS', () => {
  assert.deepEqual(
    assetReferences(`
      <script src="/assets/index-abc.js"></script>
      <link href="/assets/index-def.css" rel="stylesheet">
      body { font: url(/assets/font-ghi.woff2) }
    `),
    [
      '/assets/index-abc.js',
      '/assets/index-def.css',
      '/assets/font-ghi.woff2',
    ],
  )
})

test('service worker excludes private application endpoints', () => {
  const source = renderServiceWorker('test-version', ['/index.html', '/offline.html'])

  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/)
  assert.match(source, /url\.pathname\.startsWith\('\/ws\/'\)/)
  assert.doesNotMatch(source, /skipWaiting/)
})

test('service worker uses an offline document only for failed navigation', () => {
  const source = renderServiceWorker('test-version', ['/index.html', '/offline.html'])

  assert.match(source, /request\.mode === 'navigate'/)
  assert.match(source, /caches\.match\('\/offline\.html'\)/)
  assert.match(source, /quillum-shell-\$\{VERSION\}/)
})

test('startup update discovery stays quiet while later checks notify the active client', async () => {
  const source = await readFile(new URL('../src/pwa/registerPwa.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /registration\.waiting\) announceUpdate/)
  assert.match(source, /watchWorker\(registration\.installing, false\)/)
  assert.match(source, /watchWorker\(worker, announceFutureUpdates\)/)
  assert.match(source, /announceFutureUpdates = true/)
})

test('manifest provides Chromium-sized regular and maskable icons', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
  ) as {
    icons: Array<{ sizes: string; purpose: string }>
  }

  for (const size of ['192x192', '512x512']) {
    assert.ok(manifest.icons.some((icon) => icon.sizes === size && icon.purpose === 'any'))
    assert.ok(manifest.icons.some((icon) => icon.sizes === size && icon.purpose === 'maskable'))
  }
})

test('installed shell applies theme-aware system chrome with a dark launch fallback', async () => {
  const [manifestSource, index, themeBootstrap] = await Promise.all([
    readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/theme-bootstrap.js', import.meta.url), 'utf8'),
  ])
  const manifest = JSON.parse(manifestSource) as {
    background_color: string
    theme_color: string
  }

  assert.equal(manifest.background_color, '#191a1b')
  assert.equal(manifest.theme_color, '#191a1b')
  assert.match(index, /interactive-widget=resizes-content/)
  assert.match(index, /viewport-fit=cover/)
  assert.match(index, /data-theme-color="light"/)
  assert.match(index, /data-theme-color="dark"/)
  assert.match(index, /media="\(prefers-color-scheme: light\)"/)
  assert.match(index, /media="\(prefers-color-scheme: dark\)"/)
  assert.match(themeBootstrap, /meta\[data-theme-color\]/)
  assert.match(themeBootstrap, /metaTheme === theme \? 'all' : 'not all'/)
})

test('offline document does not require inline script execution', async () => {
  const document = await readFile(
    new URL('../public/offline.html', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(document, /<script|\son[a-z]+=/i)
  assert.match(document, /lang="ru"/)
  assert.match(document, /media="\(prefers-color-scheme: light\)"/)
  assert.match(document, /media="\(prefers-color-scheme: dark\)"/)
})
