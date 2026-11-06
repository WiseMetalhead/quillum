import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'

export type BookItem = {
  id: string
  parentId: string | null
  kind: 'folder' | 'document'
  title: string
  position: number
  wordCount?: number
  characterCount?: number
  trashedAt: string | null
}

export type BookTree = {
  items: BookItem[]
  trash: BookItem[]
  structureGeneration: number
  maxFolderDepth: number
}

type Props = {
  manuscriptId: string
  tree: BookTree
  activeId: string | null
  editable: boolean
  showTrash?: boolean
  onOpenDocument: (id: string) => void
  onTrash: (id: string) => Promise<void>
  onRestore: (id: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onMove: (id: string, parentId: string | null, beforeId: string | null) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
}

export function BookNavigator({
  manuscriptId,
  tree,
  activeId,
  editable,
  showTrash = true,
  onOpenDocument,
  onTrash,
  onRestore,
  onDelete,
  onMove,
  onRename,
}: Props) {
  const { t, i18n } = useTranslation()
  const storageKey = `quillum:manuscript-navigation:${manuscriptId}`
  const [view, setView] = useState<'tree' | 'cards'>(() =>
    localStorage.getItem(storageKey) === 'cards' ? 'cards' : 'tree',
  )
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [folderId, setFolderId] = useState<string | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameItem, setRenameItem] = useState<BookItem | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [deleteItem, setDeleteItem] = useState<BookItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [mobileActionItem, setMobileActionItem] = useState<BookItem | null>(null)
  const isMobile = useMobileViewport()
  const children = useMemo(() => groupChildren(tree.items), [tree.items])
  const itemById = useMemo(() => new Map(tree.items.map((item) => [item.id, item])), [tree.items])
  const locale = i18n.resolvedLanguage ?? 'en'

  useEffect(() => {
    if (!menuId) return
    function closeMenu(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.bookItemMenu')) {
        setMenuId(null)
      }
    }
    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuId(null)
    }
    window.document.addEventListener('mousedown', closeMenu)
    window.document.addEventListener('keydown', closeMenuOnEscape)
    return () => {
      window.document.removeEventListener('mousedown', closeMenu)
      window.document.removeEventListener('keydown', closeMenuOnEscape)
    }
  }, [menuId])

  function selectView(next: 'tree' | 'cards') {
    setView(next)
    localStorage.setItem(storageKey, next)
    setTrashOpen(false)
    setMobileActionItem(null)
  }

  function openFolder(id: string | null) {
    setFolderId(id)
  }

  function toggleFolder(id: string) {
    openFolder(id)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startRename(item: BookItem) {
    setMenuId(null)
    setRenameItem(item)
    setRenameTitle(item.title)
  }

  async function submitRename() {
    if (!renameItem || !renameTitle.trim() || renaming) return
    setRenaming(true)
    try {
      await onRename(renameItem.id, renameTitle.trim())
      setRenameItem(null)
    } finally {
      setRenaming(false)
    }
  }

  async function submitDelete(closeAfterDelete = true) {
    if (!deleteItem || deleting) return
    setDeleting(true)
    try {
      await onDelete(deleteItem.id)
      if (closeAfterDelete) setDeleteItem(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="bookNavigator">
      <div className="bookNavigatorModes commentFilters" role="tablist" aria-label={t('bookNavigator.contentsView')}>
        <button type="button" role="tab" aria-selected={view === 'tree'} className={`spaceButton ${view === 'tree' ? 'active' : ''}`} onClick={() => selectView('tree')}>
          {t('bookNavigator.tree')}
        </button>
        <button type="button" role="tab" aria-selected={view === 'cards'} className={`spaceButton ${view === 'cards' ? 'active' : ''}`} onClick={() => selectView('cards')}>
          {t('bookNavigator.cards')}
        </button>
      </div>

      <div className={`bookNavigatorBody ${!trashOpen && view === 'cards' ? 'cardsView' : ''}`}>
        {trashOpen ? (
          <TrashView
            items={tree.trash}
            onBack={() => setTrashOpen(false)}
            onRestore={onRestore}
            onDelete={setDeleteItem}
          />
        ) : view === 'tree' ? (
          <div
            className="bookTree"
            role="tree"
            onDragOver={(event) => editable && !isMobile && event.preventDefault()}
            onDrop={(event) => {
              if (!editable || isMobile || event.target !== event.currentTarget) return
              const id = event.dataTransfer.getData('text/plain')
              if (id) void onMove(id, null, null)
            }}
          >
            {(children.get(null) ?? []).map((item) => (
              <TreeItem
                key={item.id}
                item={item}
                depth={0}
                activeId={activeId}
                editable={editable}
                children={children}
                expanded={expanded}
                menuId={menuId}
                onMenuChange={setMenuId}
                onToggle={toggleFolder}
                onOpenDocument={(id) => {
                  onOpenDocument(id)
                }}
                onMove={onMove}
                onRename={startRename}
                onTrash={onTrash}
                isMobile={isMobile}
                onMobileAction={setMobileActionItem}
              />
            ))}
          </div>
        ) : (
          <div className="bookCards">
            <Breadcrumbs folderId={folderId} itemById={itemById} onOpen={openFolder} />
            <div className="bookCardGrid">
              {(children.get(folderId) ?? []).map((item) => (
                <BookCard
                  key={item.id}
                  item={item}
                  active={activeId === item.id}
                  editable={editable}
                  isMobile={isMobile}
                  children={children}
                  locale={locale}
                  menuOpen={menuId === item.id}
                  onMenuChange={() => setMenuId(menuId === item.id ? null : item.id)}
                  onOpenFolder={openFolder}
                  onOpenDocument={onOpenDocument}
                  onMove={onMove}
                  onRename={startRename}
                  onTrash={onTrash}
                  onMobileAction={setMobileActionItem}
                />
              ))}
              {!(children.get(folderId) ?? []).length && <p className="bookNavigatorEmpty">{t('bookNavigator.folderEmpty')}</p>}
            </div>
          </div>
        )}
      </div>

      {showTrash && <button type="button" className={`bookTrashButton spaceButton ${trashOpen ? 'active' : ''}`} onClick={() => setTrashOpen((value) => !value)}>
        <span><Icon name="trash-bin-trash-light" /> {t('bookNavigator.trash')}</span>
        {!!tree.trash.length && <span className="bookTrashCount">{tree.trash.length}</span>}
      </button>}

      <MobileLibraryActionSheet
        open={mobileActionItem !== null}
        title={mobileActionItem?.title ?? ''}
        dismissOnSelect
        onClose={() => setMobileActionItem(null)}
        actions={mobileActionItem ? [
          {
            key: 'rename',
            label: t('bookNavigator.rename'),
            icon: <Icon name="edit-light" />,
            onSelect: () => startRename(mobileActionItem),
          },
          ...(mobileActionItem.parentId ? [{
            key: 'move-to-root',
            label: t('bookNavigator.moveToRoot'),
            icon: <Icon name="move-to-folder-light" />,
            onSelect: () => { void onMove(mobileActionItem.id, null, null) },
          }] : []),
          {
            key: 'trash',
            label: t('bookNavigator.moveToTrash'),
            icon: <Icon name="trash-bin-trash-light" />,
            danger: true,
            onSelect: () => { void onTrash(mobileActionItem.id) },
          },
        ] : []}
      />

      {renameItem && (
        <ActionDialog variant="structured" title={t(renameItem.kind === 'folder' ? 'bookNavigator.renameFolder' : 'bookNavigator.renameDocument')} closeLabel={t('common.close')} busy={renaming} className="bookItemActionDialog" onClose={() => !renaming && setRenameItem(null)}>
          <form onSubmit={(event) => { event.preventDefault(); void submitRename() }}>
            <label className="dialogField"><span>{t('editorShell.title')}</span><input autoFocus value={renameTitle} maxLength={240} onChange={(event) => setRenameTitle(event.target.value)} /></label>
            <footer>
              <button type="button" className="dialogCancel spaceButton" onClick={() => setRenameItem(null)} disabled={renaming}>{t('common.cancel')}</button>
              <button type="submit" className="dialogSubmit spaceButton" disabled={renaming || !renameTitle.trim()}>{renaming ? t('bookNavigator.renaming') : t('bookNavigator.rename')}</button>
            </footer>
          </form>
        </ActionDialog>
      )}

      {deleteItem && isMobile && (
        <MobileBookItemDeleteDialog
          item={deleteItem}
          deleting={deleting}
          onClose={() => setDeleteItem(null)}
          onDelete={() => submitDelete(false)}
        />
      )}

      {deleteItem && !isMobile && (
        <ActionDialog variant="structured" role="alertdialog" title={t('bookNavigator.deletePermanently')} closeLabel={t('common.close')} busy={deleting} className="bookItemActionDialog" onClose={() => !deleting && setDeleteItem(null)}>
          <div className="standardDialogSection">
            <p>{t('bookNavigator.deleteConfirm', { title: deleteItem.title })}</p>
            <footer className="standardDialogFooter">
              <button type="button" className="dialogCancel spaceButton" disabled={deleting} onClick={() => setDeleteItem(null)}>{t('common.cancel')}</button>
              <button type="button" className="dialogSubmit danger spaceButton" disabled={deleting} onClick={() => void submitDelete()}>{t(deleting ? 'account.deleting' : 'bookNavigator.deletePermanently')}</button>
            </footer>
          </div>
        </ActionDialog>
      )}
    </div>
  )
}

function groupChildren(items: BookItem[]) {
  const result = new Map<string | null, BookItem[]>()
  for (const item of items) {
    const group = result.get(item.parentId) ?? []
    group.push(item)
    result.set(item.parentId, group)
  }
  for (const group of result.values()) group.sort((left, right) => left.position - right.position)
  return result
}

function formatCount(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value)
}

function bookItemIconName(item: BookItem, children: Map<string | null, BookItem[]>) {
  if (item.kind === 'document') return 'file-document-light' as const
  return children.has(item.id) ? 'folder-with-files-light' as const : 'folder-light' as const
}

function folderPath(folderId: string | null, itemById: Map<string, BookItem>) {
  const result: BookItem[] = []
  let current = folderId ? itemById.get(folderId) : undefined
  while (current) {
    result.unshift(current)
    current = current.parentId ? itemById.get(current.parentId) : undefined
  }
  return result
}

function Breadcrumbs({ folderId, itemById, onOpen }: { folderId: string | null; itemById: Map<string, BookItem>; onOpen: (id: string | null) => void }) {
  const { t } = useTranslation()
  return <nav className="bookBreadcrumbs" aria-label={t('bookNavigator.currentFolder')}>
    <button type="button" className="spaceButton" onClick={() => onOpen(null)}>{t('bookNavigator.book')}</button>
    {folderPath(folderId, itemById).map((item) => <span key={item.id}><Icon name="arrow-right-2" /><button type="button" className="spaceButton" onClick={() => onOpen(item.id)}>{item.title}</button></span>)}
  </nav>
}

type BookCardProps = {
  item: BookItem
  active: boolean
  editable: boolean
  isMobile: boolean
  children: Map<string | null, BookItem[]>
  locale: string
  menuOpen: boolean
  onMenuChange: () => void
  onOpenFolder: (id: string | null) => void
  onOpenDocument: (id: string) => void
  onMove: (id: string, parentId: string | null, beforeId: string | null) => Promise<void>
  onRename: (item: BookItem) => void
  onTrash: (id: string) => Promise<void>
  onMobileAction: (item: BookItem) => void
}

function BookCard({ item, active, editable, isMobile, children, locale, menuOpen, onMenuChange, onOpenFolder, onOpenDocument, onMove, onRename, onTrash, onMobileAction }: BookCardProps) {
  const { t } = useTranslation()
  const longPress = useMobileItemLongPress(editable && isMobile, () => onMobileAction(item))

  return (
    <article
      className={`bookItemCard ${active ? 'active' : ''}`}
      draggable={editable && !isMobile}
      onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
      onDragOver={(event) => editable && !isMobile && event.preventDefault()}
      onDrop={(event) => {
        if (!editable || isMobile) return
        event.stopPropagation()
        const draggedId = event.dataTransfer.getData('text/plain')
        if (draggedId && draggedId !== item.id) {
          void onMove(
            draggedId,
            item.kind === 'folder' ? item.id : item.parentId,
            item.kind === 'folder' ? null : item.id,
          )
        }
      }}
    >
      <button
        type="button"
        className="bookCardMain spaceButton"
        aria-haspopup={editable && isMobile ? 'dialog' : undefined}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.cancel}
        onPointerCancel={longPress.cancel}
        onPointerLeave={longPress.cancel}
        onContextMenu={longPress.onContextMenu}
        onKeyDown={longPress.onKeyDown}
        onClick={() => {
          if (longPress.consumeClick()) return
          if (item.kind === 'folder') onOpenFolder(item.id)
          else onOpenDocument(item.id)
        }}
      >
        <span className="bookItemIcon"><Icon name={bookItemIconName(item, children)} /></span>
        <span className="bookCardText">
          <strong>{item.title}</strong>
          <span className="bookCardMeta">
            <span>{t('bookNavigator.words', { count: item.wordCount ?? 0, formatted: formatCount(item.wordCount ?? 0, locale) })}</span>
            <i aria-hidden="true" />
            <span>{t('bookNavigator.characters', { count: item.characterCount ?? 0, formatted: formatCount(item.characterCount ?? 0, locale) })}</span>
            <span className="bookCardStatusSlot" aria-hidden="true" />
          </span>
        </span>
      </button>
      {editable && !isMobile && (
        <ItemMenu
          item={item}
          open={menuOpen}
          onOpen={onMenuChange}
          onRename={onRename}
          onMoveToRoot={(id) => {
            onMenuChange()
            return onMove(id, null, null)
          }}
          onTrash={(id) => {
            onMenuChange()
            return onTrash(id)
          }}
        />
      )}
    </article>
  )
}

