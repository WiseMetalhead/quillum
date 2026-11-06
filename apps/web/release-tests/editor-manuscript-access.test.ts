import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { en } from '../src/i18n/locales/en.ts'
import { ru } from '../src/i18n/locales/ru.ts'

test('editor manuscript access opens only the grant-scoped editor capability', async () => {
  const sourceRoot = new URL('../src/', import.meta.url)
  const [
    app,
    library,
    dialog,
    navigation,
    styles,
    editor,
    documentEditor,
    documentEditorStyles,
    endpoints,
    illustrationNodeView,
    responsiveStyles,
    versions,
    versionStyles,
  ] = await Promise.all([
    readFile(new URL('App.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/ManuscriptsPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/ManuscriptEditorAccessDialog.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/manuscriptLibraryNavigation.ts', sourceRoot), 'utf8'),
    readFile(new URL('features/books/ManuscriptsPage.css', sourceRoot), 'utf8'),
    readFile(new URL('features/books/ManuscriptEditorPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/DocumentEditor.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/DocumentEditor.css', sourceRoot), 'utf8'),
    readFile(new URL('features/books/ManuscriptEndpoints.ts', sourceRoot), 'utf8'),
    readFile(new URL('features/books/ResizableIllustrationNodeView.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/ManuscriptResponsive.css', sourceRoot), 'utf8'),
    readFile(new URL('features/books/VersionsPanel.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/VersionsPanel.css', sourceRoot), 'utf8'),
  ])

  const returnMenuStart = app.indexOf('{sectionMenuOpen && (')
  const returnMenuEnd = app.indexOf('{authorWorkspaceActive && <>', returnMenuStart)
  assert.notEqual(returnMenuStart, -1)
  assert.notEqual(returnMenuEnd, -1)
  const returnMenu = app.slice(returnMenuStart, returnMenuEnd)

  assert.match(app, /mode=\{authorWorkspaceActive \? 'owner' : 'editor'\}/)
  assert.match(app, /if \(route\) return `\/manuscripts\/\$\{route\.manuscriptId\}\/editor`/)
  assert.match(returnMenu, /\{authorWorkspaceActive && \([\s\S]*openSection\('ideas'\)/)
  assert.match(returnMenu, /editorManuscripts\.title/)
  assert.match(library, /apiQuery<\{ items: AvailableManuscript\[\] \}>\([\s\S]{0,80}'\/api\/editor\/manuscripts\/'/)
  assert.match(library, /readOnly=\{editorMode\}/)
  assert.match(library, /readOnly \? \([\s\S]{0,140}<button[\s\S]{0,120}editorAvailableManuscriptCard[\s\S]{0,120}onClick=\{\(\) => onOpen\(item\.id\)\}/)
  assert.match(library, /!editorMode && <div className="newManuscript"/)
  assert.match(navigation, /section !== 'series'/)
  assert.match(dialog, /method: 'POST'/)
  assert.match(dialog, /method: 'DELETE'/)
  assert.match(dialog, /useMobileDialogTransition\(\{ onClose \}\)/)
  assert.match(dialog, /mobileFullViewBackdrop editorAccessBackdrop/)
  assert.match(dialog, /mobileFullViewForm mobileHeaderActionForm editorAccessForm/)
  assert.match(library, /editorManuscriptAuthorAvatar/)
  assert.match(styles, /\.editorAvailableLibrary \.mobileManuscriptCategorySelector \{[\s\S]{0,80}place-items: center/)
  assert.match(editor, /editable=\{!registeredEditor && manuscript\.kind === 'book'\}/)
  assert.match(editor, /showTrash=\{!registeredEditor\}/)
  assert.match(editor, /visibleInspectorTools/)
  assert.match(documentEditor, /editor_illustration_mutation_forbidden|ReadOnlyIllustrations/)
  assert.match(endpoints, /return `\$\{API_BASE\}\/api\/editor\/manuscripts\/\$\{manuscriptId\}\/assets\/\$\{assetId\}\/\$\{variant\}\//)
  assert.doesNotMatch(illustrationNodeView, /<PrivateImage[^>]+loading="lazy"/)
  assert.match(documentEditor, /registeredEditor \? '\/api\/editor\/preferences\/'/)
  assert.match(documentEditor, /documentTitleButton editorAccessDocumentTitle/)
  assert.match(documentEditorStyles, /\.editorAccessDocumentTitle \{[\s\S]*font: inherit;[\s\S]*font-weight: 700;/)
  assert.match(documentEditor, /editorMobileQuickActions \$\{registeredEditor \? 'editorAccess' : ''\}/)
  assert.match(responsiveStyles, /\.editorMobileQuickActions\.editorAccess \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(versions, /accessMode === 'owner' && <header className="commentsPanelHeader versionsHeader">/)
  assert.match(versions, /versionActions \$\{accessMode === 'editor' \? 'editorAccess' : ''\}/)
  assert.match(versionStyles, /\.versionActions\.editorAccess \{[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/)
})

test('editor manuscript access copy has English and Russian parity', () => {
  assert.deepEqual(Object.keys(en.editorDashboard), Object.keys(ru.editorDashboard))
  assert.deepEqual(Object.keys(en.editorManuscripts), Object.keys(ru.editorManuscripts))
  assert.deepEqual(Object.keys(en.editorAccess), Object.keys(ru.editorAccess))
  for (const error of [
    'editor_connection_not_found',
    'editor_workspace_required',
    'manuscript_editor_grant_already_exists',
    'manuscript_editor_grant_not_found',
    'annotation_delete_has_replies',
    'editor_illustration_mutation_forbidden',
  ] as const) {
    assert.equal(typeof en.errors[error], 'string')
    assert.equal(typeof ru.errors[error], 'string')
  }
})

test('editor workspace search stays grant-scoped and reuses the shared interaction', async () => {
  const sourceRoot = new URL('../src/', import.meta.url)
  const [app, editorDashboard, sharedSearch, searchConfig, styles] = await Promise.all([
    readFile(new URL('App.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/dashboard/EditorDashboardPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/dashboard/WorkspaceSearch.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/dashboard/workspaceSearchConfig.ts', sourceRoot), 'utf8'),
    readFile(new URL('features/dashboard/EditorDashboardPage.css', sourceRoot), 'utf8'),
  ])

  assert.match(editorDashboard, /endpoint="\/api\/editor\/workspace\/search\/"/)
  assert.match(editorDashboard, /kinds=\{EDITOR_WORKSPACE_SEARCH_KINDS\}/)
  assert.match(searchConfig, /EDITOR_WORKSPACE_SEARCH_KINDS[\s\S]*'manuscript',[\s\S]*'document'/)
  assert.match(editorDashboard, /showAuthor/)
  assert.match(sharedSearch, /window\.setTimeout\(async \(\) => \{/)
  assert.match(sharedSearch, /\}, 250\)/)
  assert.match(sharedSearch, /event\.key === 'ArrowDown'/)
  assert.match(sharedSearch, /navigator\.onLine/)
  assert.match(styles, /url\('\/workspace-background\.webp'\)/)
  assert.match(styles, /\.editorWorkspaceHomeWorkspace \{[\s\S]*padding: 0;/)
  assert.match(styles, /\.editorWorkspaceHomeWorkspace \.workspaceInner \{[\s\S]*width: 100%;/)
  assert.match(styles, /mask-image: radial-gradient/)
  assert.match(styles, /mask-image: linear-gradient/)
  assert.match(styles, /\.editorWorkspaceHero \{[\s\S]*overflow: hidden;/)
  assert.match(styles, /\.editorWorkspaceHero:has\(\.workspaceSearchResults\) \{[\s\S]{0,80}overflow: visible;/)
  assert.match(styles, /@media \(min-width: 861px\) \{[\s\S]*\.workspace\.editorWorkspaceHomeWorkspace \{[\s\S]*height: calc\(100dvh - var\(--app-header-height\)\);[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto;/)
  assert.match(styles, /\.editorWorkspaceHomeWorkspace \.workspaceInner,[\s\S]*\.editorWorkspaceHome,[\s\S]*\.editorWorkspaceHero \{[\s\S]*height: 100%;[\s\S]*min-height: 0;/)
  assert.match(app, /<EditorDashboardPage[\s\S]{0,160}onOpenSearchResult=\{openWorkspaceSearchResult\}/)
  assert.match(app, /if \(authorWorkspaceActive\) prefetchManuscriptData\(nextManuscriptId\)/)
})

test('dual workspaces keep capabilities independent from active navigation context', async () => {
  const sourceRoot = new URL('../src/', import.meta.url)
  const [app, settings, editorial, invitation, activationBanner] = await Promise.all([
    readFile(new URL('App.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/settings/SettingsPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/settings/EditorSettingsTab.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/auth/EditorInvitationPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/settings/WorkspaceActivationBanner.tsx', sourceRoot), 'utf8'),
  ])

  assert.match(app, /const \[activeWorkspace, setActiveWorkspace\] = useState<WorkspaceKind>\('author'\)/)
  assert.match(app, /'\/api\/auth\/workspace\/switch\/'/)
  assert.match(app, /user\.authorWorkspaceEnabled && user\.editorWorkspaceEnabled/)
  assert.match(app, /workspaceSwitcher\.toEditor/)
  assert.match(app, /authorWorkspaceActive \? 'mynaui-pen' : 'books-light'/)
  assert.match(app, /profileDropdownDivider/)
  assert.match(app, /authorWorkspaceRequiredForPath/)
  assert.match(app, /clearPrivateMediaCache\(\)[\s\S]{0,100}clearApiQueryCache\(\)/)
  assert.match(settings, /workspace="author"/)
  assert.match(settings, /presentation="promotional"/)
  assert.match(editorial, /workspace="editor"/)
  assert.match(editorial, /payload\.editors/)
  assert.match(editorial, /payload\.writers/)
  assert.match(activationBanner, /workspaceActivationBenefits/)
  assert.match(invitation, /activateAndAcceptTitle/)
  assert.match(invitation, /oidcConfirmTitle/)
  assert.deepEqual(Object.keys(en.workspaceActivation), Object.keys(ru.workspaceActivation))
  assert.deepEqual(Object.keys(en.workspaceSwitcher), Object.keys(ru.workspaceSwitcher))
  assert.deepEqual(Object.keys(en.editorInvitation), Object.keys(ru.editorInvitation))
})
