type GroupableNotification = {
  id: string
  kind: string
  readAt: string | null
}

export type NotificationListEntry<T extends GroupableNotification> =
  | { type: 'item'; item: T }
  | { type: 'group'; items: T[] }

function canGroup(item: GroupableNotification) {
  return item.readAt === null && item.kind !== 'admin.announcement'
}

export function groupNotificationItems<T extends GroupableNotification>(
  items: T[],
): NotificationListEntry<T>[] {
  const entries: NotificationListEntry<T>[] = []
  let index = 0

  while (index < items.length) {
    const item = items[index]
    if (!canGroup(item)) {
      entries.push({ type: 'item', item })
      index += 1
      continue
    }

    const run = [item]
    let nextIndex = index + 1
    while (
      nextIndex < items.length
      && canGroup(items[nextIndex])
      && items[nextIndex].kind === item.kind
    ) {
      run.push(items[nextIndex])
      nextIndex += 1
    }

    entries.push(
      run.length > 1
        ? { type: 'group', items: run }
        : { type: 'item', item },
    )
    index = nextIndex
  }

  return entries
}
