import type { JSONContent } from '@tiptap/core'
import { diffArrays, diffWordsWithSpace } from 'diff'

export type ComparisonMark = 'bold' | 'italic' | 'strike'

export type ComparisonSegment = {
  text: string
  marks: ComparisonMark[]
  annotationIds: string[]
  change: 'none' | 'added' | 'removed'
  formattingChanged: boolean
  annotationsChanged: boolean
}

export type IllustrationComparison = {
  assetId: string
  alt: string
  caption: string
}

export type ComparisonMetadataChange =
  | 'blockType'
  | 'headingLevel'
  | 'alignment'
  | 'illustrationAsset'
  | 'illustrationAlt'
  | 'illustrationCaption'

export type ComparisonBlock = {
  type: 'paragraph' | 'heading' | 'sceneBreak' | 'illustration'
  level: number | null
  alignment: 'left' | 'center' | 'right'
  segments: ComparisonSegment[]
  illustration: IllustrationComparison | null
  metadataChanges: ComparisonMetadataChange[]
}

export type ComparisonRow = {
  id: string
  groupId: number | null
  changed: boolean
  left: ComparisonBlock | null
  right: ComparisonBlock | null
}

export type DocumentComparisonResult = {
  rows: ComparisonRow[]
  groupCount: number
  usedAlignmentFallback: boolean
}

export type VisibleComparisonItem =
  | { kind: 'row'; row: ComparisonRow }
  | { kind: 'gap'; id: string; start: number; end: number; count: number }

type InlineRun = {
  text: string
  marks: ComparisonMark[]
  annotationIds: string[]
}

type NormalizedBlock = {
  type: ComparisonBlock['type']
  level: number | null
  alignment: ComparisonBlock['alignment']
  text: string
  runs: InlineRun[]
  illustration: IllustrationComparison | null
  fingerprint: string
}

type AlignedBlock = {
  left: NormalizedBlock | null
  right: NormalizedBlock | null
  changed: boolean
}

const ALIGNMENT_MATRIX_LIMIT = 10_000

function normalizedMarks(node: JSONContent): ComparisonMark[] {
  return (node.marks ?? [])
    .map((mark) => mark.type)
    .filter((mark): mark is ComparisonMark => (
      mark === 'bold' || mark === 'italic' || mark === 'strike'
    ))
    .sort()
}

