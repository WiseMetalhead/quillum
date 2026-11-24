import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { en } from '../src/i18n/locales/en.ts'
import { ru } from '../src/i18n/locales/ru.ts'

const sourceRoot = new URL('../src/', import.meta.url)

test('context-aware header search keeps local scopes ahead of workspace results', async () => {
  const [
    main,
    headerSearch,
    workspaceSearch,
    provider,
    manuscripts,
    series,
    boards,
    glossary,
  ] = await Promise.all([
    readFile(new URL('main.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/dashboard/HeaderWorkspaceSearch.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/dashboard/WorkspaceSearch.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/dashboard/ContextualWorkspaceSearchProvider.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/ManuscriptsPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/SeriesPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/BoardsPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/GlossaryPage.tsx', sourceRoot), 'utf8'),
  ])

  assert.match(main, /<ContextualWorkspaceSearchProvider>\s*<App \/>/)
  assert.match(headerSearch, /useActiveContextualWorkspaceSearch/)
  assert.match(headerSearch, /contextualSearch=\{contextualSearch\}/)
  assert.match(workspaceSearch, /contextualResults[\s\S]*orderedGlobalResults/)
  assert.match(workspaceSearch, /contextualGlobalKeys\.has\(`\$\{result\.kind\}:\$\{result\.id\}`\)/)
  assert.match(workspaceSearch, /dashboard\.showContextResults/)
  assert.match(workspaceSearch, /dashboard\.searchEverywhere/)
  assert.match(provider, /query: '', results: \[\], total: 0/)

  for (const page of [manuscripts, series, boards, glossary]) {
    assert.match(page, /useContextualPageSearch/)
    assert.match(page, /<ContextualSearchFilterChip/)
    assert.match(page, /publishContextualSearchResults/)
  }

  assert.match(manuscripts, /<MobileLibraryQueryControls/)
  assert.match(series, /<MobileLibraryQueryControls/)
  assert.match(boards, /ref=\{mobileSearchInputRef\}/)
  assert.match(glossary, /ref=\{mobileSearchInputRef\}/)

  for (const locale of [en, ru]) {
    assert.equal(typeof locale.dashboard.searchEverywhere, 'string')
    assert.equal(typeof locale.dashboard.contextSearchFilter, 'string')
    assert.equal(typeof locale.manuscripts.contextSearchPlaceholder, 'string')
    assert.equal(typeof locale.series.contextSearchPlaceholder, 'string')
    assert.equal(typeof locale.boards.contextSearchPlaceholder, 'string')
    assert.equal(typeof locale.glossary.contextSearchPlaceholder, 'string')
  }
})
