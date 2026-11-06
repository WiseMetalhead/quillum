import type { JSONContent } from '@tiptap/core'
import { TextAlign } from '@tiptap/extension-text-align'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AnnotationAnchor } from './AnnotationAnchor'
import { ResizableIllustration } from './ResizableIllustration'
import { SceneBreak } from './SceneBreak'

type VersionViewerProps = {
  content: JSONContent
  assetUrl?: (assetId: string) => string
}

export function VersionViewer({ content, assetUrl }: VersionViewerProps) {
  const { t, i18n } = useTranslation()
  const editor = useEditor({
    injectCSS: false,
    extensions: [
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
      SceneBreak,
      assetUrl ? ResizableIllustration.configure({ assetUrl }) : ResizableIllustration,
      AnnotationAnchor,
    ],
    content,
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { class: 'tiptapEditor versionViewerEditor', 'aria-label': t('versions.viewer') } },
  })

  useEffect(() => {
    editor?.setOptions({
      editorProps: {
        attributes: {
          class: 'tiptapEditor versionViewerEditor',
          'aria-label': t('versions.viewer'),
        },
      },
    })
  }, [editor, i18n.resolvedLanguage, t])

  return <EditorContent editor={editor} />
}