function useMobileItemLongPress(enabled: boolean, onLongPress: () => void) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const onLongPressRef = useRef(onLongPress)

  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])

  function cancel() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (!enabled) return
      suppressClickRef.current = false
      if (event.pointerType === 'mouse' || event.button !== 0) return
      cancel()
      startRef.current = { x: event.clientX, y: event.clientY }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        startRef.current = null
        suppressClickRef.current = true
        onLongPressRef.current()
      }, 520)
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      if (!startRef.current) return
      if (Math.hypot(event.clientX - startRef.current.x, event.clientY - startRef.current.y) > 10) cancel()
    },
    cancel,
    onContextMenu(event: ReactMouseEvent<HTMLElement>) {
      if (!enabled) return
      event.preventDefault()
      cancel()
      suppressClickRef.current = true
      onLongPressRef.current()
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
      if (!enabled || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return
      event.preventDefault()
      cancel()
      onLongPressRef.current()
    },
    consumeClick() {
      if (!suppressClickRef.current) return false
      suppressClickRef.current = false
      return true
    },
  }
}

type TreeItemProps = {
  item: BookItem
  depth: number
  activeId: string | null
  editable: boolean
  children: Map<string | null, BookItem[]>
  expanded: Set<string>
  menuId: string | null
  onMenuChange: (id: string | null) => void
  onToggle: (id: string) => void
  onOpenDocument: (id: string) => void
  onMove: (id: string, parentId: string | null, beforeId: string | null) => Promise<void>
  onRename: (item: BookItem) => void
  onTrash: (id: string) => Promise<void>
  isMobile: boolean
  onMobileAction: (item: BookItem) => void
}

