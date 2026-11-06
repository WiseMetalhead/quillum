import { useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { CSSProperties, ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import StarterKit from '@tiptap/starter-kit'
import type { JSONContent } from '@tiptap/core'
import { useTranslation } from 'react-i18next'
import { apiUpload } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { Illustration } from './Illustration'
import { ImageUploadPlaceholder, removeImageUploadPlaceholder, replaceImageUploadPlaceholder, showImageUploadPlaceholder } from './ImageUploadPlaceholder'
import { StorageImagePickerDialog } from '../shared/StorageImagePickerDialog'
import { NoteColorPicker } from './NoteColorPicker'
import { BoardsSaveStatusIndicator } from './BoardsSaveStatusIndicator'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { LibraryAction } from '../shared/MobileLibraryActionSheet'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import type { StorageItem } from '../../types'
import type { Board, BoardsSaveStatus, Note, NoteContextItem, NoteDraft, NoteTag } from './BoardsTypes'
import { EMPTY_NOTE_CONTENT } from './BoardsTypes'

const NOTE_COLORS = ['yellow', 'blue', 'green', 'purple', 'orange', 'pink', 'gray'] as const
type MobileToolbarLevel = 'main' | 'format' | 'color'
type MobilePicker = 'board' | 'items' | 'tags'

type Props = {
  manuscriptId: string
  note: Note | null
  initialBoardId: string | null
  initialTagIds: string[]
  initialFavourite: boolean
  boards: Board[]
  tags: NoteTag[]
  contextItems: NoteContextItem[]
  onClose: () => void
  onSave: (draft: NoteDraft, note: Note | null) => Promise<Note>
  onCreateTag: (name: string) => Promise<NoteTag>
  onLifecycle: (note: Note, action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'delete') => Promise<void>
  onSaveStatusChange: (status: BoardsSaveStatus) => void
  onError: (message: string) => void
}

export function BoardsNoteEditor({
  manuscriptId,
  note,
  initialBoardId,
  initialTagIds,
  initialFavourite,
  boards,
  tags,
  contextItems,
  onClose,
  onSave,
  onCreateTag,
  onLifecycle,
  onSaveStatusChange,
  onError,
}: Props) {
  const { t, i18n } = useTranslation()
  const [title, setTitle] = useState(note?.title ?? '')
  const [color, setColor] = useState(note?.color ?? 'blue')
  const [boardId, setBoardId] = useState(note?.boardId ?? initialBoardId ?? '')
  const [tagIds, setTagIds] = useState<string[]>(note?.tags.map((tag) => tag.id) ?? initialTagIds)
  const [itemIds, setItemIds] = useState<string[]>(note?.associatedItems.map((item) => item.id) ?? [])
  const [pinned, setPinned] = useState(note?.pinned ?? false)
  const [favourite, setFavourite] = useState(note?.favourite ?? initialFavourite)
  const [currentNote, setCurrentNote] = useState(note)
  const [content, setContent] = useState<JSONContent>(note?.content ?? EMPTY_NOTE_CONTENT)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [tagCreateOpen, setTagCreateOpen] = useState(false)
  const [linksOpen, setLinksOpen] = useState(() => Boolean(note?.associatedItems.length))
  const [editingTitle, setEditingTitle] = useState(() => note === null)
  const [savedSignature, setSavedSignature] = useState(() => draftSignature(note ? {
    title: note.title, content: note.content, color: note.color, boardId: note.boardId,
    tagIds: note.tags.map((tag) => tag.id), itemIds: note.associatedItems.map((item) => item.id),
    pinned: note.pinned, favourite: note.favourite,
  } : { title: '', content: EMPTY_NOTE_CONTENT, color: 'blue', boardId: initialBoardId,
    tagIds: initialTagIds, itemIds: [], pinned: false, favourite: initialFavourite }))
  const [tagName, setTagName] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)
  const [mobileToolbarLevel, setMobileToolbarLevel] = useState<MobileToolbarLevel>('main')
  const [mobilePicker, setMobilePicker] = useState<MobilePicker | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const focusDialogOnMountRef = useRef(note !== null)
  const saveTimerRef = useRef<number | null>(null)

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
    editorProps: { attributes: { class: 'boardsTiptap', 'aria-label': t('notes.noteText') } },
    onUpdate: ({ editor: currentEditor }) => setContent(currentEditor.getJSON()),
  })

  useEffect(() => {
    editor?.setOptions({ editorProps: { attributes: { class: 'boardsTiptap', 'aria-label': t('notes.noteText') } } })
  }, [editor, i18n.resolvedLanguage, t])

  const draft = useMemo<NoteDraft>(() => ({
    title,
    content,
    color,
    boardId: boardId || null,
    tagIds,
    itemIds,
    pinned,
    favourite,
  }), [boardId, color, content, favourite, itemIds, pinned, tagIds, title])
  const signature = draftSignature(draft)
  const meaningful = Boolean(title.trim() || noteText(content) || assetIds(content).length)
  const displayedTitle = title.trim() || t(currentNote ? 'notes.untitled' : 'notes.newNote')
  const editorColorStyle = color.startsWith('#') ? { '--note-color': color } as CSSProperties : undefined
  const saveStatus: BoardsSaveStatus = saveFailed
    ? 'error'
    : saving
      ? 'saving'
      : meaningful && signature !== savedSignature ? 'dirty' : 'saved'

  useEffect(() => {
    onSaveStatusChange(saveStatus)
  }, [onSaveStatusChange, saveStatus])

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select()
  }, [editingTitle])

  useEffect(() => {
    if (focusDialogOnMountRef.current) dialogRef.current?.focus()
  }, [])

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
      } catch (err) {
        setSaveFailed(true)
        onError(err instanceof Error ? err.message : i18n.t('notes.saveFailed'))
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
      onClose()
      return
    }
    setSaving(true)
    setSaveFailed(false)
    try {
      await onSave(draft, currentNote)
      onClose()
    } catch (err) {
      setSaveFailed(true)
      onError(err instanceof Error ? err.message : i18n.t('notes.saveFailed'))
      setSaving(false)
    }
  }

  async function runLifecycle(action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'delete') {
    if (!currentNote || saving) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    setSaving(true)
    setSaveFailed(false)
    try {
      const target = meaningful && signature !== savedSignature
        ? await onSave(draft, currentNote)
        : currentNote
      await onLifecycle(target, action)
    } catch (err) {
      setSaveFailed(true)
      onError(err instanceof Error ? err.message : i18n.t('notes.updateFailed'))
    } finally {
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
        `/api/manuscripts/${manuscriptId}/assets/`, form,
      )
      replaceImageUploadPlaceholder(editor, placeholderId, {
        type: 'illustration',
        attrs: { assetId: payload.asset.id, alt: payload.asset.alt, caption: payload.asset.caption, alignment: 'center' },
      })
    } catch (err) {
      if (!editor.isDestroyed) removeImageUploadPlaceholder(editor, placeholderId)
      onError(err instanceof Error ? err.message : i18n.t('notes.uploadFailed'))
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
    } catch (err) {
      onError(err instanceof Error ? err.message : i18n.t('notes.createTagFailed'))
    } finally {
      setAddingTag(false)
    }
  }

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
      { key: 'restore', label: t('notes.restore'), icon: <Icon name="restart-light" />, disabled: saving },
      { key: 'delete', label: t('notes.deleteForever'), icon: <Icon name="trash-bin-trash-light" />, danger: true, disabled: saving },
    )
  } else if (currentNote) {
    mobileActions.push(
      { key: currentNote.archivedAt ? 'unarchive' : 'archive', label: t(currentNote.archivedAt ? 'notes.unarchive' : 'notes.archive'), icon: <Icon name="archive-light" />, disabled: saving },
      { key: 'trash', label: t('notes.moveToTrash'), icon: <Icon name="trash-bin-trash-light" />, danger: true, disabled: saving },
    )
  }

  return (
    <div className="boardsEditorBackdrop dialogBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void closeEditor() }}>
    <aside
      ref={dialogRef}
      className="boardsEditor createOneShotDialog"
      data-note-color={color}
      role="dialog"
      aria-modal="true"
      aria-label={t(currentNote ? 'notes.editNote' : 'notes.newNoteEditor')}
      tabIndex={-1}
      style={editorColorStyle}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !window.matchMedia('(min-width: 521px)').matches) return
        if (imagePickerOpen || mobileActionsOpen || mobilePicker) return
        const target = event.target as HTMLElement
        if (target.closest('[aria-expanded="true"], .boardsSaveStatusPopover, .noteColorPopover, [role="listbox"]')) return
        event.preventDefault()
        void closeEditor()
      }}
    >
      <header>
        <button type="button" className="spaceButton boardsEditorMobileBack" aria-label={t('notes.backToNotes')} disabled={saving} onClick={() => void closeEditor()}><Icon name="arrow-left-1" /></button>
        <div className="boardsEditorTitleLine">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="boardsEditorTitleInput"
              type="text"
              value={title}
              maxLength={240}
              placeholder={t(currentNote ? 'notes.untitled' : 'notes.newNote')}
              aria-label={t('notes.noteTitle')}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'Escape') {
                  if (event.key === 'Escape') event.stopPropagation()
                  event.currentTarget.blur()
                }
              }}
            />
          ) : (
            <button type="button" className="spaceButton boardsEditorTitleButton" title={t('notes.renameNote')} onClick={() => setEditingTitle(true)}>
              {displayedTitle}
            </button>
          )}
        </div>
        <button type="button" className="dialogClose booksButton boardsEditorDesktopClose" aria-label={t('notes.closeEditor')} disabled={saving} onClick={() => void closeEditor()}><Icon name="close-square-light" /></button>
        <button type="button" className={`spaceButton boardsEditorMobileActions ${mobileActionsOpen ? 'active' : ''}`} aria-label={t('notes.noteActions')} aria-expanded={mobileActionsOpen} onClick={() => setMobileActionsOpen((open) => !open)}><Icon name="menu-dots-light" /></button>
      </header>
      <div className="boardsEditorBody">
        <div className="boardsEditorComposer">
        <div className="boardsFormatBar" aria-label={t('notes.textFormatting')}>
          <button type="button" className={`spaceButton ${editor?.isActive('bold') ? 'active' : ''}`} aria-label={t('notes.bold')} onClick={() => editor?.chain().focus().toggleBold().run()}><Icon name="text-bold-light" /></button>
          <button type="button" className={`spaceButton ${editor?.isActive('italic') ? 'active' : ''}`} aria-label={t('notes.italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}><Icon name="text-italic-light" /></button>
          <button type="button" className={`spaceButton ${editor?.isActive('strike') ? 'active' : ''}`} aria-label={t('notes.strikethrough')} onClick={() => editor?.chain().focus().toggleStrike().run()}><Icon name="text-cross-light" /></button>
          <span />
          <button type="button" className={`spaceButton ${editor?.isActive('bulletList') ? 'active' : ''}`} aria-label={t('notes.bulletedList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}><Icon name="mingcute-list-check-line" className="mingcuteToolbarIcon" /></button>
          <button type="button" className={`spaceButton ${editor?.isActive('taskList') ? 'active' : ''}`} aria-label={t('notes.checklist')} onClick={() => editor?.chain().focus().toggleTaskList().run()}><Icon name="mingcute-list-check-2-line" className="mingcuteToolbarIcon" /></button>
          <span />
          <button type="button" className="spaceButton" aria-label={t('notes.addImage')} disabled={uploading} onClick={() => setImagePickerOpen(true)}><Icon name="gallery-light" /></button>
          <span className="boardsFormatSpacer" />
          <BoardsSaveStatusIndicator status={saveStatus} className="boardsEditorDialogSaveStatus" />
        </div>
        <EditorContent editor={editor} />
        </div>

        <div className="boardsEditorMetadata">
        <section className="boardsEditorSection">
          <h2>{t('notes.board')}</h2>
          <CustomSelect value={boardId} onChange={(event) => setBoardId(event.target.value)}>
            <option value="">{t('notes.noBoard')}</option>
            {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
          </CustomSelect>
        </section>
        <section className="boardsEditorSection">
          <h2>{t('notes.color')}</h2>
          <div className="boardsColors">
            {NOTE_COLORS.map((candidate) => (
              <button key={candidate} type="button" className={color === candidate ? `spaceButton active ${candidate}` : `spaceButton ${candidate}`} aria-label={t('notes.noteColor', { color: t(`notes.colors.${candidate}`) })} onClick={() => setColor(candidate)} />
            ))}
            <NoteColorPicker value={color} onChange={setColor} />
          </div>
        </section>

        <section className="boardsEditorSection">
          <h2>{t('notes.tags')}</h2>
          <div className="boardsTagChoices">
            {tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} /><span style={{ '--tag-color': tag.color } as CSSProperties}>{tag.name}</span></label>)}
            {!tagCreateOpen && <button type="button" className="spaceButton boardsAddTagButton" aria-label={t('notes.createTag')} onClick={(event) => { event.stopPropagation(); setTagCreateOpen(true) }}><Icon name="sign-plus-light" /></button>}
          </div>
          {tagCreateOpen
            ? <div className="boardsInlineCreate"><input autoFocus value={tagName} maxLength={40} placeholder={t('notes.newTag')} onChange={(event) => setTagName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createTag(); if (event.key === 'Escape') { event.stopPropagation(); setTagCreateOpen(false); setTagName('') } }} /><button type="button" className="spaceButton" aria-label={t('notes.addTag')} disabled={!tagName.trim() || addingTag} onClick={() => void createTag()}><Icon name="sign-plus-light" /></button></div>
            : null}
        </section>

        <section className="boardsEditorSection">
          <h2>{t('notes.linkedItems')}</h2>
          <button type="button" className="spaceButton boardsLinkToggle" aria-expanded={linksOpen} onClick={() => setLinksOpen((open) => !open)}><Icon name="link-minimalistic-light" /> {itemIds.length ? t('notes.linkedItemsCount', { count: itemIds.length }) : t('notes.linkNote')}</button>
          {linksOpen && <div className="boardsItemChoices">
            {contextItems.map((item) => <label key={item.id} style={{ '--item-depth': itemDepth(item, contextItems) } as CSSProperties}><input type="checkbox" checked={itemIds.includes(item.id)} onChange={() => setItemIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><Icon name={item.kind === 'folder' ? 'folder-light' : 'file-document-light'} /><span>{item.title}</span></label>)}
            {!contextItems.length && <p>{t('notes.noItems')}</p>}
          </div>}
        </section>

        <div className="boardsNoteOptions">
          <button type="button" className={`spaceButton ${pinned ? 'active' : ''}`} onClick={() => setPinned((value) => !value)}><Icon name="pin-linear" className="boardsPinIcon" /> {t(pinned ? 'notes.pinned' : 'notes.pinNote')}</button>
          <button type="button" className={`spaceButton ${favourite ? 'active' : ''}`} onClick={() => setFavourite((value) => !value)}><Icon name="star-light" /> {t(favourite ? 'notes.favourite' : 'notes.addToFavourites')}</button>
        </div>
        {currentNote && <div className="boardsEditorLifecycleActions">
          {currentNote.trashedAt ? <>
            <button type="button" className="spaceButton" disabled={saving} onClick={() => void runLifecycle('restore')}>{t('notes.restore')}</button>
            <button type="button" className="spaceButton danger" disabled={saving} onClick={() => void runLifecycle('delete')}><Icon name="trash-bin-trash-light" /> {t('notes.deleteForever')}</button>
          </> : <>
            <button type="button" className="spaceButton" disabled={saving} onClick={() => void runLifecycle(currentNote.archivedAt ? 'unarchive' : 'archive')}><Icon name="archive-light" /> {t(currentNote.archivedAt ? 'notes.unarchive' : 'notes.archive')}</button>
            <button type="button" className="spaceButton danger" disabled={saving} onClick={() => void runLifecycle('trash')}><Icon name="trash-bin-trash-light" /> {t('notes.moveToTrash')}</button>
          </>}
        </div>}
        </div>
      </div>
      <div className={`boardsEditorMobileToolbar level-${mobileToolbarLevel}`} aria-label={t('notes.noteFormatting')}>
        {mobileToolbarLevel === 'main' && (
          <div className="boardsEditorMobileToolbarLevel main">
            <button type="button" className="spaceButton" aria-label={t('notes.color')} onClick={() => setMobileToolbarLevel('color')}><Icon name="pallete-2-light" /></button>
            <button type="button" className={`spaceButton ${tagIds.length ? 'active' : ''}`} aria-label={t('notes.tags')} onClick={() => setMobilePicker('tags')}><Icon name="bookmark-light" />{tagIds.length > 0 && <small>{tagIds.length}</small>}</button>
            <button type="button" className="spaceButton" aria-label={t('notes.textFormatting')} onClick={() => setMobileToolbarLevel('format')}><Icon name="mynaui-type-text" className="mynauiToolbarIcon" /></button>
            <span className="boardsEditorMobileToolbarSpacer" />
            <BoardsSaveStatusIndicator status={saveStatus} className="boardsEditorMobileToolbarStatus" />
          </div>
        )}
        {mobileToolbarLevel === 'format' && (
          <div className="boardsEditorMobileToolbarLevel format">
            <button type="button" className="spaceButton" aria-label={t('common.back')} onClick={() => setMobileToolbarLevel('main')}><Icon name="arrow-left-1" /></button>
            <span />
            <button type="button" className={`spaceButton ${editor?.isActive('bold') ? 'active' : ''}`} aria-label={t('notes.bold')} onClick={() => editor?.chain().focus().toggleBold().run()}><Icon name="text-bold-light" /></button>
            <button type="button" className={`spaceButton ${editor?.isActive('italic') ? 'active' : ''}`} aria-label={t('notes.italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}><Icon name="text-italic-light" /></button>
            <button type="button" className={`spaceButton ${editor?.isActive('strike') ? 'active' : ''}`} aria-label={t('notes.strikethrough')} onClick={() => editor?.chain().focus().toggleStrike().run()}><Icon name="text-cross-light" /></button>
            <span />
            <button type="button" className={`spaceButton ${editor?.isActive('bulletList') ? 'active' : ''}`} aria-label={t('notes.bulletedList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}><Icon name="mingcute-list-check-line" className="mingcuteToolbarIcon" /></button>
            <button type="button" className={`spaceButton ${editor?.isActive('taskList') ? 'active' : ''}`} aria-label={t('notes.checklist')} onClick={() => editor?.chain().focus().toggleTaskList().run()}><Icon name="mingcute-list-check-2-line" className="mingcuteToolbarIcon" /></button>
            <span />
            <button type="button" className="spaceButton" aria-label={t('notes.addImage')} disabled={uploading} onClick={() => setImagePickerOpen(true)}><Icon name="gallery-light" /></button>
          </div>
        )}
        {mobileToolbarLevel === 'color' && (
          <div className="boardsEditorMobileToolbarLevel color">
            <button type="button" className="spaceButton" aria-label={t('common.back')} onClick={() => setMobileToolbarLevel('main')}><Icon name="arrow-left-1" /></button>
            <span />
            {NOTE_COLORS.map((candidate) => (
              <button key={candidate} type="button" className={`spaceButton boardsEditorMobileColorChoice ${color === candidate ? 'active' : ''}`} aria-label={t('notes.noteColor', { color: t(`notes.colors.${candidate}`) })} onClick={() => setColor(candidate)}><i className={candidate} /></button>
            ))}
            <NoteColorPicker value={color} onChange={setColor} />
          </div>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => void uploadImage(event.target.files?.[0])} />
      <StorageImagePickerDialog open={imagePickerOpen} onClose={() => setImagePickerOpen(false)} onSelect={(item) => void selectStoredImage(item)} onUpload={() => { setImagePickerOpen(false); fileInputRef.current?.click() }} />
      <MobileLibraryActionSheet
        open={mobileActionsOpen}
        title={displayedTitle}
        actions={mobileActions}
        dismissOnSelect
        onClose={() => setMobileActionsOpen(false)}
        onActionSelect={(action) => {
          if (action.key === 'restore' || action.key === 'delete' || action.key === 'archive' || action.key === 'unarchive' || action.key === 'trash') {
            void runLifecycle(action.key)
          }
        }}
        topContent={(
          <div className="boardsEditorMobileQuickActions">
            <button type="button" className={`spaceButton ${pinned ? 'active' : ''}`} aria-pressed={pinned} onClick={() => setPinned((value) => !value)}><Icon name="pin-linear" className="boardsPinIcon" /><span>{t(pinned ? 'notes.pinned' : 'notes.pinNote')}</span></button>
            <button type="button" className={`spaceButton ${favourite ? 'active' : ''}`} aria-pressed={favourite} onClick={() => setFavourite((value) => !value)}><Icon name="star-light" /><span>{t(favourite ? 'notes.favourite' : 'notes.addToFavourites')}</span></button>
          </div>
        )}
      />
      {mobilePicker === 'board' && <MobileNotePickerSheet title={t('notes.board')} onClose={() => setMobilePicker(null)}>
        <div className="boardsMobileBoardPicker">
          <button type="button" className={`spaceButton ${!boardId ? 'active' : ''}`} onClick={() => setBoardId('')}>{t('notes.noBoard')}</button>
          {boards.map((board) => <button type="button" className={`spaceButton ${boardId === board.id ? 'active' : ''}`} key={board.id} onClick={() => setBoardId(board.id)}>{board.name}</button>)}
        </div>
      </MobileNotePickerSheet>}
      {mobilePicker === 'items' && <MobileNotePickerSheet title={t('notes.linkedItems')} onClose={() => setMobilePicker(null)}>
        <div className="boardsMobileItemPicker">
          {contextItems.map((item) => <label key={item.id} style={{ '--item-depth': itemDepth(item, contextItems) } as CSSProperties}><input type="checkbox" checked={itemIds.includes(item.id)} onChange={() => setItemIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><Icon name={item.kind === 'folder' ? 'folder-light' : 'file-document-light'} /><span>{item.title}</span></label>)}
          {!contextItems.length && <p>{t('notes.noItems')}</p>}
        </div>
      </MobileNotePickerSheet>}
      {mobilePicker === 'tags' && <MobileNotePickerSheet title={t('notes.tags')} onClose={() => setMobilePicker(null)}>
        <div className="boardsMobileTagPicker">
          <div className="boardsMobileTagChoices">
            {tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} /><span style={{ '--tag-color': tag.color } as CSSProperties}>{tag.name}</span></label>)}
          </div>
          <div className="boardsMobileTagCreate"><input value={tagName} maxLength={40} placeholder={t('notes.newTag')} onChange={(event) => setTagName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createTag() }} /><button type="button" className="spaceButton" aria-label={t('notes.addTag')} disabled={!tagName.trim() || addingTag} onClick={() => void createTag()}><Icon name="sign-plus-light" /></button></div>
        </div>
      </MobileNotePickerSheet>}
    </aside>
    </div>
  )
}

function MobileNotePickerSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  const { backdropStateClass, close: closeSheet, closing, setDialogRef } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') closeSheet()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeSheet])

  return (
    <div className={`dialogBackdrop mobileBottomSheetBackdrop boardsMobilePickerBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSheet() }}>
      <section className="createOneShotDialog mobileBottomSheet boardsMobilePickerSheet" role="dialog" aria-modal="true" aria-label={title} ref={setDialogRef}>
        <header><div><h2>{title}</h2></div><button type="button" className="dialogClose booksButton" aria-label={t('common.close')} disabled={closing} onClick={closeSheet}><Icon name="close-square-light" /></button></header>
        <div className="boardsMobilePickerBody">{children}</div>
        <footer><button type="button" className="dialogSubmit booksButton" disabled={closing} onClick={closeSheet}>{t('common.close')}</button></footer>
      </section>
    </div>
  )
}

function draftSignature(draft: NoteDraft) { return JSON.stringify(draft) }
function assetIds(content: JSONContent) { return (content.content ?? []).filter((node) => node.type === 'illustration').map((node) => String(node.attrs?.assetId ?? '')).filter(Boolean) }
function noteText(node: JSONContent): string { return `${node.text ?? ''}${(node.content ?? []).map(noteText).join('')}`.trim() }
function itemDepth(item: NoteContextItem, items: NoteContextItem[]) { const byId = new Map(items.map((candidate) => [candidate.id, candidate])); let depth = 0; let parent = item.parentId ? byId.get(item.parentId) : undefined; while (parent && depth < 3) { depth += 1; parent = parent.parentId ? byId.get(parent.parentId) : undefined } return depth }
