import { TableCell, TableHeader } from '@tiptap/extension-table'
import { Mark, mergeAttributes, Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { API_BASE } from '../../api/client'
import {
  GlossaryCalloutView,
  GlossaryIllustrationGalleryView,
  GlossaryIllustrationView,
} from './GlossaryNodeViews'
import type { GlossaryLightboxImage } from './GlossaryImageLightbox'

export const GLOSSARY_CALLOUT_KINDS = ['info', 'attention', 'warning', 'check'] as const
export type GlossaryCalloutKind = typeof GLOSSARY_CALLOUT_KINDS[number]

type GlossaryIllustrationOptions = {
  manuscriptId: string
  onOpenLightbox?: (image: GlossaryLightboxImage) => void
}

export const GlossaryTableCell = TableCell.extend({
  content: 'paragraph+',
})

export const GlossaryTableHeader = TableHeader.extend({
  content: 'paragraph+',
})

export const GlossaryLink = Mark.create({
  name: 'glossaryLink',
  inclusive: false,

  addAttributes() {
    return {
      articleId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-glossary-article-id') ?? '',
      },
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-glossary-article-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      mergeAttributes({
        'data-glossary-article-id': HTMLAttributes.articleId,
        href: '#',
        class: 'glossaryInternalLink',
      }),
      0,
    ]
  },
})

export const GlossaryCallout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'paragraph+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'info',
        parseHTML: (element) => element.getAttribute('data-kind') ?? 'info',
      },
    }
  },

  parseHTML() {
    return [{ tag: 'aside[data-glossary-callout]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'aside',
      mergeAttributes({
        'data-glossary-callout': '',
        'data-kind': HTMLAttributes.kind,
        class: 'glossaryCallout',
      }),
      0,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(GlossaryCalloutView)
  },
})

export const GlossaryIllustrationGallery = Node.create({
  name: 'illustrationGallery',
  group: 'block',
  content: 'illustration+',
  defining: true,

  parseHTML() {
    return [{ tag: 'section[data-glossary-gallery]' }]
  },

  renderHTML() {
    return [
      'section',
      { 'data-glossary-gallery': '', class: 'glossaryGallery' },
      0,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(GlossaryIllustrationGalleryView)
  },
})

export const GlossaryIllustration = Node.create({
  name: 'illustration',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions(): GlossaryIllustrationOptions {
    return {
      manuscriptId: '',
      onOpenLightbox: undefined,
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
      displayWidth: {
        default: 100,
        parseHTML: (element) => {
          const value = Number(element.getAttribute('data-display-width'))
          return Number.isInteger(value) && value >= 25 && value <= 100 ? value : 100
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'figure[data-glossary-asset]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const { assetId, alt, caption, alignment, displayWidth } = HTMLAttributes
    const normalizedDisplayWidth = Number.isInteger(displayWidth) && displayWidth >= 25 && displayWidth <= 100
      ? displayWidth
      : 100
    return [
      'figure',
      mergeAttributes({
        'data-glossary-asset': '',
        'data-asset-id': assetId,
        'data-alignment': alignment,
        'data-display-width': normalizedDisplayWidth,
        style: `width: ${normalizedDisplayWidth}%`,
        class: 'glossaryIllustration',
      }),
      [
        'img',
        {
          src: `${API_BASE}/api/manuscripts/${this.options.manuscriptId}/glossary/assets/${assetId}/large/`,
          alt,
          draggable: 'false',
        },
      ],
      ['figcaption', {}, caption],
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(GlossaryIllustrationView, {
      trackNodeViewPosition: true,
    })
  },
})