function TreeItem({ item, depth, activeId, editable, children, expanded, menuId, onMenuChange, onToggle, onOpenDocument, onMove, onRename, onTrash, isMobile, onMobileAction }: TreeItemProps) {
  const isFolder = item.kind === 'folder'
  const isExpanded = expanded.has(item.id)
  const longPress = useMobileItemLongPress(editable && isMobile, () => onMobileAction(item))
  return <div role="treeitem" aria-expanded={isFolder ? isExpanded : undefined}>
    <div className={`bookTreeItem ${activeId === item.id ? 'active' : ''}`} style={{ '--tree-depth': depth } as CSSProperties}>
      <button
        type="button"
        draggable={editable && !isMobile}
        className="bookTreeRow spaceButton"
        aria-haspopup={editable && isMobile ? 'dialog' : undefined}
        onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
        onDragOver={(event) => editable && !isMobile && event.preventDefault()}
        onDrop={(event) => {
          if (!editable || isMobile) return
          event.stopPropagation()
          const draggedId = event.dataTransfer.getData('text/plain')
          if (draggedId && draggedId !== item.id) void onMove(draggedId, isFolder ? item.id : item.parentId, isFolder ? null : item.id)
        }}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.cancel}
        onPointerCancel={longPress.cancel}
        onPointerLeave={longPress.cancel}
        onContextMenu={longPress.onContextMenu}
        onKeyDown={longPress.onKeyDown}
        onClick={() => {
          if (longPress.consumeClick()) return
          if (isFolder) onToggle(item.id)
          else onOpenDocument(item.id)
        }}
      >
        <span className={`bookTreeChevron ${!isFolder ? 'placeholder' : ''}`}>{isFolder && <Icon name="arrow-right-2" className={isExpanded ? 'expanded' : undefined} />}</span>
        <span className={`bookTreeTypeIcon ${isFolder ? 'folder' : 'document'}`}><Icon name={bookItemIconName(item, children)} /></span>
        <span className="bookTreeTitle">{item.title}</span>
      </button>
      {editable && !isMobile && <ItemMenu item={item} open={menuId === item.id} onOpen={() => onMenuChange(menuId === item.id ? null : item.id)} onRename={onRename} onMoveToRoot={(id) => { onMenuChange(null); return onMove(id, null, null) }} onTrash={(id) => { onMenuChange(null); return onTrash(id) }} />}
    </div>
    {isFolder && isExpanded && (children.get(item.id) ?? []).map((child) => (
      <TreeItem key={child.id} item={child} depth={depth + 1} activeId={activeId} editable={editable} children={children} expanded={expanded} menuId={menuId} onMenuChange={onMenuChange} onToggle={onToggle} onOpenDocument={onOpenDocument} onMove={onMove} onRename={onRename} onTrash={onTrash} isMobile={isMobile} onMobileAction={onMobileAction} />
    ))}
  </div>
}

