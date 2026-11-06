import { useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { FormEvent } from 'react'
import type { TFunction } from 'i18next'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { PlannerItem, PlannerTask, PlannerTaskPriority } from './PlannerTypes'

type Props = {
  manuscriptId: string
  tasks: PlannerTask[]
  items: PlannerItem[]
  variant?: 'planner' | 'editor'
  initialScopeItemIds?: string[]
  defaultAssociatedItemId?: string
  onChange: (tasks: PlannerTask[]) => void
  onError: (error: string) => void
}

type StatusFilter = 'all' | 'active' | 'done'
type PriorityFilter = 'all' | PlannerTaskPriority

const INITIAL_TASKS = 5
const TASK_BATCH = 8
const priorityOrder: PlannerTaskPriority[] = ['high', 'medium', 'low']

export function PlannerTasks({ manuscriptId, tasks, items, variant = 'planner', initialScopeItemIds, defaultAssociatedItemId, onChange, onError }: Props) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const mobilePlanner = variant === 'planner' && isMobile
  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  const [status, setStatus] = useState<StatusFilter>('active')
  const [priority, setPriority] = useState<PriorityFilter>('all')
  const [part, setPart] = useState(initialScopeItemIds?.length ? 'scope' : 'all')
  const [visibleCount, setVisibleCount] = useState(INITIAL_TASKS)
  const [editing, setEditing] = useState<PlannerTask | 'new' | null>(null)
  const [viewing, setViewing] = useState<PlannerTask | null>(null)
  const [deleting, setDeleting] = useState<PlannerTask | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])

  useEffect(() => {
    if (!menuId) return
    function close(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.plannerTaskMenu, .plannerTaskMenuPopover')) setMenuId(null)
    }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') setMenuId(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [menuId])

  const filtered = useMemo(() => tasks
    .filter((task) => status === 'all' || (status === 'done' ? task.completed : !task.completed))
    .filter((task) => priority === 'all' || task.priority === priority)
    .filter((task) => {
      if (part === 'all') return true
      if (part === 'scope') return Boolean(task.associatedItemId && initialScopeItemIds?.includes(task.associatedItemId))
      if (part === 'none') return task.associatedItemId === null
      return task.associatedItemId === part
    })
    .sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || Date.parse(right.createdAt) - Date.parse(left.createdAt)), [initialScopeItemIds, part, priority, status, tasks])
  const visible = mobilePlanner ? filtered : filtered.slice(0, visibleCount)
  const expanded = visibleCount > INITIAL_TASKS

  function replaceTask(nextTask: PlannerTask) {
    onChange(tasks.some((task) => task.id === nextTask.id)
      ? tasks.map((task) => task.id === nextTask.id ? nextTask : task)
      : [nextTask, ...tasks])
  }

  function toggleMenu(task: PlannerTask, button: HTMLButtonElement) {
    const taskId = task.id
    if (menuId === taskId) {
      setMenuId(null)
      setMenuPosition(null)
      return
    }
    const rect = button.getBoundingClientRect()
    const menuHeight = task.description ? 114 : 78
    const top = rect.bottom + menuHeight + 6 <= window.innerHeight
      ? rect.bottom + 4
      : Math.max(8, rect.top - menuHeight - 4)
    setMenuPosition({ left: Math.max(8, rect.right - 116), top })
    setMenuId(taskId)
  }

  async function toggleCompleted(task: PlannerTask) {
    onError('')
    try {
      const payload = await apiRequest<{ task: PlannerTask }>(`/api/manuscripts/planner-tasks/${task.id}/`, {
        method: 'PATCH', body: JSON.stringify({ completed: !task.completed }),
      })
      replaceTask(payload.task)
    } catch (err) { onError(err instanceof Error ? err.message : t('plannerTasks.updateFailed')) }
  }

  const statusFilters = <div className="plannerTaskStatusFilters" aria-label={t('plannerTasks.statusFilters')}>
    {(['all', 'active', 'done'] as StatusFilter[]).map((value) => <button key={value} type="button" className={`booksButton ${status === value ? 'active' : ''}`} onClick={() => { setStatus(value); setVisibleCount(INITIAL_TASKS) }}>{t(`plannerTasks.${value}`)}</button>)}
  </div>

  return <section className={`plannerTasks ${variant === 'editor' ? 'editorTasks' : ''}`} aria-label={t('plannerTasks.tasks')}>
    {variant === 'planner' ? <>
      <header className="plannerTasksHeader">
        <div className="plannerTasksHeaderPrimary">
          <h2>{t('plannerTasks.tasks')}</h2>
          {statusFilters}
        </div>
        <div className="plannerTasksHeaderControls">
          <TaskSelectFilters priority={priority} part={part} items={items} hasScope={Boolean(initialScopeItemIds?.length)} onPriorityChange={(value) => { setPriority(value); setVisibleCount(INITIAL_TASKS) }} onPartChange={(value) => { setPart(value); setVisibleCount(INITIAL_TASKS) }} />
          <button type="button" className="plannerAddTask booksButton" onClick={() => setEditing('new')}><PlusIcon />{t('plannerTasks.addTask')}</button>
        </div>
      </header>
    </> : <>
      <header className="editorTasksHeader">
        {statusFilters}
        <button type="button" className="plannerAddTask booksButton" onClick={() => setEditing('new')}><Icon name="check-square-light" />{t('plannerTasks.addTask')}</button>
      </header>
      <div className="plannerTaskFilters">
        <TaskSelectFilters priority={priority} part={part} items={items} hasScope={Boolean(initialScopeItemIds?.length)} onPriorityChange={(value) => { setPriority(value); setVisibleCount(INITIAL_TASKS) }} onPartChange={(value) => { setPart(value); setVisibleCount(INITIAL_TASKS) }} />
      </div>
    </>}
    <div className={`plannerTaskList ${expanded ? 'expanded' : ''}`}>
      {visible.map((task) => <article
        key={task.id}
        className={`plannerTaskRow ${task.pinned ? 'pinned' : ''} ${task.completed ? 'completed' : ''} ${mobilePlanner ? 'mobileInteractive' : ''}`}
      >
        <button type="button" className="plannerTaskCheck booksButton" aria-label={t(task.completed ? 'plannerTasks.markActive' : 'plannerTasks.complete', { title: task.title })} onClick={(event) => { event.stopPropagation(); void toggleCompleted(task) }}>{task.completed && <CheckIcon />}</button>
        {mobilePlanner ? <button type="button" className="plannerTaskOpen booksButton" aria-label={t('plannerTasks.editNamed', { title: task.title })} onClick={() => setEditing(task)}>
          <span className="plannerTaskCopy" title={task.description || undefined}><strong>{task.title}</strong><small>{task.associatedItemId ? itemById.get(task.associatedItemId)?.title || t('plannerTasks.unavailablePart') : t('plannerTasks.noLinkedPart')}</small></span>
          <span className="plannerTaskMeta"><span className={`plannerTaskPriority ${task.priority}`}>{t(`planner.priorities.${task.priority}`)}</span><time dateTime={task.deadline || undefined}>{task.deadline ? formatDate(task.deadline, dateFormatter) : t('plannerTasks.noDeadline')}</time></span>
        </button> : <>
          <div className="plannerTaskCopy" title={task.description || undefined}>
            <strong>{task.title}</strong>
            {variant === 'planner' && task.description && <span className="plannerTaskDescriptionExcerpt">{task.description}</span>}
            <small>{task.associatedItemId ? itemById.get(task.associatedItemId)?.title || t('plannerTasks.unavailablePart') : t('plannerTasks.noLinkedPart')}</small>
          </div>
          <div className="plannerTaskMeta"><span className={`plannerTaskPriority ${task.priority}`}>{t(`planner.priorities.${task.priority}`)}</span><time dateTime={task.deadline || undefined}>{task.deadline ? formatDate(task.deadline, dateFormatter) : t('plannerTasks.noDeadline')}</time></div>
          <div className="plannerTaskMenu">
          <button type="button" className="plannerTaskMenuButton booksButton" aria-label={t('plannerTasks.actionsFor', { title: task.title })} aria-expanded={menuId === task.id} onClick={(event) => toggleMenu(task, event.currentTarget)}><Icon name="menu-dots-light" /></button>
          {menuId === task.id && menuPosition && createPortal(<div className="plannerTaskMenuPopover" role="menu" style={menuPosition}>{task.description && <button type="button" className="booksButton" role="menuitem" onClick={() => { setMenuId(null); setViewing(task) }}><Icon name="file-text-light" />{t('plannerTasks.view')}</button>}<button type="button" className="booksButton" role="menuitem" onClick={() => { setMenuId(null); setEditing(task) }}><Icon name="edit-light" />{t('plannerTasks.edit')}</button><button type="button" className="danger booksButton" role="menuitem" onClick={() => { setMenuId(null); setDeleting(task) }}><Icon name="trash-bin-trash-light" />{t('plannerTasks.delete')}</button></div>, document.body)}
          </div>
        </>}
      </article>)}
      {!visible.length && <div className="plannerTaskEmpty"><strong>{t(status === 'done' ? 'plannerTasks.noCompleted' : 'plannerTasks.noTasks')}</strong><span>{t(status === 'active' ? 'plannerTasks.addOrAdjust' : 'plannerTasks.adjustFilters')}</span></div>}
    </div>
    {!mobilePlanner && visibleCount < filtered.length && <button type="button" className="plannerTasksMore booksButton" onClick={() => setVisibleCount((count) => count + TASK_BATCH)}>{t('plannerTasks.showMore')}</button>}
    {mobilePlanner && !editing && !deleting && (
      <div className="plannerMobileTaskActions">
        <button type="button" className={`plannerMobileFilterAction booksButton ${filtersOpen ? 'active' : ''}`} aria-label={t('plannerTasks.openFilters')} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}>
          <Icon name="filter-linear" />
        </button>
        <button type="button" className="plannerMobileAddAction booksButton" aria-label={t('plannerTasks.addTask')} onClick={() => setEditing('new')}>
          <PlusIcon />
        </button>
      </div>
    )}
    <MobileLibraryActionSheet
      open={mobilePlanner && filtersOpen}
      title={t('plannerTasks.filters')}
      onClose={() => setFiltersOpen(false)}
      backdropClassName="plannerTaskFilterSheet"
      topContent={(
        <div className="plannerMobileFilters">
          <fieldset>
            <legend>{t('plannerTasks.status')}</legend>
            <div>
              {(['all', 'active', 'done'] as StatusFilter[]).map((value) => (
                <button type="button" className={`booksButton ${status === value ? 'active' : ''}`} aria-pressed={status === value} key={value} onClick={() => { setStatus(value); setVisibleCount(INITIAL_TASKS) }}>
                  {t(`plannerTasks.${value}`)}
                </button>
              ))}
            </div>
          </fieldset>
          <label>
            <span>{t('plannerTasks.priority')}</span>
            <CustomSelect value={priority} onChange={(event) => { setPriority(event.target.value as PriorityFilter); setVisibleCount(INITIAL_TASKS) }}>
              <option value="all">{t('plannerTasks.allPriorities')}</option>
              {priorityOrder.map((value) => <option key={value} value={value}>{t(`planner.priorities.${value}`)}</option>)}
            </CustomSelect>
          </label>
          <label>
            <span>{t('plannerTasks.manuscriptPart')}</span>
            <CustomSelect value={part} onChange={(event) => { setPart(event.target.value); setVisibleCount(INITIAL_TASKS) }}>
              <option value="all">{t('plannerTasks.allParts')}</option>
              {initialScopeItemIds?.length && <option value="scope">{t('plannerTasks.currentScope')}</option>}
              <option value="none">{t('plannerTasks.noLinkedPart')}</option>
              {items.map((item) => <option key={item.id} value={item.id}>{itemLabel(item, t)}</option>)}
            </CustomSelect>
          </label>
        </div>
      )}
      actions={[]}
    />
    {editing && <TaskDialog manuscriptId={manuscriptId} task={editing === 'new' ? null : editing} items={items} defaultAssociatedItemId={defaultAssociatedItemId} mobilePresentation={mobilePlanner} onClose={() => setEditing(null)} onSaved={(task) => { replaceTask(task); setEditing(null) }} onRequestDelete={editing === 'new' ? undefined : () => setDeleting(editing)} onError={onError} />}
    {viewing && <TaskDescriptionDialog task={viewing} onClose={() => setViewing(null)} />}
    {deleting && <DeleteTaskDialog task={deleting} mobilePresentation={mobilePlanner} onClose={() => setDeleting(null)} onDeleted={() => { onChange(tasks.filter((task) => task.id !== deleting.id)); setDeleting(null); if (mobilePlanner) setEditing(null) }} onError={onError} />}
  </section>
}