function annotationIds(node: JSONContent) {
  return (node.marks ?? [])
    .filter((mark) => mark.type === 'annotationAnchor')
    .map((mark) => String(mark.attrs?.annotationId ?? ''))
    .filter(Boolean)
    .sort()
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function pushRun(runs: InlineRun[], run: InlineRun) {
  if (!run.text) return
  const previous = runs.at(-1)
  if (
    previous
    && sameStrings(previous.marks, run.marks)
    && sameStrings(previous.annotationIds, run.annotationIds)
  ) {
    previous.text += run.text
    return
  }
  runs.push(run)
}

function normalizeBlock(block: JSONContent): NormalizedBlock {
  const type = block.type === 'heading'
    ? 'heading'
    : block.type === 'sceneBreak'
      ? 'sceneBreak'
      : block.type === 'illustration'
        ? 'illustration'
        : 'paragraph'
  const alignment = block.attrs?.textAlign === 'center' || block.attrs?.textAlign === 'right'
    ? block.attrs.textAlign
    : 'left'
  const level = type === 'heading' ? Number(block.attrs?.level ?? 1) : null
  const runs: InlineRun[] = []

  if (type === 'paragraph' || type === 'heading') {
    for (const node of block.content ?? []) {
      if (node.type === 'hardBreak') {
        pushRun(runs, { text: '\n', marks: [], annotationIds: [] })
      } else if (node.type === 'text') {
        pushRun(runs, {
          text: node.text ?? '',
          marks: normalizedMarks(node),
          annotationIds: annotationIds(node),
        })
      }
    }
  }

  const illustration = type === 'illustration'
    ? {
        assetId: String(block.attrs?.assetId ?? ''),
        alt: String(block.attrs?.alt ?? ''),
        caption: String(block.attrs?.caption ?? ''),
      } satisfies IllustrationComparison
    : null
  const text = runs.map((run) => run.text).join('')
  const fingerprint = type === 'illustration'
    ? JSON.stringify({ type, illustration })
    : JSON.stringify({ type, level, alignment, runs })

  return { type, level, alignment, text, runs, illustration, fingerprint }
}

function normalizeDocument(content: JSONContent) {
  return (content.content ?? []).map(normalizeBlock)
}

function blockTokens(block: NormalizedBlock) {
  const source = block.illustration
    ? `${block.illustration.caption} ${block.illustration.alt}`
    : block.text
  return source.toLocaleLowerCase().match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? []
}

function blockSimilarity(left: NormalizedBlock, right: NormalizedBlock) {
  const leftTokens = blockTokens(left)
  const rightTokens = blockTokens(right)
  if (leftTokens.length === 0 && rightTokens.length === 0) {
    return left.type === right.type ? 0.7 : 0.25
  }
  const counts = new Map<string, number>()
  for (const token of leftTokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  let overlap = 0
  for (const token of rightTokens) {
    const count = counts.get(token) ?? 0
    if (count > 0) {
      overlap += 1
      counts.set(token, count - 1)
    }
  }
  const dice = (2 * overlap) / (leftTokens.length + rightTokens.length)
  const sameVisibleText = left.text === right.text && left.text.length > 0
  return Math.min(1, dice + (left.type === right.type ? 0.08 : 0) + (sameVisibleText ? 0.3 : 0))
}

function substitutionCost(left: NormalizedBlock, right: NormalizedBlock) {
  const similarity = blockSimilarity(left, right)
  return similarity < 0.2 ? 2.1 : 1.55 - similarity
}

function positionalAlignment(left: NormalizedBlock[], right: NormalizedBlock[]) {
  const rows: AlignedBlock[] = []
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    rows.push({ left: left[index] ?? null, right: right[index] ?? null, changed: true })
  }
  return rows
}

function alignChangedBlocks(left: NormalizedBlock[], right: NormalizedBlock[]) {
  if (left.length * right.length > ALIGNMENT_MATRIX_LIMIT) {
    return { rows: positionalAlignment(left, right), usedFallback: true }
  }
  const width = right.length + 1
  const costs = new Float64Array((left.length + 1) * width)
  const choices = new Uint8Array((left.length + 1) * width)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    costs[leftIndex * width] = leftIndex
    choices[leftIndex * width] = 1
  }
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    costs[rightIndex] = rightIndex
    choices[rightIndex] = 2
  }
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const offset = leftIndex * width + rightIndex
      const remove = costs[(leftIndex - 1) * width + rightIndex] + 1
      const add = costs[leftIndex * width + rightIndex - 1] + 1
      const replace = costs[(leftIndex - 1) * width + rightIndex - 1]
        + substitutionCost(left[leftIndex - 1], right[rightIndex - 1])
      if (replace <= remove && replace <= add) {
        costs[offset] = replace
        choices[offset] = 3
      } else if (remove <= add) {
        costs[offset] = remove
        choices[offset] = 1
      } else {
        costs[offset] = add
        choices[offset] = 2
      }
    }
  }
  const rows: AlignedBlock[] = []
  let leftIndex = left.length
  let rightIndex = right.length
  while (leftIndex > 0 || rightIndex > 0) {
    const choice = choices[leftIndex * width + rightIndex]
    if (choice === 3) {
      rows.push({ left: left[leftIndex - 1], right: right[rightIndex - 1], changed: true })
      leftIndex -= 1
      rightIndex -= 1
    } else if (choice === 1) {
      rows.push({ left: left[leftIndex - 1], right: null, changed: true })
      leftIndex -= 1
    } else {
      rows.push({ left: null, right: right[rightIndex - 1], changed: true })
      rightIndex -= 1
    }
  }
  rows.reverse()
  return { rows, usedFallback: false }
}

function alignDocuments(left: NormalizedBlock[], right: NormalizedBlock[]) {
  const changes = diffArrays(left, right, {
    comparator: (leftBlock, rightBlock) => leftBlock.fingerprint === rightBlock.fingerprint,
  })
  const rows: AlignedBlock[] = []
  let pendingLeft: NormalizedBlock[] = []
  let pendingRight: NormalizedBlock[] = []
  let usedFallback = false
  const flush = () => {
    if (pendingLeft.length === 0 && pendingRight.length === 0) return
    const aligned = alignChangedBlocks(pendingLeft, pendingRight)
    rows.push(...aligned.rows)
    usedFallback ||= aligned.usedFallback
    pendingLeft = []
    pendingRight = []
  }
  for (const change of changes) {
    if (change.removed) {
      pendingLeft.push(...change.value)
    } else if (change.added) {
      pendingRight.push(...change.value)
    } else {
      flush()
      for (const block of change.value) rows.push({ left: block, right: block, changed: false })
    }
  }
  flush()
  return { rows, usedFallback }
}

