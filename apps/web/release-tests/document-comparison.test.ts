import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  compareDocuments,
  visibleComparisonItems,
} from '../src/features/books/DocumentComparisonEngine.ts'

type Mark = { type: string; attrs?: Record<string, unknown> }

function paragraph(text: string, marks?: Mark[], textAlign?: 'left' | 'center' | 'right') {
  return {
    type: 'paragraph',
    ...(textAlign ? { attrs: { textAlign } } : {}),
    content: text ? [{ type: 'text', text, ...(marks ? { marks } : {}) }] : [],
  }
}

function documentWith(...content: Record<string, unknown>[]) {
  return { type: 'doc', content }
}

test('aligns prose blocks and highlights words and punctuation on their own sides', () => {
  const result = compareDocuments(
    documentWith(paragraph('Он открыл дверь. Тихо.')),
    documentWith(paragraph('Он осторожно открыл дверь — тихо.')),
  )

  assert.equal(result.groupCount, 1)
  assert.equal(result.rows.length, 1)
  assert.match(
    result.rows[0].left?.segments.filter((segment) => segment.change === 'removed').map((segment) => segment.text).join('') ?? '',
    /\.\s*Т/,
  )
  assert.match(
    result.rows[0].right?.segments.filter((segment) => segment.change === 'added').map((segment) => segment.text).join('') ?? '',
    /осторожно|—/,
  )
})

test('keeps inserted and removed paragraphs in explicit unmatched cells', () => {
  const result = compareDocuments(
    documentWith(paragraph('Начало'), paragraph('Удалённый абзац'), paragraph('Финал')),
    documentWith(paragraph('Начало'), paragraph('Новый абзац'), paragraph('Ещё один'), paragraph('Финал')),
  )

  assert.equal(result.groupCount, 1)
  assert.equal(result.rows[0].changed, false)
  assert.ok(result.rows.slice(1, -1).some((row) => row.left === null || row.right === null))
  assert.equal(result.rows.at(-1)?.changed, false)
})

test('represents a moved paragraph as two change groups around stable prose anchors', () => {
  const result = compareDocuments(
    documentWith(paragraph('Первый'), paragraph('Переносимый'), paragraph('Второй'), paragraph('Третий')),
    documentWith(paragraph('Первый'), paragraph('Второй'), paragraph('Третий'), paragraph('Переносимый')),
  )

  assert.equal(result.groupCount, 2)
  assert.ok(result.rows.some((row) => row.left !== null && row.right === null))
  assert.ok(result.rows.some((row) => row.left === null && row.right !== null))
})

test('detects formatting, alignment, heading, hard-break, and comment-anchor changes', () => {
  const anchor = '00000000-0000-4000-8000-000000000001'
  const left = documentWith(
    paragraph('Выделено', [{ type: 'bold' }, { type: 'annotationAnchor', attrs: { annotationId: anchor } }], 'left'),
    { type: 'paragraph', content: [{ type: 'text', text: 'Строка' }, { type: 'hardBreak' }, { type: 'text', text: 'ниже' }] },
  )
  const right = documentWith(
    { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'Выделено', marks: [{ type: 'italic' }] }] },
    paragraph('Строка ниже'),
  )
  const result = compareDocuments(left, right)
  const first = result.rows[0]

  assert.ok(first.left?.metadataChanges.includes('blockType'))
  assert.ok(first.left?.metadataChanges.includes('headingLevel'))
  assert.ok(first.left?.metadataChanges.includes('alignment'))
  assert.ok(first.left?.segments.some((segment) => segment.formattingChanged))
  assert.ok(first.left?.segments.some((segment) => segment.annotationsChanged))
  assert.ok(result.rows[1].left?.segments.some((segment) => segment.change === 'removed'))
})

test('detects scene breaks and illustration replacement without listing presentation metadata', () => {
  const left = documentWith(
    { type: 'sceneBreak' },
    { type: 'illustration', attrs: { assetId: 'a', alt: 'Старый alt', caption: 'Старая подпись', alignment: 'left', displayWidth: 60 } },
  )
  const right = documentWith(
    paragraph('***'),
    { type: 'illustration', attrs: { assetId: 'b', alt: 'Новый alt', caption: 'Новая подпись', alignment: 'right', displayWidth: 90 } },
  )
  const result = compareDocuments(left, right)
  const illustrationRow = result.rows.find((row) => row.left?.type === 'illustration')

  assert.ok(result.rows.some((row) => row.left?.type === 'sceneBreak'))
  assert.deepEqual(illustrationRow?.left?.metadataChanges, [
    'illustrationAsset',
    'illustrationAlt',
    'illustrationCaption',
  ])
})

test('ignores illustration alignment and width-only changes', () => {
  const result = compareDocuments(
    documentWith({ type: 'illustration', attrs: { assetId: 'same', alt: 'Alt', caption: 'Подпись', alignment: 'left', displayWidth: 60 } }),
    documentWith({ type: 'illustration', attrs: { assetId: 'same', alt: 'Alt', caption: 'Подпись', alignment: 'right', displayWidth: 90 } }),
  )

  assert.equal(result.groupCount, 0)
  assert.equal(result.rows[0].changed, false)
})

test('collapses distant unchanged context and expands a selected shared gap', () => {
  const leftBlocks = Array.from({ length: 12 }, (_, index) => paragraph(`Абзац ${index}`))
  const rightBlocks = structuredClone(leftBlocks)
  rightBlocks[6] = paragraph('Изменённый абзац')
  const result = compareDocuments(documentWith(...leftBlocks), documentWith(...rightBlocks))
  const collapsed = visibleComparisonItems(result, new Set(), false)
  const gaps = collapsed.filter((item) => item.kind === 'gap')

  assert.equal(gaps.length, 2)
  assert.equal(collapsed.filter((item) => item.kind === 'row').length, 5)
  const expanded = visibleComparisonItems(result, new Set([gaps[0].id]), false)
  assert.ok(expanded.length > collapsed.length)
  assert.equal(visibleComparisonItems(result, new Set(), true).length, 12)
})

