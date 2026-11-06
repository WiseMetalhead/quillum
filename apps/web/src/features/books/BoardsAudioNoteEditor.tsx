import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { AudioNotePlayer, AudioWaveform } from '../shared/AudioNotePlayer'
import { AudioTranscriptionPanel } from '../shared/AudioTranscriptionPanel'
import { CustomSelect } from '../shared/CustomSelect'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { LibraryAction } from '../shared/MobileLibraryActionSheet'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useAudioRecorder } from '../shared/useAudioRecorder'
import type { AudioRecorderError, AudioRecordingResult } from '../shared/useAudioRecorder'
import { NoteColorPicker } from './NoteColorPicker'
import {
  formatAudioDuration,
} from './audioNoteRecording'
import type { AudioNoteDraft, Board, BoardsSaveStatus, Note, NoteContextItem, NoteTag } from './BoardsTypes'

const NOTE_COLORS = ['yellow', 'blue', 'green', 'purple', 'orange', 'pink', 'gray'] as const
type MobileToolbarLevel = 'main' | 'color'
type MobilePicker = 'board' | 'items' | 'tags'

type Props = {
  note: Note | null
  initialBoardId: string | null
  initialFavourite: boolean
  boards: Board[]
  tags: NoteTag[]
  contextItems: NoteContextItem[]
  onClose: () => void
  onCreate: (blob: Blob, draft: AudioNoteDraft, durationMs: number, waveform: number[]) => Promise<Note>
  onSave: (draft: AudioNoteDraft, note: Note) => Promise<Note>
  onCreateTag: (name: string) => Promise<NoteTag>
  onLifecycle: (note: Note, action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'delete') => Promise<void>
  onSaveStatusChange: (status: BoardsSaveStatus) => void
  onError: (message: string) => void
}

