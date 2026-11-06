import { useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { ChangeEvent, DragEvent } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_FILES = 100
const MAX_FOLDERS = 30
const MAX_NODES = MAX_FILES + MAX_FOLDERS
const MAX_FOLDER_DEPTH = 3
const IMPORT_FILE_ACCEPT = [
  '.docx',
  '.md',
  '.odt',
  '.txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'text/markdown',
  'text/plain',
].join(',')

type ImportKind = 'oneshot' | 'book'
type DropPosition = 'before' | 'inside' | 'after'
type ImportIssue = 'file_too_large' | 'duplicate_path' | 'path_too_deep' | 'oneshot_extra'
type ImportNode = {
  id: string
  kind: 'folder' | 'document'
  title: string
  parentId: string | null
  order: number
  sourcePath: string
  file?: File
  recognized: boolean
  issue?: ImportIssue
}

export type ImportSubmission = {
  manifest: string
  files: Array<{ key: string; file: File }>
  documentCount: number
}

type Props = {
  kind: ImportKind
  onChange: (submission: ImportSubmission | null) => void
}

type FileCandidate = { file: File; path: string }

function id() {
  return crypto.randomUUID()
}

function titleFromPath(path: string, untitled: string) {
  const name = path.split('/').pop() || untitled
  return name.replace(/\.(docx|md|odt|txt)$/i, '') || untitled
}

function isSupported(path: string) {
  return /\.(docx|md|odt|txt)$/i.test(path)
}

function siblingOrder(nodes: ImportNode[], parentId: string | null) {
  return nodes.filter((node) => node.recognized && node.parentId === parentId).length
}

function folderDepth(nodes: ImportNode[], parentId: string | null) {
  let depth = 0
  let current = parentId
  const seen = new Set<string>()
  while (current) {
    if (seen.has(current)) return MAX_FOLDER_DEPTH + 1
    seen.add(current)
    const parent = nodes.find((node) => node.id === current && node.kind === 'folder')
    if (!parent) break
    depth += 1
    current = parent.parentId
  }
  return depth
}

function folderSubtreeHeight(nodes: ImportNode[], nodeId: string): number {
  const folderChildren = nodes.filter(
    (node) => node.kind === 'folder' && node.parentId === nodeId,
  )
  return 1 + Math.max(
    0,
    ...folderChildren.map((child) => folderSubtreeHeight(nodes, child.id)),
  )
}

async function readDirectory(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = []
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (!batch.length) return entries
    entries.push(...batch)
  }
}

async function walkEntry(entry: FileSystemEntry, parentPath = ''): Promise<FileCandidate[]> {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      ;(entry as FileSystemFileEntry).file(resolve, reject)
    })
    return [{ file, path }]
  }
  if (!entry.isDirectory) return []
  const children = await readDirectory((entry as FileSystemDirectoryEntry).createReader())
  const nested = await Promise.all(children.map((child) => walkEntry(child, path)))
  return nested.flat()
}

function stripCommonRoot(candidates: FileCandidate[]) {
  const roots = new Set(candidates.map((candidate) => candidate.path.split('/')[0]))
  if (roots.size !== 1 || candidates.some((candidate) => !candidate.path.includes('/'))) {
    return candidates
  }
  return candidates.map((candidate) => ({
    ...candidate,
    path: candidate.path.split('/').slice(1).join('/'),
  }))
}

function rowDropPosition(node: ImportNode, event: DragEvent<HTMLElement>): DropPosition {
  const bounds = event.currentTarget.getBoundingClientRect()
  const ratio = (event.clientY - bounds.top) / bounds.height
  if (node.kind === 'folder' && ratio >= 0.28 && ratio <= 0.72) return 'inside'
  return ratio < 0.5 ? 'before' : 'after'
}

