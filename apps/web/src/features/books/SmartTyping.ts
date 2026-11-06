import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorPreferences } from './EditorPreferences'

type SmartTypingOptions = {
  preferences: EditorPreferences
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    smartTyping: {
      setSmartTypingPreferences: (preferences: EditorPreferences) => ReturnType
    }
  }
}

const quotePairs = {
  guillemets: ['«', '»'],
  curly: ['“', '”'],
} as const

const smartTypingPluginKey = new PluginKey<EditorPreferences>('smartTyping')

function shouldCapitalize(before: string) {
  return /^\s*$/u.test(before) || /[.!?][”»"'’)\]]?\s+$/u.test(before)
}

export const SmartTyping = Extension.create<SmartTypingOptions>({
  name: 'smartTyping',

  addOptions() {
    return {
      preferences: {
        fontSize: 16,
        smartQuotes: false,
        quoteStyle: 'guillemets',
        autoCapitalize: false,
        autoReplace: false,
        spellcheckEnabled: false,
        spellcheckDictionary: 'ru',
      },
    }
  },

  addCommands() {
    return {
      setSmartTypingPreferences:
        (preferences) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(smartTypingPluginKey, preferences)
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: smartTypingPluginKey,
        state: {
          init: () => this.options.preferences,
          apply: (transaction, preferences) =>
            transaction.getMeta(smartTypingPluginKey) ?? preferences,
        },
        props: {
          handleTextInput: (view, from, to, text) => {
            if (view.composing) return false
            const { state } = view
            const preferences = smartTypingPluginKey.getState(state) ?? this.options.preferences
            const $from = state.doc.resolve(from)
            const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n')

            if (preferences.smartQuotes && text === '"') {
              const [openingQuote, closingQuote] = quotePairs[preferences.quoteStyle]
              const nextCharacter = state.doc.textBetween(
                from,
                Math.min(from + 1, state.doc.content.size),
                '\n',
                '\n',
              )
              if (from === to && nextCharacter === closingQuote) {
                view.dispatch(
                  state.tr.setSelection(TextSelection.create(state.doc, from + closingQuote.length)),
                )
                return true
              }
              const transaction = state.tr
              if (from !== to) {
                transaction.insertText(closingQuote, to)
                transaction.insertText(openingQuote, from)
                transaction.setSelection(
                  TextSelection.create(
                    transaction.doc,
                    to + openingQuote.length + closingQuote.length,
                  ),
                )
              } else {
                transaction.insertText(`${openingQuote}${closingQuote}`, from, to)
                transaction.setSelection(
                  TextSelection.create(transaction.doc, from + openingQuote.length),
                )
              }
              view.dispatch(transaction.scrollIntoView())
              return true
            }

            if (preferences.autoReplace) {
              const replacements: Array<[boolean, number, string]> = [
                [text === '-' && before.endsWith('-'), 1, '—'],
                [text === '<' && before.endsWith('<'), 1, '«'],
                [text === '>' && before.endsWith('>'), 1, '»'],
                [text === '.' && before.endsWith('..'), 2, '…'],
              ]
              const replacement = replacements.find(([matches]) => matches)
              if (replacement) {
                const [, charactersToReplace, value] = replacement
                view.dispatch(state.tr.insertText(value, from - charactersToReplace, to))
                return true
              }
            }

            if (
              preferences.autoCapitalize &&
              Array.from(text).length === 1 &&
              /^\p{Ll}$/u.test(text) &&
              shouldCapitalize(before)
            ) {
              view.dispatch(state.tr.insertText(text.toLocaleUpperCase(), from, to))
              return true
            }
            return false
          },

          handleKeyDown: (view, event) => {
            if (event.key !== 'Backspace' || view.composing) return false
            const { state } = view
            const preferences = smartTypingPluginKey.getState(state) ?? this.options.preferences
            if (!preferences.smartQuotes) return false
            const { from, to, empty } = state.selection
            if (!empty || from !== to || from === 0) return false
            const [openingQuote, closingQuote] = quotePairs[preferences.quoteStyle]
            const previousCharacter = state.doc.textBetween(from - 1, from, '\n', '\n')
            const nextCharacter = state.doc.textBetween(
              from,
              Math.min(from + 1, state.doc.content.size),
              '\n',
              '\n',
            )
            if (previousCharacter !== openingQuote || nextCharacter !== closingQuote) return false
            view.dispatch(state.tr.delete(from - 1, from + 1))
            return true
          },
        },
      }),
    ]
  },
})
