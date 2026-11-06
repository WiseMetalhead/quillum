import { useTranslation } from 'react-i18next'

type PaginationButtonsProps = {
  page: number
  totalPages: number
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
}

export function PaginationButtons({
  page,
  totalPages,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: PaginationButtonsProps) {
  const { t } = useTranslation()
  return (
    <div className="pagination">
      <button type="button" className="secondary" disabled={!hasPrevious} onClick={onPrevious}>
        {t('admin.previous')}
      </button>
      <span>
        {t('admin.page', { page, total: totalPages || 1 })}
      </span>
      <button type="button" className="secondary" disabled={!hasNext} onClick={onNext}>
        {t('admin.next')}
      </button>
    </div>
  )
}