function TaskSelectFilters({ priority, part, items, hasScope, onPriorityChange, onPartChange }: { priority: PriorityFilter; part: string; items: PlannerItem[]; hasScope: boolean; onPriorityChange: (priority: PriorityFilter) => void; onPartChange: (part: string) => void }) {
  const { t } = useTranslation()
  return <div className="plannerTaskSelectFilters">
    <CustomSelect className="plannerTaskPriorityFilter" aria-label={t('plannerTasks.priorityFilter')} value={priority} onChange={(event) => onPriorityChange(event.target.value as PriorityFilter)}>
      <option value="all">{t('plannerTasks.allPriorities')}</option>{priorityOrder.map((value) => <option key={value} value={value}>{t(`planner.priorities.${value}`)}</option>)}
    </CustomSelect>
    <CustomSelect className="plannerTaskPartFilter" aria-label={t('plannerTasks.partFilter')} value={part} onChange={(event) => onPartChange(event.target.value)}>
      <option value="all">{t('plannerTasks.allParts')}</option>
      {hasScope && <option value="scope">{t('plannerTasks.currentScope')}</option>}
      <option value="none">{t('plannerTasks.noLinkedPart')}</option>
      {items.map((item) => <option key={item.id} value={item.id}>{itemLabel(item, t)}</option>)}
    </CustomSelect>
  </div>
}

