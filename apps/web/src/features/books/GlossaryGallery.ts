import { Extension, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import './GlossaryGallery.css'

export const GLOSSARY_SCHEMA_VERSION = 2

type DropSide = 'before' | 'after'

type GalleryDrag = {
  from: number
  galleryFrom: number
  target: number | null
  side: DropSide | null
}

type GalleryState = {
  decorations: DecorationSet
  drag: GalleryDrag | null
}

type GalleryMeta =
  | { action: 'start'; from: number; galleryFrom: number }
  | { action: 'over'; target: number; side: DropSide }
  | { action: 'leave' }
  | { action: 'clear' }

const galleryKey = new PluginKey<GalleryState>('glossaryGalleryInteractions')

function isEmptyParagraph(node: JSONContent | undefined) {
  return node?.type === 'paragraph' && !(node.content?.length)
}

function jsonIllustrations(node: JSONContent | undefined) {
  if (node?.type === 'illustration') return [node]
  if (node?.type !== 'illustrationGallery') return null
  return (node.content ?? []).filter((child) => child.type === 'illustration')
}

export function normalizeGlossaryGalleries(content: JSONContent): JSONContent {
  const source = content.content ?? []
  const normalized: JSONContent[] = []
  let index = 0

  while (index < source.length) {
    const node = source[index]
    const firstIllustrations = jsonIllustrations(node)
    if (!firstIllustrations) {
      normalized.push(node)
      index += 1
      continue
    }

    const illustrations = [...firstIllustrations]
    let cursor = index + 1
    while (cursor < source.length) {
      const directIllustrations = jsonIllustrations(source[cursor])
      if (directIllustrations) {
        illustrations.push(...directIllustrations)
        cursor += 1
        continue
      }
      const illustrationsAfterParagraph = isEmptyParagraph(source[cursor])
        ? jsonIllustrations(source[cursor + 1])
        : null
      if (illustrationsAfterParagraph) {
        illustrations.push(...illustrationsAfterParagraph)
        cursor += 2
        continue
      }
      break
    }
    if (illustrations.length > 1) {
      normalized.push({ type: 'illustrationGallery', content: illustrations })
    } else if (illustrations.length === 1) {
      normalized.push(illustrations[0])
    } else {
      normalized.push(node)
    }
    index = cursor
  }

  return { ...content, content: normalized }
}

type GalleryReplacement = {
  from: number
  to: number
  node: ProseMirrorNode
}

function isIllustrationBlock(node: ProseMirrorNode | undefined) {
  return node?.type.name === 'illustration' || node?.type.name === 'illustrationGallery'
}

function isEmptyDocumentParagraph(node: ProseMirrorNode | undefined) {
  return node?.type.name === 'paragraph' && node.content.size === 0
}

function galleryReplacements(doc: ProseMirrorNode) {
  const galleryType = doc.type.schema.nodes.illustrationGallery
  const blocks: Array<{ from: number; to: number; node: ProseMirrorNode }> = []
  const replacements: GalleryReplacement[] = []
  doc.forEach((node, from) => blocks.push({ from, to: from + node.nodeSize, node }))

  let index = 0
  while (index < blocks.length) {
    const first = blocks[index]
    if (!isIllustrationBlock(first.node)) {
      index += 1
      continue
    }

    const illustrations: ProseMirrorNode[] = []
    let imageBlockCount = 0
    let last = index
    let cursor = index
    while (cursor < blocks.length) {
      const block = blocks[cursor]
      if (block.node.type.name === 'illustration') {
        illustrations.push(block.node)
        imageBlockCount += 1
        last = cursor
        cursor += 1
        continue
      }
      if (block.node.type.name === 'illustrationGallery') {
        block.node.forEach((child) => illustrations.push(child))
        imageBlockCount += 1
        last = cursor
        cursor += 1
        continue
      }
      if (
        isEmptyDocumentParagraph(block.node)
        && isIllustrationBlock(blocks[cursor + 1]?.node)
      ) {
        last = cursor
        cursor += 1
        continue
      }
      break
    }

    const unchangedStandalone = imageBlockCount === 1
      && first.node.type.name === 'illustration'
    const unchangedGallery = imageBlockCount === 1
      && first.node.type.name === 'illustrationGallery'
      && first.node.childCount > 1
    if (!unchangedStandalone && !unchangedGallery && illustrations.length) {
      replacements.push({
        from: first.from,
        to: blocks[last].to,
        node: illustrations.length === 1
          ? illustrations[0]
          : galleryType.create(null, illustrations),
      })
    }
    index = cursor
  }

  return replacements
}

function illustrationElement(event: DragEvent) {
  if (!(event.target instanceof Element)) return null
  const element = event.target.closest<HTMLElement>('.node-illustration')
  if (element?.closest('.glossaryGallery')) return element
  const gallery = event.target.closest<HTMLElement>('.glossaryGallery')
  if (!gallery) return null
  const illustrations = Array.from(
    gallery.querySelectorAll<HTMLElement>(
      '.glossaryGalleryGrid > [data-node-view-content-react] > .node-illustration',
    ),
  )
  let nearest: HTMLElement | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  illustrations.forEach((illustration) => {
    const rect = illustration.getBoundingClientRect()
    const nearestX = Math.max(rect.left, Math.min(event.clientX, rect.right))
    const nearestY = Math.max(rect.top, Math.min(event.clientY, rect.bottom))
    const distance = (event.clientX - nearestX) ** 2 + (event.clientY - nearestY) ** 2
    if (distance < nearestDistance) {
      nearest = illustration
      nearestDistance = distance
    }
  })
  return nearest
}

function illustrationPosition(view: EditorView, element: HTMLElement | null) {
  if (!element) return null
  const position = view.posAtDOM(element, 0)
  if (view.state.doc.nodeAt(position)?.type.name === 'illustration') return position
  if (position > 0 && view.state.doc.nodeAt(position - 1)?.type.name === 'illustration') {
    return position - 1
  }
  return null
}

function parentGalleryPosition(view: EditorView, position: number) {
  const resolved = view.state.doc.resolve(position)
  return resolved.parent.type.name === 'illustrationGallery' && resolved.depth > 0
    ? resolved.before(resolved.depth)
    : null
}

function stateDecorations(doc: EditorView['state']['doc'], drag: GalleryDrag | null) {
  if (drag?.target === null || !drag?.side) return DecorationSet.empty
  const node = doc.nodeAt(drag.target)
  if (!node || node.type.name !== 'illustration') return DecorationSet.empty
  return DecorationSet.create(doc, [
    Decoration.node(drag.target, drag.target + node.nodeSize, {
      class: drag.side === 'before' ? 'glossaryGalleryDropBefore' : 'glossaryGalleryDropAfter',
    }),
  ])
}

function clearDrag(view: EditorView) {
  if (galleryKey.getState(view.state)?.drag) {
    view.dispatch(view.state.tr.setMeta(galleryKey, { action: 'clear' } satisfies GalleryMeta))
  }
}

export const GlossaryGalleryInteractions = Extension.create({
  name: 'glossaryGalleryInteractions',

  extendNodeSchema(extension) {
    if (extension.name === 'illustrationGallery') {
      return { disableDropCursor: true }
    }
    if (extension.name === 'illustration') {
      return {
        disableDropCursor: (
          view: EditorView,
          position: { inside: number },
        ) => view.state.doc.resolve(position.inside).parent.type.name === 'illustrationGallery',
      }
    }
    return {}
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<GalleryState>({
        key: galleryKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty, drag: null }),
          apply(transaction, previous) {
            const meta = transaction.getMeta(galleryKey) as GalleryMeta | undefined
            let drag = previous.drag
            if (meta?.action === 'start') {
              drag = {
                from: meta.from,
                galleryFrom: meta.galleryFrom,
                target: null,
                side: null,
              }
            } else if (meta?.action === 'over' && drag) {
              drag = { ...drag, target: meta.target, side: meta.side }
            } else if (meta?.action === 'leave' && drag) {
              drag = { ...drag, target: null, side: null }
            } else if (meta?.action === 'clear') {
              drag = null
            } else if (transaction.docChanged && drag) {
              drag = {
                ...drag,
                from: transaction.mapping.map(drag.from),
                galleryFrom: transaction.mapping.map(drag.galleryFrom),
                target: drag.target === null ? null : transaction.mapping.map(drag.target),
              }
            }
            return { decorations: stateDecorations(transaction.doc, drag), drag }
          },
        },
        props: {
          decorations: (state) => galleryKey.getState(state)?.decorations,
          handleDOMEvents: {
            dragstart(view, event) {
              const from = illustrationPosition(view, illustrationElement(event))
              if (from === null || !view.editable) return false
              const galleryFrom = parentGalleryPosition(view, from)
              if (galleryFrom === null) return false
              view.dispatch(
                view.state.tr
                  .setSelection(NodeSelection.create(view.state.doc, from))
                  .setMeta(
                    galleryKey,
                    { action: 'start', from, galleryFrom } satisfies GalleryMeta,
                  ),
              )
              return false
            },
            dragover(view, event) {
              const drag = galleryKey.getState(view.state)?.drag
              const element = illustrationElement(event)
              const target = illustrationPosition(view, element)
              if (!drag) return false
              if (
                !element
                || target === null
                || target === drag.from
                || parentGalleryPosition(view, target) !== drag.galleryFrom
              ) {
                if (drag.target !== null) {
                  view.dispatch(
                    view.state.tr.setMeta(galleryKey, { action: 'leave' } satisfies GalleryMeta),
                  )
                }
                return false
              }
              event.preventDefault()
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
              const rect = element.getBoundingClientRect()
              const side: DropSide = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
              if (drag.target !== target || drag.side !== side) {
                view.dispatch(view.state.tr.setMeta(
                  galleryKey,
                  { action: 'over', target, side } satisfies GalleryMeta,
                ))
              }
              return true
            },
            drop(view, event) {
              const drag = galleryKey.getState(view.state)?.drag
              if (!drag) return false
              const dropGallery = event.target instanceof Element
                ? event.target.closest('.glossaryGallery')
                : null
              if (!dropGallery) {
                clearDrag(view)
                return false
              }
              event.preventDefault()
              const element = illustrationElement(event)
              const target = illustrationPosition(view, element)
              if (
                !element
                || target === null
                || target === drag.from
                || parentGalleryPosition(view, target) !== drag.galleryFrom
              ) {
                clearDrag(view)
                return true
              }
              const rect = element.getBoundingClientRect()
              const side: DropSide = event.clientX < rect.left + rect.width / 2
                ? 'before'
                : 'after'
              const sourceNode = view.state.doc.nodeAt(drag.from)
              const targetNode = view.state.doc.nodeAt(target)
              if (sourceNode?.type.name !== 'illustration' || targetNode?.type.name !== 'illustration') {
                clearDrag(view)
                return true
              }
              let destination = side === 'before'
                ? target
                : target + targetNode.nodeSize
              if (drag.from < destination) destination -= sourceNode.nodeSize
              if (destination === drag.from) {
                clearDrag(view)
                return true
              }
              let transaction = view.state.tr.delete(drag.from, drag.from + sourceNode.nodeSize)
              transaction = transaction
                .insert(destination, sourceNode)
                .setSelection(NodeSelection.create(transaction.doc, destination))
                .setMeta(galleryKey, { action: 'clear' } satisfies GalleryMeta)
              view.dispatch(transaction)
              return true
            },
            dragend(view) {
              clearDrag(view)
              return false
            },
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null
          const replacements = galleryReplacements(newState.doc)
          if (!replacements.length) return null
          const selectedIllustration = newState.selection instanceof NodeSelection
            && newState.selection.node.type.name === 'illustration'
            ? newState.selection.node
            : null
          let transaction = newState.tr
          replacements.reverse().forEach(({ from, to, node }) => {
            transaction = transaction.replaceWith(from, to, node)
          })
          if (selectedIllustration) {
            let selectedPosition: number | null = null
            transaction.doc.descendants((node, position) => {
              if (node === selectedIllustration) selectedPosition = position
              return selectedPosition === null
            })
            if (selectedPosition !== null) {
              transaction = transaction.setSelection(
                NodeSelection.create(transaction.doc, selectedPosition),
              )
            }
          }
          return transaction
        },
      }),
    ]
  },
})
