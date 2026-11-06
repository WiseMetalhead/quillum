import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import i18next from 'i18next'

import { auditEventName, AUDIT_EVENT_CODES } from '../src/features/admin/auditEvents.ts'
import { en } from '../src/i18n/locales/en.ts'
import { ru } from '../src/i18n/locales/ru.ts'

type AuditEventCatalog = Record<string, Record<string, string>>

function flattenAuditEventCatalog(catalog: AuditEventCatalog) {
  return Object.entries(catalog).flatMap(([namespace, events]) => (
    Object.keys(events).map((event) => `${namespace}.${event}`)
  )).sort()
}

async function productionPythonFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      if (['__pycache__', 'migrations', 'tests'].includes(entry.name)) return []
      return productionPythonFiles(new URL(`${entry.name}/`, directory))
    }
    if (!entry.isFile() || !entry.name.endsWith('.py')) return []
    if (entry.name === 'tests.py' || entry.name.startsWith('test_')) return []
    return [new URL(entry.name, directory)]
  }))
  return files.flat()
}

function callBodies(source: string, marker: string) {
  const bodies: string[] = []
  let cursor = 0

  while (cursor < source.length) {
    const markerStart = source.indexOf(marker, cursor)
    if (markerStart < 0) break

    let open = markerStart + marker.length
    while (/\s/.test(source[open] || '')) open += 1
    if (source[open] !== '(') {
      cursor = open
      continue
    }

    let depth = 1
    let quote = ''
    let tripleQuoted = false
    let index = open + 1
    while (index < source.length && depth > 0) {
      const character = source[index]
      if (quote) {
        if (character === '\\') {
          index += 2
          continue
        }
        if (tripleQuoted && source.slice(index, index + 3) === quote.repeat(3)) {
          quote = ''
          tripleQuoted = false
          index += 3
          continue
        }
        if (!tripleQuoted && character === quote) quote = ''
        index += 1
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        tripleQuoted = source.slice(index, index + 3) === character.repeat(3)
        index += tripleQuoted ? 3 : 1
        continue
      }
      if (character === '#') {
        index = source.indexOf('\n', index)
        if (index < 0) break
        continue
      }
      if (character === '(') depth += 1
      if (character === ')') depth -= 1
      index += 1
    }

    if (depth === 0) bodies.push(source.slice(open + 1, index - 1))
    cursor = Math.max(index, open + 1)
  }

  return bodies
}

test('audit event list and localized catalogs stay aligned', () => {
  const listedCodes = [...AUDIT_EVENT_CODES].sort()

  assert.deepEqual(flattenAuditEventCatalog(en.admin.auditEventNames), listedCodes)
  assert.deepEqual(flattenAuditEventCatalog(ru.admin.auditEventNames), listedCodes)
})

test('backend audit producers are covered by the localized event list', async () => {
  const files = await productionPythonFiles(new URL('../../api/apps/', import.meta.url))
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')))
  const producerCodes = new Set<string>()
  const eventPattern = /['"]((?:admin|auth|editor|manuscript|system)\.[a-z0-9_]+)['"]/g

  for (const source of sources) {
    for (const marker of ['write_audit_event', 'write_system_audit_event', 'AuditEvent.objects.create', '_audit']) {
      for (const body of callBodies(source, marker)) {
        for (const match of body.matchAll(eventPattern)) producerCodes.add(match[1])
      }
    }
  }

  const allSources = sources.join('\n')
  assert.match(allSources, /f["']admin\.maintenance_\{action\}_refresh_requested["']/)
  assert.match(allSources, /action=["']news["']/)
  assert.match(allSources, /action=["']contests["']/)
  producerCodes.add('admin.maintenance_news_refresh_requested')
  producerCodes.add('admin.maintenance_contests_refresh_requested')

  assert.match(allSources, /f["']manuscript\.note_bulk_\{action\}["']/)
  assert.match(allSources, /action not in \{["']restore["'], ["']unarchive["']\}/)
  producerCodes.add('manuscript.note_bulk_restore')
  producerCodes.add('manuscript.note_bulk_unarchive')

  const listedCodes = new Set<string>(AUDIT_EVENT_CODES)
  const missingCodes = [...producerCodes].filter((event) => !listedCodes.has(event)).sort()
  assert.deepEqual(missingCodes, [])
})

test('unknown audit events use a localized fallback and retain the technical code', async () => {
  const i18n = i18next.createInstance()
  await i18n.init({
    lng: 'ru',
    fallbackLng: 'en',
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
  })

  assert.equal(
    auditEventName(i18n.t, 'future.example'),
    'Неизвестное событие: future.example',
  )
})
