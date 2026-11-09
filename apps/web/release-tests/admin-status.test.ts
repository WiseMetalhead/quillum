import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const webSourceRoot = new URL('../src/', import.meta.url)
const apiRoot = new URL('../../api/', import.meta.url)

async function read(root: URL, path: string) {
  return readFile(fileURLToPath(new URL(path, root)), 'utf8')
}

function taskNames(source: string) {
  return Array.from(
    source.matchAll(/@(?:shared_task|app\.task)[^\n]*\ndef\s+(\w+)\s*\(/g),
    (match) => match[1],
  )
}

function taskNameCatalog(source: string) {
  const start = source.indexOf('taskNames: {')
  const end = source.indexOf('\n    },', start)
  assert.notEqual(start, -1, 'taskNames catalog is missing')
  assert.notEqual(end, -1, 'taskNames catalog is not closed')
  return source.slice(start, end)
}

test('every declared Celery task has English and Russian admin labels', async () => {
  const [celery, manuscriptTasks, notificationTasks, auditTasks, en, ru] = await Promise.all([
    read(apiRoot, 'config/celery.py'),
    read(apiRoot, 'apps/manuscripts/tasks.py'),
    read(apiRoot, 'apps/notifications/tasks.py'),
    read(apiRoot, 'apps/audit/tasks.py'),
    read(webSourceRoot, 'i18n/locales/en.ts'),
    read(webSourceRoot, 'i18n/locales/ru.ts'),
  ])
  const declaredTasks = [celery, manuscriptTasks, notificationTasks, auditTasks].flatMap(taskNames)
  assert.ok(declaredTasks.length > 0, 'Celery task discovery returned no tasks')
  assert.ok(declaredTasks.includes('scan_due_user_notification_rules'))

  for (const locale of [taskNameCatalog(en), taskNameCatalog(ru)]) {
    for (const taskName of declaredTasks) {
      assert.ok(locale.includes(`${taskName}:`), `${taskName} is missing from an admin locale`)
    }
  }
})

test('frequent status refresh does not render a redundant last-updated indicator', async () => {
  const [statusTab, en, ru] = await Promise.all([
    read(webSourceRoot, 'features/admin/StatusTab.tsx'),
    read(webSourceRoot, 'i18n/locales/en.ts'),
    read(webSourceRoot, 'i18n/locales/ru.ts'),
  ])

  assert.ok(statusTab.includes('STATUS_REFRESH_INTERVAL_MS = 30_000'))
  assert.ok(!statusTab.includes('statusUpdated'))
  assert.ok(!en.includes('statusUpdated:'))
  assert.ok(!ru.includes('statusUpdated:'))
})

test('admin status owns compact phone cards and mobile detail sheets', async () => {
  const [statusTab, statusCard, adminCss] = await Promise.all([
    read(webSourceRoot, 'features/admin/StatusTab.tsx'),
    read(webSourceRoot, 'features/admin/StatusCard.tsx'),
    read(webSourceRoot, 'features/admin/AdminPage.css'),
  ])

  assert.ok(statusTab.includes('useMobileViewport()'))
  assert.ok(statusTab.includes('!isMobile && ('))
  assert.equal(statusTab.match(/<MobileStatusCard/g)?.length, 5)
  assert.equal(statusTab.match(/<MobileVersionCard/g)?.length, 1)
  assert.ok(statusTab.includes("mobileSheet === 'tasks'"))
  assert.ok(statusTab.includes("mobileSheet === 'audit'"))
  assert.ok(statusTab.includes('<MobileSettingsSheet'))
  assert.ok(adminCss.includes('.adminStatusServiceGrid.mobile'))
  assert.ok(adminCss.includes('.adminMobileVersionCard'))
  assert.ok(adminCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'))
  assert.ok(adminCss.includes('.adminStatusMobileMenuRow'))
  assert.ok(adminCss.includes('.adminStatusMobileSheetContent'))
  assert.ok(adminCss.includes('min-height: 52px'))
  assert.ok(adminCss.includes('.adminStatusDetailsList > div:first-child'))
  assert.ok(adminCss.includes('.adminStatusSheetPanel .adminLastTaskHeading'))
  assert.ok(adminCss.includes('-webkit-line-clamp: 2'))
  assert.ok(statusTab.includes('<strong title={taskLabel}>{taskLabel}</strong>'))
  assert.ok(statusCard.includes('aria-haspopup="dialog"'))
  assert.ok(statusCard.includes('<strong title={metricValue}>{metricValue}</strong>'))
})

test('desktop admin status uses a title card, scrollable service row, and detail dialog', async () => {
  const [statusTab, desktopStatus, adminCss, en, ru] = await Promise.all([
    read(webSourceRoot, 'features/admin/StatusTab.tsx'),
    read(webSourceRoot, 'features/admin/DesktopStatusOverview.tsx'),
    read(webSourceRoot, 'features/admin/AdminPage.css'),
    read(webSourceRoot, 'i18n/locales/en.ts'),
    read(webSourceRoot, 'i18n/locales/ru.ts'),
  ])

  assert.ok(statusTab.includes('<DesktopStatusOverview'))
  assert.ok(desktopStatus.includes('className={`adminApplicationCard ${appService.tone} spaceButton`}'))
  assert.ok(desktopStatus.includes('className="adminServiceCarousel"'))
  assert.ok(desktopStatus.includes('<ResponsiveDetailsPanel'))
  assert.ok(desktopStatus.includes('desktopClassName="adminStatusDetailsDialog"'))
  assert.ok(desktopStatus.includes("metricLabel: t('admin.version')"))
  assert.ok(desktopStatus.includes("metricLabel: t('admin.memory')"))
  assert.ok(desktopStatus.includes("metricLabel: t('admin.workers')"))
  assert.ok(desktopStatus.includes("metricLabel: t('admin.connections')"))
  assert.ok(desktopStatus.includes("metricLabel: t('admin.mediaUsage')"))
  assert.ok(adminCss.includes('.adminApplicationCard'))
  assert.ok(adminCss.includes('.adminServiceCarouselControl.forward'))
  assert.ok(adminCss.includes('scroll-snap-type: inline mandatory'))
  assert.ok(adminCss.includes('.adminStatusDialogDetails'))
  for (const locale of [en, ru]) {
    assert.ok(locale.includes('openServiceDetails:'))
    assert.ok(locale.includes('closeServiceDetails:'))
    assert.ok(locale.includes('previousServices:'))
    assert.ok(locale.includes('nextServices:'))
    assert.ok(locale.includes('collaborationModes:'))
  }
})

test('non-phone admin sections keep breathing room below the application header', async () => {
  const adminCss = await read(webSourceRoot, 'features/admin/AdminPage.css')
  const desktopAdminBody = adminCss.match(/@media \(min-width: 521px\)[\s\S]*?\.adminPage > \.adminBody \{([\s\S]*?)\}/)

  assert.ok(desktopAdminBody, 'non-phone admin body rule is missing')
  assert.match(desktopAdminBody[1], /padding-top: 12px/)
})

test('super administrator maintenance owns independent feed refresh actions and responsive rows', async () => {
  const [adminPage, maintenanceTab, adminCss, sourceTasks, en, ru] = await Promise.all([
    read(webSourceRoot, 'features/admin/AdminPage.tsx'),
    read(webSourceRoot, 'features/admin/MaintenanceTab.tsx'),
    read(webSourceRoot, 'features/admin/AdminPage.css'),
    read(apiRoot, 'apps/sources/tasks.py'),
    read(webSourceRoot, 'i18n/locales/en.ts'),
    read(webSourceRoot, 'i18n/locales/ru.ts'),
  ])

  assert.ok(adminPage.includes("view: 'maintenance'"))
  assert.ok(adminPage.includes("icon: 'sledgehammer-light'"))
  assert.ok(adminPage.includes("if (!user.isSuperuser)"))
  assert.ok(adminPage.includes("adminView === 'maintenance' && ("))
  assert.ok(maintenanceTab.includes("'/api/admin/maintenance/'"))
  assert.ok(maintenanceTab.includes('POLL_INTERVAL_MS = 1_500'))
  assert.ok(maintenanceTab.includes("{ id: 'news'"))
  assert.ok(maintenanceTab.includes("{ id: 'contests'"))
  assert.ok(sourceTasks.includes('def admin_refresh_news_sources'))
  assert.ok(sourceTasks.includes('def admin_refresh_contest_sources'))
  assert.ok(sourceTasks.includes('services.sync_contest_detail(contest_id)'))
  assert.ok(adminCss.includes('.adminMaintenanceRow'))
  assert.ok(adminCss.includes('.adminMaintenanceAction'))
  assert.ok(en.includes("maintenance: 'Maintenance'"))
  assert.ok(ru.includes("maintenance: 'Обслуживание'"))
  assert.ok(en.includes('admin_refresh_contest_sources:'))
  assert.ok(ru.includes('admin_refresh_contest_sources:'))
})