test('bounds expensive changed-hunk alignment for large unrelated documents', () => {
  const left = documentWith(...Array.from({ length: 101 }, (_, index) => paragraph(`Left ${index}`)))
  const right = documentWith(...Array.from({ length: 100 }, (_, index) => paragraph(`Right ${index}`)))
  const result = compareDocuments(left, right)

  assert.equal(result.usedAlignmentFallback, true)
  assert.equal(result.rows.length, 101)
  assert.equal(result.groupCount, 1)
})

test('reports no visible changes for equal English and Russian content', () => {
  const content = documentWith(paragraph('Same text — тот же текст.'))
  const result = compareDocuments(content, structuredClone(content))

  assert.equal(result.groupCount, 0)
  assert.equal(result.rows[0].changed, false)
})

test('keeps the Worker, retry, shared history UI, and confirmed conflict choices wired together', async () => {
  const root = new URL('../src/features/books/', import.meta.url)
  const [comparison, versions, editor] = await Promise.all([
    readFile(new URL('DocumentComparison.tsx', root), 'utf8'),
    readFile(new URL('VersionsPanel.tsx', root), 'utf8'),
    readFile(new URL('ManuscriptEditorPage.tsx', root), 'utf8'),
  ])

  assert.match(comparison, /new Worker\(new URL\('\.\/DocumentComparison\.worker\.ts'/)
  assert.match(comparison, /failed: true/)
  assert.match(comparison, /documentComparison\.retry/)
  assert.match(versions, /<DocumentComparison/)
  assert.match(editor, /pendingConflictChoice/)
  assert.match(editor, /role="alertdialog"/)
  assert.match(editor, /await editorRef\.current\?\.prepareConflictResolution\(\)/)
  assert.match(editor, /deleteOfflineDocument/)
  assert.match(editor, /confirmedGeneration: conflict\.server\.saveGeneration/)
  assert.doesNotMatch(editor, /role="alertdialog"[\s\S]{0,400}description=/)
})

test('conflict resolution drains and disarms stale editor persistence before remount', async () => {
  const editor = await readFile(
    new URL('../src/features/books/DocumentEditor.tsx', import.meta.url),
    'utf8',
  )
  const method = editor.slice(
    editor.indexOf('async function prepareConflictResolution()'),
    editor.indexOf('useImperativeHandle(ref'),
  )

  assert.match(method, /clearTimeout\(saveTimerRef\.current\)/)
  assert.match(method, /clearTimeout\(localSaveTimerRef\.current\)/)
  assert.match(method, /pendingSaveRef\.current = null/)
  assert.match(method, /offlineDocumentRef\.current = null/)
  assert.match(method, /await persistenceQueueRef\.current/)
  assert.match(editor, /prepareConflictResolution,/)
})

test('mobile conflict comparison reuses the full-view header, toolbar, and action-sheet contracts', async () => {
  const root = new URL('../src/features/books/', import.meta.url)
  const [comparison, styles, editorPage] = await Promise.all([
    readFile(new URL('DocumentComparison.tsx', root), 'utf8'),
    readFile(new URL('DocumentComparison.css', root), 'utf8'),
    readFile(new URL('ManuscriptEditorPage.tsx', root), 'utf8'),
  ])

  assert.match(comparison, /documentComparisonMobileHeader/)
  assert.match(comparison, /documentComparisonMobileToolbar/)
  assert.match(comparison, /<MobileLibraryActionSheet/)
  assert.match(comparison, /documentComparison\.comparisonOptions/)
  assert.match(comparison, /documentComparison\.chooseVersion/)
  assert.match(editorPage, /mobileConflictControls=/)
  assert.match(editorPage, /function ConflictConfirmationDialog/)
  assert.match(editorPage, /bookItemDeleteBackdrop \$\{backdropStateClass\}/)
  assert.match(editorPage, /bookItemDeleteSheet/)
  assert.match(editorPage, /globalThis\.document\.body\.classList\.add\('conflictComparisonOpen'\)/)
  assert.match(editorPage, /globalThis\.document\.body\.classList\.remove\('conflictComparisonOpen'\)/)
  assert.match(editorPage, /isMobileViewport && scaffoldRef\.current/)
  assert.match(styles, /inset: var\(--app-header-height\) 0 0/)
  assert.match(styles, /body\.conflictComparisonOpen \.appHeader/)
  assert.match(styles, /-webkit-backdrop-filter: none/)
  assert.match(styles, /body\.conflictComparisonOpen button\.brandButton:disabled/)
  assert.match(styles, /body\.conflictComparisonOpen button\.notificationButton:disabled/)
  assert.match(styles, /cursor: default;\s+opacity: 1;/)
  assert.match(styles, /\.editorScaffold > \.conflictComparisonBackdrop \{\s+position: absolute;\s+z-index: 30;\s+inset: 0;/)
  assert.match(styles, /\.conflictComparisonDialog:focus \{ outline: none; \}/)
  assert.match(styles, /\.documentComparison\.mobileConflict/)
  assert.match(styles, /\.standardDialogBackdrop\.conflictConfirmationBackdrop/)
})

test('desktop comparison centers the scrollbar gutter to keep column dividers aligned', async () => {
  const styles = await readFile(
    new URL('../src/features/books/DocumentComparison.css', import.meta.url),
    'utf8',
  )

  assert.match(styles, /@media \(min-width: 521px\) \{\s+\.documentComparisonScroll \{ scrollbar-gutter: stable both-edges; \}/)
})
