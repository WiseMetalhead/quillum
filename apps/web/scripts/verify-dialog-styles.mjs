import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(scriptDirectory, '../src')
const distRoot = resolve(scriptDirectory, '../dist')
const indexHtml = await readFile(resolve(distRoot, 'index.html'), 'utf8')
const stylesheetUrls = Array.from(
  indexHtml.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g),
  (match) => match[1],
)

if (stylesheetUrls.length === 0) {
  throw new Error('The production entry document does not reference a stylesheet.')
}

const entryCss = (
  await Promise.all(
    stylesheetUrls.map((url) => readFile(resolve(distRoot, url.replace(/^\//, '')), 'utf8')),
  )
).join('\n')

const requiredDialogSelectors = [
  '.dialogBackdrop',
  '.createOneShotDialog',
  '.mobileFullViewBackdrop',
  '.mobileBottomSheetBackdrop',
  '.fieldError',
  '.imageUploadOverlay',
]

for (const selector of requiredDialogSelectors) {
  if (!entryCss.includes(selector)) {
    throw new Error(`The production entry stylesheet is missing ${selector}.`)
  }
}

const [
  actionDialogSource,
  adminSettingsSource,
  adminTierQuotasSource,
  adminPageCss,
  boardsPageSource,
  boardsPageCss,
  glossaryPageCss,
  manuscriptsPageCss,
  manuscriptExportDialogCss,
] = await Promise.all([
  readFile(resolve(sourceRoot, 'features/shared/ActionDialog.tsx'), 'utf8'),
  readFile(resolve(sourceRoot, 'features/admin/SettingsTab.tsx'), 'utf8'),
  readFile(resolve(sourceRoot, 'features/admin/TierQuotasPanel.tsx'), 'utf8'),
  readFile(resolve(sourceRoot, 'features/admin/AdminPage.css'), 'utf8'),
  readFile(resolve(sourceRoot, 'features/books/BoardsPage.tsx'), 'utf8'),
  readFile(resolve(sourceRoot, 'features/books/BoardsPage.css'), 'utf8'),
  readFile(resolve(sourceRoot, 'features/books/GlossaryPage.css'), 'utf8'),
  readFile(resolve(sourceRoot, 'features/books/ManuscriptsPage.css'), 'utf8'),
  readFile(resolve(sourceRoot, 'features/books/ManuscriptExportDialog.css'), 'utf8'),
])

if (!actionDialogSource.includes('createPortal(')) {
  throw new Error('ActionDialog must portal overlays outside route stacking contexts.')
}

for (const foreignClass of ['iconAction', 'inlineEditForm', 'accountValueWithAction', 'accountFieldValue']) {
  if (adminSettingsSource.includes(`className="${foreignClass}`)) {
    throw new Error(`Admin Settings must not depend on lazy SettingsPage .${foreignClass} styles.`)
  }
  if (adminTierQuotasSource.includes(`className="${foreignClass}`)) {
    throw new Error(`Admin Tier Quotas must not depend on lazy SettingsPage .${foreignClass} styles.`)
  }
}

if (!adminPageCss.includes('.adminIconAction')) {
  throw new Error('AdminPage.css must own its icon-action styles.')
}

if (
  boardsPageSource.includes('emptyCreateButton')
  || !boardsPageSource.includes('boardsEmptyCreateButton')
  || !boardsPageCss.includes('button.boardsEmptyCreateButton')
) {
  throw new Error('The Boards empty-state action must own its route-local button styles.')
}

for (const foreignSelector of ['.fieldError', '.imageUploadOverlay', '.exportDialog', '.exportFormatPicker']) {
  if (manuscriptsPageCss.includes(foreignSelector)) {
    throw new Error(`ManuscriptsPage.css must not own the shared ${foreignSelector} contract.`)
  }
}

if (!manuscriptExportDialogCss.includes('.exportFormatPickerDialog.mobileBottomSheet')) {
  throw new Error('The export dialog stylesheet must own its mobile format picker styles.')
}

if (!glossaryPageCss.includes('.glossarySidebar > button.glossaryMobileSidebarClose')) {
  throw new Error('The Glossary mobile sidebar close action must remain hidden outside phone layout.')
}

console.log('Shared and route-owned dialog styles passed production ownership checks.')
