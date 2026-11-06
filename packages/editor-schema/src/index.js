import { Mark, mergeAttributes, Node } from '@tiptap/core'
import { TextAlign } from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'

export const SceneBreakCore = Node.create({
  name: 'sceneBreak',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div[data-scene-break]' }]
  },

  renderHTML() {
    return ['div', { 'data-scene-break': '', class: 'sceneBreak' }, '***']
  },

  renderText() {
    return '***'
  },
})

export const AnnotationAnchorCore = Mark.create({
  name: 'annotationAnchor',
  inclusive: true,
  excludes: '',

  addAttributes() {
    return {
      annotationId: { default: '' },
    }
  },

  parseHTML() {
    return [{
      tag: 'span[data-annotation-id]',
      getAttrs: (element) => ({
        annotationId: element.dataset.annotationId ?? '',
      }),
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({
        class: 'annotationAnchor',
        'data-annotation-id': HTMLAttributes.annotationId,
      }),
      0,
    ]
  },
})

export const IllustrationCore = Node.create({
  name: 'illustration',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      assetId: { default: '' },
      alt: { default: '' },
      caption: { default: '' },
      alignment: { default: 'center' },
      displayWidth: { default: 80 },
    }
  },

  parseHTML() {
    return [{ tag: 'figure[data-asset-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes({
      'data-asset-id': HTMLAttributes.assetId,
      'data-alignment': HTMLAttributes.alignment,
      'data-display-width': HTMLAttributes.displayWidth,
    })]
  },
})

export function createHeadlessEditorExtensions() {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: { levels: [1, 2, 3] },
      horizontalRule: false,
      link: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      trailingNode: false,
      underline: false,
    }),
    TextAlign.configure({
      types: ['paragraph', 'heading'],
      alignments: ['left', 'center', 'right'],
      defaultAlignment: 'left',
    }),
    SceneBreakCore,
    IllustrationCore,
    AnnotationAnchorCore,
  ]
}
