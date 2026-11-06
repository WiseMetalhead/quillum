import { mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { Illustration } from './Illustration'
import { ResizableIllustrationView } from './ResizableIllustrationNodeView'

const DEFAULT_DISPLAY_WIDTH = 80

function normalizedDisplayWidth(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 25 && Number(value) <= 100
    ? Number(value)
    : DEFAULT_DISPLAY_WIDTH
}

export const ResizableIllustration = Illustration.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      displayWidth: {
        default: DEFAULT_DISPLAY_WIDTH,
        parseHTML: (element) => normalizedDisplayWidth(Number(element.getAttribute('data-display-width'))),
      },
    }
  },

  renderHTML({ HTMLAttributes }) {
    const { assetId, alt, caption, alignment } = HTMLAttributes
    const displayWidth = normalizedDisplayWidth(HTMLAttributes.displayWidth)
    return [
      'figure',
      mergeAttributes({
        'data-asset-id': assetId,
        'data-alignment': alignment,
        'data-display-width': displayWidth,
        style: `--illustration-display-width: ${displayWidth}%`,
        class: 'editorIllustration',
      }),
      [
        'div',
        { class: 'editorIllustrationFrame' },
        ['img', { src: this.options.assetUrl(assetId), alt, draggable: 'false' }],
      ],
      ['figcaption', {}, caption],
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableIllustrationView, {
      trackNodeViewPosition: true,
    })
  },
})
