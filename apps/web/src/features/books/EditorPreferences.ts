export type QuoteStyle = 'guillemets' | 'curly'
export type SpellcheckDictionary = 'ru' | 'en-US' | 'en-GB'

export type EditorPreferences = {
  fontSize: number
  smartQuotes: boolean
  quoteStyle: QuoteStyle
  autoCapitalize: boolean
  autoReplace: boolean
  spellcheckEnabled: boolean
  spellcheckDictionary: SpellcheckDictionary
}
