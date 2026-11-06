import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)

async function source(path: string) {
  return readFile(fileURLToPath(new URL(path, root)), 'utf8')
}

test('tier progression UI stays conditional, accessible, and localized', async () => {
  const [types, tiersTab, adminPanel, en, ru] = await Promise.all([
    source('types.ts'),
    source('features/settings/TiersTab.tsx'),
    source('features/admin/TierProgressionPanel.tsx'),
    source('i18n/locales/en.ts'),
    source('i18n/locales/ru.ts'),
  ])

  assert.ok(types.includes('automaticPromotion: TierAutomaticPromotion | null'))
  assert.ok(tiersTab.includes('const automaticPromotion = payload.automaticPromotion'))
  assert.ok(tiersTab.includes('{automaticPromotion && ('))
  assert.ok(tiersTab.includes('{automaticPromotion ? ('))
  assert.ok(tiersTab.includes('showPromotion && automaticPromotion'))
  assert.ok(tiersTab.includes('role="progressbar"'))
  assert.ok(tiersTab.includes('aria-valuenow'))
  assert.ok(adminPanel.includes('/api/admin/tier-progression/'))
  assert.ok(adminPanel.includes('confirmDisable'))
  for (const locale of [en, ru]) {
    assert.ok(locale.includes('adminTierProgression:'))
    assert.ok(locale.includes('promotion: {'))
    assert.ok(locale.includes('progressValue_one:'))
    assert.ok(locale.includes('progressValue_other:'))
    assert.ok(locale.includes('countedManuscript:'))
  }
})
