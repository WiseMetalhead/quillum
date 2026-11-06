import assert from 'node:assert/strict'
import test from 'node:test'

import { groupNotificationItems } from '../src/features/notifications/notificationGroups.ts'

type Item = {
  id: string
  kind: string
  readAt: string | null
}

function item(id: string, kind: string, readAt: string | null = null): Item {
  return { id, kind, readAt }
}

function shape(items: Item[]) {
  return groupNotificationItems(items).map((entry) => (
    entry.type === 'group'
      ? `group:${entry.items.map((entryItem) => entryItem.id).join(',')}`
      : `item:${entry.item.id}`
  ))
}

test('groups only consecutive unread notifications of the same kind', () => {
  assert.deepEqual(
    shape([
      item('a1', 'service.export_expiring'),
      item('a2', 'service.export_expiring'),
      item('b1', 'service.new_login'),
      item('a3', 'service.export_expiring'),
      item('a4', 'service.export_expiring'),
    ]),
    ['group:a1,a2', 'item:b1', 'group:a3,a4'],
  )
})

test('read notifications stay single and break unread groups', () => {
  assert.deepEqual(
    shape([
      item('a1', 'service.export_expiring'),
      item('a2', 'service.export_expiring', '2026-07-17T10:00:00Z'),
      item('a3', 'service.export_expiring'),
    ]),
    ['item:a1', 'item:a2', 'item:a3'],
  )
})

test('administrator announcements are never grouped', () => {
  assert.deepEqual(
    shape([
      item('admin1', 'admin.announcement'),
      item('admin2', 'admin.announcement'),
    ]),
    ['item:admin1', 'item:admin2'],
  )
})

test('a newly loaded adjacent item extends the existing unread group', () => {
  const loaded = [
    item('a1', 'service.export_expiring'),
    item('a2', 'service.export_expiring'),
  ]
  assert.deepEqual(shape(loaded), ['group:a1,a2'])
  assert.deepEqual(
    shape([...loaded, item('a3', 'service.export_expiring')]),
    ['group:a1,a2,a3'],
  )
})