function TaskDescriptionDialog({ task, onClose }: { task: PlannerTask; onClose: () => void }) {
  const { t } = useTranslation()
  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])
  return <div className="dialogBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className="createOneShotDialog plannerTaskDescriptionDialog" role="dialog" aria-modal="true" aria-labelledby="task-description-title"><header><div><h2 id="task-description-title">{task.title}</h2><p>{t('plannerTasks.descriptionTitle')}</p></div><button type="button" className="dialogClose booksButton" aria-label={t('plannerTasks.close')} onClick={onClose}><Icon name="close-square-light" /></button></header><div className="plannerTaskDescriptionBody"><p>{task.description}</p></div><footer><button type="button" className="dialogSubmit booksButton" onClick={onClose}>{t('plannerTasks.close')}</button></footer></div></div>
}

function TaskDialog({ manuscriptId, task, items, defaultAssociatedItemId, mobilePresentation, onClose, onSaved, onRequestDelete, onError }: { manuscriptId: string; task: PlannerTask | null; items: PlannerItem[]; defaultAssociatedItemId?: string; mobilePresentation: boolean; onClose: () => void; onSaved: (task: PlannerTask) => void; onRequestDelete?: () => void; onError: (error: string) => void }) {
  const { t } = useTranslation()
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [deadline, setDeadline] = useState(task?.deadline ?? '')
  const [priority, setPriority] = useState<PlannerTaskPriority>(task?.priority ?? 'medium')
  const [associatedItemId, setAssociatedItemId] = useState(task?.associatedItemId ?? defaultAssociatedItemId ?? '')
  const [pinned, setPinned] = useState(task?.pinned ?? false)
  const [submitting, setSubmitting] = useState(false)
  const { backdropStateClass, close: closeMobileDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose, initialFocusRef: titleRef, focusOnDesktop: false })
  const closeDialog = mobilePresentation ? closeMobileDialog : onClose
  useEffect(() => { function escape(event: KeyboardEvent) { if (event.key === 'Escape' && !submitting) closeDialog() } document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape) }, [closeDialog, submitting])

  async function persist(completed?: boolean) {
    if (submitting || !title.trim()) return
    setSubmitting(true)
    onError('')
    try {
      const payload = await apiRequest<{ task: PlannerTask }>(task ? `/api/manuscripts/planner-tasks/${task.id}/` : `/api/manuscripts/${manuscriptId}/planner/tasks/`, {
        method: task ? 'PATCH' : 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          deadline: deadline || null,
          priority,
          associatedItemId: associatedItemId || null,
          pinned,
          ...(completed === undefined ? {} : { completed }),
        }),
      })
      if (mobilePresentation) finishAfterExit(() => onSaved(payload.task))
      else onSaved(payload.task)
    } catch (err) { onError(err instanceof Error ? err.message : t('plannerTasks.saveFailed')); setSubmitting(false) }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void persist()
  }

  const formId = task ? `planner-task-form-${task.id}` : 'planner-task-form-new'
  return <div className={`dialogBackdrop ${mobilePresentation ? `mobileFullViewBackdrop plannerTaskMobileBackdrop ${backdropStateClass}` : ''}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) closeDialog() }}><div className={`createOneShotDialog plannerTaskDialog ${mobilePresentation ? 'mobileFullView plannerTaskMobileView' : ''}`} role="dialog" aria-modal="true" aria-labelledby="planner-task-dialog-title" ref={mobilePresentation ? setDialogRef : undefined}><header>
    <button type="button" className="mobileDialogBack booksButton" aria-label={t('common.back')} onClick={closeDialog} disabled={submitting || closing}><Icon name="arrow-left-1" /></button>
    <div className={mobilePresentation ? 'mobileDialogHeaderCopy' : undefined}><h2 id="planner-task-dialog-title">{t(task ? 'plannerTasks.editTask' : 'plannerTasks.addTask')}</h2></div>
    <button type="button" className="dialogClose booksButton" aria-label={t('plannerTasks.close')} onClick={closeDialog} disabled={submitting || closing}><Icon name="close-square-light" /></button>
    <button type="submit" form={formId} className="mobileDialogPrimary booksButton" title={t(submitting ? 'common.saving' : 'common.save')} aria-label={t(submitting ? 'common.saving' : 'common.save')} disabled={submitting || closing || !title.trim()}><Icon name="diskette-light" /></button>
  </header><form id={formId} className={mobilePresentation ? 'mobileFullViewForm mobileHeaderActionForm' : undefined} onSubmit={submit}>
    <label className="dialogField"><span>{t('plannerTasks.task')}</span><input ref={titleRef} required maxLength={240} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('plannerTasks.taskPlaceholder')} /></label>
    <label className="dialogField"><span>{t('plannerTasks.description')} <em>{t('manuscripts.optional')}</em></span><textarea maxLength={5000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('plannerTasks.descriptionPlaceholder')} /></label>
    <div className="plannerItemFormGrid"><label className="dialogField"><span>{t('plannerTasks.deadline')} <em>{t('manuscripts.optional')}</em></span><input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label><label className="dialogField"><span>{t('plannerTasks.priority')}</span><CustomSelect value={priority} onChange={(event) => setPriority(event.target.value as PlannerTaskPriority)}>{priorityOrder.map((value) => <option key={value} value={value}>{t(`planner.priorities.${value}`)}</option>)}</CustomSelect></label></div>
    <label className="dialogField"><span>{t('plannerTasks.manuscriptPart')} <em>{t('manuscripts.optional')}</em></span><CustomSelect value={associatedItemId} onChange={(event) => setAssociatedItemId(event.target.value)}><option value="">{t('plannerTasks.noLinkedPart')}</option>{items.map((item) => <option key={item.id} value={item.id}>{itemLabel(item, t)}</option>)}</CustomSelect></label>
    <label className="plannerTaskPin"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /><span><strong>{t('plannerTasks.pin')}</strong><small>{t('plannerTasks.pinLead')}</small></span></label>
    {task && mobilePresentation && <div className="plannerTaskMobileLifecycle">
      <button type="button" className="plannerTaskCompleteAction booksButton" disabled={submitting || closing || !title.trim()} onClick={() => void persist(!task.completed)}><Icon name={task.completed ? 'restart-light' : 'check-circle-1-light'} />{t(task.completed ? 'plannerTasks.returnToActive' : 'plannerTasks.completeAction')}</button>
      <button type="button" className="plannerTaskDeleteAction booksButton" disabled={submitting || closing} onClick={onRequestDelete}><Icon name="trash-bin-trash-light" />{t('plannerTasks.delete')}</button>
    </div>}
    <footer><button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button><button type="submit" className="dialogSubmit booksButton" disabled={submitting || !title.trim()}>{submitting ? t('common.saving') : t(task ? 'plannerTasks.saveChanges' : 'plannerTasks.addTask')}</button></footer>
  </form></div></div>
}

function DeleteTaskDialog({ task, mobilePresentation, onClose, onDeleted, onError }: { task: PlannerTask; mobilePresentation: boolean; onClose: () => void; onDeleted: () => void; onError: (error: string) => void }) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const { backdropStateClass, close: closeMobileDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose, focusOnDesktop: false })
  const closeDialog = mobilePresentation ? closeMobileDialog : onClose
  async function remove() { setSubmitting(true); onError(''); try { await apiRequest(`/api/manuscripts/planner-tasks/${task.id}/`, { method: 'DELETE' }); if (mobilePresentation) finishAfterExit(onDeleted); else onDeleted() } catch (err) { onError(err instanceof Error ? err.message : t('plannerTasks.deleteFailed')); setSubmitting(false) } }
  if (mobilePresentation) return <div className={`dialogBackdrop mobileBottomSheetBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) closeDialog() }}>
    <div className="createOneShotDialog manuscriptDeleteDialog plannerDeleteTaskDialog mobileBottomSheet" role="alertdialog" aria-modal="true" aria-labelledby="planner-delete-task-title" aria-describedby="planner-delete-task-description" ref={setDialogRef}>
      <header><div><h2 id="planner-delete-task-title">{t('plannerTasks.deleteTitle')}</h2><p>{t('plannerTasks.deleteLead', { title: task.title })}</p></div><button type="button" className="dialogClose booksButton" aria-label={t('plannerTasks.close')} onClick={closeDialog} disabled={submitting || closing}><Icon name="close-square-light" /></button></header>
      <div className="manuscriptDeleteBody"><p id="planner-delete-task-description">{t('plannerTasks.deleteLead', { title: task.title })}</p></div>
      <footer><button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button><button type="button" className="dialogDelete booksButton" onClick={() => void remove()} disabled={submitting || closing}>{submitting ? t('account.deleting') : t('plannerTasks.deleteTask')}</button></footer>
    </div>
  </div>
  return <ActionDialog variant="structured" role="alertdialog" title={t('plannerTasks.deleteTitle')} closeLabel={t('plannerTasks.close')} busy={submitting} className="plannerDeleteTaskDialog" onClose={onClose}><div className="standardDialogSection"><p>{t('plannerTasks.deleteLead', { title: task.title })}</p><footer className="standardDialogFooter"><button type="button" className="dialogCancel booksButton" onClick={onClose} disabled={submitting}>{t('common.cancel')}</button><button type="button" className="dialogSubmit danger booksButton" onClick={() => void remove()} disabled={submitting}>{submitting ? t('account.deleting') : t('plannerTasks.deleteTask')}</button></footer></div></ActionDialog>
}

function itemLabel(item: PlannerItem, t: TFunction) { const key = item.role === 'untyped' ? `plannerTasks.kinds.${item.kind}` : `planner.roles.${item.role}`; return `${t(key)} — ${item.title}` }
function formatDate(value: string, formatter: Intl.DateTimeFormat) { return formatter.format(new Date(`${value}T00:00:00Z`)) }
function PlusIcon() { return <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg> }
function CheckIcon() { return <svg viewBox="0 0 24 24"><path d="m6 12 4 4 8-9" /></svg> }
