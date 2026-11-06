import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import type { JSONContent } from '@tiptap/core'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiQuery, apiRequest, apiUpload } from '../../api/client'
import type { Manuscript } from './ManuscriptTypes'
import { Icon, type IconName } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { AudioWaveform } from '../shared/AudioNotePlayer'
import { PrivateImage } from '../shared/PrivateImage'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { NoteContentPreview } from './NoteContentPreview'
import { BoardsSaveStatusIndicator } from './BoardsSaveStatusIndicator'
import type { AudioNoteDraft, Board, BoardsSaveStatus, BoardsView, Note, NoteContextItem, NoteDraft, NoteTag } from './BoardsTypes'
import { NOTE_SCHEMA_VERSION, noteTagCssColor, pickNoteTagColor } from './BoardsTypes'
import './BoardsPage.css'

type Props = { manuscript: Manuscript; initialNoteId: string | null; onError: (error: string) => void }
type BoardsConfirmAction =
  | { kind: 'delete-note'; note: Note }
  | { kind: 'empty-trash' }
  | { kind: 'bulk-unarchive' }
  | { kind: 'bulk-restore' }
type NoteDropTarget = BoardsView | 'all-notes' | `board:${string}`

const viewLabelKeys: Record<BoardsView, string> = { boards: 'boards.boards', favourites: 'boards.favourites', archive: 'boards.archive', trash: 'boards.trash' }
const apiViews: Record<BoardsView, string> = { boards: 'all', favourites: 'favourites', archive: 'archive', trash: 'trash' }
const emptyViewIcons: Record<BoardsView, IconName> = {
  boards: 'widget-light',
  favourites: 'star-light',
  archive: 'archive-light',
  trash: 'trash-bin-trash-light',
}
const NOTE_COLUMN_WIDTH = 260
const NOTE_COLUMN_GAP = 14
const BoardsNoteEditor = lazy(() => import('./BoardsNoteEditor').then((module) => ({ default: module.BoardsNoteEditor })))
const BoardsAudioNoteEditor = lazy(() => import('./BoardsAudioNoteEditor').then((module) => ({ default: module.BoardsAudioNoteEditor })))

