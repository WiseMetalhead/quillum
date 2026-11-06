import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const assetsRoot = resolve(scriptDirectory, '../dist/assets')
const files = await readdir(assetsRoot)
const workerFiles = files.filter((file) => /^SpellcheckWorker-[\w-]+\.js$/.test(file))

if (workerFiles.length !== 1) {
  throw new Error(`Expected one spellcheck worker bundle, found ${workerFiles.length}.`)
}

const workerFile = workerFiles[0]
const workerPath = resolve(assetsRoot, workerFile)
const [workerSource, workerStats] = await Promise.all([
  readFile(workerPath, 'utf8'),
  stat(workerPath),
])

if (workerStats.size > 100_000) {
  throw new Error(
    `Spellcheck worker is ${workerStats.size} bytes; dictionaries may have been bundled eagerly.`,
  )
}

const lazyAssets = new Set(
  Array.from(
    workerSource.matchAll(/import\((["'`])\.\/(.+?\.js)\1\)/g),
    (match) => match[2],
  ),
)

if (lazyAssets.size < 7) {
  throw new Error(
    `Expected separate spellcheck dictionary assets, found ${lazyAssets.size} dynamic imports.`,
  )
}

for (const asset of lazyAssets) {
  if (!files.includes(asset)) {
    throw new Error(`Spellcheck worker references missing asset ${asset}.`)
  }
}

console.log(
  `Spellcheck bundle split verified: ${workerFile} (${workerStats.size} bytes), `
  + `${lazyAssets.size} lazy assets.`,
)