function runOffsets(runs: InlineRun[]) {
  const offsets: number[] = []
  let offset = 0
  for (const run of runs) {
    offsets.push(offset)
    offset += run.text.length
  }
  return offsets
}

function runAt(runs: InlineRun[], offsets: number[], position: number) {
  let low = 0
  let high = offsets.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle] <= position) low = middle + 1
    else high = middle - 1
  }
  const index = Math.max(0, high)
  return { run: runs[index], end: offsets[index] + (runs[index]?.text.length ?? 0) }
}

function pushSegment(segments: ComparisonSegment[], segment: ComparisonSegment) {
  if (!segment.text) return
  const previous = segments.at(-1)
  if (
    previous
    && previous.change === segment.change
    && previous.formattingChanged === segment.formattingChanged
    && previous.annotationsChanged === segment.annotationsChanged
    && sameStrings(previous.marks, segment.marks)
    && sameStrings(previous.annotationIds, segment.annotationIds)
  ) {
    previous.text += segment.text
    return
  }
  segments.push(segment)
}

function appendChangedRange(
  target: ComparisonSegment[],
  runs: InlineRun[],
  offsets: number[],
  start: number,
  length: number,
  change: 'added' | 'removed',
) {
  let position = start
  const end = start + length
  while (position < end) {
    const located = runAt(runs, offsets, position)
    const next = Math.min(end, located.end)
    pushSegment(target, {
      text: located.run.text.slice(position - (located.end - located.run.text.length), next - (located.end - located.run.text.length)),
      marks: located.run.marks,
      annotationIds: located.run.annotationIds,
      change,
      formattingChanged: false,
      annotationsChanged: false,
    })
    position = next
  }
}

function appendEqualRange(
  leftTarget: ComparisonSegment[],
  rightTarget: ComparisonSegment[],
  left: NormalizedBlock,
  right: NormalizedBlock,
  leftOffsets: number[],
  rightOffsets: number[],
  leftStart: number,
  rightStart: number,
  length: number,
) {
  let consumed = 0
  while (consumed < length) {
    const leftPosition = leftStart + consumed
    const rightPosition = rightStart + consumed
    const leftLocated = runAt(left.runs, leftOffsets, leftPosition)
    const rightLocated = runAt(right.runs, rightOffsets, rightPosition)
    const take = Math.min(
      length - consumed,
      leftLocated.end - leftPosition,
      rightLocated.end - rightPosition,
    )
    const formattingChanged = !sameStrings(leftLocated.run.marks, rightLocated.run.marks)
    const annotationsChanged = !sameStrings(
      leftLocated.run.annotationIds,
      rightLocated.run.annotationIds,
    )
    const common = {
      text: left.text.slice(leftPosition, leftPosition + take),
      change: 'none' as const,
      formattingChanged,
      annotationsChanged,
    }
    pushSegment(leftTarget, {
      ...common,
      marks: leftLocated.run.marks,
      annotationIds: leftLocated.run.annotationIds,
    })
    pushSegment(rightTarget, {
      ...common,
      marks: rightLocated.run.marks,
      annotationIds: rightLocated.run.annotationIds,
    })
    consumed += take
  }
}

function compareSegments(left: NormalizedBlock, right: NormalizedBlock) {
  const leftSegments: ComparisonSegment[] = []
  const rightSegments: ComparisonSegment[] = []
  const leftOffsets = runOffsets(left.runs)
  const rightOffsets = runOffsets(right.runs)
  let leftPosition = 0
  let rightPosition = 0
  for (const part of diffWordsWithSpace(left.text, right.text)) {
    if (part.removed) {
      appendChangedRange(leftSegments, left.runs, leftOffsets, leftPosition, part.value.length, 'removed')
      leftPosition += part.value.length
    } else if (part.added) {
      appendChangedRange(rightSegments, right.runs, rightOffsets, rightPosition, part.value.length, 'added')
      rightPosition += part.value.length
    } else {
      appendEqualRange(
        leftSegments,
        rightSegments,
        left,
        right,
        leftOffsets,
        rightOffsets,
        leftPosition,
        rightPosition,
        part.value.length,
      )
      leftPosition += part.value.length
      rightPosition += part.value.length
    }
  }
  return { leftSegments, rightSegments }
}

