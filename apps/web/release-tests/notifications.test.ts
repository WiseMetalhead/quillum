import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)

async function source(path: string) {
  return readFile(fileURLToPath(new URL(path, root)), 'utf8')
}

const userKinds = [
  'user.manuscript_deadline',
  'user.item_deadline',
  'user.task_deadline',
  'user.review_comment',
  'user.daily_goal',
  'user.manuscript_digest',
]

const editorAccessKinds = [
  'service.editor_manuscript_access_granted',
  'service.editor_manuscript_access_revoked',
]

test('user notification kinds stay aligned across types, settings, panel, and locales', async () => {
  const [types, settings, panel, en, ru] = await Promise.all([
    source('types.ts'),
    source('features/settings/NotificationSettingsTab.tsx'),
    source('features/notifications/NotificationPanel.tsx'),
    source('i18n/locales/en.ts'),
    source('i18n/locales/ru.ts'),
  ])
  for (const kind of userKinds) {
    assert.ok(types.includes(`'${kind}'`), `${kind} is missing from frontend types`)
    assert.ok(settings.includes(`'${kind}'`), `${kind} is missing from settings`)
    assert.ok(panel.includes(`"${kind}"`), `${kind} is missing from panel mapping`)
    const localeKey = kind.replaceAll('.', '_')
    assert.ok(en.includes(`${localeKey}:`), `${kind} is missing from English copy`)
    assert.ok(ru.includes(`${localeKey}:`), `${kind} is missing from Russian copy`)
  }
})

test('comment deep links accept only UUID targets and clear transient parameters', async () => {
  const [space, editor] = await Promise.all([
    source('features/books/ManuscriptSpace.tsx'),
    source('features/books/ManuscriptEditorPage.tsx'),
  ])
  assert.ok(space.includes('UUID_PATTERN.test'))
  for (const parameter of ['dialog', 'inspector', 'annotation']) {
    assert.ok(editor.includes(`parameters.delete('${parameter}')`))
  }
})

test('due admin notification campaigns refresh until delivery finishes', async () => {
  const panel = await source('features/admin/NotificationsTestTab.tsx')

  assert.ok(panel.includes('CAMPAIGN_STATUS_POLL_INTERVAL_MS'))
  assert.ok(panel.includes("campaign.status === 'processing'"))
  assert.ok(panel.includes("campaign.status === 'scheduled'"))
  assert.ok(panel.includes('campaignDeliveryIsPending(payload.campaign)'))
  assert.ok(panel.includes('CAMPAIGN_STATUS_POLL_LIMIT'))
  assert.ok(panel.includes("action === 'send' || action === 'retry'"))
  assert.ok(panel.includes('`/api/admin/notifications/campaigns/${campaignId}/`'))
})

test('notification background transport pauses while the browser is offline', async () => {
  const panel = await source('features/notifications/NotificationPanel.tsx')

  assert.ok(panel.includes('useState(() => navigator.onLine)'))
  assert.ok(panel.includes('window.addEventListener("online", handleOnline)'))
  assert.ok(panel.includes('window.addEventListener("offline", handleOffline)'))
  assert.ok(panel.includes('if (disabled || !online) return;'))
  assert.ok(panel.includes('if (socketConnected || disabled || !online) return;'))
  assert.ok(panel.includes('if (!disabled && navigator.onLine) void refreshRef.current();'))
  assert.ok(panel.includes('disabled={disabled || !online}'))
})

test('audio transcription notifications use the shared soundwave icon', async () => {
  const panel = await source('features/notifications/NotificationPanel.tsx')

  assert.ok(panel.includes('"service.audio_transcription_ready": "soundwave-linear"'))
  assert.ok(panel.includes('"service.audio_transcription_failed": "soundwave-linear"'))
})

test('editor manuscript access notifications stay aligned across panel, self-test, and locales', async () => {
  const [types, panel, selfTest, app, en, ru] = await Promise.all([
    source('types.ts'),
    source('features/notifications/NotificationPanel.tsx'),
    source('features/admin/NotificationsTestTab.tsx'),
    source('App.tsx'),
    source('i18n/locales/en.ts'),
    source('i18n/locales/ru.ts'),
  ])
  for (const kind of editorAccessKinds) {
    assert.ok(types.includes(`'${kind}'`), `${kind} is missing from frontend types`)
    assert.ok(panel.includes(`"${kind}"`), `${kind} is missing from panel mapping`)
    assert.ok(selfTest.includes(`'${kind}'`), `${kind} is missing from Product Admin self-test`)
    const localeKey = kind.replaceAll('.', '_')
    assert.ok(en.includes(`${localeKey}:`), `${kind} is missing from English copy`)
    assert.ok(ru.includes(`${localeKey}:`), `${kind} is missing from Russian copy`)
  }
  assert.ok(panel.includes('onNavigate(path, item.kind)'))
  assert.ok(app.includes("url.searchParams.get('workspace')"))
  assert.ok(app.includes("kind.startsWith('service.editor_manuscript_access_')"))
  assert.ok(app.includes('await switchWorkspace(targetWorkspace, destination)'))
})
