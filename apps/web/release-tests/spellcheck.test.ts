import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import nspell from 'nspell'
import RussianStemmer from '../src/features/books/spellcheck/vendor/snowball/russian-stemmer.js'

const vendor = new URL('../src/features/books/spellcheck/vendor/', import.meta.url)

async function dictionary(name: string) {
  const root = new URL(`${name}/`, vendor)
  return nspell({
    aff: await readFile(fileURLToPath(new URL('index.aff', root)), 'utf8'),
    dic: await readFile(fileURLToPath(new URL('index.dic', root)), 'utf8'),
  })
}

test('bundled dictionaries cover Russian and both English variants', async () => {
  const [russian, englishUs, englishGb] = await Promise.all([
    dictionary('ru'),
    dictionary('en-us'),
    dictionary('en-gb'),
  ])
  assert.equal(russian.correct('рукописи'), true)
  assert.equal(russian.correct('ошипка'), false)
  assert.ok(russian.suggest('ошипка').includes('ошибка'))
  for (const word of ['какие-то', 'как-нибудь', 'чего-то']) {
    assert.equal(word.split('-').every((part) => russian.correct(part)), true)
  }
  assert.equal(englishUs.correct('color'), true)
  assert.equal(englishGb.correct('colour'), true)
})

test('Snowball groups regular Russian proper-name forms but not irregular names', () => {
  const stemmer = new RussianStemmer()
  assert.equal(stemmer.stem('альтарион'), stemmer.stem('альтариона'))
  assert.equal(stemmer.stem('элирия'), stemmer.stem('элирией'))
  assert.notEqual(stemmer.stem('лев'), stemmer.stem('льва'))
})
