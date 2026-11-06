import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CustomSelect } from '../shared/CustomSelect'
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import type { Manuscript } from './ManuscriptTypes'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { NoteColorPicker } from './NoteColorPicker'
import type { PlannerData, PlannerItem, PlannerStatus } from './PlannerTypes'

type Props = {
  manuscript: Manuscript
  planner: PlannerData
  onChange: (planner: PlannerData) => void
  onError: (error: string) => void
  onOpenEditorDocument: (itemId: string | null) => void
}

type CreateRole = 'act' | 'chapter' | 'scene'
type EditableStatus = Omit<PlannerStatus, 'id' | 'position'> & { key: string; id: string | null }
type TreeDrop = { itemId: string; position: 'before' | 'inside' | 'after' }
type MobileDialogTransition = ReturnType<typeof useMobileDialogTransition>

const presetColors = {
  gray: '#64748b',
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#d97706',
  purple: '#7c3aed',
  red: '#dc2626',
  teal: '#0d9488',
} as const
export function PlannerPlan({ manuscript, planner, onChange, onError, onOpenEditorDocument }: Props) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const formatter = new Intl.NumberFormat(i18n.resolvedLanguage)
  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  })
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [menuId, setMenuId] = useState<string | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [createRole, setCreateRole] = useState<CreateRole | null>(null)
  const [editItem, setEditItem] = useState<PlannerItem | null>(null)
  const [detailItem, setDetailItem] = useState<PlannerItem | null>(null)
  const [mobileActionItem, setMobileActionItem] = useState<PlannerItem | null>(null)
  const [mobileCreateMenuOpen, setMobileCreateMenuOpen] = useState(false)
  const [statusesOpen, setStatusesOpen] = useState(false)
  const [reorganizeOpen, setReorganizeOpen] = useState(false)
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null)
  const [treeDrop, setTreeDrop] = useState<TreeDrop | null>(null)
  const [visibleLimit, setVisibleLimit] = useState(8)
  const actionMenuRef = useRef<HTMLDivElement>(null)
  const knownFolders = useRef<Set<string>>(new Set())
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressRowClickRef = useRef(false)

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current)
      for (const item of planner.plan.items) {
        if (item.kind === 'folder' && !knownFolders.current.has(item.id)) next.add(item.id)
        if (item.kind === 'folder') knownFolders.current.add(item.id)
      }
      return next
    })
  }, [planner.plan.items])

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
  }, [])

  useEffect(() => {
    if (!menuId && !addMenuOpen) return
    function close(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.plannerActionMenu')) {
        setMenuId(null)
        if (!actionMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false)
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { setMenuId(null); setAddMenuOpen(false) }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [addMenuOpen, menuId])

  const rows = useMemo(() => flattenItems(planner.plan.items, expanded), [expanded, planner.plan.items])
  const visibleRows = isMobile ? rows : rows.slice(0, visibleLimit)
  const statusById = useMemo(
    () => new Map(planner.plan.statuses.map((status) => [status.id, status])),
    [planner.plan.statuses],
  )
  const foldersWithChildren = useMemo(
    () => new Set(planner.plan.items.flatMap((item) => item.parentId ? [item.parentId] : [])),
    [planner.plan.items],
  )

  async function refreshPlanner() {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const payload = await apiRequest<{ planner: PlannerData }>(
      `/api/manuscripts/${manuscript.id}/planner/?timezone=${encodeURIComponent(timezone)}`,
    )
    onChange(payload.planner)
  }

  async function trash(item: PlannerItem) {
    setMenuId(null)
    try {
      await apiRequest(`/api/manuscripts/book-items/${item.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'trash',
          expectedStructureGeneration: planner.plan.structureGeneration,
        }),
      })
      await refreshPlanner()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('plannerPlan.trashFailed'))
    }
  }

  function cancelLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null
  }

  function startLongPress(item: PlannerItem, event: ReactPointerEvent<HTMLElement>) {
    if (!isMobile || event.button !== 0) return
    cancelLongPress()
    longPressStartRef.current = { x: event.clientX, y: event.clientY }
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null
      longPressStartRef.current = null
      suppressRowClickRef.current = true
      setMobileActionItem(item)
    }, 550)
  }

  function moveLongPress(event: ReactPointerEvent<HTMLElement>) {
    const start = longPressStartRef.current
    if (!start) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 9) {
      cancelLongPress()
    }
  }

  function suppressClickAfterLongPress(event: ReactMouseEvent<HTMLElement>) {
    if (!suppressRowClickRef.current) return
    suppressRowClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  async function moveItem(sourceId: string, target: PlannerItem, position: TreeDrop['position']) {
    if (sourceId === target.id) return
    let parentId = target.parentId
    let beforeId: string | null = target.id
    if (position === 'inside') {
      parentId = target.id
      beforeId = null
    } else if (position === 'after') {
      const siblings = planner.plan.items
        .filter((item) => item.parentId === target.parentId && item.id !== sourceId)
        .sort((left, right) => left.position - right.position)
      const targetIndex = siblings.findIndex((item) => item.id === target.id)
      beforeId = siblings[targetIndex + 1]?.id ?? null
    }
    setTreeDrop(null)
    try {
      await apiRequest(`/api/manuscripts/book-items/${sourceId}/`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'move',
          parentId,
          beforeId,
          expectedStructureGeneration: planner.plan.structureGeneration,
        }),
      })
      await refreshPlanner()
    } catch (err) {
      onError(err instanceof Error ? err.message : t('plannerPlan.moveFailed'))
    } finally {
      setDraggedItemId(null)
    }
  }

  return (
    <section className="plannerPlanBlock">
      <header className="plannerPlanHeader">
        <h2 className="plannerBlockTitle"><Icon name="file-document-light" />{t('plannerPlan.title')}</h2>
        <div className="plannerPlanActions">
          {manuscript.kind === 'book' && (
            <div className="plannerActionMenu" ref={actionMenuRef}>
              <button type="button" className="plannerAddButton booksButton" aria-haspopup="menu" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((open) => !open)}>
                <PlusIcon /> {t('plannerPlan.addItem')}
              </button>
              {addMenuOpen && (
                <div className="plannerHeaderMenu" role="menu">
                  {(['act', 'chapter', 'scene'] as CreateRole[]).map((role) => (
                    <button key={role} type="button" className="booksButton" role="menuitem" onClick={() => { setAddMenuOpen(false); setCreateRole(role) }}>
                      {addRoleLabel(role, t)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button type="button" className="plannerBlockMenuButton booksButton" aria-label={t('plannerPlan.settings')} onClick={() => setStatusesOpen(true)}><Icon name="settings-light" /></button>
        </div>
      </header>

      <div className="plannerTableScroll">
        <div className="plannerTable" role="table" aria-label={t('plannerPlan.title')}>
          <div className="plannerTableHeader" role="row">
            <span role="columnheader">{t('plannerPlan.structure')}</span>
            <span role="columnheader">{t('plannerPlan.status')}</span>
            <span role="columnheader">{t('plannerPlan.deadline')}</span>
            <span role="columnheader">{t('plannerPlan.words')}</span>
            <span role="columnheader">{t('plannerPlan.progress')}</span>
            <span aria-hidden="true" />
          </div>
          {visibleRows.map(({ item, depth }, rowIndex) => {
            const status = item.statusId ? statusById.get(item.statusId) : undefined
            const itemProgress = progress(item.wordCount, item.wordGoal)
            return (
              <div
                className={`plannerTableRow ${rowIndex < 2 ? 'topRow' : ''} ${draggedItemId === item.id ? 'dragging' : ''} ${treeDrop?.itemId === item.id ? `drop-${treeDrop.position}` : ''}`}
                role="row"
                key={item.id}
                onDragOver={(event) => {
                  if (!draggedItemId || draggedItemId === item.id) return
                  event.preventDefault()
                  const bounds = event.currentTarget.getBoundingClientRect()
                  const ratio = (event.clientY - bounds.top) / bounds.height
                  const position = item.kind === 'folder' && ratio >= 0.28 && ratio <= 0.72
                    ? 'inside'
                    : ratio < 0.5 ? 'before' : 'after'
                  setTreeDrop({ itemId: item.id, position })
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setTreeDrop((current) => current?.itemId === item.id ? null : current)
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (draggedItemId && treeDrop?.itemId === item.id) void moveItem(draggedItemId, item, treeDrop.position)
                }}
              >
                <div className="plannerStructureCell" role="cell" style={{ '--planner-depth': depth } as CSSProperties}>
                  <button type="button" className={`plannerExpand booksButton ${item.kind === 'folder' ? '' : 'placeholder'}`} aria-label={item.kind === 'folder' ? t(expanded.has(item.id) ? 'plannerPlan.collapse' : 'plannerPlan.expand', { title: item.title }) : undefined} onClick={() => item.kind === 'folder' && setExpanded(toggleSet(expanded, item.id))}>
                    {item.kind === 'folder' && <ChevronIcon open={expanded.has(item.id)} />}
                  </button>
                  {manuscript.kind === 'book' && (
                    <span
                      className="plannerTreeDragHandle"
                      draggable
                      title={t('plannerPlan.dragMove')}
                      onDragStart={(event) => {
                        setDraggedItemId(item.id)
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', item.id)
                      }}
                      onDragEnd={() => { setDraggedItemId(null); setTreeDrop(null) }}
                    ><i /><i /><i /><i /><i /><i /></span>
                  )}
                  <span className="plannerItemIcon" aria-hidden="true">
                    <Icon
                      name={
                        item.kind === 'folder'
                          ? foldersWithChildren.has(item.id)
                            ? 'folder-with-files-light'
                            : 'folder-light'
                          : 'file-text-light'
                      }
                    />
                  </span>
                  <span className="plannerItemTitle">
                    {item.kind === 'document' ? (
                      <button
                        type="button"
                        className="plannerItemTitleButton booksButton"
                        onClick={() => onOpenEditorDocument(manuscript.kind === 'book' ? item.id : null)}
                      >
                        <strong>{item.title}</strong>
                      </button>
                    ) : (
                      <strong>{item.title}</strong>
                    )}
                    <small>{roleLabel(item.role, t)}</small>
                  </span>
                </div>
                <div role="cell">{status ? <span className={`plannerStatusChip ${statusColorClass(status.color)}`} style={statusColorStyle(status.color)}>{status.name}</span> : <span className="plannerMuted">{t('plannerPlan.noStatus')}</span>}</div>
                <div role="cell" className="plannerDeadlineCell">{item.deadline ? <><span>{formatDate(item.deadline, dateFormatter)}</span><DeadlineMark item={item} status={status} today={planner.statistics.today} /></> : <span className="plannerMuted">{t('plannerPlan.noDeadline')}</span>}</div>
                <div role="cell" className="plannerWordsCell"><span>{formatter.format(item.wordCount)}</span>{item.wordGoal ? <span> / {formatter.format(item.wordGoal)}</span> : null}</div>
                <div role="cell" className="plannerRowProgress"><span>{item.wordGoal ? `${itemProgress}%` : '—'}</span><i><b style={{ width: `${itemProgress}%` }} /></i></div>
                <div role="cell" className="plannerActionMenu">
                  <button type="button" className="plannerRowMenuButton booksButton" aria-label={t('plannerPlan.actionsFor', { title: item.title })} aria-expanded={menuId === item.id} onClick={() => setMenuId(menuId === item.id ? null : item.id)}><Icon name="menu-dots-light" /></button>
                  {menuId === item.id && (
                    <div className="plannerRowMenu" role="menu">
                      <button type="button" className="booksButton" role="menuitem" onClick={() => { setMenuId(null); setEditItem(item) }}><Icon name="settings-light" />{t('plannerPlan.itemSettings')}</button>
                      {manuscript.kind === 'book' && <button type="button" className="danger booksButton" role="menuitem" onClick={() => void trash(item)}><Icon name="trash-bin-trash-light" />{t('plannerPlan.moveToTrash')}</button>}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="plannerMobilePlanTree" role="tree" aria-label={t('plannerPlan.title')}>
        {visibleRows.map(({ item, depth }) => {
          const status = item.statusId ? statusById.get(item.statusId) : undefined
          const folderOpen = item.kind === 'folder' && expanded.has(item.id)
          return (
            <div
              className="plannerMobilePlanRow"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={item.kind === 'folder' ? folderOpen : undefined}
              style={{ '--planner-depth': depth } as CSSProperties}
              key={item.id}
              onPointerDown={(event) => startLongPress(item, event)}
              onPointerMove={moveLongPress}
              onPointerUp={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onClickCapture={suppressClickAfterLongPress}
              onContextMenu={(event) => {
                event.preventDefault()
                cancelLongPress()
                setMobileActionItem(item)
              }}
            >
              {item.kind === 'folder' ? (
                <button
                  type="button"
                  className="plannerMobilePlanExpand booksButton"
                  aria-label={t(folderOpen ? 'plannerPlan.collapse' : 'plannerPlan.expand', { title: item.title })}
                  onClick={() => setExpanded(toggleSet(expanded, item.id))}
                >
                  <ChevronIcon open={folderOpen} />
                </button>
              ) : <span className="plannerMobilePlanExpand placeholder" aria-hidden="true" />}
              <button
                type="button"
                className="plannerMobilePlanMain booksButton"
                aria-haspopup="menu"
                onClick={() => {
                  if (item.kind === 'document') onOpenEditorDocument(manuscript.kind === 'book' ? item.id : null)
                  else setExpanded(toggleSet(expanded, item.id))
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    setMobileActionItem(item)
                  }
                }}
              >
                <span className="plannerMobilePlanIdentity">
                  <Icon name={item.kind === 'folder' ? foldersWithChildren.has(item.id) ? 'folder-with-files-light' : 'folder-light' : 'file-text-light'} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{roleLabel(item.role, t)}</small>
                  </span>
                </span>
                <span className="plannerMobilePlanSummary">
                  <span>{t('plannerPlan.wordCount', { count: item.wordCount, formattedCount: formatter.format(item.wordCount) })}</span>
                  <span className="plannerMobilePlanStatus">
                    <i style={{ background: status ? statusColorValue(status.color) : 'var(--color-text-subtle)' }} />
                    {status?.name || t('plannerPlan.noStatus')}
                  </span>
                </span>
              </button>
            </div>
          )
        })}
      </div>

      {!rows.length && <p className="plannerPlanEmpty">{t('plannerPlan.noItems')}</p>}
      {!isMobile && rows.length > visibleLimit && (
        <footer className="plannerShowMore">
          <button type="button" className="booksButton" onClick={() => setVisibleLimit((current) => current + 8)}>
            {t('plannerPlan.showMore', { count: Math.min(8, rows.length - visibleLimit) })}
            <ChevronIcon open />
          </button>
        </footer>
      )}
      {isMobile && !createRole && !editItem && !detailItem && !statusesOpen && !reorganizeOpen && (
        <div className="plannerMobilePlanActions">
          <button type="button" className="plannerMobileStatusesAction booksButton" aria-label={t('plannerPlan.settings')} onClick={() => setStatusesOpen(true)}><Icon name="settings-light" /></button>
          {manuscript.kind === 'book' && <button type="button" className="plannerMobilePlanAddAction booksButton" aria-label={t('plannerPlan.addItem')} onClick={() => setMobileCreateMenuOpen(true)}><PlusIcon /></button>}
        </div>
      )}
      <MobileLibraryActionSheet
        open={isMobile && mobileCreateMenuOpen}
        title={t('plannerPlan.addItem')}
        dismissOnSelect
        onClose={() => setMobileCreateMenuOpen(false)}
        actions={(manuscript.kind === 'book' ? (['act', 'chapter', 'scene'] as CreateRole[]) : []).map((role) => ({
          key: role,
          label: addRoleLabel(role, t),
          icon: <Icon name={role === 'act' ? 'folder-with-files-light' : role === 'chapter' ? 'folder-light' : 'file-text-light'} />,
          onSelect: () => setCreateRole(role),
        }))}
      />
      <MobileLibraryActionSheet
        open={isMobile && mobileActionItem !== null}
        title={mobileActionItem?.title || t('plannerPlan.title')}
        dismissOnSelect
        onClose={() => {
          suppressRowClickRef.current = false
          setMobileActionItem(null)
        }}
        actions={mobileActionItem ? [
          {
            key: 'details',
            label: t('plannerPlan.details'),
            icon: <Icon name="information-circle-light" />,
            onSelect: () => setDetailItem(mobileActionItem),
          },
          {
            key: 'settings',
            label: t('plannerPlan.itemSettings'),
            icon: <Icon name="settings-light" />,
            onSelect: () => setEditItem(mobileActionItem),
          },
          ...(manuscript.kind === 'book' ? [{
            key: 'reorganize',
            label: t('plannerPlan.reorganize'),
            icon: <Icon name="move-to-folder-light" />,
            onSelect: () => setReorganizeOpen(true),
          }, {
            key: 'delete',
            label: t('plannerPlan.moveToTrash'),
            icon: <Icon name="trash-bin-trash-light" />,
            danger: true,
            onSelect: () => void trash(mobileActionItem),
          }] : []),
        ] : []}
      />
      {detailItem && <PlannerItemDetailsDialog item={detailItem} status={detailItem.statusId ? statusById.get(detailItem.statusId) : undefined} locale={i18n.resolvedLanguage} onClose={() => setDetailItem(null)} onEdit={() => { setDetailItem(null); setEditItem(detailItem) }} />}
      {createRole && <CreatePlannerItemDialog role={createRole} manuscript={manuscript} planner={planner} mobilePresentation={isMobile} onClose={() => setCreateRole(null)} onSaved={(next) => { onChange(next); setCreateRole(null) }} onError={onError} />}
      {editItem && <PlannerItemDialog item={editItem} planner={planner} mobilePresentation={isMobile} onClose={() => setEditItem(null)} onSaved={(next) => { onChange(next); setEditItem(null) }} onError={onError} />}
      {statusesOpen && <PlannerStatusesDialog planner={planner} manuscriptId={manuscript.id} mobilePresentation={isMobile} onClose={() => setStatusesOpen(false)} onSaved={(next) => { onChange(next); setStatusesOpen(false) }} onError={onError} />}
      {reorganizeOpen && <PlannerReorganizeDialog items={planner.plan.items} onClose={() => setReorganizeOpen(false)} onMove={moveItem} />}
    </section>
  )
}

function PlannerReorganizeDialog({ items, onClose, onMove }: { items: PlannerItem[]; onClose: () => void; onMove: (sourceId: string, target: PlannerItem, position: TreeDrop['position']) => Promise<void> }) {
  const { t } = useTranslation()
  const transition = useMobileDialogTransition({ onClose, focusOnDesktop: false })
  const rows = useMemo(
    () => flattenItems(items, new Set(items.filter((item) => item.kind === 'folder').map((item) => item.id))),
    [items],
  )
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const listRef = useRef<HTMLDivElement>(null)
  const sourceIdRef = useRef<string | null>(null)
  const dropRef = useRef<TreeDrop | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<TreeDrop | null>(null)
  const [moving, setMoving] = useState(false)

  function updateDrop(event: ReactPointerEvent<HTMLButtonElement>) {
    const sourceId = sourceIdRef.current
    if (!sourceId) return
    const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-reorganize-item-id]')
    const targetId = targetRow?.dataset.reorganizeItemId
    const target = targetId ? itemById.get(targetId) : undefined
    if (!targetRow || !target || target.id === sourceId || isItemDescendant(items, target.id, sourceId)) {
      dropRef.current = null
      setDropTarget(null)
      return
    }
    const bounds = targetRow.getBoundingClientRect()
    const ratio = (event.clientY - bounds.top) / bounds.height
    const position: TreeDrop['position'] = target.kind === 'folder' && ratio >= 0.28 && ratio <= 0.72
      ? 'inside'
      : ratio < 0.5 ? 'before' : 'after'
    const next = { itemId: target.id, position }
    dropRef.current = next
    setDropTarget(next)

    const list = listRef.current
    if (list) {
      const listBounds = list.getBoundingClientRect()
      if (event.clientY < listBounds.top + 52) list.scrollTop -= 14
      else if (event.clientY > listBounds.bottom - 52) list.scrollTop += 14
    }
  }

  async function finishDrag(event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const sourceId = sourceIdRef.current
    const destination = dropRef.current
    sourceIdRef.current = null
    dropRef.current = null
    setDraggedId(null)
    setDropTarget(null)
    if (!commit || !sourceId || !destination) return
    const target = itemById.get(destination.itemId)
    if (!target) return
    setMoving(true)
    await onMove(sourceId, target, destination.position)
    setMoving(false)
  }

  return <PlannerDialog
    title={t('plannerPlan.reorganizeTitle')}
    mobilePresentation
    transition={transition}
    onClose={onClose}
    disabled={moving}
    wide
  >
    <div className="plannerReorganizeBody" aria-busy={moving}>
      <p>{t('plannerPlan.reorganizeHint')}</p>
      <div className="plannerReorganizeTree" role="tree" aria-label={t('plannerPlan.reorganizeTitle')} ref={listRef}>
        {rows.map(({ item, depth }) => <div
          className={`plannerReorganizeRow ${draggedId === item.id ? 'dragging' : ''} ${dropTarget?.itemId === item.id ? `drop-${dropTarget.position}` : ''}`}
          data-reorganize-item-id={item.id}
          role="treeitem"
          aria-level={depth + 1}
          style={{ '--planner-depth': depth } as CSSProperties}
          key={item.id}
        >
          <button
            type="button"
            className="plannerReorganizeHandle booksButton"
            aria-label={t('plannerPlan.dragMove')}
            title={t('plannerPlan.dragMove')}
            disabled={moving}
            onPointerDown={(event) => {
              if (event.button !== 0 || moving) return
              event.preventDefault()
              sourceIdRef.current = item.id
              setDraggedId(item.id)
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={updateDrop}
            onPointerUp={(event) => void finishDrag(event, true)}
            onPointerCancel={(event) => void finishDrag(event, false)}
          ><i /><i /><i /><i /><i /><i /></button>
          <span className="plannerReorganizeIdentity">
            <Icon name={item.kind === 'folder' ? 'folder-light' : 'file-text-light'} />
            <span><strong>{item.title}</strong><small>{roleLabel(item.role, t)}</small></span>
          </span>
        </div>)}
      </div>
    </div>
  </PlannerDialog>
}

function CreatePlannerItemDialog({ role, manuscript, planner, mobilePresentation, onClose, onSaved, onError }: { role: CreateRole; manuscript: Manuscript; planner: PlannerData; mobilePresentation: boolean; onClose: () => void; onSaved: (planner: PlannerData) => void; onError: (error: string) => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [chapterMode, setChapterMode] = useState<'document' | 'scenes'>('document')
  const [parentId, setParentId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const folders = planner.plan.items.filter((item) => item.kind === 'folder')
  const formId = `planner-create-${role}-form`
  const { backdropStateClass, close: closeMobileDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose, focusOnDesktop: false })
  const closeDialog = mobilePresentation ? closeMobileDialog : onClose

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, submitting])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim() || submitting || (role === 'scene' && !parentId)) return
    setSubmitting(true)
    try {
      const payload = await apiRequest<{ planner: PlannerData }>(`/api/manuscripts/${manuscript.id}/planner/items/`, {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), role, chapterMode, parentId: parentId || null, expectedStructureGeneration: planner.plan.structureGeneration, expectedPlannerGeneration: planner.plan.plannerGeneration, timezone: browserTimezone() }),
      })
      if (mobilePresentation) finishAfterExit(() => onSaved(payload.planner))
      else onSaved(payload.planner)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('plannerPlan.createFailed'))
      setSubmitting(false)
    }
  }

  const fields = <>
    <label className="dialogField"><span>{t('plannerPlan.itemTitle')}</span><input autoFocus required maxLength={240} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    {role === 'chapter' && <fieldset className="plannerChapterMode"><legend>{t('plannerPlan.chapterStructure')}</legend><label className={chapterMode === 'document' ? 'selected' : ''}><input type="radio" checked={chapterMode === 'document'} onChange={() => setChapterMode('document')} /><strong>{t('plannerPlan.chapterDocument')}</strong><small>{t('plannerPlan.chapterDocumentLead')}</small></label><label className={chapterMode === 'scenes' ? 'selected' : ''}><input type="radio" checked={chapterMode === 'scenes'} onChange={() => setChapterMode('scenes')} /><strong>{t('plannerPlan.chapterWithScenes')}</strong><small>{t('plannerPlan.chapterWithScenesLead')}</small></label></fieldset>}
    {role !== 'act' && <label className="dialogField"><span>{t('plannerPlan.location')} {role === 'scene' && <strong aria-hidden="true">*</strong>}</span><CustomSelect required={role === 'scene'} value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">{t('plannerPlan.bookRoot')}</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.title}</option>)}</CustomSelect></label>}
  </>
  const dialogTitle = addRoleLabel(role, t)
  const invalid = !title.trim() || (role === 'scene' && !parentId)

  if (mobilePresentation) return <div className={`dialogBackdrop mobileBottomSheetBackdrop plannerCreateItemBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) closeDialog() }}>
    <div className="createOneShotDialog plannerCreateItemSheet mobileBottomSheet" role="dialog" aria-modal="true" aria-labelledby={`${formId}-title`} ref={setDialogRef}>
      <header><div><h2 id={`${formId}-title`}>{dialogTitle}</h2></div><button type="button" className="dialogClose booksButton" aria-label={t('plannerPlan.close')} onClick={closeDialog} disabled={submitting || closing}><Icon name="close-square-light" /></button></header>
      <form id={formId} onSubmit={(event) => void submit(event)}>
        {fields}
        <footer><button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button><button type="submit" className="dialogSubmit booksButton" disabled={submitting || closing || invalid}>{submitting ? t('common.saving') : dialogTitle}</button></footer>
      </form>
    </div>
  </div>

  return <div className="dialogBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose() }}>
    <div className="createOneShotDialog plannerItemDialog" role="dialog" aria-modal="true" aria-labelledby={`${formId}-title`}>
      <header><div><h2 id={`${formId}-title`}>{dialogTitle}</h2></div><button type="button" className="dialogClose booksButton" aria-label={t('plannerPlan.close')} onClick={onClose} disabled={submitting}><Icon name="close-square-light" /></button></header>
    <form id={formId} onSubmit={(event) => void submit(event)}>
      {fields}
      <DialogFooter onClose={onClose} submitting={submitting} submitLabel={addRoleLabel(role, t)} disabled={!title.trim() || (role === 'scene' && !parentId)} />
    </form>
    </div>
  </div>
}

function PlannerItemDialog({ item, planner, mobilePresentation, onClose, onSaved, onError }: { item: PlannerItem; planner: PlannerData; mobilePresentation: boolean; onClose: () => void; onSaved: (planner: PlannerData) => void; onError: (error: string) => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(item.title)
  const [synopsis, setSynopsis] = useState(item.synopsis)
  const [deadline, setDeadline] = useState(item.deadline ?? '')
  const [wordGoal, setWordGoal] = useState(String(item.wordGoal || ''))
  const [statusId, setStatusId] = useState(item.statusId ?? '')
  const [role, setRole] = useState(item.role)
  const [submitting, setSubmitting] = useState(false)
  const allowedRoles = item.kind === 'folder' ? ['untyped', 'act', 'chapter'] : ['untyped', 'chapter', 'scene']
  const formId = `planner-item-${item.id}-form`
  const transition = useMobileDialogTransition({ onClose, focusOnDesktop: false })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim() || submitting) return
    setSubmitting(true)
    try {
      const payload = await apiRequest<{ planner: PlannerData }>(`/api/manuscripts/planner-items/${item.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ title: title.trim(), synopsis: synopsis.trim(), deadline: deadline || null, wordGoal: Number(wordGoal || 0), statusId: statusId || null, role, expectedStructureGeneration: planner.plan.structureGeneration, expectedPlannerGeneration: planner.plan.plannerGeneration, timezone: browserTimezone() }),
      })
      if (mobilePresentation) transition.finishAfterExit(() => onSaved(payload.planner))
      else onSaved(payload.planner)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('plannerPlan.updateFailed'))
      setSubmitting(false)
    }
  }

  return <PlannerDialog title={t('plannerPlan.settingsTitle', { title: item.title })} mobilePresentation={mobilePresentation} transition={transition} formId={formId} primaryLabel={t(submitting ? 'common.saving' : 'common.save')} primaryDisabled={!title.trim()} onClose={onClose} disabled={submitting} wide>
    <form id={formId} className={mobilePresentation ? 'mobileFullViewForm mobileHeaderActionForm' : undefined} onSubmit={(event) => void submit(event)}>
      <div className="plannerItemFormGrid"><label className="dialogField"><span>{t('plannerPlan.itemTitle')}</span><input required maxLength={240} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="dialogField"><span>{t('plannerPlan.type')}</span><CustomSelect value={role} onChange={(event) => setRole(event.target.value as PlannerItem['role'])}>{allowedRoles.map((value) => <option key={value} value={value}>{roleLabel(value as PlannerItem['role'], t)}</option>)}</CustomSelect></label></div>
      <label className="dialogField"><span>{t('plannerPlan.synopsis')} <em>{t('manuscripts.optional')}</em></span><textarea rows={4} maxLength={5000} value={synopsis} onChange={(event) => setSynopsis(event.target.value)} /></label>
      <div className="plannerItemFormGrid"><label className="dialogField"><span>{t('plannerPlan.status')}</span><CustomSelect value={statusId} onChange={(event) => setStatusId(event.target.value)}><option value="">{t('plannerPlan.noStatus')}</option>{planner.plan.statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</CustomSelect></label><label className="dialogField"><span>{t('plannerPlan.deadline')}</span><input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label></div>
      <label className="dialogField"><span>{t('plannerPlan.wordGoal')} <em>{t('manuscripts.optional')}</em></span><input type="number" min="0" max="100000000" step="1" value={wordGoal} placeholder="10000" onChange={(event) => setWordGoal(event.target.value)} /></label>
      <DialogFooter onClose={onClose} submitting={submitting} submitLabel={t('plannerPlan.saveSettings')} disabled={!title.trim()} />
    </form>
  </PlannerDialog>
}

function PlannerStatusesDialog({ planner, manuscriptId, mobilePresentation, onClose, onSaved, onError }: { planner: PlannerData; manuscriptId: string; mobilePresentation: boolean; onClose: () => void; onSaved: (planner: PlannerData) => void; onError: (error: string) => void }) {
  const { t } = useTranslation()
  const [items, setItems] = useState<EditableStatus[]>(() => planner.plan.statuses.map((status) => ({ ...status, key: status.id })))
  const [submitting, setSubmitting] = useState(false)
  const [colorPickerKey, setColorPickerKey] = useState<string | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<HTMLButtonElement | null>(null)
  const [draggedKey, setDraggedKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [mobileActionKey, setMobileActionKey] = useState<string | null>(null)
  const [mobileStatusDraft, setMobileStatusDraft] = useState<EditableStatus | null>(null)
  const mobileDraggedKeyRef = useRef<string | null>(null)
  const formId = 'planner-statuses-form'
  const transition = useMobileDialogTransition({ onClose, focusOnDesktop: false })

  useEffect(() => {
    if (!colorPickerKey && !helpOpen) return
    function closePopovers(event: MouseEvent) {
      if (!(event.target instanceof Element)) return
      if (colorPickerKey && !event.target.closest('.plannerColorControl, .plannerColorPopover')) {
        setColorPickerKey(null)
      }
      if (helpOpen && !event.target.closest('.plannerCompletionHeading')) {
        setHelpOpen(false)
      }
    }
    document.addEventListener('mousedown', closePopovers)
    return () => document.removeEventListener('mousedown', closePopovers)
  }, [colorPickerKey, helpOpen])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting || items.some((item) => !item.name.trim())) return
    setSubmitting(true)
    try {
      const payload = await apiRequest<{ planner: PlannerData }>(`/api/manuscripts/${manuscriptId}/planner/statuses/`, {
        method: 'PATCH',
        body: JSON.stringify({ statuses: items.map(({ id, name, color, countsAsComplete }) => ({ id, name: name.trim(), color, countsAsComplete })), expectedPlannerGeneration: planner.plan.plannerGeneration, timezone: browserTimezone() }),
      })
      if (mobilePresentation) transition.finishAfterExit(() => onSaved(payload.planner))
      else onSaved(payload.planner)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('plannerPlan.statusesSaveFailed'))
      setSubmitting(false)
    }
  }

  function update(key: string, change: Partial<EditableStatus>) { setItems((current) => current.map((item) => item.key === key ? { ...item, ...change } : item)) }

  function drop(targetKey: string, after: boolean) {
    if (!draggedKey || draggedKey === targetKey) return
    setItems((current) => {
      const next = current.filter((item) => item.key !== draggedKey)
      const targetIndex = next.findIndex((item) => item.key === targetKey)
      const dragged = current.find((item) => item.key === draggedKey)
      if (!dragged || targetIndex < 0) return current
      next.splice(targetIndex + (after ? 1 : 0), 0, dragged)
      return next
    })
    setDraggedKey(null)
    setDropTarget(null)
  }

  function moveMobileStatus(event: ReactPointerEvent<HTMLButtonElement>) {
    const sourceKey = mobileDraggedKeyRef.current
    if (!sourceKey) return
    const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-mobile-status-key]')
    const targetKey = targetRow?.dataset.mobileStatusKey
    if (!targetKey || targetKey === sourceKey) return
    const after = event.clientY > targetRow.getBoundingClientRect().top + targetRow.getBoundingClientRect().height / 2
    setItems((current) => reorderStatus(current, sourceKey, targetKey, after))
  }

  function finishMobileStatusDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    mobileDraggedKeyRef.current = null
    setDraggedKey(null)
  }

  function moveMobileStatusByOffset(key: string, offset: number) {
    setItems((current) => {
      const index = current.findIndex((item) => item.key === key)
      const targetIndex = index + offset
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
  }

  const mobileActionStatus = items.find((item) => item.key === mobileActionKey) ?? null
  const colorPickerItem = items.find((item) => item.key === colorPickerKey) ?? null

  return <>
  <PlannerDialog title={t('plannerPlan.statusesTitle')} mobilePresentation={mobilePresentation} transition={transition} formId={formId} primaryLabel={t(submitting ? 'common.saving' : 'common.save')} primaryDisabled={items.some((item) => !item.name.trim())} active={!mobilePresentation || (!mobileStatusDraft && !mobileActionStatus)} onClose={onClose} disabled={submitting} wide>
    <form id={formId} className={mobilePresentation ? 'mobileFullViewForm mobileHeaderActionForm plannerStatusesMobileForm' : undefined} onSubmit={(event) => void submit(event)}>
      {mobilePresentation ? <div className="plannerMobileStatusList">
        {items.map((item, index) => <div className={`plannerMobileStatusRow ${draggedKey === item.key ? 'dragging' : ''}`} data-mobile-status-key={item.key} key={item.key}>
          <button
            type="button"
            className="plannerMobileStatusHandle booksButton"
            aria-label={t('plannerPlan.dragStatus', { name: item.name })}
            onPointerDown={(event) => {
              if (submitting) return
              mobileDraggedKeyRef.current = item.key
              setDraggedKey(item.key)
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={moveMobileStatus}
            onPointerUp={finishMobileStatusDrag}
            onPointerCancel={finishMobileStatusDrag}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && index > 0) {
                event.preventDefault()
                moveMobileStatusByOffset(item.key, -1)
              } else if (event.key === 'ArrowDown' && index < items.length - 1) {
                event.preventDefault()
                moveMobileStatusByOffset(item.key, 1)
              }
            }}
          ><i /><i /><i /><i /><i /><i /></button>
          <strong className="plannerMobileStatusName">{item.name}</strong>
          <button type="button" className="plannerMobileStatusMenu booksButton" aria-label={t('plannerPlan.statusActionsFor', { name: item.name })} aria-haspopup="dialog" aria-expanded={mobileActionKey === item.key} onClick={() => setMobileActionKey(item.key)}><Icon name="menu-dots-light" /></button>
        </div>)}
        {!items.length && <p className="plannerMobileStatusesEmpty">{t('plannerPlan.noStatuses')}</p>}
      </div> : <div className="plannerStatusEditor">
        <div className="plannerStatusEditorHeader">
          <span />
          <span>{t('plannerPlan.statusName')}</span>
          <span>{t('plannerPlan.color')}</span>
          <span className="plannerCompletionHeading">
            {t('plannerPlan.marksCompletion')}
            <button type="button" className="plannerStatusHelp booksButton" aria-label={t('plannerPlan.marksCompletionHelp')} aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}>
              <Icon name="information-circle-light" />
            </button>
            {helpOpen && <span className="plannerCompletionPopup" role="tooltip">{t('plannerPlan.marksCompletionLead')}</span>}
          </span>
          <span />
        </div>
        {items.map((item) => (
          <div
            className={`plannerStatusEditorRow ${draggedKey === item.key ? 'dragging' : ''} ${dropTarget?.key === item.key ? dropTarget.after ? 'dropAfter' : 'dropBefore' : ''}`}
            key={item.key}
            onDragOver={(event) => {
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              setDropTarget({ key: item.key, after: event.clientY > bounds.top + bounds.height / 2 })
            }}
            onDragLeave={() => setDropTarget((current) => current?.key === item.key ? null : current)}
            onDrop={(event) => { event.preventDefault(); drop(item.key, dropTarget?.after ?? false) }}
          >
            <span
              className="plannerStatusDragHandle"
              draggable={!submitting}
              title={t('plannerPlan.dragReorder')}
              aria-label={t('plannerPlan.dragStatus', { name: item.name || t('plannerPlan.unnamedStatus') })}
              onDragStart={(event) => {
                setDraggedKey(item.key)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', item.key)
              }}
              onDragEnd={() => { setDraggedKey(null); setDropTarget(null) }}
            >
              <i /><i /><i /><i /><i /><i />
            </span>
            <input aria-label={t('plannerPlan.statusName')} maxLength={40} value={item.name} onChange={(event) => update(item.key, { name: event.target.value })} />
            <div className="plannerColorControl">
              <button
                type="button"
                className="plannerColorSwatch booksButton"
                aria-label={t('plannerPlan.chooseColor', { name: item.name || t('plannerPlan.unnamedStatus') })}
                aria-expanded={colorPickerKey === item.key}
                style={{ background: statusColorValue(item.color) }}
                onClick={(event) => {
                  if (colorPickerKey === item.key) {
                    setColorPickerKey(null)
                    setColorPickerAnchor(null)
                  } else {
                    setColorPickerKey(item.key)
                    setColorPickerAnchor(event.currentTarget)
                  }
                }}
              />
            </div>
            <label className="plannerCompletionToggle"><input type="checkbox" checked={item.countsAsComplete} onChange={(event) => update(item.key, { countsAsComplete: event.target.checked })} /><span>{t('plannerPlan.completed')}</span></label>
            <button type="button" className="plannerStatusRemove booksButton" aria-label={t('plannerPlan.removeStatus')} onClick={() => setItems((current) => current.filter((candidate) => candidate.key !== item.key))}><Icon name="trash-bin-trash-light" /></button>
          </div>
        ))}
      </div>}
      {!mobilePresentation && items.length < 20 && <button type="button" className="plannerAddStatus booksButton" onClick={() => setItems((current) => [...current, { key: `new-${Date.now()}`, id: null, name: '', color: 'gray', countsAsComplete: false }])}><PlusIcon /> {t('plannerPlan.addStatus')}</button>}
      <DialogFooter onClose={onClose} submitting={submitting} submitLabel={t('plannerPlan.saveStatuses')} disabled={items.some((item) => !item.name.trim())} />
    </form>
  </PlannerDialog>
  {!mobilePresentation && colorPickerItem && colorPickerAnchor && <PlannerStatusColorPopover
    anchor={colorPickerAnchor}
    item={colorPickerItem}
    onPreset={(color) => {
      update(colorPickerItem.key, { color })
      setColorPickerKey(null)
    }}
    onCustom={(color) => update(colorPickerItem.key, { color })}
  />}
  {mobilePresentation && items.length < 20 && !mobileStatusDraft && <div className="plannerMobileStatusAddAction"><button type="button" className="booksButton" aria-label={t('plannerPlan.addStatus')} onClick={() => setMobileStatusDraft({ key: `new-${Date.now()}`, id: null, name: '', color: 'gray', countsAsComplete: false })}><PlusIcon /></button></div>}
  <MobileLibraryActionSheet
    open={mobilePresentation && mobileActionStatus !== null}
    title={mobileActionStatus?.name || t('plannerPlan.unnamedStatus')}
    dismissOnSelect
    onClose={() => setMobileActionKey(null)}
    actions={mobileActionStatus ? [
      { key: 'edit', label: t('plannerPlan.editStatus'), icon: <Icon name="edit-light" />, onSelect: () => setMobileStatusDraft(mobileActionStatus) },
      { key: 'delete', label: t('common.delete'), icon: <Icon name="trash-bin-trash-light" />, danger: true, onSelect: () => setItems((current) => current.filter((item) => item.key !== mobileActionStatus.key)) },
    ] : []}
  />
  {mobilePresentation && mobileStatusDraft && <PlannerStatusMobileDialog
    status={mobileStatusDraft}
    editing={items.some((item) => item.key === mobileStatusDraft.key)}
    onClose={() => setMobileStatusDraft(null)}
    onApply={(status) => {
      setItems((current) => current.some((item) => item.key === status.key)
        ? current.map((item) => item.key === status.key ? status : item)
        : [...current, status])
      setMobileStatusDraft(null)
    }}
  />}
  </>
}

function PlannerStatusColorPopover({ anchor, item, onPreset, onCustom }: { anchor: HTMLButtonElement; item: EditableStatus; onPreset: (color: string) => void; onCustom: (color: string) => void }) {
  const { t } = useTranslation()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    function updatePosition() {
      const popover = popoverRef.current
      if (!popover || !anchor.isConnected) return
      const anchorBounds = anchor.getBoundingClientRect()
      const popoverBounds = popover.getBoundingClientRect()
      const viewportGap = 8
      const desiredLeft = anchorBounds.left + (anchorBounds.width - popoverBounds.width) / 2
      const maxLeft = Math.max(viewportGap, window.innerWidth - popoverBounds.width - viewportGap)
      const left = Math.min(Math.max(desiredLeft, viewportGap), maxLeft)
      const below = anchorBounds.bottom + viewportGap
      const above = anchorBounds.top - popoverBounds.height - viewportGap
      const maxTop = Math.max(viewportGap, window.innerHeight - popoverBounds.height - viewportGap)
      const top = below + popoverBounds.height <= window.innerHeight - viewportGap || above < viewportGap
        ? Math.min(below, maxTop)
        : above
      setPosition({ top, left })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={popoverRef}
      className="plannerColorPopover"
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
    >
      <strong>{t('plannerPlan.presetColors')}</strong>
      <div className="plannerPresetColorList">{Object.entries(presetColors).map(([name, color]) => <button type="button" className="booksButton" key={name} aria-label={t(`plannerPlan.colors.${name}`)} title={t(`plannerPlan.colors.${name}`)} style={{ background: color }} onClick={() => onPreset(name)} />)}</div>
      <div className="plannerCustomColorPicker"><span>{t('plannerPlan.customColor')}</span><NoteColorPicker value={item.color} onChange={onCustom} /></div>
    </div>,
    document.body,
  )
}

function PlannerStatusMobileDialog({ status, editing, onClose, onApply }: { status: EditableStatus; editing: boolean; onClose: () => void; onApply: (status: EditableStatus) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(status.name)
  const [color, setColor] = useState(status.color)
  const [countsAsComplete, setCountsAsComplete] = useState(status.countsAsComplete)
  const transition = useMobileDialogTransition({ onClose, focusOnDesktop: false })
  const formId = `planner-mobile-status-${status.key}-form`

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    transition.finishAfterExit(() => onApply({ ...status, name: name.trim(), color, countsAsComplete }))
  }

  return <PlannerDialog
    title={t(editing ? 'plannerPlan.editStatusTitle' : 'plannerPlan.createStatusTitle')}
    mobilePresentation
    transition={transition}
    formId={formId}
    primaryLabel={t('common.save')}
    primaryDisabled={!name.trim()}
    onClose={onClose}
    disabled={false}
  >
    <form id={formId} className="mobileFullViewForm mobileHeaderActionForm plannerMobileStatusForm" onSubmit={submit}>
      <label className="dialogField"><span>{t('plannerPlan.statusName')}</span><input autoFocus maxLength={40} required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <fieldset className="plannerMobileStatusColors">
        <legend>{t('plannerPlan.color')}</legend>
        <div>
          {Object.entries(presetColors).map(([preset, value]) => <button
            type="button"
            className={color === preset ? 'selected booksButton' : 'booksButton'}
            aria-label={t(`plannerPlan.colors.${preset}`)}
            aria-pressed={color === preset}
            key={preset}
            style={{ background: value }}
            onClick={() => setColor(preset)}
          />)}
          <NoteColorPicker value={color} onChange={setColor} />
        </div>
      </fieldset>
      <label className="plannerMobileStatusCompletion"><input type="checkbox" checked={countsAsComplete} onChange={(event) => setCountsAsComplete(event.target.checked)} /><span><strong>{t('plannerPlan.marksCompletion')}</strong><small>{t('plannerPlan.marksCompletionLead')}</small></span></label>
      <DialogFooter onClose={onClose} submitting={false} submitLabel={t('common.save')} disabled={!name.trim()} />
    </form>
  </PlannerDialog>
}

function PlannerItemDetailsDialog({ item, status, locale, onClose, onEdit }: { item: PlannerItem; status?: PlannerStatus; locale?: string; onClose: () => void; onEdit: () => void }) {
  const { t } = useTranslation()
  const titleId = useId()
  const numberFormatter = new Intl.NumberFormat(locale)
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' })
  const itemProgress = progress(item.wordCount, item.wordGoal)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose, focusOnDesktop: false })

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !closing) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, closing])

  return <div className={`dialogBackdrop mobileFullViewBackdrop plannerPlanMobileBackdrop ${backdropStateClass}`} role="presentation">
    <div className="createOneShotDialog mobileFullView plannerItemDetailsView" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={setDialogRef}>
      <header>
        <button type="button" className="mobileDialogBack booksButton" aria-label={t('common.back')} disabled={closing} onClick={closeDialog}><Icon name="arrow-left-1" /></button>
        <div className="mobileDialogHeaderCopy"><h2 id={titleId}>{item.title}</h2></div>
        <button type="button" className="mobileDialogPrimary booksButton" aria-label={t('plannerPlan.editDetails')} title={t('plannerPlan.editDetails')} disabled={closing} onClick={() => finishAfterExit(onEdit)}><Icon name="edit-light" /></button>
      </header>
      <div className="plannerItemDetailsBody">
        <section className="plannerItemDetailsProgress">
          <div>
            <strong>{t('plannerPlan.progress')}</strong>
            <span className="plannerItemDetailsStatus"><i style={{ background: status ? statusColorValue(status.color) : 'var(--color-text-subtle)' }} />{status?.name || t('plannerPlan.noStatus')}</span>
          </div>
          <span className="plannerItemDetailsProgressBar" role="progressbar" aria-label={t('plannerPlan.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.wordGoal ? itemProgress : 0}>
            <span style={{ width: `${item.wordGoal ? itemProgress : 0}%` }} />
          </span>
          <small>{item.wordGoal ? `${numberFormatter.format(item.wordCount)} / ${numberFormatter.format(item.wordGoal)} · ${itemProgress}%` : t('plannerPlan.wordCount', { count: item.wordCount, formattedCount: numberFormatter.format(item.wordCount) })}</small>
        </section>
        <section className="plannerItemDetailsSynopsis">
          <h3>{t('plannerPlan.synopsis')}</h3>
          <p>{item.synopsis || t('plannerPlan.noSynopsis')}</p>
        </section>
        <dl className="plannerItemDetailsList">
          <div><dt>{t('plannerPlan.type')}</dt><dd>{roleLabel(item.role, t)}</dd></div>
          <div><dt>{t('plannerPlan.words')}</dt><dd>{numberFormatter.format(item.wordCount)}</dd></div>
          <div><dt>{t('plannerPlan.wordGoal')}</dt><dd>{item.wordGoal ? numberFormatter.format(item.wordGoal) : t('plannerPlan.notSet')}</dd></div>
          <div><dt>{t('plannerPlan.deadline')}</dt><dd>{item.deadline ? formatDate(item.deadline, dateFormatter) : t('plannerPlan.noDeadline')}</dd></div>
          {item.completedDate && <div><dt>{t('plannerPlan.completedDate')}</dt><dd>{formatDate(item.completedDate, dateFormatter)}</dd></div>}
        </dl>
      </div>
    </div>
  </div>
}

function PlannerDialog({ title, description, mobilePresentation, transition, formId, primaryLabel, primaryDisabled = false, active = true, onClose, disabled, wide = false, children }: { title: string; description?: string; mobilePresentation: boolean; transition: MobileDialogTransition; formId?: string; primaryLabel?: string; primaryDisabled?: boolean; active?: boolean; onClose: () => void; disabled: boolean; wide?: boolean; children: ReactNode }) {
  const { t } = useTranslation()
  const titleId = useId()
  const { backdropStateClass, close: closeMobileDialog, closing, setDialogRef } = transition
  const closeDialog = mobilePresentation ? closeMobileDialog : onClose
  useEffect(() => {
    if (!active) return
    function escape(event: KeyboardEvent) { if (event.key === 'Escape' && !disabled) closeDialog() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [active, closeDialog, disabled])
  return <div className={`dialogBackdrop ${mobilePresentation ? `mobileFullViewBackdrop plannerPlanMobileBackdrop ${backdropStateClass}` : ''}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !disabled) closeDialog() }}><div className={`createOneShotDialog plannerItemDialog ${wide ? 'wide' : ''} ${mobilePresentation ? 'mobileFullView plannerPlanMobileView' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={mobilePresentation ? setDialogRef : undefined}><header>
    <button type="button" className="mobileDialogBack booksButton" aria-label={t('common.back')} onClick={closeDialog} disabled={disabled || closing}><Icon name="arrow-left-1" /></button>
    <div className={mobilePresentation ? 'mobileDialogHeaderCopy' : undefined}><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
    <button type="button" className="dialogClose booksButton" aria-label={t('plannerPlan.close')} onClick={closeDialog} disabled={disabled || closing}><Icon name="close-square-light" /></button>
    {formId && <button type="submit" form={formId} className="mobileDialogPrimary booksButton" aria-label={primaryLabel} title={primaryLabel} disabled={disabled || closing || primaryDisabled}><Icon name="diskette-light" /></button>}
  </header>{children}</div></div>
}

function DialogFooter({ onClose, submitting, submitLabel, disabled }: { onClose: () => void; submitting: boolean; submitLabel: string; disabled: boolean }) { const { t } = useTranslation(); return <footer><button type="button" className="dialogCancel booksButton" onClick={onClose} disabled={submitting}>{t('common.cancel')}</button><button type="submit" className="dialogSubmit booksButton" disabled={submitting || disabled}>{submitting ? t('common.saving') : submitLabel}</button></footer> }

function flattenItems(items: PlannerItem[], expanded: Set<string>) { const children = new Map<string | null, PlannerItem[]>(); for (const item of items) { const group = children.get(item.parentId) ?? []; group.push(item); children.set(item.parentId, group) } for (const group of children.values()) group.sort((a, b) => a.position - b.position); const result: { item: PlannerItem; depth: number }[] = []; function visit(parentId: string | null, depth: number) { for (const item of children.get(parentId) ?? []) { result.push({ item, depth }); if (item.kind === 'folder' && expanded.has(item.id)) visit(item.id, depth + 1) } } visit(null, 0); return result }
function isItemDescendant(items: PlannerItem[], itemId: string, ancestorId: string) {
  const itemById = new Map(items.map((item) => [item.id, item]))
  let current = itemById.get(itemId)
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true
    current = itemById.get(current.parentId)
  }
  return false
}
function toggleSet(current: Set<string>, id: string) { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }
function reorderStatus(items: EditableStatus[], sourceKey: string, targetKey: string, after: boolean) {
  const source = items.find((item) => item.key === sourceKey)
  if (!source) return items
  const next = items.filter((item) => item.key !== sourceKey)
  const targetIndex = next.findIndex((item) => item.key === targetKey)
  if (targetIndex < 0) return items
  next.splice(targetIndex + (after ? 1 : 0), 0, source)
  return next
}
function browserTimezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
function progress(current: number, goal: number) { return goal ? Math.min(100, Math.round(current / goal * 100)) : 0 }
function roleLabel(role: PlannerItem['role'], t: TFunction) { return role === 'untyped' ? t('plannerPlan.unclassified') : t(`planner.roles.${role}`) }
function addRoleLabel(role: CreateRole, t: TFunction) { return t(`plannerPlan.addRoles.${role}`) }
function formatDate(value: string, formatter: Intl.DateTimeFormat) { return formatter.format(new Date(`${value}T00:00:00Z`)) }
function statusColorValue(color: string) { return presetColors[color as keyof typeof presetColors] ?? color }
function statusColorClass(color: string) { return color in presetColors ? color : 'custom' }
function statusColorStyle(color: string) {
  if (color in presetColors) return undefined
  return {
    borderColor: color,
    color,
    backgroundColor: `${color}12`,
  } as CSSProperties
}

function DeadlineMark({ item, status, today }: { item: PlannerItem; status?: PlannerStatus; today: string }) { const { t } = useTranslation(); if (!item.deadline) return null; let state = 'pending'; let label = t('plannerPlan.deadlineUpcoming'); if (status?.countsAsComplete && item.completedDate) { state = item.completedDate <= item.deadline ? 'complete' : 'late'; label = t(state === 'complete' ? 'plannerPlan.completedOnTime' : 'plannerPlan.completedLate') } else if (today > item.deadline) { state = 'overdue'; label = t('plannerPlan.overdue') } return <span className={`plannerDeadlineMark ${state}`} title={label} aria-label={label}>{state === 'complete' ? '✓' : state === 'pending' ? '' : '!'}</span> }
function PlusIcon() { return <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg> }
function ChevronIcon({ open }: { open: boolean }) { return <svg className={open ? 'open' : ''} viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg> }
