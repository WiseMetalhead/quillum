import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Writer Workspace home keeps bookmarks before compact bottom statistics', async () => {
  const sourceRoot = new URL('../src/', import.meta.url)
  const [dashboard, app, navigation, sharedStyles, responsiveStyles] = await Promise.all([
    readFile(new URL('features/dashboard/DashboardPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('App.tsx', sourceRoot), 'utf8'),
    readFile(new URL('api/navigationData.ts', sourceRoot), 'utf8'),
    readFile(new URL('styles/shared.css', sourceRoot), 'utf8'),
    readFile(new URL('styles/responsive.css', sourceRoot), 'utf8'),
  ])

  const heroIndex = dashboard.indexOf('<section className="workspaceGreeting"')
  const bookmarksIndex = dashboard.indexOf('<section className="workspaceUsefulLinksCard"')
  const statsIndex = dashboard.indexOf('<section className="workspaceStatsGrid"')

  assert.ok(heroIndex >= 0)
  assert.ok(bookmarksIndex > heroIndex)
  assert.ok(statsIndex > bookmarksIndex)
  assert.doesNotMatch(dashboard, /workspaceContinue|dashboard\/recent-work|recentWork/)
  assert.doesNotMatch(navigation, /dashboard\/recent-work/)
  assert.doesNotMatch(app, /<DashboardPage[\s\S]{0,160}onOpenEditorDocument=/)

  assert.match(sharedStyles, /\.workspaceHomeGrid \{[\s\S]{0,240}grid-template-rows: auto auto minmax\(0, 1fr\) auto;/)
  assert.match(sharedStyles, /\.workspaceStatsGrid \{[\s\S]{0,180}grid-row: 4;[\s\S]{0,180}1080px/)
  assert.match(sharedStyles, /min-height: max\(100%, 640px\)/)
  assert.doesNotMatch(responsiveStyles, /\.workspaceHomeGrid \{[\s\S]{0,100}zoom:/)
  assert.match(responsiveStyles, /\.workspaceUsefulLinksCard,[\s\S]{0,80}\.workspaceStatsGrid \{[\s\S]{0,80}width: calc\(100% - 32px\)/)
})
