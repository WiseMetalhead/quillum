import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { Manuscript } from './ManuscriptTypes'
import './ManuscriptStatusChip.css'

export function ManuscriptStatusChip({ status }: { status: Manuscript['status'] }) {
  const { t } = useTranslation()
  return <span className={`manuscriptStatusChip ${status}`}>{manuscriptStatusLabel(status, t)}</span>
}

function manuscriptStatusLabel(status: Manuscript['status'], t: TFunction) {
  if (status === 'complete') return t('manuscriptStatus.complete')
  if (status === 'in_progress') return t('manuscriptStatus.inProgress')
  return t('manuscriptStatus.new')
}
