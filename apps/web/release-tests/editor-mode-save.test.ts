import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('view and edit mode changes do not enter either editor autosave queue', async () => {
  const root = new URL('../src/features/books/', import.meta.url)
  const [documentEditor, glossaryEditor] = await Promise.all([
    readFile(new URL('DocumentEditor.tsx', root), 'utf8'),
    readFile(new URL('GlossaryArticleDocument.tsx', root), 'utf8'),
  ])

  assert.match(documentEditor, /onUpdate: \(\{ editor: currentEditor, transaction, appendedTransactions \}\) => \{\s+if \(!transaction\.docChanged && !appendedTransactions\.some/)
  assert.match(documentEditor, /editor\.setEditable\(true, false\)/)
  assert.match(documentEditor, /editor\.setEditable\(false, false\)/)

  assert.match(glossaryEditor, /onUpdate: \(\{ editor: currentEditor, transaction, appendedTransactions \}\) => \{[\s\S]{0,200}!transaction\.docChanged && !appendedTransactions\.some/)
  assert.match(glossaryEditor, /editor\.setEditable\(editable, false\)/)
})
