import type { SpellcheckDictionary } from '../EditorPreferences'

export type { SpellcheckDictionary } from '../EditorPreferences'

export type SpellcheckCustomWord = {
  id: string
  word: string
  createdAt: string
}

export type SpellcheckLexicon = {
  scope: { type: 'manuscript' | 'series'; id: string }
  revision: string
  customWords: SpellcheckCustomWord[]
  glossaryTerms: string[]
}

export type SpellcheckStatus = 'disabled' | 'loading' | 'ready' | 'error'

export type SpellcheckPopupTarget = {
  from: number
  to: number
  word: string
  rect: { top: number; right: number; bottom: number; left: number }
}

export type WorkerRequest =
  | { id: number; type: 'initialize'; lexicon: SpellcheckLexicon; dictionary: SpellcheckDictionary }
  | { id: number; type: 'check'; words: string[] }
  | { id: number; type: 'suggest'; word: string }
  | { id: number; type: 'updateLexicon'; lexicon: SpellcheckLexicon }

export type WorkerResponse =
  | { id: number; ok: true; type: 'initialized' | 'updated' }
  | { id: number; ok: true; type: 'checked'; misspelled: string[] }
  | { id: number; ok: true; type: 'suggested'; suggestions: string[] }
  | { id: number; ok: false; error: string }
