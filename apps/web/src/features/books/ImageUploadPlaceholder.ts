import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import './ImageUploadPlaceholder.css'

type UploadPlaceholderMeta =
  | { action: 'add'; id: string; position: number; label: string }
  | { action: 'remove'; id: string }

const uploadPlaceholderKey = new PluginKey<DecorationSet>('imageUploadPlaceholder')

function placeholderElement(label: string) {
  const element = document.createElement('div')
  element.className = 'editorImageUploadPlaceholder'
  element.setAttribute('role', 'status')
  element.setAttribute('aria-label', label)
  element.contentEditable = 'false'
  element.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12,23a9.63,9.63,0,0,1-8-9.5,9.51,9.51,0,0,1,6.79-9.1A1.66,1.66,0,0,0,12,2.81h0a1.67,1.67,0,0,0-1.94-1.64A11,11,0,0,0,12,23Z"><animateTransform attributeName="transform" dur="0.75s" repeatCount="indefinite" type="rotate" values="0 12 12;360 12 12"/></path></svg><span></span>`
  const labelElement = element.querySelector('span')
  if (labelElement) labelElement.textContent = label
  return element
}

export const ImageUploadPlaceholder = Extension.create({
  name: 'imageUploadPlaceholder',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: uploadPlaceholderKey,
        state: {
          init: () => DecorationSet.empty,
          apply(transaction, decorations) {
            const mapped = decorations.map(transaction.mapping, transaction.doc)
            const meta = transaction.getMeta(uploadPlaceholderKey) as UploadPlaceholderMeta | undefined
            if (!meta) return mapped
            if (meta.action === 'remove') {
              return mapped.remove(mapped.find(undefined, undefined, (spec) => spec.id === meta.id))
            }
            const widget = Decoration.widget(
              meta.position,
              () => placeholderElement(meta.label),
              { id: meta.id, side: -1 },
            )
            return mapped.add(transaction.doc, [widget])
          },
        },
        props: {
          decorations: (state) => uploadPlaceholderKey.getState(state),
        },
      }),
    ]
  },
})

export function showImageUploadPlaceholder(editor: Editor, label: string) {
  const id = crypto.randomUUID()
  const { selection } = editor.state
  const { $from } = selection
  const position = selection instanceof NodeSelection && selection.node.type.name === 'illustration'
    ? selection.to
    : $from.depth > 0 ? $from.after(1) : $from.pos
  editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, {
    action: 'add',
    id,
    position,
    label,
  } satisfies UploadPlaceholderMeta))
  return id
}

export function imageUploadPlaceholderPosition(editor: Editor, id: string) {
  const match = uploadPlaceholderKey.getState(editor.state)?.find(
    undefined,
    undefined,
    (spec) => spec.id === id,
  )[0]
  return match?.from ?? null
}

export function removeImageUploadPlaceholder(editor: Editor, id: string) {
  editor.view.dispatch(editor.state.tr.setMeta(uploadPlaceholderKey, {
    action: 'remove',
    id,
  } satisfies UploadPlaceholderMeta))
}

export function replaceImageUploadPlaceholder(
  editor: Editor,
  id: string,
  content: JSONContent | JSONContent[],
) {
  const position = imageUploadPlaceholderPosition(editor, id)
  if (position === null) return false
  const nodes = (Array.isArray(content) ? content : [content]).map(
    (node) => editor.schema.nodeFromJSON(node),
  )
  let transaction = editor.state.tr.insert(position, Fragment.fromArray(nodes))
  transaction = transaction
    .setSelection(NodeSelection.create(transaction.doc, position))
    .setMeta(uploadPlaceholderKey, { action: 'remove', id } satisfies UploadPlaceholderMeta)
  editor.view.dispatch(transaction)
  editor.view.focus()
  return true
}