function ItemMenu({ item, open, onOpen, onRename, onMoveToRoot, onTrash }: { item: BookItem; open: boolean; onOpen: () => void; onRename: (item: BookItem) => void; onMoveToRoot: (id: string) => Promise<void>; onTrash: (id: string) => Promise<void> }) {
  const { t } = useTranslation()
  return <div className="bookItemMenu">
    <button type="button" className="bookItemMenuButton spaceButton" aria-label={t('bookNavigator.actionsFor', { title: item.title })} aria-expanded={open} onClick={onOpen}><Icon name="menu-kebab-vertical-light" /></button>
    {open && <div className="bookItemMenuPopover">
      <button type="button" className="spaceButton" onClick={() => onRename(item)}><Icon name="edit-light" />{t('bookNavigator.rename')}</button>
      {item.parentId && <button type="button" className="spaceButton" onClick={() => void onMoveToRoot(item.id)}><Icon name="move-to-folder-light" />{t('bookNavigator.moveToRoot')}</button>}
      <button type="button" className="danger spaceButton" onClick={() => void onTrash(item.id)}><Icon name="trash-bin-trash-light" />{t('bookNavigator.moveToTrash')}</button>
    </div>}
  </div>
}

function MobileBookItemDeleteDialog({ item, deleting, onClose, onDelete }: { item: BookItem; deleting: boolean; onClose: () => void; onDelete: () => Promise<void> }) {
  const { t } = useTranslation()
  const titleId = useId()
  const descriptionId = useId()
  const { backdropStateClass, close, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !deleting) close()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [close, deleting])

  async function remove() {
    if (deleting || closing) return
    await onDelete()
    finishAfterExit(onClose)
  }

  return createPortal(
    <div
      className={`standardDialogBackdrop bookItemDeleteBackdrop ${backdropStateClass}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) close()
      }}
    >
      <section
        className="standardActionDialog bookItemActionDialog bookItemDeleteSheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        ref={setDialogRef}
      >
        <header>
          <div><h2 id={titleId}>{t('bookNavigator.deletePermanently')}</h2></div>
          <button type="button" className="standardDialogClose spaceButton" aria-label={t('common.close')} disabled={deleting || closing} onClick={close}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="standardDialogContent">
          <div className="standardDialogSection">
            <p id={descriptionId}>{t('bookNavigator.deleteConfirm', { title: item.title })}</p>
            <footer className="standardDialogFooter">
              <button type="button" className="dialogCancel spaceButton" disabled={deleting || closing} onClick={close}>{t('common.cancel')}</button>
              <button type="button" className="dialogSubmit danger spaceButton" disabled={deleting || closing} onClick={() => void remove()}>{t(deleting ? 'account.deleting' : 'bookNavigator.deletePermanently')}</button>
            </footer>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function TrashView({ items, onBack, onRestore, onDelete }: { items: BookItem[]; onBack: () => void; onRestore: (id: string) => Promise<void>; onDelete: (item: BookItem) => void }) {
  const { t } = useTranslation()
  return <div className="bookTrashView">
    <button type="button" className="bookNavigatorBack spaceButton" onClick={onBack}><Icon name="arrow-left-1" /> {t('bookNavigator.contents')}</button>
    <h3>{t('bookNavigator.trash')}</h3>
    {items.length ? items.map((item) => <div className="bookTrashItem" key={item.id}>
      <span className="bookItemIcon"><Icon name={item.kind === 'folder' ? 'folder-light' : 'file-document-light'} /></span>
      <strong>{item.title}</strong>
      <button type="button" className="bookTrashItemAction spaceButton" aria-label={t('bookNavigator.restoreItem', { title: item.title })} title={t('bookNavigator.restore')} onClick={() => void onRestore(item.id)}><Icon name="restart-light" /></button>
      <button type="button" className="bookTrashItemAction danger spaceButton" aria-label={t('bookNavigator.permanentlyDeleteItem', { title: item.title })} title={t('bookNavigator.deletePermanently')} onClick={() => onDelete(item)}><Icon name="trash-bin-trash-light" /></button>
    </div>) : <p className="bookNavigatorEmpty">{t('bookNavigator.trashEmpty')}</p>}
  </div>
}
