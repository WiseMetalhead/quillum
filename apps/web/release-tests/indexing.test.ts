import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('application shell and public gateway responses opt out of search indexing', async () => {
  const [index, nginx] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../../deploy/nginx.conf', import.meta.url), 'utf8'),
  ])

  assert.match(index, /<meta name="robots" content="noindex, nofollow"\s*\/?>/)
  assert.match(nginx, /add_header X-Robots-Tag "noindex, nofollow" always;/)
})

test('robots file lets crawlers read the noindex response policy', async () => {
  const robots = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8')

  assert.match(robots, /^User-agent: \*$/m)
  assert.match(robots, /^Allow: \/$/m)
  assert.doesNotMatch(robots, /^Disallow:/m)
})
