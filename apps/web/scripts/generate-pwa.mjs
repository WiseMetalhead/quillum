import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(scriptDirectory, '..')
const distRoot = resolve(webRoot, 'dist')

const fixedShellUrls = [
  '/index.html',
  '/manifest.webmanifest',
  '/offline.html',
  '/offline.css',
  '/theme-bootstrap.js',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/pwa-icon-maskable-192.png',
  '/pwa-icon-maskable-512.png',
]

function assetPath(url) {
  return resolve(distRoot, url.replace(/^\//, ''))
}

export function assetReferences(source) {
  return Array.from(
    source.matchAll(
      /(?:src|href)\s*=\s*["'](\/assets\/[^"']+)|url\(\s*["']?(\/assets\/[^"')\s]+)/g,
    ),
    (match) => match[1] ?? match[2],
  )
}

export function renderServiceWorker(cacheVersion, precacheUrls) {
  return `const VERSION = ${JSON.stringify(cacheVersion)}
const SHELL_CACHE = \`quillum-shell-\${VERSION}\`
const RUNTIME_CACHE = \`quillum-runtime-\${VERSION}\`
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)}
const PRECACHE_PATHS = new Set(PRECACHE_URLS)

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => (
          (key.startsWith('quillum-shell-') || key.startsWith('quillum-runtime-'))
          && key !== SHELL_CACHE
          && key !== RUNTIME_CACHE
        ))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (
    url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/ws/')
    || url.pathname.startsWith('/django-admin/')
  ) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (
        (await caches.match('/offline.html'))
        || Response.error()
      )),
    )
    return
  }

  if (PRECACHE_PATHS.has(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((cached) => cached || fetch(request)))
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request)
        if (cached) return cached
        const response = await fetch(request)
        if (response.ok) await cache.put(request, response.clone())
        return response
      }),
    )
  }
})
`
}

export async function generatePwa() {
  const indexHtml = await readFile(resolve(distRoot, 'index.html'), 'utf8')
  const precache = new Set([...fixedShellUrls, ...assetReferences(indexHtml)])
  for (const url of [...precache]) {
    if (!url.endsWith('.css') && !url.endsWith('.js')) continue
    const content = await readFile(assetPath(url), 'utf8')
    for (const reference of assetReferences(content)) precache.add(reference)
  }
  const precacheUrls = [...precache].sort()
  const versionHash = createHash('sha256')
  for (const url of precacheUrls) {
    versionHash.update(url)
    versionHash.update(await readFile(assetPath(url)))
  }
  const cacheVersion = versionHash.digest('hex').slice(0, 16)
  await writeFile(
    resolve(distRoot, 'sw.js'),
    renderServiceWorker(cacheVersion, precacheUrls),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generatePwa()
}
