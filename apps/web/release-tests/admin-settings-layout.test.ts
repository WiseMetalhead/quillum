import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const webSourceRoot = new URL('../src/', import.meta.url)

test('desktop admin settings share aligned columns across each section', async () => {
  const adminCss = await readFile(
    fileURLToPath(new URL('features/admin/AdminPage.css', webSourceRoot)),
    'utf8',
  )
  const settingsGrid = adminCss.match(/\.adminSettingsGrid \{[\s\S]*?\}/g)
    ?.find((rule) => rule.includes('max-content'))
  const settingRow = adminCss.match(/\.adminSettingRow \{[\s\S]*?\}/g)
    ?.find((rule) => rule.includes('grid-template-columns: subgrid'))

  assert.match(settingsGrid ?? '', /grid-template-columns: minmax\(180px, 0\.55fr\) minmax\(0, 1fr\) max-content/)
  assert.match(settingRow ?? '', /grid-column: 1 \/ -1/)
  assert.match(settingRow ?? '', /grid-template-columns: subgrid/)
})
