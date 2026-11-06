import { SceneBreakCore } from '@quillum/editor-schema'
import { canInsertNode, isNodeSelection } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sceneBreak: {
      insertSceneBreak: () => ReturnType
    }
  }
}

export const SceneBreak = SceneBreakCore.extend({
  addCommands() {
    return {
      insertSceneBreak:
        () =>
        ({ chain, state }) => {
          if (!canInsertNode(state, state.schema.nodes[this.name])) return false

          const { selection } = state
          const { $to: $originTo } = selection
          const currentChain = chain()
          if (isNodeSelection(selection)) {
            currentChain.insertContentAt($originTo.pos, { type: this.name })
          } else {
            currentChain.insertContent({ type: this.name })
          }

          return currentChain
            .command(({ state: chainState, tr, dispatch }) => {
              if (dispatch) {
                const { $to } = tr.selection
                const positionAfter = $to.end()
                if ($to.nodeAfter?.isTextblock) {
                  tr.setSelection(TextSelection.create(tr.doc, $to.pos + 1))
                } else if ($to.nodeAfter?.isBlock) {
                  tr.setSelection(NodeSelection.create(tr.doc, $to.pos))
                } else if ($to.nodeAfter) {
                  tr.setSelection(TextSelection.create(tr.doc, $to.pos))
                } else {
                  const nodeType = chainState.schema.nodes.paragraph
                  const node = nodeType?.create()
                  if (node) {
                    tr.insert(positionAfter, node)
                    tr.setSelection(TextSelection.create(tr.doc, positionAfter + 1))
                  }
                }
                tr.scrollIntoView()
              }
              return true
            })
            .run()
        },
    }
  },
})
