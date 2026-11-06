import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { CSSProperties } from 'react'
import type { JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import StarterKit from '@tiptap/starter-kit'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiRequest, apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { Illustration } from './Illustration'
import { ImageUploadPlaceholder, removeImageUploadPlaceholder, replaceImageUploadPlaceholder, showImageUploadPlaceholder } from './ImageUploadPlaceholder'
import { PrivateImage } from '../shared/PrivateImage'
import { StorageImagePickerDialog } from '../shared/StorageImagePickerDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { AudioNotePlayer, AudioWaveform } from '../shared/AudioNotePlayer'
import { AudioTranscriptionPanel } from '../shared/AudioTranscriptionPanel'
import { formatAudioDuration } from './audioNoteRecording'
import { NoteColorPicker } from './NoteColorPicker'
import { NoteContentPreview } from './NoteContentPreview'
import type { StorageItem } from '../../types'
import type { Board, Note, NoteDraft, NoteTag } from './BoardsTypes'
import { EMPTY_NOTE_CONTENT, NOTE_SCHEMA_VERSION, noteTagCssColor, pickNoteTagColor } from './BoardsTypes'

const NOTE_COLORS = ['yellow', 'blue', 'green', 'purple', 'orange', 'pink', 'gray'] as const

type Props = {
  manuscriptId: string
  selectedItemId: string | null
  onError: (error: string) => void
}

type NotesScope = 'all' | 'linked'

export function EditorNotesPanel({ manuscriptId, selectedItemId, onError }: Props) {
  const { t, i18n } = useTranslation()
  const [scope, setScope] = useState<NotesScope>('all')
  const [boards, setBoards] = useState<Board[]>([])
  const [tags, setTags] = useState<NoteTag[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeNote, setActiveNote] = useState<Note | null>(null)
  const [editing, setEditing] = useState(false)

  const loadNotes = useCallback(async () => {
    if (scope === 'linked' && !selectedItemId) {
      setNotes([])
      return
    }
    const params = new URLSearchParams({ view: 'all' })
    if (scope === 'linked' && selectedItemId) params.set('itemId', selectedItemId)
    const payload = await apiRequest<{ items: Note[] }>(`/api/manuscripts/${manuscriptId}/notes/?${params}`)
    setNotes(payload.items)
  }, [manuscriptId, scope, selectedItemId])

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      try {
        const [boardPayload, tagPayload] = await Promise.all([
          apiRequest<{ items: Board[] }>(`/api/manuscripts/${manuscriptId}/boards/`),
          apiRequest<{ items: NoteTag[] }>(`/api/manuscripts/${manuscriptId}/note-tags/`),
        ])
        if (!active) return
        setBoards(boardPayload.items)
        setTags(tagPayload.items)
        await loadNotes()
      } catch (error) {
        if (active) onError(error instanceof Error ? error.message : i18n.t('notes.loadFailed'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [i18n, loadNotes, manuscriptId, onError])

  const locale = i18n.resolvedLanguage ?? 'en'
  const filteredNotes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale)
    if (!query) return notes
    return notes.filter((note) => (
      `${note.title} ${note.preview} ${noteContentText(note.content)}`.toLocaleLowerCase(locale).includes(query)
    ))
  }, [locale, notes, search])

  async function createTag(name: string) {
    const payload = await apiRequest<{ tag: NoteTag }>(`/api/manuscripts/${manuscriptId}/note-tags/`, {
      method: 'POST',
      body: JSON.stringify({ name, color: pickNoteTagColor(name, tags.map((tag) => tag.color)) }),
    })
    setTags((current) => [...current, payload.tag])
    return payload.tag
  }

  async function saveNote(draft: NoteDraft, note: Note | null) {
    const payload = await apiRequest<{ note: Note }>(
      note ? `/api/manuscripts/notes/${note.id}/` : `/api/manuscripts/${manuscriptId}/notes/`,
      {
        method: note ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...draft,
          schemaVersion: NOTE_SCHEMA_VERSION,
          ...(note ? { expectedGeneration: note.saveGeneration } : {}),
        }),
      },
    )
    setNotes((current) => {
      const matchesLinked = scope !== 'linked'
        || payload.note.associatedItems.some((item) => item.id === selectedItemId)
      if (!matchesLinked) return current.filter((item) => item.id !== payload.note.id)
      const exists = current.some((item) => item.id === payload.note.id)
      const next = exists
        ? current.map((item) => item.id === payload.note.id ? payload.note : item)
        : [payload.note, ...current]
      return next.sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    })
    setActiveNote(payload.note)
    return payload.note
  }

  if (editing && activeNote?.kind === 'audio' && activeNote.audio) {
    return <EditorAudioNoteDetail manuscriptId={manuscriptId} note={activeNote} onBack={() => { setEditing(false); setActiveNote(null) }} />
  }

  if (editing) {
    return (
      <EditorNoteForm
        key={activeNote?.id ?? 'new'}
        manuscriptId={manuscriptId}
        note={activeNote}
        selectedItemId={selectedItemId}
        boards={boards}
        tags={tags}
        onBack={() => {
          setEditing(false)
          setActiveNote(null)
          void loadNotes()
        }}
        onSave={saveNote}
        onCreateTag={createTag}
        onError={onError}
      />
    )
  }

  return (
    <div className="editorNotesPanel">
      <header className="editorNotesHeader">
        <div className="commentFilters editorNotesScope" role="tablist" aria-label={t('notes.scope')}>
          <button type="button" className={`spaceButton ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>{t('notes.allNotes')}</button>
          <button type="button" className={`spaceButton ${scope === 'linked' ? 'active' : ''}`} onClick={() => setScope('linked')}>{t('notes.linkedNotes')}</button>
        </div>
        <button type="button" className="plannerAddTask editorAddNoteButton spaceButton" onClick={() => { setActiveNote(null); setEditing(true) }}>
          <Icon name="document-light" /> {t('notes.addNote')}
        </button>
      </header>
      <div className="editorNotesSearchBlock">
        <label className="editorNotesSearch">
          <SearchIcon />
          <input value={search} placeholder={t('notes.search')} aria-label={t('notes.search')} onChange={(event) => setSearch(event.target.value)} />
          {search && <button type="button" className="spaceButton" aria-label={t('notes.clearSearch')} onClick={() => setSearch('')}><Icon name="close-light" /></button>}
        </label>
      </div>
      {loading ? (
        <TadpoleLoadingState className="editorNotesState" label={t('notes.loading')} />
      ) : filteredNotes.length ? (
        <div className="editorNotesList">
          {filteredNotes.map((note) => (
            <button type="button" className="editorNoteCard spaceButton" key={note.id} data-color={note.color} style={note.color.startsWith('#') ? { '--note-color': note.color } as CSSProperties : undefined} onClick={() => { setActiveNote(note); setEditing(true) }}>
              <span className="editorNoteCardTitle">
                <strong>{note.title || t('notes.untitled')}</strong>
                <NoteFlags note={note} />
              </span>
              {note.kind === 'audio' && note.audio ? <span className="editorAudioNoteCardPreview"><Icon name="microphone-3-linear" /><AudioWaveform values={note.audio.waveform} compact /></span> : <>{firstNoteImage(note.content) && <span className="editorNoteCardImage"><PrivateImage src={firstNoteImage(note.content)!.src} alt={firstNoteImage(note.content)!.alt} loading="lazy" decoding="async" draggable={false} /></span>}<NoteContentPreview content={note.content} className="editorNoteCardContent" /></>}
              <span className="editorNoteCardMeta">
                <span>{note.tags.slice(0, 3).map((tag) => <i key={tag.id} style={{ '--tag-color': noteTagCssColor(tag.color) } as CSSProperties}>{tag.name}</i>)}</span>
                <time>{formatRelative(note.updatedAt, locale, t)}</time>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="editorNotesState">
          {t(search.trim() ? 'notes.noSearchMatches' : scope === 'linked' ? 'notes.noLinkedNotes' : 'notes.noNotes')}
        </div>
      )}
    </div>
  )
}

function EditorAudioNoteDetail({ manuscriptId, note, onBack }: { manuscriptId: string; note: Note; onBack: () => void }) {
  const { t } = useTranslation()
  if (!note.audio) return null
  return (
    <section className="editorAudioNoteDetail">
      <header>
        <button type="button" className="spaceButton" aria-label={t('notes.backToNotes')} onClick={onBack}><Icon name="arrow-left-1" /></button>
        <div><h2>{note.title || t('notes.untitled')}</h2><span>{t('audioNotes.readOnly')}</span></div>
      </header>
      <div className="editorAudioNotePlayer"><AudioNotePlayer audio={note.audio} /></div>
      <AudioTranscriptionPanel noteId={note.id} controls={false} />
      <dl>
        <div><dt>{t('storage.duration')}</dt><dd>{formatAudioDuration(note.audio.durationMs)}</dd></div>
      </dl>
      <button type="button" className="editorAudioOpenBoards spaceButton" onClick={() => navigateToBoards(manuscriptId, note.id)}><Icon name="widget-light" />{t('audioNotes.openInBoards')}</button>
    </section>
  )
}

function navigateToBoards(manuscriptId: string, noteId: string) {
  window.history.pushState({}, '', `/manuscripts/${manuscriptId}/boards?note=${encodeURIComponent(noteId)}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function EditorNoteForm({
  manuscriptId,
  note,
  selectedItemId,
  boards,
  tags,
  onBack,
  onSave,
  onCreateTag,
  onError,
}: {
  manuscriptId: string
  note: Note | null
  selectedItemId: string | null
  boards: Board[]
  tags: NoteTag[]
  onBack: () => void
  onSave: (draft: NoteDraft, note: Note | null) => Promise<Note>
  onCreateTag: (name: string) => Promise<NoteTag>
  onError: (error: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [currentNote, setCurrentNote] = useState(note)
  const [title, setTitle] = useState(note?.title ?? '')
  const [content, setContent] = useState<JSONContent>(note?.content ?? EMPTY_NOTE_CONTENT)
  const [boardId, setBoardId] = useState(note?.boardId ?? '')
  const [color, setColor] = useState(note?.color ?? 'blue')
  const [tagIds, setTagIds] = useState<string[]>(note?.tags.map((tag) => tag.id) ?? [])
  const [pinned, setPinned] = useState(note?.pinned ?? false)
  const [favourite, setFavourite] = useState(note?.favourite ?? false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [tagCreateOpen, setTagCreateOpen] = useState(false)
  const [tagName, setTagName] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(() => note === null)
  const [savedSignature, setSavedSignature] = useState(() => draftSignature(note ? draftFromNote(note) : emptyDraft(selectedItemId)))
  const saveTimerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const editor = useEditor({
    injectCSS: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        orderedList: false,
      }),
      TaskList,
      TaskItem.configure({
        nested: false,
        a11y: { checkboxLabel: (_node, checked) => t(checked ? 'notes.markIncomplete' : 'notes.markComplete') },
      }),
      Illustration,
      ImageUploadPlaceholder,
    ],
    content: note?.content ?? EMPTY_NOTE_CONTENT,
    immediatelyRender: false,
    editorProps: { attributes: { class: 'editorNotesTiptap', 'aria-label': t('notes.noteText') } },
    onUpdate: ({ editor: currentEditor }) => setContent(currentEditor.getJSON()),
  })

  useEffect(() => {
    editor?.setOptions({ editorProps: { attributes: { class: 'editorNotesTiptap', 'aria-label': t('notes.noteText') } } })
  }, [editor, i18n.resolvedLanguage, t])

  const draft = useMemo<NoteDraft>(() => ({
    title,
    content,
    color,
    boardId: boardId || null,
    tagIds,
    itemIds: currentNote
      ? currentNote.associatedItems.map((item) => item.id)
      : selectedItemId ? [selectedItemId] : [],
    pinned,
    favourite,
  }), [boardId, color, content, currentNote, favourite, pinned, selectedItemId, tagIds, title])
  const signature = draftSignature(draft)
  const meaningful = Boolean(title.trim() || noteText(content) || assetIds(content).length)
  const displayedTitle = title.trim() || t(currentNote ? 'notes.untitled' : 'notes.newNote')
  const saveState: 'saved' | 'dirty' | 'saving' | 'error' = saveFailed
    ? 'error'
    : saving
      ? 'saving'
      : signature !== savedSignature && meaningful ? 'dirty' : 'saved'

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select()
  }, [editingTitle])

  useEffect(() => {
    if (!meaningful || saving || signature === savedSignature) return
    saveTimerRef.current = window.setTimeout(async () => {
      setSaving(true)
      setSaveFailed(false)
      const savingSignature = signature
      try {
        const saved = await onSave(draft, currentNote)
        setCurrentNote(saved)
        setSavedSignature(savingSignature)
      } catch (error) {
        setSaveFailed(true)
        onError(error instanceof Error ? error.message : i18n.t('notes.saveFailed'))
      } finally {
        setSaving(false)
      }
    }, 800)
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [currentNote, draft, i18n, meaningful, onError, onSave, savedSignature, saving, signature])

  async function closeEditor() {
    if (saving) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    if (!meaningful || signature === savedSignature) {
      onBack()
      return
    }
    setSaving(true)
    setSaveFailed(false)
    try {
      await onSave(draft, currentNote)
      onBack()
    } catch (error) {
      setSaveFailed(true)
      onError(error instanceof Error ? error.message : i18n.t('notes.saveFailed'))
      setSaving(false)
    }
  }

  async function uploadImage(file: File | undefined) {
    if (!file || !editor || uploading) return
    const placeholderId = showImageUploadPlaceholder(editor, t('uploads.processingImage'))
    setUploading(true)
    try {
      const form = new FormData()
      form.append('image', file)
      const payload = await apiUpload<{ asset: { id: string; alt: string; caption: string } }>(
        `/api/manuscripts/${manuscriptId}/assets/`,
        form,
      )
      replaceImageUploadPlaceholder(editor, placeholderId, {
        type: 'illustration',
        attrs: { assetId: payload.asset.id, alt: payload.asset.alt, caption: payload.asset.caption, alignment: 'center' },
      })
    } catch (error) {
      if (!editor.isDestroyed) removeImageUploadPlaceholder(editor, placeholderId)
      onError(error instanceof Error ? error.message : i18n.t('notes.uploadFailed'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function selectStoredImage(item: StorageItem) {
    if (!editor || uploading) return
    const placeholderId = showImageUploadPlaceholder(editor, t('uploads.processingImage'))
    setUploading(true)
    try {
      const form = new FormData()
      form.set('mediaId', item.id.replace(/^media:/, ''))
      const payload = await apiUpload<{ asset: { id: string; alt: string; caption: string } }>(`/api/manuscripts/${manuscriptId}/assets/`, form)
      replaceImageUploadPlaceholder(editor, placeholderId, { type: 'illustration', attrs: { assetId: payload.asset.id, alt: payload.asset.alt, caption: payload.asset.caption, alignment: 'center' } })
      setImagePickerOpen(false)
    } catch (err) {
      if (!editor.isDestroyed) removeImageUploadPlaceholder(editor, placeholderId)
      onError(err instanceof Error ? err.message : i18n.t('notes.uploadFailed'))
    } finally {
      setUploading(false)
    }
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
      onError(error instanceof Error ? error.message : i18n.t('notes.createTagFailed'))
    } finally {
      setAddingTag(false)
    }
  }

  return (
    <div className="editorNoteForm">
      <header className="editorNoteFormHeader">
        <button type="button" className="spaceButton" aria-label={t('notes.backToNotes')} disabled={saving} onClick={() => void closeEditor()}><Icon name="arrow-left-1" /></button>
        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="editorNoteHeaderTitle"
            value={title}
            maxLength={240}
            placeholder={t(currentNote ? 'notes.untitled' : 'notes.newNote')}
            aria-label={t('notes.noteTitle')}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
            }}
          />
        ) : (
          <button type="button" className="editorNoteHeaderTitleButton spaceButton" title={t('notes.renameNote')} onClick={() => setEditingTitle(true)}>
            {displayedTitle}
          </button>
        )}
        <span className={`editorNoteSaveButton ${saveState}`} role="status" aria-label={saveStateLabel(saveState, t)} title={saveStateLabel(saveState, t)}>
          <Icon name={saveState === 'saved' ? 'cloud-yes' : saveState === 'error' ? 'cloud-no' : 'cloud-upload'} />
        </span>
      </header>
      <div className="editorNoteFormBody">
        <div className="editorNoteFormatBar" aria-label={t('notes.noteFormatting')}>
          <button type="button" className={`spaceButton ${editor?.isActive('bold') ? 'active' : ''}`} aria-label={t('notes.bold')} onClick={() => editor?.chain().focus().toggleBold().run()}><Icon name="text-bold-light" /></button>
          <button type="button" className={`spaceButton ${editor?.isActive('italic') ? 'active' : ''}`} aria-label={t('notes.italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}><Icon name="text-italic-light" /></button>
          <button type="button" className={`spaceButton ${editor?.isActive('strike') ? 'active' : ''}`} aria-label={t('notes.strikethrough')} onClick={() => editor?.chain().focus().toggleStrike().run()}><Icon name="text-cross-light" /></button>
          <span />
          <button type="button" className={`spaceButton ${editor?.isActive('bulletList') ? 'active' : ''}`} aria-label={t('notes.bulletedList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}><Icon name="mingcute-list-check-line" className="mingcuteToolbarIcon" /></button>
          <button type="button" className={`spaceButton ${editor?.isActive('taskList') ? 'active' : ''}`} aria-label={t('notes.checklist')} onClick={() => editor?.chain().focus().toggleTaskList().run()}><Icon name="mingcute-list-check-2-line" className="mingcuteToolbarIcon" /></button>
          <span />
          <button type="button" className="spaceButton" aria-label={t('notes.addImage')} disabled={uploading} onClick={() => setImagePickerOpen(true)}><Icon name="gallery-light" /></button>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => void uploadImage(event.target.files?.[0])} />
          <StorageImagePickerDialog open={imagePickerOpen} onClose={() => setImagePickerOpen(false)} onSelect={(item) => void selectStoredImage(item)} onUpload={() => { setImagePickerOpen(false); fileInputRef.current?.click() }} />
        </div>
        <EditorContent editor={editor} />

        <section className="editorNoteSection">
          <h3>{t('notes.board')}</h3>
          <CustomSelect value={boardId} onChange={(event) => setBoardId(event.target.value)}>
            <option value="">{t('notes.noBoard')}</option>
            {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
          </CustomSelect>
        </section>
        <section className="editorNoteSection">
          <h3>{t('notes.color')}</h3>
          <div className="editorNoteColors">
            {NOTE_COLORS.map((candidate) => (
              <button key={candidate} type="button" className={color === candidate ? `spaceButton active ${candidate}` : `spaceButton ${candidate}`} aria-label={t('notes.noteColor', { color: t(`notes.colors.${candidate}`) })} onClick={() => setColor(candidate)} />
            ))}
            <NoteColorPicker value={color} onChange={setColor} />
          </div>
        </section>
        <section className="editorNoteSection">
          <h3>{t('notes.tags')}</h3>
          <div className="editorNoteTagChoices">
            {tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} /><span style={{ '--tag-color': tag.color } as CSSProperties}>{tag.name}</span></label>)}
            {!tagCreateOpen && <button type="button" className="spaceButton editorNoteAddTagButton" aria-label={t('notes.createTag')} onClick={(event) => { event.stopPropagation(); setTagCreateOpen(true) }}><Icon name="sign-plus-light" /></button>}
          </div>
          {tagCreateOpen && <div className="editorNoteInlineCreate"><input autoFocus value={tagName} maxLength={40} placeholder={t('notes.newTag')} onChange={(event) => setTagName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createTag(); if (event.key === 'Escape') { setTagCreateOpen(false); setTagName('') } }} /><button type="button" className="spaceButton" aria-label={t('notes.addTag')} disabled={!tagName.trim() || addingTag} onClick={() => void createTag()}><Icon name="sign-plus-light" /></button></div>}
        </section>
        <div className="editorNoteOptions">
          <button type="button" className={`spaceButton ${pinned ? 'active' : ''}`} onClick={() => setPinned((value) => !value)}><Icon name="pin-light" /> {t(pinned ? 'notes.pinned' : 'notes.pinNote')}</button>
          <button type="button" className={`spaceButton ${favourite ? 'active' : ''}`} onClick={() => setFavourite((value) => !value)}><Icon name="star-light" /> {t(favourite ? 'notes.favourite' : 'notes.addToFavourites')}</button>
        </div>
      </div>
    </div>
  )
}

function emptyDraft(selectedItemId: string | null): NoteDraft {
  return {
    title: '',
    content: EMPTY_NOTE_CONTENT,
    color: 'blue',
    boardId: null,
    tagIds: [],
    itemIds: selectedItemId ? [selectedItemId] : [],
    pinned: false,
    favourite: false,
  }
}

function draftFromNote(note: Note): NoteDraft {
  return {
    title: note.title,
    content: note.content,
    color: note.color,
    boardId: note.boardId,
    tagIds: note.tags.map((tag) => tag.id),
    itemIds: note.associatedItems.map((item) => item.id),
    pinned: note.pinned,
    favourite: note.favourite,
  }
}

function draftSignature(draft: NoteDraft) { return JSON.stringify(draft) }
function assetIds(content: JSONContent) { return (content.content ?? []).filter((node) => node.type === 'illustration').map((node) => String(node.attrs?.assetId ?? '')).filter(Boolean) }
function noteText(node: JSONContent): string { return `${node.text ?? ''}${(node.content ?? []).map(noteText).join('')}`.trim() }
function noteContentText(node: JSONContent): string { return `${node.text ?? ''} ${(node.content ?? []).map(noteContentText).join(' ')}` }
function firstNoteImage(node: JSONContent): { src: string; alt: string } | null {
  if (node.type === 'illustration') {
    const assetId = String(node.attrs?.assetId ?? '')
    if (!assetId) return null
    return { src: `${API_BASE}/api/manuscripts/assets/${assetId}/medium/`, alt: String(node.attrs?.alt ?? '') }
  }
  for (const child of node.content ?? []) {
    const image = firstNoteImage(child)
    if (image) return image
  }
  return null
}
function formatRelative(value: string, locale: string, t: TFunction) { const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return t('boards.now'); if (seconds < 3600) return t('boards.minutesAgo', { count: Math.floor(seconds / 60) }); if (seconds < 86400) return t('boards.hoursAgo', { count: Math.floor(seconds / 3600) }); return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(value)) }
function NoteFlags({ note }: { note: Note }) { if (!note.pinned && !note.favourite) return <span />; return <span>{note.pinned && <Icon name="pin-light" />}{note.favourite && <Icon name="star-light" />}</span> }
function SearchIcon() { return <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg> }
function saveStateLabel(state: 'saved' | 'dirty' | 'saving' | 'error', t: TFunction) {
  return {
    saved: t('notes.saved'),
    dirty: t('notes.dirty'),
    saving: t('notes.saving'),
    error: t('notes.saveStateFailed'),
  }[state]
}
