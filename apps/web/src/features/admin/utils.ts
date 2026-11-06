import type { TFunction } from 'i18next'
import type { AdminUserRow } from '../../types'

export function userRoleLabels(user: AdminUserRow, t: TFunction): string[] {
  const labels: string[] = []
  if (user.isSuperuser) labels.push(t('admin.superuser'))
  if (user.authorWorkspaceEnabled) labels.push(t('admin.user'))
  if (user.editorWorkspaceEnabled) labels.push(t('admin.editor'))
  return labels
}

export function formatBytes(value: number, locale: string): string {
  if (value <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** exponent
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: amount >= 10 || exponent === 0 ? 0 : 1,
  }).format(amount)} ${units[exponent]}`
}
