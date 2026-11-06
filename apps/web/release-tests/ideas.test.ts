import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Ideas image, text, and audio notes use the staged responsive contracts', async () => {
  const [ideas, ideasStyles, textEditor, textEditorStyles, storage, confirmation] = await Promise.all([
    readFile(new URL('../src/features/ideas/IdeasPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/ideas/IdeasPage.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/ideas/IdeaTextEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/ideas/IdeaTextEditor.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/settings/StorageTab.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/shared/ResponsiveConfirmationDialog.tsx', import.meta.url), 'utf8'),
  ])

  assert.ok(!storage.includes('window.confirm'))
  assert.ok(storage.includes('<ResponsiveConfirmationDialog'))
  assert.ok(ideas.includes('useMobileDialogTransition'))
  assert.ok(ideas.includes('mobileFullViewBackdrop ${backdropStateClass}'))
  assert.ok(!ideas.includes('mobileFullViewBackdrop open'))
  assert.match(ideas, /\{!editorOpen && \([\s\S]*?className="ideasMobileCreate image spaceButton"/)
  assert.match(ideas, /const filters: IdeaFilter\[\] = \['all', 'image', 'text', 'audio'\]/)
  assert.ok(ideas.includes("'/api/ideas/text/'"))
  assert.ok(ideas.includes("'/api/ideas/audio/'"))
  assert.ok(ideas.includes("'/api/ideas/audio/import/'"))
  assert.ok(ideas.includes("name={importingAudio ? 'cloud-upload' : 'upload-track-linear'}"))
  assert.ok(ideas.includes('<IdeaAudioEditor'))
  assert.ok(ideas.includes('className="ideasImageTitleInput"'))
  assert.equal(ideas.match(/className="ideaCardTitle"/g)?.length, 3)
  assert.ok(ideas.includes("method: 'PATCH'"))
  assert.ok(ideas.includes('expectedGeneration: item.saveGeneration'))
  assert.ok(ideas.includes('/boards?note=${payload.note.id}'))
  assert.ok(textEditor.includes('<textarea'))
  assert.ok(textEditor.includes('className="ideasTextTitleInput"'))
  assert.ok(textEditor.includes('<BoardsSaveStatusIndicator'))
  assert.ok(textEditor.includes('className="ideasTextEditorMobileSaveStatus"'))
  assert.ok(textEditor.includes('}, 800)'))
  assert.ok(textEditor.includes("'/api/ideas/targets/'"))
  assert.ok(!textEditor.includes('useEditor('))
  assert.ok(!textEditor.includes('<EditorContent'))
  assert.match(textEditorStyles, /\.ideasTextEditorActionGroup button span \{ display: none; \}/)
  assert.match(ideas, /\}, \[items\.length, loading\]\)/)
  assert.match(ideasStyles, /\.ideasViewerImage img \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: contain;/)
  assert.match(ideasStyles, /@media \(max-width: 520px\)[\s\S]*?\.ideasToolbar \{[\s\S]*?width: 100%;[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?justify-content: stretch;/)
  assert.match(ideasStyles, /@media \(max-width: 520px\)[\s\S]*?\.ideasToolbar h1 \{[\s\S]*?min-height: 56px;/)
  assert.match(ideasStyles, /\.ideasViewerBackdrop\.mobileFullViewBackdrop \{[\s\S]*?z-index: 19;[\s\S]*?inset: var\(--app-header-height\) 0 0;/)
  assert.ok(confirmation.includes('mobileBottomSheetBackdrop'))
  assert.ok(confirmation.includes('variant="structured"'))
})
