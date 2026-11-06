import { IllustrationCore } from '@quillum/editor-schema'
import { mergeAttributes } from '@tiptap/core'
import { API_BASE } from '../../api/client'

export const Illustration = IllustrationCore.extend({
  addOptions() {
    return {
      assetUrl: (assetId: string) => `${API_BASE}/api/manuscripts/assets/${assetId}/large/`,
      readOnly: false,
    }
  },

  addAttributes() {
    return {
      assetId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-asset-id') ?? '',
      },
      alt: {
        default: '',
        parseHTML: (element) => element.querySelector('img')?.getAttribute('alt') ?? '',
      },
      caption: {
        default: '',
        parseHTML: (element) => element.querySelector('figcaption')?.textContent ?? '',
      },
      alignment: {
        default: 'center',
        parseHTML: (element) => element.getAttribute('data-alignment') ?? 'center',
      },
    }
  },

  parseHTML() {
    return [{ tag: 'figure[data-asset-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const { assetId, alt, caption, alignment } = HTMLAttributes
    return [
      'figure',
      mergeAttributes({
        'data-asset-id': assetId,
        'data-alignment': alignment,
        class: 'editorIllustration',
      }),
      [
        'img',
        {
          src: this.options.assetUrl(assetId),
          alt,
          draggable: 'false',
        },
      ],
      ['figcaption', {}, caption],
    ]
  },
})
