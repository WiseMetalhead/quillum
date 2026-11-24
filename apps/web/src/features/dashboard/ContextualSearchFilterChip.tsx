import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'

type Props = {
  query: string
  onClear: () => void
  className?: string
}

export function ContextualSearchFilterChip({ query, onClear, className = '' }: Props) {
  const { t } = useTranslation()
  if (!query.trim()) return null

  return (
    <button
      type="button"
      className={`contextualSearchFilterChip spaceButton ${className}`.trim()}
      aria-label={t('dashboard.clearContextSearch')}
      onClick={onClear}
    >
      <span>{t('dashboard.contextSearchFilter', { query: query.trim() })}</span>
      <Icon name="close-light" />
    </button>
  )
}
