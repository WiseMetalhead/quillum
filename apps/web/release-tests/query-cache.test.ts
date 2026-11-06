import assert from 'node:assert/strict'
import test from 'node:test'

import { QueryCache, shouldInvalidateQueryCache } from '../src/api/queryCache.ts'

test('invalidates cached queries for mutations unless the caller opts out', () => {
  assert.equal(shouldInvalidateQueryCache(undefined), false)
  assert.equal(shouldInvalidateQueryCache('GET'), false)
  assert.equal(shouldInvalidateQueryCache('PATCH'), true)
  assert.equal(shouldInvalidateQueryCache('put', false), false)
})

test('deduplicates concurrent loads and reuses fresh data', async () => {
  let calls = 0
  let resolveLoad: ((value: { count: number }) => void) | null = null
  const cache = new QueryCache()
  const load = () => {
    calls += 1
    return new Promise<{ count: number }>((resolve) => {
      resolveLoad = resolve
    })
  }

  const first = cache.query('/items', load)
  const second = cache.query('/items', load)
  resolveLoad?.({ count: 1 })

  assert.deepEqual(await first, { count: 1 })
  assert.deepEqual(await second, { count: 1 })
  assert.deepEqual(await cache.query('/items', load), { count: 1 })
  assert.equal(calls, 1)
})

test('returns stale data while one background refresh updates consumers', async () => {
  let now = 0
  let count = 0
  const updates: number[] = []
  const cache = new QueryCache(64, () => now)
  const load = async () => ({ count: ++count })

  assert.deepEqual(await cache.query('/items', load), { count: 1 })
  now = 20
  assert.deepEqual(
    await cache.query('/items', load, {
      maxAgeMs: 10,
      staleWhileRevalidateMs: 100,
      onBackgroundUpdate: (value) => updates.push(value.count),
    }),
    { count: 1 },
  )
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(updates, [2])
  assert.deepEqual(await cache.query('/items', load), { count: 2 })
})

test('invalidation removes matching entries', async () => {
  const cache = new QueryCache()
  let calls = 0
  const load = async () => ++calls

  await cache.query('/manuscripts/one', load)
  await cache.query('/settings', load)
  cache.invalidate('/manuscripts/')

  assert.equal(await cache.query('/manuscripts/one', load), 3)
  assert.equal(await cache.query('/settings', load), 2)
})

test('clearing the cache aborts in-flight work', async () => {
  const cache = new QueryCache()
  const pending = cache.query('/items', (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))

  cache.clear()

  await assert.rejects(pending, { name: 'AbortError' })
})

test('evicts the least recently used completed entry', async () => {
  let now = 0
  let calls = 0
  const cache = new QueryCache(2, () => now)
  const load = async () => ++calls

  await cache.query('/first', load)
  now += 1
  await cache.query('/second', load)
  now += 1
  await cache.query('/third', load)
  now += 1

  assert.equal(await cache.query('/first', load), 4)
})
