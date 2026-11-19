import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseRateLimit,
  serializeRateLimit,
} from '../src/features/admin/rateLimit.ts'

const webSourceRoot = new URL('../src/', import.meta.url)

test('rate-limit editor parses supported values and preserves the API contract', () => {
  assert.deepEqual(parseRateLimit('10/hour'), {
    count: '10',
    period: '1',
    unit: 'hour',
  })
  assert.deepEqual(parseRateLimit('5/15m'), {
    count: '5',
    period: '15',
    unit: 'minute',
  })
  assert.deepEqual(parseRateLimit('2/days'), {
    count: '2',
    period: '1',
    unit: 'day',
  })
  assert.equal(parseRateLimit('hourly'), null)
  assert.equal(serializeRateLimit({ count: '10', period: '1', unit: 'hour' }), '10/hour')
  assert.equal(serializeRateLimit({ count: '5', period: '15', unit: 'minute' }), '5/15m')
})

test('rate-limit editor stays inside the existing setting value row', async () => {
  const adminCss = await readFile(
    fileURLToPath(new URL('features/admin/AdminPage.css', webSourceRoot)),
    'utf8',
  )
  const rateInput = [...adminCss.matchAll(/\.adminRateLimitInput \{([\s\S]*?)\}/g)]
    .map((match) => match[1])
    .find((rule) => rule.includes('display: grid'))

  assert.match(rateInput ?? '', /display: grid/)
  assert.match(rateInput ?? '', /grid-template-columns:/)
  assert.match(adminCss, /\.adminSettingInlineForm > \.adminRateLimitInput/)
  assert.doesNotMatch(rateInput ?? '', /position: absolute/)
})
