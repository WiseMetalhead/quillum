import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  audioWaveformHeight,
  audioWaveformLevel,
  compressAudioWaveform,
  preferredAudioMimeType,
} from '../src/features/books/audioNoteRecording.ts'

test('audio recorder prefers Opus and falls back to MP4', () => {
  assert.equal(preferredAudioMimeType(() => true), 'audio/webm;codecs=opus')
  assert.equal(
    preferredAudioMimeType((candidate) => candidate === 'audio/mp4'),
    'audio/mp4',
  )
  assert.equal(preferredAudioMimeType(() => false), '')
})

test('audio waveform is clamped and downsampled to the requested maximum', () => {
  assert.deepEqual(compressAudioWaveform([-4, 12.6, 280], 8), [0, 13, 255])
  assert.deepEqual(compressAudioWaveform([1, 2, 9, 4, 5, 8], 3), [2, 7, 7])
  assert.equal(compressAudioWaveform(Array.from({ length: 600 }, (_, index) => index % 256), 256).length, 256)
})

test('audio waveform preserves speech dynamics without saturating ordinary levels', () => {
  assert.equal(audioWaveformLevel(new Float32Array(32)), 0)
  const quiet = audioWaveformLevel(Float32Array.from([0, 0.02, -0.02, 0]))
  const loud = audioWaveformLevel(Float32Array.from([0.2, -0.2, 0.16, -0.16]))
  assert.ok(quiet > 0)
  assert.ok(loud > quiet)
  assert.ok(loud < 255)
  assert.equal(audioWaveformHeight(0), 12)
  assert.ok(audioWaveformHeight(128) < 50)
  assert.equal(audioWaveformHeight(255), 100)
})

test('audio editor keeps pause, active-time cap, discard, and upload retry contracts', async () => {
  const [source, recorder] = await Promise.all([
    readFile(new URL('../src/features/books/BoardsAudioNoteEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/shared/useAudioRecorder.ts', import.meta.url), 'utf8'),
  ])

  assert.match(recorder, /recorder\.pause\(\)/)
  assert.match(recorder, /recorder\.resume\(\)/)
  assert.match(recorder, /currentElapsed >= MAX_DURATION_MS/)
  assert.match(source, /audioNotes\.confirmDiscard/)
  assert.match(source, /<ActionDialog/)
  assert.doesNotMatch(source, /window\.confirm/)
  assert.match(source, /uploadRecording\(\)/)
  assert.match(recorder, /setResult\(next\)/)
  assert.match(recorder, /getFloatTimeDomainData/)
  assert.match(source, /boardsAudioSavedLayout/)
  assert.match(source, /boardsEditorMobileActions/)
  assert.match(source, /boardsEditorMobileToolbar/)
  assert.match(source, /MobileLibraryActionSheet/)
})

