import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repositoryRoot = new URL('../../../', import.meta.url)

async function read(path: string) {
  return readFile(new URL(path, repositoryRoot), 'utf8')
}

test('Product Admin owns OIDC settings unless deployment configuration locks them', async () => {
  const [runtimeSettings, oidc, settingsTab, compose, en, ru] = await Promise.all([
    read('apps/api/apps/adminpanel/runtime_settings.py'),
    read('apps/api/apps/accounts/oidc.py'),
    read('apps/web/src/features/admin/SettingsTab.tsx'),
    read('compose.yaml'),
    read('apps/web/src/i18n/locales/en.ts'),
    read('apps/web/src/i18n/locales/ru.ts'),
  ])
  const oidcKeys = [
    'oidc_enabled',
    'oidc_provider_name',
    'oidc_discovery_url',
    'oidc_issuer',
    'oidc_client_id',
    'oidc_client_secret',
  ]

  for (const key of oidcKeys) {
    assert.ok(runtimeSettings.includes(`"${key}"`), `${key} is missing from runtime settings`)
    assert.ok(en.includes(`${key}:`), `${key} is missing from the English catalog`)
    assert.ok(ru.includes(`${key}:`), `${key} is missing from the Russian catalog`)
  }
  assert.ok(runtimeSettings.includes('environment_guard="QUILLUM_OIDC_DEPLOYMENT_OWNED"'))
  assert.ok(runtimeSettings.includes('environment_file_name="OIDC_CLIENT_SECRET_FILE"'))
  assert.ok(compose.includes('QUILLUM_OIDC_DEPLOYMENT_OWNED: ${QUILLUM_OIDC_ENABLED:-false}'))
  assert.ok(settingsTab.includes("item.key.startsWith('oidc_')"))
  assert.ok(settingsTab.includes('{oidcSettings.map(renderSetting)}'))
  assert.ok(oidc.includes('runtime_setting("oidc_client_secret")'))
  assert.ok(!settingsTab.includes('oidcEnvironmentLead'))
  assert.ok(!en.includes('Provider connection values are supplied by the deployment environment.'))
  assert.ok(!ru.includes('Параметры подключения к провайдеру задаются окружением развёртывания.'))
})