export function BoardsPage({ manuscript, initialNoteId, onError }: Props) {
  const { t, i18n } = useTranslation()
  const [view, setView] = useState<BoardsView>('boards')
  const [boards, setBoards] = useState<Board[]>([])
  const [tags, setTags] = useState<NoteTag[]>([])
  const [contextItems, setContextItems] = useState<NoteContextItem[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null)
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null)
  const [tagSearch, setTagSearch] = useState('')
  const [tagSearchOpen, setTagSearchOpen] = useState(false)
  const [noteSearch, setNoteSearch] = useState('')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)
  const [mobileCreateMenuOpen, setMobileCreateMenuOpen] = useState(false)
  const [mobileBoardSelectorOpen, setMobileBoardSelectorOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [activeNote, setActiveNote] = useState<Note | null>(null)
  const [boardMenuId, setBoardMenuId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set())
  const [saveStatus, setSaveStatus] = useState<BoardsSaveStatus>('saved')
  const [confirmAction, setConfirmAction] = useState<BoardsConfirmAction | null>(null)
  const [createBoardOpen, setCreateBoardOpen] = useState(false)
  const [renamingBoard, setRenamingBoard] = useState<Board | null>(null)
  const [deletingBoard, setDeletingBoard] = useState<Board | null>(null)
  const [newBoardName, setNewBoardName] = useState('')
  const [boardSubmitting, setBoardSubmitting] = useState(false)
  const [dragOverTarget, setDragOverTarget] = useState<NoteDropTarget | null>(null)
  const mobileSearchRef = useRef<HTMLDivElement>(null)
  const mobileSearchInputRef = useRef<HTMLInputElement>(null)
  const mobileBottomBarRef = useRef<HTMLElement>(null)
  const mobileBoardSelectorRef = useRef<HTMLDivElement>(null)
  const tagSearchRef = useRef<HTMLElement>(null)
  const boardTabsRef = useRef<HTMLDivElement>(null)
  const notesGridRef = useRef<HTMLElement>(null)
  const notesQueryRef = useRef('')
  const routeNoteRef = useRef<string | null>(null)
  const editorSessionCounterRef = useRef(0)
  const [noteColumnCount, setNoteColumnCount] = useState(1)
  const [editorSessionKey, setEditorSessionKey] = useState('closed')
  const [editorKind, setEditorKind] = useState<'text' | 'audio'>('text')

  const loadNotes = useCallback(async () => {
    const params = new URLSearchParams({ view: apiViews[view] })
    if (selectedBoardId && view === 'boards') params.set('boardId', selectedBoardId)
    if (selectedTagId) params.set('tagId', selectedTagId)
    const path = `/api/manuscripts/${manuscript.id}/notes/?${params}`
    notesQueryRef.current = path
    const payload = await apiQuery<{ items: Note[] }>(path, {
      onBackgroundUpdate: (next) => {
        if (notesQueryRef.current === path) setNotes(next.items)
      },
    })
    if (notesQueryRef.current === path) setNotes(payload.items)
  }, [manuscript.id, selectedBoardId, selectedTagId, view])

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      try {
        const [boardPayload, tagPayload, contextPayload] = await Promise.all([
          apiQuery<{ items: Board[] }>(`/api/manuscripts/${manuscript.id}/boards/`, {
            onBackgroundUpdate: (next) => {
              if (active) setBoards(next.items)
            },
          }),
          apiQuery<{ items: NoteTag[] }>(`/api/manuscripts/${manuscript.id}/note-tags/`, {
            onBackgroundUpdate: (next) => {
              if (active) setTags(next.items)
            },
          }),
          apiQuery<{ items: NoteContextItem[] }>(`/api/manuscripts/${manuscript.id}/note-context/`, {
            onBackgroundUpdate: (next) => {
              if (active) setContextItems(next.items)
            },
          }),
        ])
        if (!active) return
        setBoards(boardPayload.items)
        setTags(tagPayload.items)
        setContextItems(contextPayload.items)
        await loadNotes()
      } catch (err) {
        if (active) onError(err instanceof Error ? err.message : i18n.t('boards.loadFailed'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [i18n, loadNotes, manuscript.id, onError])

  useEffect(() => {
    if (!initialNoteId || routeNoteRef.current === initialNoteId) return
    routeNoteRef.current = initialNoteId
    let active = true
    async function openInitialNote() {
      try {
        const payload = await apiRequest<{ note: Note }>(`/api/manuscripts/notes/${initialNoteId}/`)
        if (!active) return
        editorSessionCounterRef.current += 1
        setEditorSessionKey(`${payload.note.id}:${editorSessionCounterRef.current}`)
        setActiveNote(payload.note)
        setEditorKind(payload.note.kind)
        setEditorOpen(true)
        setView('boards')
        setSelectedBoardId(payload.note.boardId)
      } catch (err) {
        if (active) onError(err instanceof Error ? err.message : i18n.t('boards.openNoteFailed'))
      }
    }
    void openInitialNote()
    return () => {
      active = false
    }
  }, [i18n, initialNoteId, onError])

  useEffect(() => {
    if (!mobileSidebarOpen && !mobileSearchOpen && !mobileActionsOpen && !mobileCreateMenuOpen && !mobileBoardSelectorOpen) return
    function closeMobileControlsOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setMobileSidebarOpen(false)
      setMobileSearchOpen(false)
      setMobileActionsOpen(false)
      setMobileCreateMenuOpen(false)
      setMobileBoardSelectorOpen(false)
      setBoardMenuId(null)
    }
    document.addEventListener('keydown', closeMobileControlsOnEscape)
    return () => document.removeEventListener('keydown', closeMobileControlsOnEscape)
  }, [mobileActionsOpen, mobileBoardSelectorOpen, mobileCreateMenuOpen, mobileSearchOpen, mobileSidebarOpen])

  useEffect(() => {
    if (!mobileSearchOpen) return
    mobileSearchInputRef.current?.focus()
    function closeMobileSearch(event: MouseEvent) {
      if (mobileSearchRef.current?.contains(event.target as Node)) return
      if (mobileBottomBarRef.current?.contains(event.target as Node)) return
      setMobileSearchOpen(false)
    }
    document.addEventListener('mousedown', closeMobileSearch)
    return () => document.removeEventListener('mousedown', closeMobileSearch)
  }, [mobileSearchOpen])

  useEffect(() => {
    if (!mobileActionsOpen && !mobileCreateMenuOpen) return
    function closeMobileActions(event: MouseEvent) {
      if (!mobileBottomBarRef.current?.contains(event.target as Node)) {
        setMobileActionsOpen(false)
        setMobileCreateMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', closeMobileActions)
    return () => document.removeEventListener('mousedown', closeMobileActions)
  }, [mobileActionsOpen, mobileCreateMenuOpen])

  useEffect(() => {
    if (!mobileBoardSelectorOpen) return
    function closeMobileBoardSelector(event: PointerEvent) {
      const target = event.target as Element
      if (target.closest('.boardsMobileBoardSelectorToggle, .boardsMobileBoardSelectorMenu')) return
      setMobileBoardSelectorOpen(false)
      setBoardMenuId(null)
    }
    document.addEventListener('pointerdown', closeMobileBoardSelector)
    return () => document.removeEventListener('pointerdown', closeMobileBoardSelector)
  }, [mobileBoardSelectorOpen])

  useEffect(() => {
    if (!tagSearchOpen) return
    function closeTagSearch(event: MouseEvent) {
      if (tagSearchRef.current?.contains(event.target as Node)) return
      setTagSearchOpen(false)
      setTagSearch('')
    }
    function closeTagSearchOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setTagSearchOpen(false)
      setTagSearch('')
    }
    document.addEventListener('mousedown', closeTagSearch)
    document.addEventListener('keydown', closeTagSearchOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeTagSearch)
      document.removeEventListener('keydown', closeTagSearchOnEscape)
    }
  }, [tagSearchOpen])

  useEffect(() => {
    if (!boardMenuId) return
    function closeBoardMenu(event: MouseEvent) {
      if (boardTabsRef.current?.contains(event.target as Node)) return
      if (mobileBoardSelectorRef.current?.contains(event.target as Node)) return
      setBoardMenuId(null)
    }
    function closeBoardMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setBoardMenuId(null)
    }
    document.addEventListener('mousedown', closeBoardMenu)
    document.addEventListener('keydown', closeBoardMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeBoardMenu)
      document.removeEventListener('keydown', closeBoardMenuOnEscape)
    }
  }, [boardMenuId])

  async function createBoard() {
    const name = newBoardName.trim()
    if (!name || boardSubmitting) return false
    setBoardSubmitting(true)
    onError('')
    try {
      const payload = await apiRequest<{ board: Board }>(`/api/manuscripts/${manuscript.id}/boards/`, { method: 'POST', body: JSON.stringify({ name }) })
      setBoards((current) => [...current, payload.board])
      setSelectedBoardId(payload.board.id)
      setSelectedNoteIds(new Set())
      return true
    } catch (err) {
      onError(err instanceof Error ? err.message : t('boards.createBoardFailed'))
      return false
    }
    finally { setBoardSubmitting(false) }
  }

  async function renameBoard() {
    if (!renamingBoard || boardSubmitting) return false
    const name = newBoardName.trim()
    if (!name) return false
    if (name === renamingBoard.name) {
      return true
    }
    setBoardSubmitting(true)
    onError('')
    try {
      const payload = await apiRequest<{ board: Board }>(`/api/manuscripts/boards/${renamingBoard.id}/`, { method: 'PATCH', body: JSON.stringify({ name }) })
      setBoards((current) => current.map((item) => item.id === renamingBoard.id ? payload.board : item))
      return true
    } catch (err) {
      onError(err instanceof Error ? err.message : t('boards.renameBoardFailed'))
      return false
    }
    finally { setBoardSubmitting(false) }
  }

  async function deleteBoard() {
    if (!deletingBoard || boardSubmitting) return
    const board = deletingBoard
    setBoardSubmitting(true)
    onError('')
    try {
      await apiRequest(`/api/manuscripts/boards/${board.id}/`, { method: 'DELETE' })
      setBoards((current) => current.filter((item) => item.id !== board.id))
      setNotes((current) => current.map((note) => note.boardId === board.id ? { ...note, boardId: null } : note))
      if (selectedBoardId === board.id) setSelectedBoardId(null)
      if (activeNote?.boardId === board.id) { setActiveNote(null); setEditorOpen(false) }
      setDeletingBoard(null)
    } catch (err) { onError(err instanceof Error ? err.message : t('boards.deleteBoardFailed')) }
    finally { setBoardSubmitting(false) }
  }

  async function createTag(name: string) {
    const payload = await apiRequest<{ tag: NoteTag }>(`/api/manuscripts/${manuscript.id}/note-tags/`, { method: 'POST', body: JSON.stringify({ name, color: pickNoteTagColor(name, tags.map((tag) => tag.color)) }) })
    setTags((current) => [...current, payload.tag])
    return payload.tag
  }

  const saveNote = useCallback(async (draft: NoteDraft, note: Note | null) => {
    const body = JSON.stringify({ ...draft, schemaVersion: NOTE_SCHEMA_VERSION, ...(note ? { expectedGeneration: note.saveGeneration } : {}) })
    const payload = await apiRequest<{ note: Note }>(note ? `/api/manuscripts/notes/${note.id}/` : `/api/manuscripts/${manuscript.id}/notes/`, { method: note ? 'PATCH' : 'POST', body })
    setNotes((current) => {
      const matchesView = (
        (view !== 'favourites' || payload.note.favourite)
        && (!selectedBoardId || payload.note.boardId === selectedBoardId)
        && (!selectedTagId || payload.note.tags.some((tag) => tag.id === selectedTagId))
      )
      if (!matchesView) return current.filter((item) => item.id !== payload.note.id)
      const exists = current.some((item) => item.id === payload.note.id)
      const next = exists
        ? current.map((item) => item.id === payload.note.id ? payload.note : item)
        : [payload.note, ...current]
      return next.sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    })
    setActiveNote(payload.note)
    return payload.note
  }, [manuscript.id, selectedBoardId, selectedTagId, view])

  const mergeSavedNote = useCallback((saved: Note) => {
    setNotes((current) => {
      const matchesView = (
        (view !== 'favourites' || saved.favourite)
        && (!selectedBoardId || saved.boardId === selectedBoardId)
        && (!selectedTagId || saved.tags.some((tag) => tag.id === selectedTagId))
      )
      if (!matchesView) return current.filter((item) => item.id !== saved.id)
      const next = current.some((item) => item.id === saved.id)
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [saved, ...current]
      return next.sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    })
    setActiveNote(saved)
    return saved
  }, [selectedBoardId, selectedTagId, view])

  const createAudioNote = useCallback(async (blob: Blob, draft: AudioNoteDraft, durationMs: number, waveform: number[]) => {
    const extension = blob.type === 'audio/mp4' ? 'm4a' : blob.type === 'audio/ogg' ? 'ogg' : 'webm'
    const form = new FormData()
    form.append('audio', new File([blob], `audio-note.${extension}`, { type: blob.type }))
    form.append('metadata', JSON.stringify({ ...draft, durationMs, waveform }))
    const payload = await apiUpload<{ note: Note }>(`/api/manuscripts/${manuscript.id}/audio-notes/`, form)
    return mergeSavedNote(payload.note)
  }, [manuscript.id, mergeSavedNote])

  const saveAudioNote = useCallback(async (draft: AudioNoteDraft, note: Note) => {
    const payload = await apiRequest<{ note: Note }>(`/api/manuscripts/notes/${note.id}/`, {
      method: 'PATCH',
      body: JSON.stringify({ ...draft, expectedGeneration: note.saveGeneration }),
    })
    return mergeSavedNote(payload.note)
  }, [mergeSavedNote])

  async function lifecycle(note: Note, action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'delete') {
    try {
      if (action === 'delete') {
        await apiRequest(`/api/manuscripts/notes/${note.id}/lifecycle/`, { method: 'DELETE' })
      } else {
        await apiRequest(`/api/manuscripts/notes/${note.id}/lifecycle/`, { method: 'POST', body: JSON.stringify({ action, expectedGeneration: note.saveGeneration }) })
      }
      setEditorOpen(false)
      setActiveNote(null)
      setSaveStatus('saved')
      await loadNotes()
    } catch (err) { onError(err instanceof Error ? err.message : t('boards.updateNoteFailed')) }
  }

  async function bulkLifecycle(action: 'unarchive' | 'restore') {
    const selected = notes.filter((note) => selectedNoteIds.has(note.id))
    if (!selected.length || bulkBusy) return
    setBulkBusy(true)
    try {
      await apiRequest(`/api/manuscripts/${manuscript.id}/notes/bulk-lifecycle/`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          notes: selected.map((note) => ({
            id: note.id,
            expectedGeneration: note.saveGeneration,
          })),
        }),
      })
      setSelectedNoteIds(new Set())
      await loadNotes()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('boards.bulkUpdateFailed'))
    } finally {
      setBulkBusy(false)
    }
  }

  async function emptyTrash() {
    if (bulkBusy) return
    setBulkBusy(true)
    try {
      await apiRequest(`/api/manuscripts/${manuscript.id}/notes/trash/`, { method: 'DELETE' })
      setSelectedNoteIds(new Set())
      setEditorOpen(false)
      setActiveNote(null)
      await loadNotes()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('boards.emptyTrashFailed'))
    } finally {
      setBulkBusy(false)
    }
  }

  function toggleNoteSelection(noteId: string) {
    setEditorOpen(false)
    setActiveNote(null)
    setSaveStatus('saved')
    setSelectedNoteIds((current) => {
      const next = new Set(current)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
  }

  function noteDraftFrom(note: Note, overrides: Partial<NoteDraft> = {}): NoteDraft {
    return {
      title: note.title,
      content: note.content,
      color: note.color,
      boardId: note.boardId,
      tagIds: note.tags.map((tag) => tag.id),
      itemIds: note.associatedItems.map((item) => item.id),
      pinned: note.pinned,
      favourite: note.favourite,
      ...overrides,
    }
  }

  function audioDraftFrom(note: Note, overrides: Partial<NoteDraft> = {}): AudioNoteDraft {
    const draft = noteDraftFrom(note, overrides)
    return {
      title: draft.title,
      color: draft.color,
      boardId: draft.boardId,
      tagIds: draft.tagIds,
      itemIds: draft.itemIds,
      pinned: draft.pinned,
      favourite: draft.favourite,
    }
  }

  function noteFromDrag(event: DragEvent) {
    const noteId = event.dataTransfer.getData('application/x-quillum-note') || event.dataTransfer.getData('text/plain')
    return notes.find((note) => note.id === noteId) ?? null
  }

  async function updateDraggedNote(note: Note, overrides: Partial<NoteDraft>) {
    try {
      if (note.kind === 'audio') await saveAudioNote(audioDraftFrom(note, overrides), note)
      else await saveNote(noteDraftFrom(note, overrides), note)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('boards.updateNoteFailed'))
    }
  }

  function allowNoteDrop(target: NoteDropTarget, event: DragEvent) {
    if (!event.dataTransfer.types.includes('application/x-quillum-note')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverTarget(target)
  }

  async function dropNote(target: NoteDropTarget, event: DragEvent) {
    event.preventDefault()
    setDragOverTarget(null)
    const note = noteFromDrag(event)
    if (!note) return
    if (target === 'favourites') {
      if (!note.favourite) await updateDraggedNote(note, { favourite: true })
      return
    }
    if (target === 'archive') {
      if (!note.archivedAt || note.trashedAt) await lifecycle(note, 'archive')
      return
    }
    if (target === 'trash') {
      if (!note.trashedAt) await lifecycle(note, 'trash')
      return
    }
    await updateDraggedNote(note, { boardId: target === 'boards' || target === 'all-notes' ? null : target.replace('board:', '') })
  }

  function openNoteEditor(note: Note | null, kind: 'text' | 'audio' = note?.kind ?? 'text') {
    editorSessionCounterRef.current += 1
    setEditorSessionKey(`${note?.id ?? `new-${kind}`}:${editorSessionCounterRef.current}`)
    setActiveNote(note)
    setEditorKind(kind)
    setEditorOpen(true)
    setMobileSidebarOpen(false)
    setMobileSearchOpen(false)
    setMobileActionsOpen(false)
    setMobileCreateMenuOpen(false)
    setMobileBoardSelectorOpen(false)
    setBoardMenuId(null)
  }
  function openNewNote() { openNoteEditor(null) }
  function openNewAudioNote() { openNoteEditor(null, 'audio') }
  function closeNoteEditor() { setEditorOpen(false); setSaveStatus('saved') }
  function selectView(next: BoardsView) { setView(next); setSelectedBoardId(null); setSelectedNoteIds(new Set()); setEditorOpen(false); setActiveNote(null); setSaveStatus('saved'); setMobileSidebarOpen(false); setMobileActionsOpen(false); setMobileCreateMenuOpen(false); setMobileBoardSelectorOpen(false); setBoardMenuId(null) }
  function selectBoard(boardId: string | null) { setSelectedBoardId(boardId); setSelectedNoteIds(new Set()); setMobileBoardSelectorOpen(false); setBoardMenuId(null) }
  function openCreateBoard() { setNewBoardName(''); setCreateBoardOpen(true); setMobileBoardSelectorOpen(false); setBoardMenuId(null) }
  function toggleTag(tagId: string) { setSelectedTagId((current) => current === tagId ? null : tagId); setSelectedNoteIds(new Set()); setMobileSidebarOpen(false) }
  const locale = i18n.resolvedLanguage ?? 'en'
  const selectedBoard = boards.find((board) => board.id === selectedBoardId) ?? null
  const mobileHeaderTitle = view === 'boards'
    ? selectedBoard?.name ?? t('boards.allNotes')
    : t(viewLabelKeys[view])
  const filteredTags = tags.filter((tag) => tag.name.toLocaleLowerCase(locale).includes(tagSearch.trim().toLocaleLowerCase(locale)))
  const filteredNotes = useMemo(() => {
    const query = noteSearch.trim().toLocaleLowerCase(locale)
    if (!query) return notes
    const boardNames = new Map(boards.map((board) => [board.id, board.name]))
    return notes.filter((note) => noteSearchText(note, locale, note.boardId ? boardNames.get(note.boardId) ?? '' : '').includes(query))
  }, [boards, locale, noteSearch, notes])
  useEffect(() => {
    const element = notesGridRef.current
    if (!element) return
    const updateColumnCount = () => {
      const available = element.clientWidth
      const next = Math.max(1, Math.floor((available + NOTE_COLUMN_GAP) / (NOTE_COLUMN_WIDTH + NOTE_COLUMN_GAP)))
      setNoteColumnCount(next)
    }
    updateColumnCount()
    const observer = new ResizeObserver(updateColumnCount)
    observer.observe(element)
    return () => observer.disconnect()
  }, [editorOpen, filteredNotes.length, loading])
  const visibleNoteColumnCount = Math.min(noteColumnCount, Math.max(1, filteredNotes.length))
  const noteColumns = useMemo(() => {
    const columns = Array.from({ length: visibleNoteColumnCount }, () => [] as Note[])
    filteredNotes.forEach((note, index) => columns[index % visibleNoteColumnCount].push(note))
    return columns
  }, [filteredNotes, visibleNoteColumnCount])
  function handleNotesWheel(event: ReactWheelEvent<HTMLElement>) {
    const element = notesGridRef.current
    if (!element || element.scrollWidth <= element.clientWidth) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0
    if (!delta) return
    event.preventDefault()
    element.scrollLeft += delta
  }
  return (
    <div className={`boardsPage ${editorOpen ? 'editorOpen' : ''}`}>
      <aside className={`boardsSidebar ${mobileSidebarOpen ? 'mobileOpen' : ''}`} aria-label={t('boards.navigation')}>
        <nav className="boardsNavigation">
          <SidebarButton active={view === 'boards'} dropActive={dragOverTarget === 'boards'} icon={<Icon name="widget-light" />} label={t('boards.boards')} onClick={() => selectView('boards')} onDragOver={(event) => allowNoteDrop('boards', event)} onDragLeave={() => setDragOverTarget(null)} onDrop={(event) => void dropNote('boards', event)} />
          <SidebarButton active={view === 'favourites'} dropActive={dragOverTarget === 'favourites'} icon={<Icon name="star-light" />} label={t('boards.favourites')} onClick={() => selectView('favourites')} onDragOver={(event) => allowNoteDrop('favourites', event)} onDragLeave={() => setDragOverTarget(null)} onDrop={(event) => void dropNote('favourites', event)} />
          <SidebarButton active={view === 'archive'} dropActive={dragOverTarget === 'archive'} icon={<Icon name="archive-light" />} label={t('boards.archive')} onClick={() => selectView('archive')} onDragOver={(event) => allowNoteDrop('archive', event)} onDragLeave={() => setDragOverTarget(null)} onDrop={(event) => void dropNote('archive', event)} />
          <SidebarButton active={view === 'trash'} dropActive={dragOverTarget === 'trash'} icon={<Icon name="trash-bin-trash-light" />} label={t('boards.trash')} onClick={() => selectView('trash')} onDragOver={(event) => allowNoteDrop('trash', event)} onDragLeave={() => setDragOverTarget(null)} onDrop={(event) => void dropNote('trash', event)} />
        </nav>
        <section className="boardsTags" aria-labelledby="boards-tags-title" ref={tagSearchRef}>
          <div className="boardsTagsHeader"><h2 id="boards-tags-title">{t('boards.tags')}</h2><button type="button" className={`spaceButton ${tagSearchOpen ? 'active' : ''}`} aria-label={t('boards.searchTags')} aria-pressed={tagSearchOpen} onClick={() => { setTagSearchOpen((open) => !open); if (tagSearchOpen) setTagSearch('') }}><Icon name="magnifer-outline" className="boardsMagniferIcon" /></button></div>
          {tagSearchOpen && <input autoFocus className="boardsTagSearch" value={tagSearch} placeholder={t('boards.searchTags')} aria-label={t('boards.searchTags')} onChange={(event) => setTagSearch(event.target.value)} />}
          <div className="boardsTagList">
            {filteredTags.map((tag) => <button type="button" className={`spaceButton ${selectedTagId === tag.id ? 'active' : ''}`} key={tag.id} onClick={() => toggleTag(tag.id)}><span style={{ background: tag.color }} />{tag.name}</button>)}
            {!tags.length && <div className="boardsTagEmpty">{t('boards.noTags')}</div>}
          </div>
        </section>
        <button type="button" className="boardsMobileSidebarClose spaceButton" onClick={() => setMobileSidebarOpen(false)}>
          <Icon name="arrow-left-1" />
          <span>{t('boards.collapseSidebar')}</span>
        </button>
      </aside>
      {mobileSidebarOpen && <div className="boardsSidebarBackdrop" role="presentation" onPointerDown={() => setMobileSidebarOpen(false)} />}

      <main className="boardsMain">
        <div className="boardsHeaderArea" ref={mobileSearchRef}>
          <header className="boardsMainHeader">
            <div className="boardsTitle"><h1>{t(viewLabelKeys[view])}</h1><BoardsSaveStatusIndicator status={saveStatus} /></div>
            <div className="boardsMobileSectionTitle" ref={mobileBoardSelectorRef}>
              {view === 'boards' ? (
                <>
                  <button
                    type="button"
                    className={`boardsMobileBoardSelectorToggle spaceButton ${mobileBoardSelectorOpen ? 'active' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={mobileBoardSelectorOpen}
                    onClick={() => {
                      setMobileBoardSelectorOpen((open) => !open)
                      setMobileSidebarOpen(false)
                      setMobileSearchOpen(false)
                      setMobileActionsOpen(false)
                      setMobileCreateMenuOpen(false)
                      setBoardMenuId(null)
                    }}
                  >
                    <span>{mobileHeaderTitle}</span>
                    <Icon name="arrow-down-2" />
                  </button>
                  {mobileBoardSelectorOpen && (
                    <div className="boardsMobileBoardSelectorMenu" role="menu" aria-label={t('boards.boards')}>
                      <button type="button" className={`boardsMobileBoardChoice spaceButton ${!selectedBoardId ? 'active' : ''}`} role="menuitemradio" aria-checked={!selectedBoardId} onClick={() => selectBoard(null)}>
                        <span>{t('boards.allNotes')}</span>
                      </button>
                      {boards.map((board) => (
                        <div className={`boardsMobileBoardRow ${selectedBoardId === board.id ? 'active' : ''}`} key={board.id}>
                          <button type="button" className="boardsMobileBoardChoice spaceButton" role="menuitemradio" aria-checked={selectedBoardId === board.id} onClick={() => selectBoard(board.id)}>
                            <span>{board.name}</span>
                          </button>
                          <button type="button" className="boardsMobileBoardMenuToggle spaceButton" aria-label={t('boards.actionsForBoard', { name: board.name })} aria-expanded={boardMenuId === board.id} onClick={() => setBoardMenuId((current) => current === board.id ? null : board.id)}>
                            <Icon name="menu-dots-light" />
                          </button>
                          {boardMenuId === board.id && (
                            <div className="boardsMobileBoardActions">
                              <button type="button" className="spaceButton" onClick={() => { setBoardMenuId(null); setMobileBoardSelectorOpen(false); setNewBoardName(board.name); setRenamingBoard(board) }}><Icon name="edit-light" />{t('boards.rename')}</button>
                              <button type="button" className="danger spaceButton" onClick={() => { setBoardMenuId(null); setMobileBoardSelectorOpen(false); setDeletingBoard(board) }}><Icon name="trash-bin-trash-light" />{t('boards.delete')}</button>
                            </div>
                          )}
                        </div>
                      ))}
                      <button type="button" className="boardsMobileCreateBoard spaceButton" role="menuitem" onClick={openCreateBoard}>
                        <PlusIcon />
                        <span>{t('boards.createBoard')}</span>
                      </button>
                    </div>
                  )}
                </>
              ) : <h1>{mobileHeaderTitle}</h1>}
            </div>
            <div className="boardsHeaderActions">
              <label className="boardsNoteSearch"><SearchIcon /><input value={noteSearch} placeholder={t('boards.searchNotes')} aria-label={t('boards.searchNotes')} onChange={(event) => setNoteSearch(event.target.value)} />{noteSearch && <button type="button" className="spaceButton" aria-label={t('boards.clearSearch')} onClick={() => setNoteSearch('')}><Icon name="close-light" /></button>}</label>
              {(view === 'boards' || view === 'favourites') && <button type="button" className="boardsNewAudioNote spaceButton" aria-label={t('audioNotes.newAudioNote')} title={t('audioNotes.newAudioNote')} onClick={openNewAudioNote}><Icon name="microphone-3-linear" /></button>}
              {(view === 'boards' || view === 'favourites') && <button type="button" className="boardsNewNote spaceButton" onClick={openNewNote}><PlusIcon /> {t('boards.newNote')}</button>}
              {view === 'archive' && <button type="button" className="boardsBulkAction spaceButton" disabled={!selectedNoteIds.size || bulkBusy} onClick={() => setConfirmAction({ kind: 'bulk-unarchive' })}><Icon name="archive-up-light" /> {t('boards.unarchive')}{selectedNoteIds.size ? ` (${selectedNoteIds.size})` : ''}</button>}
              {view === 'trash' && <><button type="button" className="boardsEmptyTrash spaceButton" disabled={bulkBusy} onClick={() => setConfirmAction({ kind: 'empty-trash' })}><Icon name="trash-bin-trash-light" /> {t('boards.emptyTrash')}</button><button type="button" className="boardsBulkAction spaceButton" disabled={!selectedNoteIds.size || bulkBusy} onClick={() => setConfirmAction({ kind: 'bulk-restore' })}><Icon name="restart-light" /> {t('boards.restore')}{selectedNoteIds.size ? ` (${selectedNoteIds.size})` : ''}</button></>}
            </div>
          </header>
          <div className={`boardsMobileSearchPanel ${mobileSearchOpen ? 'open' : ''}`} aria-hidden={!mobileSearchOpen}>
            <div className="boardsMobileSearchPanelInner">
              <label className="boardsNoteSearch"><SearchIcon /><input ref={mobileSearchInputRef} value={noteSearch} placeholder={t('boards.searchNotes')} aria-label={t('boards.searchNotes')} onChange={(event) => setNoteSearch(event.target.value)} />{noteSearch && <button type="button" className="spaceButton" aria-label={t('boards.clearSearch')} onClick={() => setNoteSearch('')}><Icon name="close-light" /></button>}</label>
            </div>
          </div>
        </div>
        {view === 'boards' && <div className="boardsTabs" ref={boardTabsRef}>
          <div className="boardsTabsScroll" role="tablist" aria-label={t('boards.boards')}>
            <button type="button" className={`spaceButton ${!selectedBoardId ? 'active' : ''} ${dragOverTarget === 'all-notes' ? 'dropActive' : ''}`} role="tab" aria-selected={!selectedBoardId} onClick={() => selectBoard(null)} onDragOver={(event) => allowNoteDrop('all-notes', event)} onDragLeave={() => setDragOverTarget(null)} onDrop={(event) => void dropNote('all-notes', event)}>{t('boards.allNotes')}</button>
            {boards.map((board) => <div className={`boardsTab ${selectedBoardId === board.id ? 'active' : ''} ${dragOverTarget === `board:${board.id}` ? 'dropActive' : ''}`} key={board.id} onDragOver={(event) => allowNoteDrop(`board:${board.id}`, event)} onDragLeave={() => setDragOverTarget(null)} onDrop={(event) => void dropNote(`board:${board.id}`, event)}><button type="button" className="spaceButton" role="tab" aria-selected={selectedBoardId === board.id} onClick={() => selectBoard(board.id)}>{board.name}</button><button type="button" className="boardsTabMenu spaceButton" aria-label={t('boards.actionsForBoard', { name: board.name })} onClick={() => setBoardMenuId((current) => current === board.id ? null : board.id)}><Icon name="menu-kebab-vertical-light" /></button>{boardMenuId === board.id && <div className="boardsTabPopover"><button type="button" className="spaceButton" onClick={() => { setBoardMenuId(null); setNewBoardName(board.name); setRenamingBoard(board) }}><Icon name="edit-light" />{t('boards.rename')}</button><button type="button" className="danger spaceButton" onClick={() => { setBoardMenuId(null); setDeletingBoard(board) }}><Icon name="trash-bin-trash-light" />{t('boards.delete')}</button></div>}</div>)}
          </div>
          <button type="button" className="boardsAddBoard spaceButton" aria-label={t('boards.createBoard')} onClick={openCreateBoard}><Icon name="add-square-light" /></button>
        </div>}
        {view !== 'boards' && <div className="boardsTabs boardsTabsPlaceholder" aria-hidden="true" />}
        {loading ? <TadpoleLoadingState className="boardsLoading" label={t('boards.loadingNotes')} /> : filteredNotes.length ? <section className="boardsNotes grid" ref={notesGridRef} style={{ '--boards-note-column-count': visibleNoteColumnCount } as CSSProperties} onWheel={handleNotesWheel}>
          {noteColumns.map((column, columnIndex) => (
            <div className="boardsNoteColumn" key={columnIndex}>
              {column.map((note) => <NoteCard key={note.id} note={note} active={activeNote?.id === note.id && editorOpen} selectable={view === 'archive' || view === 'trash'} selected={selectedNoteIds.has(note.id)} selectionMode={selectedNoteIds.size > 0} onOpen={() => openNoteEditor(note)} onSelect={() => toggleNoteSelection(note.id)} />)}
            </div>
          ))}
        </section> : noteSearch.trim() && notes.length ? <SearchEmptyState query={noteSearch} onClear={() => setNoteSearch('')} /> : <EmptyState view={view} onCreate={openNewNote} />}
      </main>
      {!editorOpen && (
        <nav className={`boardsMobileBottomBar ${mobileActionsOpen || mobileCreateMenuOpen ? 'actionsOpen' : ''}`} aria-label={t('boards.navigation')} ref={mobileBottomBarRef}>
          {mobileCreateMenuOpen && (
            <div className="boardsMobileActionMenu boardsMobileCreateMenu" role="menu" aria-label={t('audioNotes.createMenu')}>
              <button type="button" className="spaceButton" role="menuitem" onClick={openNewNote}><span className="boardsMobileCreateMenuIcon" aria-hidden="true"><Icon name="notes-light" /></span><span>{t('boards.newNote')}</span></button>
              <button type="button" className="spaceButton" role="menuitem" onClick={openNewAudioNote}><span className="boardsMobileCreateMenuIcon" aria-hidden="true"><Icon name="microphone-3-linear" /></span><span>{t('audioNotes.newAudioNote')}</span></button>
            </div>
          )}
          {view === 'trash' && mobileActionsOpen && (
            <div className="boardsMobileActionMenu" role="menu">
              <button type="button" className="spaceButton" role="menuitem" disabled={!selectedNoteIds.size || bulkBusy} onClick={() => { setMobileActionsOpen(false); setConfirmAction({ kind: 'bulk-restore' }) }}><Icon name="restart-light" /><span>{t('boards.restore')}</span>{selectedNoteIds.size > 0 && <strong>{selectedNoteIds.size}</strong>}</button>
              <button type="button" className="danger spaceButton" role="menuitem" disabled={bulkBusy} onClick={() => { setMobileActionsOpen(false); setConfirmAction({ kind: 'empty-trash' }) }}><Icon name="trash-bin-trash-light" /><span>{t('boards.emptyTrash')}</span></button>
            </div>
          )}
          <div className="boardsMobileBottomBarSurface">
            <button type="button" className={`boardsMobileBarButton spaceButton ${mobileSidebarOpen ? 'active' : ''}`} aria-label={t('boards.openNavigation')} aria-expanded={mobileSidebarOpen} onClick={() => { setMobileSidebarOpen((open) => !open); setMobileSearchOpen(false); setMobileActionsOpen(false); setMobileCreateMenuOpen(false); setMobileBoardSelectorOpen(false); setBoardMenuId(null) }}><Icon name="sidebar-minimalistic-light" /></button>
            {(view === 'boards' || view === 'favourites') && <button type="button" className={`boardsMobilePrimaryAction spaceButton ${mobileCreateMenuOpen ? 'active' : ''}`} aria-label={t(mobileCreateMenuOpen ? 'audioNotes.closeCreateMenu' : 'audioNotes.openCreateMenu')} aria-expanded={mobileCreateMenuOpen} onClick={() => { setMobileCreateMenuOpen((open) => !open); setMobileSearchOpen(false); setMobileSidebarOpen(false); setMobileActionsOpen(false); setMobileBoardSelectorOpen(false); setBoardMenuId(null) }}><PlusIcon /></button>}
            {view === 'archive' && <button type="button" className="boardsMobilePrimaryAction spaceButton" aria-label={t('boards.unarchive')} title={t('boards.unarchive')} disabled={!selectedNoteIds.size || bulkBusy} onClick={() => setConfirmAction({ kind: 'bulk-unarchive' })}><Icon name="archive-up-light" />{selectedNoteIds.size > 0 && <span>{selectedNoteIds.size}</span>}</button>}
            {view === 'trash' && <button type="button" className={`boardsMobilePrimaryAction spaceButton ${mobileActionsOpen ? 'active' : ''}`} aria-label={t(mobileActionsOpen ? 'boards.closeActions' : 'boards.openActions')} aria-expanded={mobileActionsOpen} onClick={() => { setMobileActionsOpen((open) => !open); setMobileSearchOpen(false); setMobileSidebarOpen(false); setMobileBoardSelectorOpen(false); setBoardMenuId(null) }}><Icon name="menu-dots-light" /></button>}
            <button type="button" className={`boardsMobileBarButton boardsMobileSearchAction spaceButton ${mobileSearchOpen ? 'active' : ''}`} aria-label={t('boards.searchNotes')} aria-expanded={mobileSearchOpen} onClick={() => { setMobileSearchOpen((open) => !open); setMobileSidebarOpen(false); setMobileActionsOpen(false); setMobileCreateMenuOpen(false); setMobileBoardSelectorOpen(false); setBoardMenuId(null) }}><Icon name="magnifer-outline" className="boardsMagniferIcon" /></button>
          </div>
        </nav>
      )}
      {editorOpen && <Suspense fallback={<div className="boardsEditorBackdrop dialogBackdrop" role="presentation"><TadpoleLoadingState className="boardsEditor createOneShotDialog boardsEditorLoading" label={t('boards.loadingEditor')} /></div>}>{editorKind === 'audio' ? <BoardsAudioNoteEditor key={editorSessionKey} note={activeNote} initialBoardId={selectedBoardId} initialFavourite={view === 'favourites'} boards={boards} tags={tags} contextItems={contextItems} onClose={closeNoteEditor} onCreate={createAudioNote} onSave={saveAudioNote} onCreateTag={createTag} onLifecycle={(note, action) => { if (action === 'delete') { setConfirmAction({ kind: 'delete-note', note }); return Promise.resolve() } return lifecycle(note, action) }} onSaveStatusChange={setSaveStatus} onError={onError} /> : <BoardsNoteEditor key={editorSessionKey} manuscriptId={manuscript.id} note={activeNote} initialBoardId={selectedBoardId} initialTagIds={selectedTagId ? [selectedTagId] : []} initialFavourite={view === 'favourites'} boards={boards} tags={tags} contextItems={contextItems} onClose={closeNoteEditor} onSave={saveNote} onCreateTag={createTag} onLifecycle={(note, action) => { if (action === 'delete') { setConfirmAction({ kind: 'delete-note', note }); return Promise.resolve() } return lifecycle(note, action) }} onSaveStatusChange={setSaveStatus} onError={onError} />}</Suspense>}
      {createBoardOpen && (
        <BoardNameDialog
          mode="create"
          name={newBoardName}
          submitting={boardSubmitting}
          onNameChange={setNewBoardName}
          onClose={() => setCreateBoardOpen(false)}
          onSubmit={createBoard}
        />
      )}
      {renamingBoard && (
        <BoardNameDialog
          mode="rename"
          name={newBoardName}
          submitting={boardSubmitting}
          onNameChange={setNewBoardName}
          onClose={() => setRenamingBoard(null)}
          onSubmit={renameBoard}
        />
      )}
      {deletingBoard && (
        <BoardDeleteDialog
          board={deletingBoard}
          submitting={boardSubmitting}
          onClose={() => setDeletingBoard(null)}
          onConfirm={() => void deleteBoard()}
        />
      )}
      {confirmAction && (
        <BoardsConfirmDialog
          action={confirmAction}
          selectedCount={selectedNoteIds.size}
          busy={bulkBusy}
          onClose={() => setConfirmAction(null)}
          onConfirm={async () => {
            if (confirmAction.kind === 'delete-note') await lifecycle(confirmAction.note, 'delete')
            if (confirmAction.kind === 'empty-trash') await emptyTrash()
            if (confirmAction.kind === 'bulk-unarchive') await bulkLifecycle('unarchive')
            if (confirmAction.kind === 'bulk-restore') await bulkLifecycle('restore')
          }}
        />
      )}
    </div>
  )
}

function BoardNameDialog({ mode, name, submitting, onNameChange, onClose, onSubmit }: { mode: 'create' | 'rename'; name: string; submitting: boolean; onNameChange: (name: string) => void; onClose: () => void; onSubmit: () => Promise<boolean> }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose, initialFocusRef: inputRef })
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, submitting])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || !name.trim()) return
    if (await onSubmit()) finishAfterExit(onClose)
  }

  return (
    <div className={`dialogBackdrop mobileBottomSheetBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) closeDialog() }}>
      <div className="createOneShotDialog boardsNameDialog mobileBottomSheet" role="dialog" aria-modal="true" aria-labelledby="board-name-title" ref={setDialogRef}>
        <header>
          <div><h2 id="board-name-title">{t(mode === 'create' ? 'boards.createBoard' : 'boards.renameBoard')}</h2><p>{t(mode === 'create' ? 'boards.createBoardLead' : 'boards.renameBoardLead')}</p></div>
          <button type="button" className="dialogClose booksButton" aria-label={t('boards.close')} disabled={submitting || closing} onClick={closeDialog}><Icon name="close-square-light" /></button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label className="dialogField">
            <span>{t('boards.boardName')}</span>
            <input ref={inputRef} required maxLength={120} value={name} onChange={(event) => onNameChange(event.target.value)} />
          </label>
          <footer>
            <button type="button" className="dialogCancel booksButton" disabled={submitting || closing} onClick={closeDialog}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit booksButton" disabled={submitting || closing || !name.trim()}>{submitting ? t(mode === 'create' ? 'boards.creating' : 'common.saving') : t(mode === 'create' ? 'boards.createBoard' : 'boards.saveName')}</button>
          </footer>
        </form>
      </div>
    </div>
  )
}

function BoardDeleteDialog({ board, submitting, onClose, onConfirm }: { board: Board; submitting: boolean; onClose: () => void; onConfirm: () => void }) {
  const { t } = useTranslation()
  return (
    <ActionDialog variant="structured" role="alertdialog" title={t('boards.deleteBoard')} closeLabel={t('boards.close')} busy={submitting} className="boardsConfirmDialog" onClose={onClose}>
      <div className="standardDialogSection">
        <p>{t('boards.deleteBoardLead', { name: board.name })}</p>
        <footer className="standardDialogFooter">
          <button type="button" className="dialogCancel booksButton" disabled={submitting} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="dialogSubmit danger booksButton" disabled={submitting} onClick={onConfirm}>{submitting ? t('boards.deleting') : t('boards.deleteBoardAction')}</button>
        </footer>
      </div>
    </ActionDialog>
  )
}

function BoardsConfirmDialog({ action, selectedCount, busy, onClose, onConfirm }: { action: BoardsConfirmAction; selectedCount: number; busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const copy = boardsConfirmCopy(action, selectedCount, t)
  const effectiveBusy = busy || submitting
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !effectiveBusy) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, effectiveBusy])

  async function confirm() {
    if (effectiveBusy) return
    setSubmitting(true)
    await onConfirm()
    finishAfterExit(onClose)
  }

  return (
    <div className={`dialogBackdrop mobileBottomSheetBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !effectiveBusy) closeDialog()
    }}>
      <div className="createOneShotDialog manuscriptDeleteDialog boardsConfirmDialog mobileBottomSheet" role="alertdialog" aria-modal="true" aria-labelledby="boards-confirm-title" aria-describedby="boards-confirm-description" ref={setDialogRef}>
        <header>
          <div><h2 id="boards-confirm-title">{copy.title}</h2></div>
          <button type="button" className="dialogClose booksButton" aria-label={t('boards.close')} disabled={effectiveBusy || closing} onClick={closeDialog}><Icon name="close-square-light" /></button>
        </header>
        <div className="manuscriptDeleteBody"><p id="boards-confirm-description">{copy.description}</p></div>
        <footer>
          <button type="button" className="dialogCancel booksButton" disabled={effectiveBusy || closing} onClick={closeDialog}>{t('common.cancel')}</button>
          <button type="button" className={copy.danger ? 'dialogDelete booksButton' : 'dialogSubmit booksButton'} disabled={effectiveBusy} onClick={() => void confirm()}>{effectiveBusy ? copy.busyLabel : copy.confirmLabel}</button>
        </footer>
      </div>
    </div>
  )
}

function boardsConfirmCopy(action: BoardsConfirmAction, selectedCount: number, t: TFunction) {
  if (action.kind === 'delete-note') return {
    title: t('boards.deleteNoteForever'),
    description: t('boards.deleteNoteLead', { title: action.note.title || t('boards.untitledNote') }),
    confirmLabel: t('boards.deleteForever'),
    busyLabel: t('boards.deleting'),
    danger: true,
  }
  if (action.kind === 'empty-trash') return {
    title: t('boards.emptyTrashTitle'),
    description: t('boards.emptyTrashLead'),
    confirmLabel: t('boards.emptyTrash'),
    busyLabel: t('boards.deleting'),
    danger: true,
  }
  if (action.kind === 'bulk-unarchive') return {
    title: t('boards.unarchiveSelected'),
    description: t('boards.unarchiveSelectedLead', { count: selectedCount }),
    confirmLabel: t('boards.unarchive'),
    busyLabel: t('boards.unarchiving'),
    danger: false,
  }
  return {
    title: t('boards.restoreSelected'),
    description: t('boards.restoreSelectedLead', { count: selectedCount }),
    confirmLabel: t('boards.restore'),
    busyLabel: t('boards.restoring'),
    danger: false,
  }
}

function NoteCard({ note, active, selectable, selected, selectionMode, onOpen, onSelect }: { note: Note; active: boolean; selectable: boolean; selected: boolean; selectionMode: boolean; onOpen: () => void; onSelect: () => void }) {
  const { t, i18n } = useTranslation()
  const longPressTimer = useRef<number | null>(null)
  const longPressed = useRef(false)
  const previewImage = firstNoteImage(note.content)
  const title = note.title || t('boards.untitledNote')
  const locale = i18n.resolvedLanguage ?? 'en'
  function cancelLongPress() { if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current); longPressTimer.current = null }
  function openFromKeyboard(event: ReactKeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (selectionMode && selectable) onSelect()
    else onOpen()
  }
  if (note.id) return <article role="button" tabIndex={0} className={`boardsNoteCard ${active ? 'active' : ''} ${selected ? 'selected' : ''}`} data-color={note.color} style={note.color.startsWith('#') ? { '--note-color': note.color } as CSSProperties : undefined} onPointerDown={() => { if (!selectable) return; longPressed.current = false; longPressTimer.current = window.setTimeout(() => { longPressed.current = true; onSelect() }, 550) }} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress} onContextMenu={(event) => { if (!selectable) return; event.preventDefault(); cancelLongPress(); if (!longPressed.current) onSelect() }} onClick={() => { if (longPressed.current) { longPressed.current = false; return } if (selectionMode && selectable) onSelect(); else onOpen() }} onKeyDown={openFromKeyboard}><span className="boardsNoteCardTop"><span className="boardsNoteDragHandle" role="button" tabIndex={0} aria-label={t('boards.dragNote', { title })} draggable onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-quillum-note', note.id); event.dataTransfer.setData('text/plain', note.id) }}><DragHandleIcon /></span><strong>{title}</strong><NoteCardFlags note={note} /></span>{note.kind === 'audio' && note.audio ? <span className="boardsAudioCardPreview"><Icon name="microphone-3-linear" /><AudioWaveform values={note.audio.waveform} /></span> : <>{previewImage && <span className="boardsNotePreviewImage"><PrivateImage src={previewImage.src} alt={previewImage.alt} loading="lazy" decoding="async" draggable={false} /></span>}<NoteContentPreview content={note.content} className="boardsNoteCardContent" /></>}<span className="boardsNoteMeta"><span>{note.tags.map((tag) => <i key={tag.id} style={{ '--tag-color': noteTagCssColor(tag.color) } as CSSProperties}>{tag.name}</i>)}</span><time>{formatRelative(note.updatedAt, locale, t)}</time></span></article>
  return <button type="button" className={`boardsNoteCard spaceButton ${active ? 'active' : ''} ${selected ? 'selected' : ''}`} data-color={note.color} style={note.color.startsWith('#') ? { '--note-color': note.color } as CSSProperties : undefined} onPointerDown={() => { if (!selectable) return; longPressed.current = false; longPressTimer.current = window.setTimeout(() => { longPressed.current = true; onSelect() }, 550) }} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress} onContextMenu={(event) => { if (!selectable) return; event.preventDefault(); cancelLongPress(); if (!longPressed.current) onSelect() }} onClick={() => { if (longPressed.current) { longPressed.current = false; return } if (selectionMode && selectable) onSelect(); else onOpen() }}><span className="boardsNoteCardTop"><span className="boardsNoteGrip">⋮⋮</span><strong>{title}</strong>{selected ? <span className="boardsSelectedMark"><CheckIcon /></span> : note.pinned && <Icon name="pin-linear" className="boardsPinIcon" />}</span>{previewImage && <span className="boardsNotePreviewImage"><PrivateImage src={previewImage.src} alt={previewImage.alt} loading="lazy" decoding="async" draggable={false} /></span>}<NoteContentPreview content={note.content} className="boardsNoteCardContent" /><span className="boardsNoteMeta"><span>{note.tags.map((tag) => <i key={tag.id} style={{ '--tag-color': noteTagCssColor(tag.color) } as CSSProperties}>{tag.name}</i>)}</span><time>{formatRelative(note.updatedAt, locale, t)}</time></span></button>
}
function SearchEmptyState({ query, onClear }: { query: string; onClear: () => void }) { const { t } = useTranslation(); return <section className="boardsEmptyState"><span className="boardsEmptyIcon"><SearchIcon /></span><h2>{t('boards.noMatches')}</h2><p>{t('boards.noMatchesLead', { query: query.trim() })}</p><button type="button" onClick={onClear}>{t('boards.clearSearchAction')}</button></section> }
function NoteCardFlags({ note }: { note: Note }) { if (!note.pinned && !note.favourite) return <span className="boardsNoteFlags" />; return <span className="boardsNoteFlags">{note.pinned && <Icon name="pin-linear" className="boardsPinIcon" />}{note.favourite && <Icon name="star-light" />}</span> }
function EmptyState({ view, onCreate }: { view: BoardsView; onCreate: () => void }) { const { t } = useTranslation(); const titleKeys = { boards: 'boards.empty.boardsTitle', favourites: 'boards.empty.favouritesTitle', archive: 'boards.empty.archiveTitle', trash: 'boards.empty.trashTitle' }; const leadKeys = { boards: 'boards.empty.boardsLead', favourites: 'boards.empty.favouritesLead', archive: 'boards.empty.archiveLead', trash: 'boards.empty.trashLead' }; return <section className="boardsEmptyState"><span className="boardsEmptyIcon"><Icon name={emptyViewIcons[view]} /></span><h2>{t(titleKeys[view])}</h2><p>{t(leadKeys[view])}</p>{view !== 'archive' && view !== 'trash' && <button type="button" className="boardsEmptyCreateButton booksButton" onClick={onCreate}><Icon name="boards-light" /> {t('boards.createNote')}</button>}</section> }
function SidebarButton({ active, dropActive, icon, label, onClick, onDragOver, onDragLeave, onDrop }: { active: boolean; dropActive?: boolean; icon: ReactNode; label: string; onClick: () => void; onDragOver?: (event: DragEvent<HTMLButtonElement>) => void; onDragLeave?: () => void; onDrop?: (event: DragEvent<HTMLButtonElement>) => void }) { return <button type="button" className={`spaceButton ${active ? 'active' : ''} ${dropActive ? 'dropActive' : ''}`} onClick={onClick} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>{icon}<span>{label}</span></button> }
function noteSearchText(note: Note, locale: string, boardName: string) { return `${note.title} ${boardName} ${note.preview} ${note.tags.map((tag) => tag.name).join(' ')} ${note.associatedItems.map((item) => item.title).join(' ')} ${noteContentText(note.content)}`.toLocaleLowerCase(locale) }
function noteContentText(node: JSONContent): string { return `${node.text ?? ''} ${(node.content ?? []).map(noteContentText).join(' ')}` }
function firstNoteImage(node: JSONContent): { src: string; alt: string } | null {
  if (node.type === 'illustration') {
    const assetId = String(node.attrs?.assetId ?? '')
    if (!assetId) return null
    return {
      src: `${API_BASE}/api/manuscripts/assets/${assetId}/medium/`,
      alt: String(node.attrs?.alt ?? ''),
    }
  }
  for (const child of node.content ?? []) {
    const image = firstNoteImage(child)
    if (image) return image
  }
  return null
}
function formatRelative(value: string, locale: string, t: TFunction) { const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return t('boards.now'); if (seconds < 3600) return t('boards.minutesAgo', { count: Math.floor(seconds / 60) }); if (seconds < 86400) return t('boards.hoursAgo', { count: Math.floor(seconds / 3600) }); return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(value)) }
function SearchIcon() { return <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg> }
function PlusIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg> }
function CheckIcon() { return <svg viewBox="0 0 24 24"><path d="m6 12 4 4 8-9"/></svg> }
function DragHandleIcon() { return <svg viewBox="0 0 24 24"><path d="M8 5h.01M8 12h.01M8 19h.01M16 5h.01M16 12h.01M16 19h.01"/></svg> }