export function ManuscriptImportStep({ kind, onChange }: Props) {
  const { t, i18n } = useTranslation()
  const [nodes, setNodes] = useState<ImportNode[]>([])
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    nodeId: string
    position: DropPosition
  } | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const autoScrollFrameRef = useRef<number | null>(null)
  const autoScrollVelocityRef = useRef(0)
  const autoScrollContainerRef = useRef<HTMLElement | null>(null)

  const recognized = nodes.filter((node) => node.recognized)
  const unrecognized = nodes.filter((node) => !node.recognized)
  const folders = recognized.filter((node) => node.kind === 'folder')

  const submission = useMemo(() => {
    const placed = nodes.filter((node) => node.recognized)
    const unresolved = nodes.filter((node) => !node.recognized)
    const placedDocuments = placed.filter((node) => node.kind === 'document')
    const ready = placedDocuments.length > 0
      && unresolved.length === 0
      && placed.every((node) => node.title.trim())
      && nodes.length <= MAX_NODES
      && placed.filter((node) => node.kind === 'folder').length <= MAX_FOLDERS
      && (kind === 'book' || (placedDocuments.length === 1 && placed.length === 1))
    if (!ready) {
      return null
    }
    const files: Array<{ key: string; file: File }> = []
    const manifestNodes = placed.map((node) => {
      const siblings = placed.filter((candidate) => candidate.parentId === node.parentId)
      const order = siblings.findIndex((candidate) => candidate.id === node.id)
      if (node.kind === 'folder') {
        return {
          id: node.id,
          parentId: node.parentId,
          kind: node.kind,
          title: node.title.trim(),
          order,
        }
      }
      const key = `importFile_${files.length}`
      files.push({ key, file: node.file as File })
      return {
        id: node.id,
        parentId: node.parentId,
        kind: node.kind,
        title: node.title.trim(),
        order,
        fileKey: key,
        sourcePath: node.sourcePath,
      }
    })
    return {
      manifest: JSON.stringify({ version: 1, nodes: manifestNodes }),
      files,
      documentCount: placedDocuments.length,
    }
  }, [kind, nodes])

  useEffect(() => {
    onChange(submission)
  }, [onChange, submission])

  useEffect(() => () => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current)
    }
  }, [])

  function stopAutoScroll() {
    autoScrollVelocityRef.current = 0
    autoScrollContainerRef.current = null
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current)
      autoScrollFrameRef.current = null
    }
  }

  function updateAutoScroll(event: DragEvent<HTMLElement>) {
    const dialog = event.currentTarget.closest<HTMLElement>('.createOneShotDialog')
    const container = event.currentTarget.closest<HTMLElement>('.dialogScrollBody') ?? dialog
    if (!container) {
      stopAutoScroll()
      return
    }
    const header = dialog?.querySelector<HTMLElement>(':scope > header')
    const footer = dialog?.querySelector<HTMLElement>(':scope > form > footer')
    const bounds = container.getBoundingClientRect()
    const visibleTop = Math.max(header?.getBoundingClientRect().bottom ?? bounds.top, bounds.top)
    const visibleBottom = Math.min(footer?.getBoundingClientRect().top ?? bounds.bottom, bounds.bottom)
    const edge = Math.min(100, Math.max(48, (visibleBottom - visibleTop) * 0.22))
    const topDistance = event.clientY - visibleTop
    const bottomDistance = visibleBottom - event.clientY
    let velocity = 0
    if (topDistance < edge && topDistance <= bottomDistance) {
      const intensity = Math.min(1, Math.max(0.25, 1 - topDistance / edge))
      velocity = -Math.round(24 * intensity)
    } else if (bottomDistance < edge) {
      const intensity = Math.min(1, Math.max(0.25, 1 - bottomDistance / edge))
      velocity = Math.round(24 * intensity)
    }
    autoScrollContainerRef.current = container
    autoScrollVelocityRef.current = velocity
    if (velocity === 0 || autoScrollFrameRef.current !== null) return

    const scroll = () => {
      const scrollContainer = autoScrollContainerRef.current
      const scrollVelocity = autoScrollVelocityRef.current
      if (!scrollContainer || scrollVelocity === 0) {
        autoScrollFrameRef.current = null
        return
      }
      scrollContainer.scrollTop += scrollVelocity
      autoScrollFrameRef.current = window.requestAnimationFrame(scroll)
    }
    autoScrollFrameRef.current = window.requestAnimationFrame(scroll)
  }

  function finishDragging() {
    stopAutoScroll()
    setDraggedId(null)
    setDropTarget(null)
  }

  function addCandidates(rawCandidates: FileCandidate[], stripRoot: boolean) {
    const candidates = (stripRoot ? stripCommonRoot(rawCandidates) : rawCandidates)
      .sort((left, right) => left.path.localeCompare(right.path, i18n.resolvedLanguage, {
        numeric: true,
        sensitivity: 'base',
      }))
    const supported = candidates.filter((candidate) => isSupported(candidate.path))
    if (!supported.length) return
    const currentDocuments = nodes.filter((node) => node.kind === 'document').length
    if (currentDocuments + supported.length > MAX_FILES) {
      return
    }
    const currentBytes = nodes.reduce((sum, node) => sum + (node.file?.size || 0), 0)
    const addedBytes = supported.reduce((sum, item) => sum + item.file.size, 0)
    if (currentBytes + addedBytes > MAX_TOTAL_BYTES) {
      return
    }
    setNodes((current) => {
      const next = [...current]
      for (const candidate of supported) {
        if (candidate.file.size > MAX_FILE_BYTES) {
          next.push({
            id: id(),
            kind: 'document',
            title: titleFromPath(candidate.path, t('import.untitled')),
            parentId: null,
            order: next.length,
            sourcePath: candidate.path,
            file: candidate.file,
            recognized: false,
            issue: 'file_too_large',
          })
          continue
        }
        if (next.some((node) => node.sourcePath === candidate.path && node.kind === 'document')) {
          next.push({
            id: id(),
            kind: 'document',
            title: titleFromPath(candidate.path, t('import.untitled')),
            parentId: null,
            order: next.length,
            sourcePath: candidate.path,
            file: candidate.file,
            recognized: false,
            issue: 'duplicate_path',
          })
          continue
        }
        const parts = kind === 'oneshot'
          ? []
          : candidate.path.split('/').filter(Boolean)
        const fileName = parts.pop() || candidate.file.name
        if (parts.length > MAX_FOLDER_DEPTH) {
          next.push({
            id: id(),
            kind: 'document',
            title: titleFromPath(fileName, t('import.untitled')),
            parentId: null,
            order: next.length,
            sourcePath: candidate.path,
            file: candidate.file,
            recognized: false,
            issue: 'path_too_deep',
          })
          continue
        }
        let parentId: string | null = null
        for (const folderName of parts) {
          let folder = next.find(
            (node) => node.recognized
              && node.kind === 'folder'
              && node.parentId === parentId
              && node.title === folderName,
          )
          if (!folder) {
            folder = {
              id: id(),
              kind: 'folder',
              title: folderName,
              parentId,
              order: siblingOrder(next, parentId),
              sourcePath: '',
              recognized: true,
            }
            next.push(folder)
          }
          parentId = folder.id
        }
        const oneshotExtra = kind === 'oneshot' && next.some(
          (node) => node.recognized && node.kind === 'document',
        )
        next.push({
          id: id(),
          kind: 'document',
          title: titleFromPath(fileName, t('import.untitled')),
          parentId: oneshotExtra ? null : parentId,
          order: siblingOrder(next, parentId),
          sourcePath: candidate.path,
          file: candidate.file,
          recognized: !oneshotExtra && (kind === 'book' || parentId === null),
          issue: oneshotExtra ? 'oneshot_extra' : undefined,
        })
      }
      return next
    })
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    addCandidates(
      Array.from(event.target.files || []).map((file) => ({ file, path: file.name })),
      false,
    )
    event.target.value = ''
  }

  function chooseFolder(event: ChangeEvent<HTMLInputElement>) {
    addCandidates(
      Array.from(event.target.files || []).map((file) => ({
        file,
        path: file.webkitRelativePath || file.name,
      })),
      true,
    )
    event.target.value = ''
  }

  async function dropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDropActive(false)
    const entries: FileSystemEntry[] = []
    for (const item of Array.from(event.dataTransfer.items)) {
      if (item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry()
      if (entry) entries.push(entry)
    }
    if (entries.length) {
      const candidates = (await Promise.all(entries.map((entry) => walkEntry(entry)))).flat()
      addCandidates(candidates, entries.some((entry) => entry.isDirectory))
      return
    }
    addCandidates(
      Array.from(event.dataTransfer.files).map((file) => ({ file, path: file.name })),
      false,
    )
  }

  function updateTitle(nodeId: string, title: string) {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, title } : node))
  }

  function descendants(nodeId: string, source: ImportNode[]) {
    const result = new Set<string>()
    const pending = [nodeId]
    while (pending.length) {
      const parent = pending.pop() as string
      for (const child of source.filter((node) => node.parentId === parent)) {
        result.add(child.id)
        pending.push(child.id)
      }
    }
    return result
  }

  function moveNode(
    nodeId: string,
    parentId: string | null,
    targetId?: string,
    position?: Exclude<DropPosition, 'inside'>,
  ) {
    setNodes((current) => {
      const node = current.find((candidate) => candidate.id === nodeId)
      if (!node) return current
      if (node.file && node.file.size > MAX_FILE_BYTES) return current
      if (nodeId === parentId) return current
      if (
        kind === 'oneshot'
        && node.kind === 'document'
        && current.some((candidate) => (
          candidate.id !== node.id
          && candidate.recognized
          && candidate.kind === 'document'
        ))
      ) {
        return current
      }
      if (node.kind === 'folder' && parentId && descendants(node.id, current).has(parentId)) {
        return current
      }
      const depth = folderDepth(current, parentId) + (
        node.kind === 'folder' ? folderSubtreeHeight(current, node.id) : 0
      )
      if (depth > MAX_FOLDER_DEPTH || (kind === 'oneshot' && parentId !== null)) return current
      const moved = {
        ...node,
        parentId,
        recognized: true,
        issue: undefined,
        order: siblingOrder(current, parentId),
      }
      const next = current.filter((candidate) => candidate.id !== nodeId)
      if (!targetId || !position) return [...next, moved]
      const targetIndex = next.findIndex((candidate) => candidate.id === targetId)
      if (targetIndex < 0) return [...next, moved]
      next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moved)
      return next
    })
  }

  function dropNode(nodeId: string, targetId: string, position: DropPosition) {
    if (nodeId === targetId) return
    const target = nodes.find((candidate) => candidate.id === targetId)
    if (!target) return
    if (position === 'inside' && target.kind === 'folder') {
      moveNode(nodeId, target.id)
    } else {
      moveNode(nodeId, target.parentId, target.id, position === 'before' ? 'before' : 'after')
    }
  }

  function reorder(nodeId: string, direction: -1 | 1) {
    setNodes((current) => {
      const node = current.find((candidate) => candidate.id === nodeId)
      if (!node) return current
      const siblings = current.filter(
        (candidate) => candidate.recognized && candidate.parentId === node.parentId,
      )
      const index = siblings.findIndex((candidate) => candidate.id === nodeId)
      const swap = siblings[index + direction]
      if (!swap) return current
      const firstIndex = current.findIndex((candidate) => candidate.id === node.id)
      const secondIndex = current.findIndex((candidate) => candidate.id === swap.id)
      const next = [...current]
      ;[next[firstIndex], next[secondIndex]] = [next[secondIndex], next[firstIndex]]
      return next
    })
  }

  function removeNode(nodeId: string) {
    setNodes((current) => {
      const removed = descendants(nodeId, current)
      removed.add(nodeId)
      return current.filter((node) => !removed.has(node.id))
    })
  }

  function addFolder() {
    if (nodes.filter((node) => node.kind === 'folder').length >= MAX_FOLDERS) {
      return
    }
    setNodes((current) => [...current, {
      id: id(),
      kind: 'folder',
      title: t('import.newFolderDefault'),
      parentId: null,
      order: siblingOrder(current, null),
      sourcePath: '',
      recognized: true,
    }])
  }

  function renderTree(parentId: string | null, depth: number): ReactNode {
    return recognized.filter((node) => node.parentId === parentId).map((node) => (
      <div key={node.id}>
        <ImportRow
          node={node}
          depth={depth}
          folders={folders}
          onTitle={updateTitle}
          onMove={moveNode}
          onReorder={reorder}
          onRemove={removeNode}
          onDragStart={setDraggedId}
          onDragEnd={finishDragging}
          dropPosition={dropTarget?.nodeId === node.id ? dropTarget.position : null}
          onDragTarget={(position) => setDropTarget({ nodeId: node.id, position })}
          onDragLeave={() => setDropTarget((current) => current?.nodeId === node.id ? null : current)}
          onDrop={(position) => {
            if (draggedId) dropNode(draggedId, node.id, position)
            finishDragging()
          }}
        />
        {node.kind === 'folder' && renderTree(node.id, depth + 1)}
      </div>
    ))
  }

  return (
    <div
      className="importStep"
      onDragOverCapture={(event) => {
        if (draggedId) updateAutoScroll(event)
      }}
    >
      <details className="importCallout">
        <summary><Icon name="information-circle-light" /> {t('import.details')}</summary>
        <ul>
          <li>{t('import.supportedText')}</li>
          <li>{t('import.folderDepth')}</li>
          <li>{t('import.imagesAndLinks')}</li>
          <li>{t('import.formatting')}</li>
          <li>{t('import.itemLimits')}</li>
          <li>{t('import.sizeLimits')}</li>
        </ul>
      </details>

      <div
        className={`importDropZone ${dropActive ? 'active' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDropActive(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropActive(false)
        }}
        onDrop={(event) => void dropFiles(event)}
      >
        <Icon name="file-document-light" />
        <strong>{t('import.drop')}</strong>
        <span>{t('import.supportedFormats')}</span>
        <div>
          <button type="button" className="booksButton" onClick={() => fileInputRef.current?.click()}>
            <Icon name="file-add-light" /> {t('import.chooseFiles')}
          </button>
          <button type="button" className="booksButton" onClick={() => folderInputRef.current?.click()}>
            <Icon name="folder-add-light" /> {t('import.chooseFolder')}
          </button>
        </div>
        <input
          ref={fileInputRef}
          hidden
          type="file"
          multiple
          accept={IMPORT_FILE_ACCEPT}
          onChange={chooseFiles}
        />
        <input
          ref={(element) => {
            folderInputRef.current = element
            element?.setAttribute('webkitdirectory', '')
          }}
          hidden
          type="file"
          multiple
          accept={IMPORT_FILE_ACCEPT}
          onChange={chooseFolder}
        />
      </div>

      <section className="importStructure" aria-labelledby="detected-structure-heading">
        <header>
          <div>
            <h3 id="detected-structure-heading">{t('import.detectedStructure')}</h3>
            <span>{t('import.itemCount', { count: recognized.length })}</span>
          </div>
          {kind === 'book' && (
            <button type="button" className="booksButton" onClick={addFolder}>
              <Icon name="folder-add-light" /> {t('import.newFolder')}
            </button>
          )}
        </header>
        <div
          className="importTree"
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            if (draggedId) moveNode(draggedId, null)
            finishDragging()
          }}
        >
          {recognized.length ? renderTree(null, 0) : <p>{t('import.chooseFilesHint')}</p>}
        </div>
      </section>

      {unrecognized.length > 0 && (
        <section className="importUnrecognized" aria-labelledby="unrecognized-heading">
          <header>
            <h3 id="unrecognized-heading">{t('import.unrecognizedFiles')}</h3>
            <span>{t('import.unrecognizedLead')}</span>
          </header>
          {unrecognized.map((node) => (
            <ImportRow
              key={node.id}
              node={node}
              depth={0}
              folders={folders}
              onTitle={updateTitle}
              onMove={moveNode}
              onReorder={reorder}
              onRemove={removeNode}
              onDragStart={setDraggedId}
              onDragEnd={finishDragging}
              dropPosition={dropTarget?.nodeId === node.id ? dropTarget.position : null}
              onDragTarget={(position) => setDropTarget({ nodeId: node.id, position })}
              onDragLeave={() => setDropTarget((current) => current?.nodeId === node.id ? null : current)}
              onDrop={(position) => {
                if (draggedId) dropNode(draggedId, node.id, position)
                finishDragging()
              }}
            />
          ))}
        </section>
      )}
    </div>
  )
}

function ImportRow({
  node,
  depth,
  folders,
  onTitle,
  onMove,
  onReorder,
  onRemove,
  onDragStart,
  onDragEnd,
  dropPosition,
  onDragTarget,
  onDragLeave,
  onDrop,
}: {
  node: ImportNode
  depth: number
  folders: ImportNode[]
  onTitle: (id: string, title: string) => void
  onMove: (id: string, parentId: string | null) => void
  onReorder: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  dropPosition: DropPosition | null
  onDragTarget: (position: DropPosition) => void
  onDragLeave: () => void
  onDrop: (position: DropPosition) => void
}) {
  const { t } = useTranslation()
  const movable = !node.file || node.file.size <= MAX_FILE_BYTES
  return (
    <div
      className={`importTreeRow ${node.recognized ? '' : 'unrecognized'} ${dropPosition ? `drop-${dropPosition}` : ''}`}
      style={{ '--import-depth': depth } as CSSProperties}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onDragTarget(rowDropPosition(node, event))
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDragLeave()
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onDrop(rowDropPosition(node, event))
      }}
    >
      <span
        className="importDragHandle"
        draggable={movable}
        title={movable ? t('import.drag') : undefined}
        aria-hidden="true"
        onDragStart={(event) => {
          if (!movable) return
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', node.id)
          onDragStart(node.id)
        }}
        onDragEnd={onDragEnd}
      ><i /><i /><i /><i /><i /><i /></span>
      <Icon name={node.kind === 'folder' ? 'folder-light' : 'file-text-light'} />
      <div className="importNodeText">
        <input value={node.title} maxLength={240} aria-label={t('import.itemTitle')} onChange={(event) => onTitle(node.id, event.target.value)} />
        {node.sourcePath && <small>{node.sourcePath}</small>}
        {node.issue && <small className="fieldError">{t(`import.issues.${node.issue}`)}</small>}
      </div>
      <CustomSelect
        className="importParentSelect"
        aria-label={t('import.move', { title: node.title })}
        disabled={!movable}
        value={node.recognized ? node.parentId || '' : '__unrecognized__'}
        onChange={(event) => onMove(node.id, event.target.value || null)}
      >
        {!node.recognized && <option value="__unrecognized__">{t('import.unrecognized')}</option>}
        <option value="">{t('import.manuscriptRoot')}</option>
        {folders.filter((folder) => folder.id !== node.id).map((folder) => (
          <option key={folder.id} value={folder.id}>{folder.title}</option>
        ))}
      </CustomSelect>
      <button type="button" className="booksButton importRowAction" aria-label={t('import.moveUp', { title: node.title })} onClick={() => onReorder(node.id, -1)}>
        <Icon name="arrow-up-2" />
      </button>
      <button type="button" className="booksButton importRowAction" aria-label={t('import.moveDown', { title: node.title })} onClick={() => onReorder(node.id, 1)}>
        <Icon name="arrow-down-2" />
      </button>
      <button type="button" className="booksButton importRowAction danger" aria-label={t('import.remove', { title: node.title })} onClick={() => onRemove(node.id)}>
        <Icon name="trash-bin-trash-light" />
      </button>
    </div>
  )
}
