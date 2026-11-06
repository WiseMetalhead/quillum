import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { en } from '../src/i18n/locales/en.ts'
import { ru } from '../src/i18n/locales/ru.ts'

test('public review uses the established phone shell without exposing editor capabilities', async () => {
  const sourceRoot = new URL('../src/', import.meta.url)
  const [page, styles, handoff] = await Promise.all([
    readFile(new URL('features/books/PublicReviewPage.tsx', sourceRoot), 'utf8'),
    readFile(new URL('features/books/PublicReviewPage.css', sourceRoot), 'utf8'),
    readFile(new URL('../../../docs/development/public-review-share.md', import.meta.url), 'utf8'),
  ])

  assert.match(page, /useMobileViewport\(\)/)
  assert.match(page, /publicReviewMobileDocumentHeader/)
  assert.match(page, /MobileLibraryActionSheet/)
  assert.match(page, /publicReview\.accountMenu/)
  assert.match(page, /publicReviewMobileTitleButton/)
  assert.match(page, /PublicReviewMobileInfoPopup/)
  assert.match(page, /event\.target === event\.currentTarget/)
  assert.doesNotMatch(page, /publicReviewMobileContext/)
  assert.match(page, /publicReviewMobileCommentButton/)
  assert.match(page, /PublicReviewMobileCommentSheet/)
  assert.match(page, /publicReviewMobileCommentsView mobileFullView/)
  assert.match(page, /publicReviewMobileCommentDetailView mobileFullView/)
  assert.match(page, /filter === 'open'/)
  assert.match(page, /filter === 'resolved'/)
  assert.match(page, /publicReview\.showInText/)
  assert.match(page, /MobileSettingsSheet title=\{t\('comments\.reply'\)\}/)
  assert.match(page, /MobileSettingsSheet title=\{t\('comments\.deleteTitle'\)\}/)
  assert.doesNotMatch(page, /publicReviewMobileToolbar/)

  assert.match(page, /`\/api\/manuscripts\/review\/\$\{token\}\/documents\/\$\{draft\.documentId\}\/annotations\/`/)
  assert.match(page, /`\/api\/manuscripts\/review\/\$\{token\}\/annotations\/\$\{annotation\.id\}\/replies\/`/)
  assert.match(page, /canDelete/)
  assert.match(page, /removeAnnotation\(annotation\.id\)/)
  assert.match(page, /transaction\.removeMark\(position, position \+ node\.nodeSize, mark\)/)
  assert.doesNotMatch(page, /canResolve\s*&&/)
  assert.doesNotMatch(page, /\/api\/manuscripts\/annotations\//)

  assert.match(styles, /@media \(max-width: 520px\)/)
  assert.match(styles, /\.publicReviewMobileDocumentHeader \{[\s\S]{0,260}grid-template-columns: 48px minmax\(0, 1fr\) 48px/)
  assert.match(styles, /button\.publicReviewMobileTitleButton[\s\S]{0,520}text-overflow: ellipsis/)
  assert.match(styles, /\.publicReviewMobileInfoBackdrop \{[\s\S]{0,220}inset: var\(--app-header-height\) 0 0;[\s\S]{0,120}place-items: start center;/)
  assert.match(styles, /\.publicReviewMobileInfoBackdrop\.open[\s\S]{0,500}\.publicReviewMobileInfoPopup/)
  assert.match(styles, /\.publicReviewMobileInfoPopup h2 \{[\s\S]{0,180}overflow-wrap: anywhere/)
  assert.match(styles, /\.reviewTextSurface \{[\s\S]{0,260}overflow-x: hidden;[\s\S]{0,220}padding: 0 16px/)
  assert.match(styles, /\.publicReviewEditor \{[\s\S]{0,220}overflow-wrap: anywhere;/)
  assert.match(styles, /figure\.editorIllustration[\s\S]{0,160}max-width: 100%/)
  assert.match(styles, /\.reviewDocumentHeader,[\s\S]{0,80}\.reviewCommentsPanel \{[\s\S]{0,80}display: none;/)
  assert.match(styles, /\.publicReviewMobileCommentsBottomBar/)
  assert.match(styles, /\.publicReviewMobileCommentDetailBottomBar/)

  assert.match(handoff, /standard phone breakpoint \(`<=520px`\)/)
  assert.match(handoff, /public review routes and public guest permissions/)
  assert.match(handoff, /Tablet and desktop presentation remains unchanged/)
})

test('public review phone copy has English and Russian parity', () => {
  assert.deepEqual(Object.keys(en.publicReview), Object.keys(ru.publicReview))
  for (const key of ['accountMenu', 'accountActions', 'reviewDetails', 'showInText'] as const) {
    assert.equal(typeof en.publicReview[key], 'string')
    assert.equal(typeof ru.publicReview[key], 'string')
  }
})