test('audio notes have dedicated Board, Storage, and Editor Notes presentation', async () => {
  const [boards, storage, editorNotes, editorNotesCss, player] = await Promise.all([
    readFile(new URL('../src/features/books/BoardsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/settings/StorageTab.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/books/EditorNotesPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/books/EditorNotesPanel.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/shared/AudioNotePlayer.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(boards, /note\.kind === 'audio'/)
  assert.match(storage, /audioNotes/)
  assert.match(storage, /AudioNotePlayer/)
  assert.match(editorNotes, /EditorAudioNoteDetail/)
  assert.doesNotMatch(editorNotes, /t\('storage\.codec'\)/)
  assert.match(editorNotesCss, /\.editorAudioNotePlayer \{[^}]*background: transparent;/)
  assert.match(editorNotesCss, /\.editorAudioNoteDetail > \.audioTranscriptionPanel \.audioTranscriptionText p/)
  assert.match(player, /stableWidth \? maximum/)
})

test('audio transcription is shared across Boards, Ideas, Storage, and Editor Notes', async () => {
  const [panel, panelCss, boards, ideas, storage, storageCss, editorNotes, en, ru] = await Promise.all([
    readFile(new URL('../src/features/shared/AudioTranscriptionPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/shared/AudioTranscriptionPanel.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/books/BoardsAudioNoteEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/ideas/IdeaAudioEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/settings/StorageTab.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/settings/SettingsPage.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/books/EditorNotesPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/i18n/locales/en.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/i18n/locales/ru.ts', import.meta.url), 'utf8'),
  ])

  assert.match(panel, /setInterval\(\(\) => void load\(\), 1000\)/)
  assert.match(panel, /activeStatuses\.has\(transcription\.status\)/)
  assert.match(panel, /method: 'POST'/)
  assert.match(panel, /method: 'DELETE'/)
  assert.match(panel, /controls && transcription\.hasText/)
  assert.match(panel, /audioTranscription\.emptyTitle/)
  assert.match(panel, /audioTranscription\.emptyDescription/)
  assert.match(panel, /audioTranscription\.readyTitle/)
  assert.match(panel, /name="soundwave-linear"/)
  assert.doesNotMatch(panel, /audioTranscription\.transcript/)
  assert.match(panelCss, /\.audioTranscriptionPanel\.empty \{[^}]*justify-items: center;/)
  assert.match(panelCss, /\.audioTranscriptionPanel\.active \.audioTranscriptionProgress \{[^}]*justify-self: center;/)
  assert.match(panelCss, /\.audioTranscriptionActions \{[^}]*justify-content: center;/)
  assert.match(panelCss, /\.audioTranscriptionPanel button\.audioTranscriptionStart,[\s\S]*font-size: 12px;/)
  assert.match(panelCss, /\.audioTranscriptionPanel button\.audioTranscriptionRetry,[\s\S]*font-size: 12px;/)
  assert.match(boards, /<AudioTranscriptionPanel/)
  assert.match(ideas, /<AudioTranscriptionPanel endpoint=/)
  assert.match(storage, /<AudioTranscriptionPanel/)
  assert.match(storageCss, /\.storageMediaDialogLayout:has\(> \.audioTranscriptionPanel\)/)
  assert.match(storageCss, /grid-column: 1;\s+grid-row: 2;/)
  assert.match(editorNotes, /controls=\{false\}/)
  assert.match(en, /audioTranscription:/)
  assert.match(en, /emptyTitle: 'Turn speech into text'/)
  assert.match(en, /readyTitle: 'Recording transcript'/)
  assert.match(ru, /audioTranscription:/)
  assert.match(ru, /emptyTitle: 'Преобразуйте речь в текст'/)
  assert.match(ru, /readyTitle: 'Расшифровка записи'/)
})

test('public Docker profile verifies the pinned model and isolates a single FIFO worker', async () => {
  const [compose, installer, settings, transcription, pyproject] = await Promise.all([
    readFile(new URL('../../../compose.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../../../deploy/install-transcription-model.py', import.meta.url), 'utf8'),
    readFile(new URL('../../api/config/settings.py', import.meta.url), 'utf8'),
    readFile(new URL('../../api/apps/manuscripts/transcription.py', import.meta.url), 'utf8'),
    readFile(new URL('../../api/pyproject.toml', import.meta.url), 'utf8'),
  ])
  const revision = '536b0662742c02347bc0e980a01041f333bce120'
  const checksum = '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'

  assert.ok(installer.includes(revision))
  assert.ok(installer.includes(checksum))
  assert.ok(transcription.includes(revision))
  assert.ok(transcription.includes(checksum))
  assert.match(compose, /profiles: \["transcription"\]/)
  assert.match(compose, /--pool=solo/)
  assert.match(compose, /--concurrency=1/)
  assert.match(compose, /--prefetch-multiplier=1/)
  assert.match(compose, /mem_limit: 3g/)
  assert.match(settings, /"queue": "transcription"/)
  assert.match(transcription, /local_files_only=True/)
  assert.match(transcription, /release_transcription_model_if_idle\(\)/)
  assert.match(transcription, /gc\.collect\(\)/)
  assert.match(transcription, /malloc_trim\(0\)/)
  assert.match(pyproject, /av>=11,<19/)
})
