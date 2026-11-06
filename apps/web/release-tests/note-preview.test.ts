import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('note previews use multiline ellipsis instead of clipping text by height', async () => {
  const [boardsCss, editorNotesCss] = await Promise.all([
    readFile(new URL('../src/features/books/BoardsPage.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/books/EditorNotesPanel.css', import.meta.url), 'utf8'),
  ])

  const boardsPreview = boardsCss.match(/\.boardsNoteCardContent\s*\{([^}]+)\}/)?.[1] ?? ''
  const boardsListPreview = boardsCss.match(
    /\.boardsNotes\.list \.boardsNoteCardContent\s*\{([^}]+)\}/,
  )?.[1] ?? ''
  const editorPreview = editorNotesCss.match(/\.editorNoteCardContent\s*\{([^}]+)\}/)?.[1] ?? ''

  assert.match(boardsPreview, /display:\s*-webkit-box/)
  assert.match(boardsPreview, /-webkit-box-orient:\s*vertical/)
  assert.match(boardsPreview, /-webkit-line-clamp:\s*7/)
  assert.doesNotMatch(boardsPreview, /max-height/)
  assert.match(boardsListPreview, /-webkit-line-clamp:\s*2/)

  assert.match(editorPreview, /display:\s*-webkit-box/)
  assert.match(editorPreview, /-webkit-box-orient:\s*vertical/)
  assert.match(editorPreview, /-webkit-line-clamp:\s*5/)
  assert.doesNotMatch(editorPreview, /max-height/)
})
