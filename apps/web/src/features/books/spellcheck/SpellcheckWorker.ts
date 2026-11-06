/// <reference lib="webworker" />

import nspell, { type NSpell } from 'nspell'

import type {
  SpellcheckDictionary,
  SpellcheckLexicon,
  WorkerRequest,
  WorkerResponse,
} from './SpellcheckTypes'

const MAX_WORD_LENGTH = 80
const MAX_BATCH_SIZE = 500
const WORD_PATTERN = /[\p{L}]+(?:[-'’][\p{L}]+)*/gu
const CYRILLIC_PATTERN = /^[А-Яа-яЁё]+$/u
const CYRILLIC_WORD_PATTERN = /^[А-Яа-яЁё]+(?:[-'’][А-Яа-яЁё]+)*$/u
const LATIN_PATTERN = /^[A-Za-z]+(?:[-'’][A-Za-z]+)*$/u

type Stemmer = { stem: (word: string) => string }

let checker: NSpell | null = null
let activeDictionary: SpellcheckDictionary | null = null
let russianStemmer: Stemmer | null = null
let customWords = new Set<string>()
let glossaryWords = new Set<string>()
let glossaryStems = new Set<string>()

function normalized(word: string) {
  return word.normalize('NFC').toLocaleLowerCase('und')
}

function russianStem(word: string) {
  return russianStemmer?.stem(normalized(word).replaceAll('ё', 'е')) ?? ''
}

function lexiconTokens(terms: string[]) {
  return terms.flatMap((term) => Array.from(term.normalize('NFC').matchAll(WORD_PATTERN), (match) => match[0]))
}

function setLexicon(lexicon: SpellcheckLexicon) {
  customWords = new Set(lexicon.customWords.map((item) => normalized(item.word)))
  const tokens = lexiconTokens(lexicon.glossaryTerms)
  glossaryWords = new Set(tokens.map(normalized))
  glossaryStems = activeDictionary === 'ru'
    ? new Set(
        tokens
          .filter((word) => CYRILLIC_PATTERN.test(word))
          .map(russianStem)
          .filter((stem) => Array.from(stem).length >= 4),
      )
    : new Set()
}

async function loadDictionary(dictionary: SpellcheckDictionary) {
  if (dictionary === 'ru') {
    const [aff, dic, stemmerModule] = await Promise.all([
      import('./vendor/ru/index.aff?raw'),
      import('./vendor/ru/index.dic?raw'),
      // Snowball generates an ES module without TypeScript declarations.
      // @ts-expect-error generated vendored source
      import('./vendor/snowball/russian-stemmer.js'),
    ])
    const RussianStemmer = stemmerModule.default as new () => Stemmer
    return { checker: nspell({ aff: aff.default, dic: dic.default }), stemmer: new RussianStemmer() }
  }
  const root = dictionary === 'en-US' ? 'en-us' : 'en-gb'
  const [aff, dic] = root === 'en-us'
    ? await Promise.all([
        import('./vendor/en-us/index.aff?raw'),
        import('./vendor/en-us/index.dic?raw'),
      ])
    : await Promise.all([
        import('./vendor/en-gb/index.aff?raw'),
        import('./vendor/en-gb/index.dic?raw'),
      ])
  return { checker: nspell({ aff: aff.default, dic: dic.default }), stemmer: null }
}

async function initialize(lexicon: SpellcheckLexicon, dictionary: SpellcheckDictionary) {
  const loaded = await loadDictionary(dictionary)
  checker = loaded.checker
  russianStemmer = loaded.stemmer
  activeDictionary = dictionary
  setLexicon(lexicon)
}

function isCorrectRussianWord(word: string) {
  if (!checker || checker.correct(word)) return true
  if (!word.includes('-')) return false
  return word.split('-').every((part) => Boolean(part) && checker?.correct(part))
}

function isCorrect(word: string) {
  if (!word || Array.from(word).length > MAX_WORD_LENGTH) return true
  const value = normalized(word)
  if (customWords.has(value) || glossaryWords.has(value)) return true
  if (activeDictionary === 'ru' && CYRILLIC_WORD_PATTERN.test(word)) {
    if (CYRILLIC_PATTERN.test(word)) {
      const stem = russianStem(word)
      if (Array.from(stem).length >= 4 && glossaryStems.has(stem)) return true
    }
    return isCorrectRussianWord(word)
  }
  if (activeDictionary !== 'ru' && LATIN_PATTERN.test(word)) {
    return checker?.correct(word) ?? true
  }
  return true
}

function suggestions(word: string) {
  if (Array.from(word).length > MAX_WORD_LENGTH) return []
  const candidates = activeDictionary === 'ru' && CYRILLIC_WORD_PATTERN.test(word)
    ? checker?.suggest(word) ?? []
    : activeDictionary !== 'ru' && LATIN_PATTERN.test(word)
      ? checker?.suggest(word) ?? []
      : []
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = normalized(candidate)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 5)
}

function respond(response: WorkerResponse) {
  self.postMessage(response)
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    if (request.type === 'initialize') {
      await initialize(request.lexicon, request.dictionary)
      respond({ id: request.id, ok: true, type: 'initialized' })
      return
    }
    if (!checker || !activeDictionary) throw new Error('spellcheck_not_initialized')
    if (request.type === 'updateLexicon') {
      setLexicon(request.lexicon)
      respond({ id: request.id, ok: true, type: 'updated' })
      return
    }
    if (request.type === 'check') {
      if (request.words.length > MAX_BATCH_SIZE) throw new Error('spellcheck_batch_too_large')
      respond({
        id: request.id,
        ok: true,
        type: 'checked',
        misspelled: request.words.filter((word) => !isCorrect(word)),
      })
      return
    }
    respond({ id: request.id, ok: true, type: 'suggested', suggestions: suggestions(request.word) })
  } catch (error) {
    respond({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'spellcheck_worker_failed',
    })
  }
}
