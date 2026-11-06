import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import { SpellcheckProvider } from './SpellcheckProvider'
import type { SpellcheckPopupTarget } from './SpellcheckTypes'

const WORD_PATTERN = /[\p{L}]+(?:[-'’][\p{L}]+)*/gu
const SKIPPED_TEXT_PATTERN = /\b(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/giu
const MAX_TOKEN_LENGTH = 80
const MAX_DOCUMENT_TOKENS = 20_000
const DEBOUNCE_MS = 350

type Token = { from: number; to: number; word: string }
type PluginState = { decorations: DecorationSet; enabled: boolean; refresh: number }
type SpellcheckMeta = { decorations?: DecorationSet; enabled?: boolean; refresh?: boolean }

export const spellcheckPluginKey = new PluginKey<PluginState>('quillumSpellcheck')

function documentTokens(document: ProseMirrorNode) {
  const tokens: Token[] = []
  document.descendants((node, position, parent) => {
    if (!node.isText || !node.text) return
    if (parent?.type.spec.code || parent?.type.name === 'codeBlock') return
    const skippedRanges = Array.from(node.text.matchAll(SKIPPED_TEXT_PATTERN), (match) => ({
      from: match.index,
      to: match.index + match[0].length,
    }))
    for (const match of node.text.matchAll(WORD_PATTERN)) {
      if (match.index === undefined || Array.from(match[0]).length > MAX_TOKEN_LENGTH) continue
      const before = node.text[match.index - 1] ?? ''
      const after = node.text[match.index + match[0].length] ?? ''
      if (/[\p{L}\p{N}_]/u.test(before) || /[\p{L}\p{N}_]/u.test(after)) continue
      if (skippedRanges.some((range) => match.index! < range.to && match.index! + match[0].length > range.from)) continue
      tokens.push({ from: position + match.index, to: position + match.index + match[0].length, word: match[0] })
      if (tokens.length >= MAX_DOCUMENT_TOKENS) return false
    }
  })
  return tokens
}

function targetAt(view: EditorView, position: number): SpellcheckPopupTarget | null {
  const decorations = spellcheckPluginKey.getState(view.state)?.decorations
  const decoration = decorations
    ?.find(Math.max(0, position - 1), Math.min(view.state.doc.content.size, position + 1))
    .find((item) => item.from <= position && item.to >= position && typeof item.spec.word === 'string')
  if (!decoration) return null
  const start = view.coordsAtPos(decoration.from)
  const end = view.coordsAtPos(decoration.to)
  return {
    from: decoration.from,
    to: decoration.to,
    word: decoration.spec.word as string,
    rect: {
      top: Math.min(start.top, end.top),
      right: Math.max(start.right, end.right),
      bottom: Math.max(start.bottom, end.bottom),
      left: Math.min(start.left, end.left),
    },
  }
}

type SpellcheckExtensionOptions = {
  provider: SpellcheckProvider
  onOpen: (target: SpellcheckPopupTarget) => void
  onError: (error: Error) => void
}

export function createSpellcheckExtension(options: SpellcheckExtensionOptions) {
  return Extension.create({
    name: 'quillumSpellcheck',
    addProseMirrorPlugins() {
      return [
        new Plugin<PluginState>({
          key: spellcheckPluginKey,
          state: {
            init: () => ({ decorations: DecorationSet.empty, enabled: false, refresh: 0 }),
            apply(transaction, previous) {
              const meta = transaction.getMeta(spellcheckPluginKey) as SpellcheckMeta | undefined
              if (meta?.decorations) {
                return {
                  decorations: meta.decorations,
                  enabled: meta.enabled ?? previous.enabled,
                  refresh: previous.refresh,
                }
              }
              return {
                decorations: transaction.docChanged
                  ? previous.decorations.map(transaction.mapping, transaction.doc)
                  : previous.decorations,
                enabled: meta?.enabled ?? previous.enabled,
                refresh: previous.refresh + (meta?.refresh ? 1 : 0),
              }
            },
          },
          props: {
            decorations(state) {
              return spellcheckPluginKey.getState(state)?.decorations ?? DecorationSet.empty
            },
            handleClick(view, position) {
              if (!spellcheckPluginKey.getState(view.state)?.enabled) return false
              const target = targetAt(view, position)
              if (!target) return false
              options.onOpen(target)
              return true
            },
            handleKeyDown(view, event) {
              if (!spellcheckPluginKey.getState(view.state)?.enabled || event.key !== 'F10' || !event.shiftKey) return false
              const target = targetAt(view, view.state.selection.head)
              if (!target) return false
              event.preventDefault()
              options.onOpen(target)
              return true
            },
          },
          view(view) {
            let timer: number | null = null
            let generation = 0
            let lastDocument: ProseMirrorNode | null = null
            let lastEnabled: boolean | null = null
            let lastRefresh = -1

            const schedule = (nextView: EditorView) => {
              const state = spellcheckPluginKey.getState(nextView.state)
              const enabled = state?.enabled ?? false
              if (
                nextView.state.doc === lastDocument
                && enabled === lastEnabled
                && state?.refresh === lastRefresh
              ) return
              lastDocument = nextView.state.doc
              lastEnabled = enabled
              lastRefresh = state?.refresh ?? 0
              generation += 1
              const currentGeneration = generation
              if (timer !== null) window.clearTimeout(timer)
              if (!enabled) {
                nextView.dispatch(nextView.state.tr.setMeta(spellcheckPluginKey, { decorations: DecorationSet.empty }))
                return
              }
              timer = window.setTimeout(async () => {
                timer = null
                const tokens = documentTokens(nextView.state.doc)
                const uniqueWords = Array.from(new Set(tokens.map((token) => token.word)))
                try {
                  const misspelled = new Set(await options.provider.check(uniqueWords))
                  if (currentGeneration !== generation || nextView.isDestroyed) return
                  const decorations = DecorationSet.create(
                    nextView.state.doc,
                    tokens
                      .filter((token) => misspelled.has(token.word))
                      .map((token) => Decoration.inline(
                        token.from,
                        token.to,
                        { class: 'spellcheckError' },
                        { word: token.word },
                      )),
                  )
                  nextView.dispatch(nextView.state.tr.setMeta(spellcheckPluginKey, { decorations }))
                } catch (error) {
                  if (currentGeneration === generation) {
                    options.onError(error instanceof Error ? error : new Error('spellcheck_worker_failed'))
                  }
                }
              }, DEBOUNCE_MS)
            }

            schedule(view)
            return {
              update: schedule,
              destroy() {
                generation += 1
                if (timer !== null) window.clearTimeout(timer)
              },
            }
          },
        }),
      ]
    },
  })
}

export function refreshSpellcheck(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setMeta(spellcheckPluginKey, { refresh: true }))
}

export function setSpellcheckEnabled(editor: Editor, enabled: boolean) {
  editor.view.dispatch(editor.state.tr.setMeta(spellcheckPluginKey, { enabled, refresh: true }))
}
