import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { resolveApiBase } from '../src/api/resolveApiBase.ts'

test('production defaults to the current origin', () => {
  assert.equal(resolveApiBase(undefined, false, 'write.example.com'), '')
})

test('development retains the port-8000 fallback', () => {
  assert.equal(
    resolveApiBase(undefined, true, '127.0.0.1'),
    'http://127.0.0.1:8000',
  )
})

test('an explicit API base overrides environment defaults', () => {
  assert.equal(
    resolveApiBase('https://api.example.com', false, 'write.example.com'),
    'https://api.example.com',
  )
})

test('generic API requests bypass the browser HTTP cache', async () => {
  const source = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')

  assert.match(source, /const API_REQUEST_CACHE: RequestCache = 'no-store'/)
  assert.equal(source.match(/cache: API_REQUEST_CACHE/g)?.length, 3)
})

test('private media fetches bytes instead of reusing a bodyless conditional response', async () => {
  const source = await readFile(
    new URL('../src/features/shared/privateMediaCache.ts', import.meta.url),
    'utf8',
  )

  assert.match(source, /fetch\(source, \{[\s\S]{0,100}cache: 'no-store'/)
})