export function BoardsAudioNoteEditor({
  note,
  initialBoardId,
  initialFavourite,
  boards,
  tags,
  contextItems,
  onClose,
  onCreate,
  onSave,
  onCreateTag,
  onLifecycle,
  onSaveStatusChange,
  onError,
}: Props) {
  const { t, i18n } = useTranslation()
  const createdAtRef = useRef(new Date())
  const initialTitle = note?.title ?? t('audioNotes.defaultTitle', {
    date: new Intl.DateTimeFormat(i18n.resolvedLanguage, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(createdAtRef.current),
  })
  const [title, setTitle] = useState(initialTitle)
  const [color, setColor] = useState(note?.color ?? 'blue')
  const [boardId, setBoardId] = useState(note?.boardId ?? initialBoardId ?? '')
  const [tagIds, setTagIds] = useState(note?.tags.map((tag) => tag.id) ?? [])
  const [itemIds, setItemIds] = useState(note?.associatedItems.map((item) => item.id) ?? [])
  const [pinned, setPinned] = useState(note?.pinned ?? false)
  const [favourite, setFavourite] = useState(note?.favourite ?? initialFavourite)
  const [currentNote, setCurrentNote] = useState(note)
  const [uploading, setUploading] = useState(false)
  const [uploadFailed, setUploadFailed] = useState(false)
  const [editingTitle, setEditingTitle] = useState(!note)
  const [tagCreateOpen, setTagCreateOpen] = useState(false)
  const [linksOpen, setLinksOpen] = useState(() => Boolean(note?.associatedItems.length))
  const [tagName, setTagName] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [savingMetadata, setSavingMetadata] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)
  const [mobileToolbarLevel, setMobileToolbarLevel] = useState<MobileToolbarLevel>('main')
  const [mobilePicker, setMobilePicker] = useState<MobilePicker | null>(null)
  const savedSignatureRef = useRef('')
  const draft = useMemo<AudioNoteDraft>(() => ({
    title,
    color,
    boardId: boardId || null,
    tagIds,
    itemIds,
    pinned,
    favourite,
  }), [boardId, color, favourite, itemIds, pinned, tagIds, title])
  const signature = JSON.stringify(draft)
  const latestDraftRef = useRef(draft)
  latestDraftRef.current = draft
  const recorder = useAudioRecorder({
    onStopped: (result) => void uploadRecording(result),
    onError: (code) => onError(t(`audioNotes.errors.${audioErrorKey(code)}`)),
  })
  const state = currentNote
    ? uploading ? 'uploading' : 'saved'
    : uploading ? 'uploading' : uploadFailed ? 'error' : recorder.state
  const audio = currentNote?.audio ?? (recorder.result ? {
    contentType: recorder.result.blob.type,
    codec: recorder.result.blob.type.startsWith('audio/mp4') ? 'aac' as const : 'opus' as const,
    byteSize: recorder.result.blob.size,
    durationMs: recorder.result.durationMs,
    waveform: recorder.result.waveform,
    playbackUrl: '',
    downloadUrl: '',
  } : null)
  const editorColorStyle = color.startsWith('#') ? { '--note-color': color } as CSSProperties : undefined
  const saveStatus: BoardsSaveStatus = saveFailed || uploadFailed ? 'error' : savingMetadata || state === 'uploading'
    ? 'saving' : currentNote && signature !== savedSignatureRef.current ? 'dirty' : 'saved'

  useEffect(() => {
    savedSignatureRef.current = JSON.stringify({
      title: note?.title ?? initialTitle,
      color: note?.color ?? 'blue',
      boardId: note?.boardId ?? initialBoardId,
      tagIds: note?.tags.map((tag) => tag.id) ?? [],
      itemIds: note?.associatedItems.map((item) => item.id) ?? [],
      pinned: note?.pinned ?? false,
      favourite: note?.favourite ?? initialFavourite,
    })
  }, [initialFavourite, initialBoardId, initialTitle, note])

  useEffect(() => onSaveStatusChange(saveStatus), [onSaveStatusChange, saveStatus])

  useEffect(() => {
    if (note) return
    void recorder.start()
    return () => recorder.discard()
    // The shared recorder makes StrictMode's setup-cleanup replay safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note])

  useEffect(() => {
    if (!currentNote || state !== 'saved' || signature === savedSignatureRef.current || savingMetadata) return
    const timer = window.setTimeout(() => void saveMetadata(), 800)
    return () => window.clearTimeout(timer)
    // saveMetadata intentionally follows the current draft signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNote, savingMetadata, signature, state])

  async function uploadRecording(result: AudioRecordingResult | null = recorder.result) {
    if (!result) return
    setUploading(true)
    setUploadFailed(false)
    setSaveFailed(false)
    try {
      const uploadedDraft = latestDraftRef.current
      const uploadedSignature = JSON.stringify(uploadedDraft)
      const saved = await onCreate(
        result.blob,
        uploadedDraft,
        result.durationMs,
        result.waveform,
      )
      setCurrentNote(saved)
      savedSignatureRef.current = uploadedSignature
    } catch (error) {
      setUploadFailed(true)
      onError(error instanceof Error ? error.message : t('audioNotes.errors.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  async function saveMetadata() {
    if (!currentNote || savingMetadata) return null
    setSavingMetadata(true)
    setSaveFailed(false)
    const savingSignature = signature
    try {
      const saved = await onSave(draft, currentNote)
      setCurrentNote(saved)
      savedSignatureRef.current = savingSignature
      return saved
    } catch (error) {
      setSaveFailed(true)
      onError(error instanceof Error ? error.message : t('notes.saveFailed'))
      return null
    } finally {
      setSavingMetadata(false)
    }
  }

  async function closeEditor(discardConfirmed = false) {
    if (state === 'uploading') return
    if (!discardConfirmed && (state === 'requesting' || state === 'recording' || state === 'paused' || state === 'stopped' || (!currentNote && recorder.result))) {
      setDiscardConfirmOpen(true)
      return
    }
    if (currentNote && signature !== savedSignatureRef.current && !(await saveMetadata())) return
    recorder.discard()
    onClose()
  }

  async function createTag() {
    const name = tagName.trim()
    if (!name || addingTag) return
    setAddingTag(true)
    try {
      const tag = await onCreateTag(name)
      setTagIds((current) => [...current, tag.id])
      setTagName('')
      setTagCreateOpen(false)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('notes.createTagFailed'))
    } finally {
      setAddingTag(false)
    }
  }

  async function runLifecycle(action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'delete') {
    if (!currentNote) return
    let lifecycleNote = currentNote
    if (signature !== savedSignatureRef.current) {
      const saved = await saveMetadata()
      if (!saved) return
      lifecycleNote = saved
    }
    await onLifecycle(lifecycleNote, action)
  }

  const displayedTitle = title.trim() || t('notes.untitled')
  const recording = state === 'recording' || state === 'paused'
  const savedAudio = !recording && audio && currentNote
  const unavailable = state === 'uploading' || savingMetadata
  const selectedBoardName = boards.find((board) => board.id === boardId)?.name ?? t('notes.noBoard')
  const mobileActions: LibraryAction[] = [
    {
      key: 'board',
      label: `${t('notes.board')}: ${selectedBoardName}`,
      icon: <Icon name="widget-light" />,
      onSelect: () => setMobilePicker('board'),
    },
    {
      key: 'items',
      label: itemIds.length ? t('notes.linkedItemsCount', { count: itemIds.length }) : t('notes.linkNote'),
      icon: <Icon name="link-minimalistic-light" />,
      onSelect: () => setMobilePicker('items'),
    },
  ]
  if (currentNote?.trashedAt) {
    mobileActions.push(
      { key: 'restore', label: t('notes.restore'), icon: <Icon name="restart-light" />, disabled: unavailable },
      { key: 'delete', label: t('notes.deleteForever'), icon: <Icon name="trash-bin-trash-light" />, danger: true, disabled: unavailable },
    )
  } else if (currentNote) {
    mobileActions.push(
      { key: currentNote.archivedAt ? 'unarchive' : 'archive', label: t(currentNote.archivedAt ? 'notes.unarchive' : 'notes.archive'), icon: <Icon name="archive-light" />, disabled: unavailable },
      { key: 'trash', label: t('notes.moveToTrash'), icon: <Icon name="trash-bin-trash-light" />, danger: true, disabled: unavailable },
    )
  }

  return (
    <>
    <div className="boardsEditorBackdrop dialogBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void closeEditor() }}>
      <aside className="boardsEditor boardsAudioEditor createOneShotDialog" data-note-color={color} role="dialog" aria-modal="true" aria-label={t('audioNotes.editorLabel')} style={editorColorStyle}>
        <header>
          <button type="button" className="spaceButton boardsEditorMobileBack" aria-label={t('notes.backToNotes')} disabled={state === 'uploading'} onClick={() => void closeEditor()}><Icon name="arrow-left-1" /></button>
          <div className="boardsEditorTitleLine">
            {editingTitle ? <input autoFocus className="boardsEditorTitleInput" value={title} maxLength={240} aria-label={t('notes.noteTitle')} onChange={(event) => setTitle(event.target.value)} onBlur={() => setEditingTitle(false)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
              : <button type="button" className="spaceButton boardsEditorTitleButton" onClick={() => setEditingTitle(true)}>{displayedTitle}</button>}
          </div>
          <button type="button" className="dialogClose booksButton boardsEditorDesktopClose" aria-label={t('notes.closeEditor')} disabled={state === 'uploading'} onClick={() => void closeEditor()}><Icon name="close-square-light" /></button>
          <button type="button" className={`spaceButton boardsEditorMobileActions ${mobileActionsOpen ? 'active' : ''}`} aria-label={t('notes.noteActions')} aria-expanded={mobileActionsOpen} onClick={() => setMobileActionsOpen((open) => !open)}><Icon name="menu-dots-light" /></button>
        </header>
        <div className="boardsEditorBody boardsAudioEditorBody">
          <div className={`boardsAudioMain ${savedAudio ? 'withTranscription' : ''}`}>
            {state === 'requesting' && <div className="boardsAudioState"><Icon name="microphone-3-linear" /><strong>{t('audioNotes.requestingPermission')}</strong></div>}
            {recording && <>
              <div className={`boardsAudioRecordingMark ${state}`}><Icon name="microphone-3-linear" /><strong>{formatAudioDuration(recorder.elapsedMs)}</strong><span>{t(state === 'paused' ? 'audioNotes.paused' : 'audioNotes.recording')}</span></div>
              <AudioWaveform values={recorder.waveform} live />
              <div className="boardsAudioRecordActions">
                <button type="button" className="spaceButton" onClick={state === 'paused' ? recorder.resume : recorder.pause}><Icon name={state === 'paused' ? 'play-light' : 'pause-light'} />{t(state === 'paused' ? 'audioNotes.resume' : 'audioNotes.pause')}</button>
                <button type="button" className="spaceButton stop" onClick={recorder.stop}><Icon name="stop-light" />{t('audioNotes.stop')}</button>
              </div>
            </>}
            {savedAudio ? (
              <div className="boardsAudioSavedLayout">
                <div className="boardsAudioPlaybackPane">
                  <AudioNotePlayer audio={audio} source={recorder.result?.source || undefined} />
                </div>
                <AudioTranscriptionPanel noteId={currentNote.id} trashed={Boolean(currentNote.trashedAt)} onError={onError} />
              </div>
            ) : !recording && audio ? <AudioNotePlayer audio={audio} source={recorder.result?.source || undefined} /> : null}
            {state === 'uploading' && <p className="boardsAudioHint">{t('audioNotes.uploading')}</p>}
          {state === 'error' && <div className="boardsAudioError"><p>{t(recorder.result ? 'audioNotes.errors.uploadFailed' : 'audioNotes.errors.recordingFailed')}</p>{recorder.result ? <button type="button" onClick={() => void uploadRecording()}>{t('audioNotes.retryUpload')}</button> : <button type="button" onClick={() => void recorder.start()}>{t('audioNotes.retryPermission')}</button>}</div>}
          </div>
          <div className="boardsEditorMetadata boardsAudioMetadata">
            <section className="boardsEditorSection"><h2>{t('notes.board')}</h2><CustomSelect value={boardId} onChange={(event) => setBoardId(event.target.value)}><option value="">{t('notes.noBoard')}</option>{boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}</CustomSelect></section>
            <section className="boardsEditorSection"><h2>{t('notes.color')}</h2><div className="boardsColors">{NOTE_COLORS.map((candidate) => <button key={candidate} type="button" className={color === candidate ? `spaceButton active ${candidate}` : `spaceButton ${candidate}`} aria-label={t('notes.noteColor', { color: t(`notes.colors.${candidate}`) })} onClick={() => setColor(candidate)} />)}<NoteColorPicker value={color} onChange={setColor} /></div></section>
            <section className="boardsEditorSection"><h2>{t('notes.tags')}</h2><div className="boardsTagChoices">{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} /><span style={{ '--tag-color': tag.color } as CSSProperties}>{tag.name}</span></label>)}{!tagCreateOpen && <button type="button" className="spaceButton boardsAddTagButton" aria-label={t('notes.createTag')} onClick={() => setTagCreateOpen(true)}><Icon name="sign-plus-light" /></button>}</div>{tagCreateOpen && <div className="boardsInlineCreate"><input autoFocus value={tagName} maxLength={40} placeholder={t('notes.newTag')} onChange={(event) => setTagName(event.target.value)} /><button type="button" className="spaceButton" disabled={!tagName.trim() || addingTag} onClick={() => void createTag()}><Icon name="sign-plus-light" /></button></div>}</section>
            <section className="boardsEditorSection"><h2>{t('notes.linkedItems')}</h2><button type="button" className="spaceButton boardsLinkToggle" aria-expanded={linksOpen} onClick={() => setLinksOpen((open) => !open)}><Icon name="link-minimalistic-light" /> {itemIds.length ? t('notes.linkedItemsCount', { count: itemIds.length }) : t('notes.linkNote')}</button>{linksOpen && <div className="boardsItemChoices boardsAudioItemChoices">{contextItems.map((item) => <label key={item.id} style={{ '--item-depth': itemDepth(item, contextItems) } as CSSProperties}><input type="checkbox" checked={itemIds.includes(item.id)} onChange={() => setItemIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><Icon name={item.kind === 'folder' ? 'folder-light' : 'file-document-light'} /><span>{item.title}</span></label>)}{!contextItems.length && <p>{t('notes.noItems')}</p>}</div>}</section>
            <div className="boardsNoteOptions"><button type="button" className={`spaceButton ${pinned ? 'active' : ''}`} onClick={() => setPinned((value) => !value)}><Icon name="pin-linear" className="boardsPinIcon" /> {t(pinned ? 'notes.pinned' : 'notes.pinNote')}</button><button type="button" className={`spaceButton ${favourite ? 'active' : ''}`} onClick={() => setFavourite((value) => !value)}><Icon name="star-light" /> {t(favourite ? 'notes.favourite' : 'notes.addToFavourites')}</button></div>
            {currentNote && <div className="boardsEditorLifecycleActions">{currentNote.trashedAt ? <><button type="button" className="spaceButton" disabled={unavailable} onClick={() => void runLifecycle('restore')}><Icon name="restart-light" /> {t('notes.restore')}</button><button type="button" className="spaceButton danger" disabled={unavailable} onClick={() => void runLifecycle('delete')}><Icon name="trash-bin-trash-light" /> {t('notes.deleteForever')}</button></> : <><button type="button" className="spaceButton" disabled={unavailable} onClick={() => void runLifecycle(currentNote.archivedAt ? 'unarchive' : 'archive')}><Icon name="archive-light" /> {t(currentNote.archivedAt ? 'notes.unarchive' : 'notes.archive')}</button><button type="button" className="spaceButton danger" disabled={unavailable} onClick={() => void runLifecycle('trash')}><Icon name="trash-bin-trash-light" /> {t('notes.moveToTrash')}</button></>}</div>}
          </div>
        </div>
        <div className={`boardsEditorMobileToolbar level-${mobileToolbarLevel}`} aria-label={t('notes.noteFormatting')}>
          {mobileToolbarLevel === 'main' && <div className="boardsEditorMobileToolbarLevel main">
            <button type="button" className="spaceButton" aria-label={t('notes.color')} onClick={() => setMobileToolbarLevel('color')}><Icon name="pallete-2-light" /></button>
            <button type="button" className={`spaceButton ${tagIds.length ? 'active' : ''}`} aria-label={t('notes.tags')} onClick={() => setMobilePicker('tags')}><Icon name="bookmark-light" />{tagIds.length > 0 && <small>{tagIds.length}</small>}</button>
            <span className="boardsEditorMobileToolbarSpacer" />
          </div>}
          {mobileToolbarLevel === 'color' && <div className="boardsEditorMobileToolbarLevel color">
            <button type="button" className="spaceButton" aria-label={t('common.back')} onClick={() => setMobileToolbarLevel('main')}><Icon name="arrow-left-1" /></button>
            <span />
            {NOTE_COLORS.map((candidate) => <button key={candidate} type="button" className={`spaceButton boardsEditorMobileColorChoice ${color === candidate ? 'active' : ''}`} aria-label={t('notes.noteColor', { color: t(`notes.colors.${candidate}`) })} onClick={() => setColor(candidate)}><i className={candidate} /></button>)}
            <NoteColorPicker value={color} onChange={setColor} />
          </div>}
        </div>
        <MobileLibraryActionSheet
          open={mobileActionsOpen}
          title={displayedTitle}
          actions={mobileActions}
          dismissOnSelect
          onClose={() => setMobileActionsOpen(false)}
          onActionSelect={(action) => {
            if (action.key === 'restore' || action.key === 'delete' || action.key === 'archive' || action.key === 'unarchive' || action.key === 'trash') void runLifecycle(action.key)
          }}
          topContent={<div className="boardsEditorMobileQuickActions"><button type="button" className={`spaceButton ${pinned ? 'active' : ''}`} aria-pressed={pinned} onClick={() => setPinned((value) => !value)}><Icon name="pin-linear" className="boardsPinIcon" /><span>{t(pinned ? 'notes.pinned' : 'notes.pinNote')}</span></button><button type="button" className={`spaceButton ${favourite ? 'active' : ''}`} aria-pressed={favourite} onClick={() => setFavourite((value) => !value)}><Icon name="star-light" /><span>{t(favourite ? 'notes.favourite' : 'notes.addToFavourites')}</span></button></div>}
        />
        {mobilePicker === 'board' && <MobileNotePickerSheet title={t('notes.board')} onClose={() => setMobilePicker(null)}><div className="boardsMobileBoardPicker"><button type="button" className={`spaceButton ${!boardId ? 'active' : ''}`} onClick={() => setBoardId('')}>{t('notes.noBoard')}</button>{boards.map((board) => <button type="button" className={`spaceButton ${boardId === board.id ? 'active' : ''}`} key={board.id} onClick={() => setBoardId(board.id)}>{board.name}</button>)}</div></MobileNotePickerSheet>}
        {mobilePicker === 'items' && <MobileNotePickerSheet title={t('notes.linkedItems')} onClose={() => setMobilePicker(null)}><div className="boardsMobileItemPicker">{contextItems.map((item) => <label key={item.id} style={{ '--item-depth': itemDepth(item, contextItems) } as CSSProperties}><input type="checkbox" checked={itemIds.includes(item.id)} onChange={() => setItemIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><Icon name={item.kind === 'folder' ? 'folder-light' : 'file-document-light'} /><span>{item.title}</span></label>)}{!contextItems.length && <p>{t('notes.noItems')}</p>}</div></MobileNotePickerSheet>}
        {mobilePicker === 'tags' && <MobileNotePickerSheet title={t('notes.tags')} onClose={() => setMobilePicker(null)}><div className="boardsMobileTagPicker"><div className="boardsMobileTagChoices">{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} /><span style={{ '--tag-color': tag.color } as CSSProperties}>{tag.name}</span></label>)}</div><div className="boardsMobileTagCreate"><input value={tagName} maxLength={40} placeholder={t('notes.newTag')} onChange={(event) => setTagName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createTag() }} /><button type="button" className="spaceButton" aria-label={t('notes.addTag')} disabled={!tagName.trim() || addingTag} onClick={() => void createTag()}><Icon name="sign-plus-light" /></button></div></div></MobileNotePickerSheet>}
      </aside>
    </div>
    {discardConfirmOpen && <ActionDialog variant="structured" role="alertdialog" title={t('audioNotes.discardTitle')} closeLabel={t('common.cancel')} className="boardsConfirmDialog" onClose={() => setDiscardConfirmOpen(false)}><div className="standardDialogSection"><p>{t('audioNotes.confirmDiscard')}</p><footer className="standardDialogFooter"><button type="button" className="dialogCancel booksButton" onClick={() => setDiscardConfirmOpen(false)}>{t('common.cancel')}</button><button type="button" className="dialogSubmit danger booksButton" onClick={() => { setDiscardConfirmOpen(false); void closeEditor(true) }}>{t('audioNotes.discardAction')}</button></footer></div></ActionDialog>}
    </>
  )
}

function MobileNotePickerSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  const { backdropStateClass, close: closeSheet, closing, setDialogRef } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') closeSheet() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeSheet])

  return <div className={`dialogBackdrop mobileBottomSheetBackdrop boardsMobilePickerBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSheet() }}><section className="createOneShotDialog mobileBottomSheet boardsMobilePickerSheet" role="dialog" aria-modal="true" aria-label={title} ref={setDialogRef}><header><div><h2>{title}</h2></div><button type="button" className="dialogClose booksButton" aria-label={t('common.close')} disabled={closing} onClick={closeSheet}><Icon name="close-square-light" /></button></header><div className="boardsMobilePickerBody">{children}</div><footer><button type="button" className="dialogSubmit booksButton" disabled={closing} onClick={closeSheet}>{t('common.close')}</button></footer></section></div>
}

function itemDepth(item: NoteContextItem, items: NoteContextItem[]) {
  const byId = new Map(items.map((candidate) => [candidate.id, candidate]))
  let depth = 0
  let parent = item.parentId ? byId.get(item.parentId) : undefined
  while (parent && depth < 3) {
    depth += 1
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return depth
}

function audioErrorKey(code: AudioRecorderError) {
  return code
}
