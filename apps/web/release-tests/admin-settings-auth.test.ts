import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const webSourceRoot = new URL('../src/', import.meta.url)
const apiRoot = new URL('../../api/', import.meta.url)

async function read(root: URL, path: string) {
  return readFile(fileURLToPath(new URL(path, root)), 'utf8')
}

test('Product Admin settings save directly while other sensitive actions keep reauthentication', async () => {
  const [adminPage, settings, quotas, progression, users, servicePages, adminViews] = await Promise.all([
    read(webSourceRoot, 'features/admin/AdminPage.tsx'),
    read(webSourceRoot, 'features/admin/SettingsTab.tsx'),
    read(webSourceRoot, 'features/admin/TierQuotasPanel.tsx'),
    read(webSourceRoot, 'features/admin/TierProgressionPanel.tsx'),
    read(webSourceRoot, 'features/admin/UsersTab.tsx'),
    read(webSourceRoot, 'features/admin/ServicePagesTab.tsx'),
    read(apiRoot, 'apps/adminpanel/views.py'),
  ])

  assert.ok(adminPage.includes("adminView === 'settings' && <SettingsTab />"))
  assert.ok(!settings.includes('onSensitiveAction'))
  assert.ok(!quotas.includes('onSensitiveAction'))
  assert.ok(!progression.includes('onSensitiveAction'))
  assert.ok(settings.includes("apiRequest<AdminSettingsPayload>('/api/admin/settings/'"))
  assert.ok(settings.includes("apiRequest<{ ok: boolean; sent: number }>('/api/admin/settings/email/test/'"))
  assert.ok(quotas.includes("apiRequest<AdminTierQuotasPayload>('/api/admin/tier-quotas/'"))
  assert.ok(progression.includes("apiRequest<AdminTierProgressionPayload>('/api/admin/tier-progression/'"))

  assert.ok(users.includes('onSensitiveAction'))
  assert.ok(servicePages.includes('onSensitiveAction'))
  assert.ok(adminPage.includes('onSensitiveAction={runSensitiveAction}'))
  assert.ok(adminPage.includes('{reauthenticationDialog}'))

  for (const endpoint of ['service_settings', 'test_email_settings', 'tier_quotas', 'tier_progression']) {
    const start = adminViews.indexOf(`def ${endpoint}(`)
    const end = adminViews.indexOf('\n\n@', start)
    assert.notEqual(start, -1, `${endpoint} is missing`)
    assert.notEqual(end, -1, `${endpoint} is not bounded by the next view`)
    assert.ok(!adminViews.slice(start, end).includes('require_recent_auth'))
  }

  const roleUpdateStart = adminViews.indexOf('def update_user_role(')
  const roleUpdateEnd = adminViews.indexOf('\n\n@', roleUpdateStart)
  assert.ok(adminViews.slice(roleUpdateStart, roleUpdateEnd).includes('require_recent_auth'))
})
