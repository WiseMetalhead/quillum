import { AnnotationAnchorCore } from '@quillum/editor-schema'
import { type Editor } from '@tiptap/core'
import { Fragment, Slice, type MarkType, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

type AnnotationPresentation = {
  activeId: string | null
  resolvedIds: string[]
}

type AnnotationPresentationState = AnnotationPresentation & {
  decorations: DecorationSet
}

const annotationPresentationKey = new PluginKey<AnnotationPresentationState>(
  'annotationPresentation',
)

function annotationDecorations(
  doc: Parameters<typeof DecorationSet.create>[0],
  presentation: AnnotationPresentation,
) {
  const resolvedIds = new Set(presentation.resolvedIds)
  const decorations: Decoration[] = []
  doc.descendants((node, position) => {
    if (!node.isText) return
    const anchor = node.marks.find((mark) => mark.type.name === 'annotationAnchor')
    const annotationId = anchor?.attrs.annotationId as string | undefined
    if (!annotationId) return
    const classes = [
      annotationId === presentation.activeId ? 'activeAnnotationAnchor' : '',
      resolvedIds.has(annotationId) ? 'resolvedAnnotationAnchor' : '',
    ].filter(Boolean).join(' ')
    if (classes) {
      decorations.push(Decoration.inline(position, position + node.nodeSize, { class: classes }))
    }
  })
  return DecorationSet.create(doc, decorations)
}

function stripAnnotationMarks(fragment: Fragment, markType: MarkType): Fragment {
  const nodes: ProseMirrorNode[] = []
  fragment.forEach((node) => {
    let cleanNode = node.content.size > 0
      ? node.copy(stripAnnotationMarks(node.content, markType))
      : node
    if (cleanNode.marks.some((mark) => mark.type === markType)) {
      cleanNode = cleanNode.mark(cleanNode.marks.filter((mark) => mark.type !== markType))
    }
    nodes.push(cleanNode)
  })
  return Fragment.fromArray(nodes)
}

export const AnnotationAnchor = AnnotationAnchorCore.extend({
  addProseMirrorPlugins() {
    const markType = this.type
    return [
      new Plugin<AnnotationPresentationState>({
        key: annotationPresentationKey,
        state: {
          init: () => ({
            activeId: null,
            resolvedIds: [],
            decorations: DecorationSet.empty,
          }),
          apply: (transaction, current) => {
            const next = transaction.getMeta(annotationPresentationKey) as
              | AnnotationPresentation
              | undefined
            if (!next && !transaction.docChanged) return current
            const presentation = next ?? current
            return {
              ...presentation,
              decorations: annotationDecorations(transaction.doc, presentation),
            }
          },
        },
        props: {
          decorations: (state) => annotationPresentationKey.getState(state)?.decorations,
          transformPasted: (slice) => new Slice(
            stripAnnotationMarks(slice.content, markType),
            slice.openStart,
            slice.openEnd,
          ),
        },
      }),
    ]
  },
})

export function setAnnotationPresentation(
  editor: Editor,
  activeId: string | null,
  resolvedIds: string[],
) {
  editor.view.dispatch(
    editor.state.tr.setMeta(annotationPresentationKey, { activeId, resolvedIds }),
  )
}
