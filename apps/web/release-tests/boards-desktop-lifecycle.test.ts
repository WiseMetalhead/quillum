import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('desktop note editor keeps one stable surface across its lazy fallback', async () => {
  const css = await readFile(
    new URL('../src/features/books/BoardsPage.css', import.meta.url),
    'utf8',
  )

  assert.match(
    css,
    /@media \(min-width: 521px\)[\s\S]*?\.boardsEditorBackdrop,\s*\.boardsEditorBackdrop > \.boardsEditor\s*\{ animation: none; \}/,
  )
})

test('note columns are remeasured after the loading grid returns', async () => {
  const source = await readFile(
    new URL('../src/features/books/BoardsPage.tsx', import.meta.url),
    'utf8',
  )

  assert.match(source, /\}, \[editorOpen, filteredNotes\.length, loading\]\)/)
})