function metadataChanges(left: NormalizedBlock, right: NormalizedBlock) {
  const changes: ComparisonMetadataChange[] = []
  if (left.type !== right.type) changes.push('blockType')
  if (left.level !== right.level) changes.push('headingLevel')
  if (left.alignment !== right.alignment) changes.push('alignment')
  if (left.illustration && right.illustration) {
    if (left.illustration.assetId !== right.illustration.assetId) changes.push('illustrationAsset')
    if (left.illustration.alt !== right.illustration.alt) changes.push('illustrationAlt')
    if (left.illustration.caption !== right.illustration.caption) changes.push('illustrationCaption')
  }
  return changes
}

function plainSegments(block: NormalizedBlock, change: 'none' | 'added' | 'removed') {
  return block.runs.map((run) => ({
    text: run.text,
    marks: run.marks,
    annotationIds: run.annotationIds,
    change,
    formattingChanged: false,
    annotationsChanged: false,
  } satisfies ComparisonSegment))
}

function comparisonBlock(
  block: NormalizedBlock,
  segments: ComparisonSegment[],
  changes: ComparisonMetadataChange[],
): ComparisonBlock {
  return {
    type: block.type,
    level: block.level,
    alignment: block.alignment,
    segments,
    illustration: block.illustration,
    metadataChanges: changes,
  }
}

export function compareDocuments(leftContent: JSONContent, rightContent: JSONContent): DocumentComparisonResult {
  const aligned = alignDocuments(normalizeDocument(leftContent), normalizeDocument(rightContent))
  let groupCount = 0
  let insideGroup = false
  const rows = aligned.rows.map((row, index): ComparisonRow => {
    if (row.changed && !insideGroup) groupCount += 1
    insideGroup = row.changed
    if (!row.left && row.right) {
      return {
        id: `row-${index}`,
        groupId: groupCount,
        changed: true,
        left: null,
        right: comparisonBlock(row.right, plainSegments(row.right, 'added'), []),
      }
    }
    if (row.left && !row.right) {
      return {
        id: `row-${index}`,
        groupId: groupCount,
        changed: true,
        left: comparisonBlock(row.left, plainSegments(row.left, 'removed'), []),
        right: null,
      }
    }
    if (!row.left || !row.right) throw new Error('comparison_alignment_invalid')
    if (!row.changed) {
      return {
        id: `row-${index}`,
        groupId: null,
        changed: false,
        left: comparisonBlock(row.left, plainSegments(row.left, 'none'), []),
        right: comparisonBlock(row.right, plainSegments(row.right, 'none'), []),
      }
    }
    const segments = compareSegments(row.left, row.right)
    const changes = metadataChanges(row.left, row.right)
    return {
      id: `row-${index}`,
      groupId: groupCount,
      changed: true,
      left: comparisonBlock(row.left, segments.leftSegments, changes),
      right: comparisonBlock(row.right, segments.rightSegments, changes),
    }
  })
  return { rows, groupCount, usedAlignmentFallback: aligned.usedFallback }
}

export function visibleComparisonItems(
  result: DocumentComparisonResult,
  expandedGaps: ReadonlySet<string>,
  showAll: boolean,
  context = 2,
): VisibleComparisonItem[] {
  if (showAll || result.groupCount === 0) return result.rows.map((row) => ({ kind: 'row', row }))
  const visible = new Set<number>()
  result.rows.forEach((row, index) => {
    if (!row.changed) return
    for (
      let contextIndex = Math.max(0, index - context);
      contextIndex <= Math.min(result.rows.length - 1, index + context);
      contextIndex += 1
    ) visible.add(contextIndex)
  })
  const items: VisibleComparisonItem[] = []
  let index = 0
  while (index < result.rows.length) {
    if (visible.has(index)) {
      items.push({ kind: 'row', row: result.rows[index] })
      index += 1
      continue
    }
    const start = index
    while (index < result.rows.length && !visible.has(index)) index += 1
    const end = index - 1
    const id = `gap-${start}-${end}`
    if (expandedGaps.has(id)) {
      for (let rowIndex = start; rowIndex <= end; rowIndex += 1) {
        items.push({ kind: 'row', row: result.rows[rowIndex] })
      }
    } else {
      items.push({ kind: 'gap', id, start, end, count: end - start + 1 })
    }
  }
  return items
}
