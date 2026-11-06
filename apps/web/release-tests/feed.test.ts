import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)

async function source(path: string) {
  return readFile(fileURLToPath(new URL(path, root)), 'utf8')
}

test('Feed navigation is subscription-gated with independent categories and safe links', async () => {
  const [app, feed, feedStyles, news, contests, contestDetails, contestTracking, plannerCalendar, settings, sharedStyles, en, ru] = await Promise.all([
    source('App.tsx'),
    source('features/feed/FeedPage.tsx'),
    source('features/feed/FeedPage.css'),
    source('features/news/NewsPage.tsx'),
    source('features/feed/ContestFeed.tsx'),
    source('features/feed/ContestDetailsPanel.tsx'),
    source('features/feed/ContestTrackingDialog.tsx'),
    source('features/books/PlannerCalendar.tsx'),
    source('features/settings/FeedSourcesTab.tsx'),
    source('styles/shared.css'),
    source('i18n/locales/en.ts'),
    source('i18n/locales/ru.ts'),
  ])

  assert.ok(app.includes("path === '/feed' && currentUser?.feedEnabled"))
  assert.ok(app.includes("canonicalPath === '/feed' && !user.feedEnabled"))
  assert.ok(app.includes('user.feedEnabled && ('))
  assert.ok(!app.includes("path === '/news'"))
  assert.ok(feed.includes('user.newsEnabled'))
  assert.ok(feed.includes('user.contestsEnabled'))
  assert.ok(feed.includes('<MobileSectionSelector'))
  assert.ok(feed.includes("icon: 'cup-star-light'"))
  for (const page of [news, contests]) {
    assert.ok(page.includes('target="_blank"'))
    assert.ok(page.includes('rel="noopener noreferrer"'))
  }
  assert.ok(contests.includes("t(`contests.statuses.${item.status}`)"))
  assert.ok(contests.includes('item.discussionUrl &&'))
  assert.ok(contests.includes('item.terminalAction &&'))
  assert.ok(contests.includes('<ContestDetailsPanel'))
  assert.ok(contests.includes("t('contests.detailsAction')"))
  assert.ok(contests.includes('className="contestActionsRow"'))
  assert.ok(contestDetails.includes('/api/contests/${contest.id}/details/'))
  assert.ok(contestDetails.includes('<ResponsiveDetailsPanel'))
  assert.ok(contestDetails.includes('mobileFullViewTransition'))
  assert.ok(contestDetails.includes('details.conditionFacts.map'))
  assert.ok(contestDetails.includes('details.conditionsSections.map'))
  assert.ok(contestDetails.includes('details.recommendedManuscripts.map'))
  assert.ok(contestDetails.includes('/participation/${manuscriptId}/'))
  assert.ok(contestDetails.includes("method: participating ? 'DELETE' : 'PUT'"))
  assert.ok(contestDetails.includes('manuscript.trackingEnabled'))
  assert.ok(contestDetails.includes('name="settings-light"'))
  assert.ok(contestTracking.includes("method: 'PATCH'"))
  assert.ok(contestTracking.includes('trackDeadlines: enabled'))
  assert.ok(contestTracking.includes('<MobileSettingsSheet'))
  assert.ok(plannerCalendar.includes("phase.precision !== 'exact'"))
  assert.ok(plannerCalendar.includes('planner.contestDeadlines'))
  assert.ok(plannerCalendar.includes("t('planner.contestDeadlines')"))
  assert.ok(plannerCalendar.includes('rangeEventsForDate(ranges, day.date)'))
  assert.ok(plannerCalendar.includes('compareContestPhases(left.phase, right.phase)'))
  assert.ok(feedStyles.includes('.contestTrackingOption'))
  assert.ok(contestDetails.includes('<PrivateImage'))
  assert.ok(contestDetails.includes('<details key='))
  assert.ok(settings.includes('/api/news/sources/'))
  assert.ok(settings.includes('/api/contests/sources/'))
  assert.ok(settings.includes('enabledSourceKeys'))
  assert.ok(settings.includes('<MobileSettingsSheet'))
  assert.ok(settings.includes('accountMobileSettingRow'))
  assert.ok(feedStyles.includes('.contestDetailsMobile.mobileFullView'))
  assert.ok(feedStyles.includes('grid-auto-flow: column;'))
  assert.ok(feedStyles.includes('scroll-snap-type: x proximity;'))
  assert.ok(feedStyles.includes('padding: 18px 16px 14px;'))
  assert.ok(sharedStyles.includes('.srOnly {'))
  assert.ok(en.includes("summary: 'Main requirements'"))
  assert.ok(ru.includes("summary: 'Главные условия'"))
  assert.ok(en.includes("markParticipation: 'Mark participation'"))
  assert.ok(ru.includes("markParticipation: 'Отметить участие'"))
  assert.ok(en.includes("trackDeadlines: 'Add contest deadline tracking to the calendar'"))
  assert.ok(ru.includes("trackDeadlines: 'Добавить отслеживание сроков конкурса в календарь'"))
  for (const locale of [en, ru]) {
    assert.ok(locale.includes('feed: {'))
    assert.ok(locale.includes('contests: {'))
    assert.ok(locale.includes('feedSources: {'))
    assert.ok(locale.includes('author_today_contests:'))
  }
})
