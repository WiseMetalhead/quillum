import { useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { apiQuery, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import type { Manuscript, Series } from './ManuscriptTypes'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'

type Props = {
  book: Manuscript
  onClose: () => void
  onAdded: (book: Manuscript, series: Series) => void
  onError: (error: string) => void
}

export function AddToSeriesDialog({ book, onClose, onAdded, onError }: Props) {
  const { t, i18n } = useTranslation()
  const [seriesItems, setSeriesItems] = useState<Series[]>([])
  const [seriesId, setSeriesId] = useState('')
  const [position, setPosition] = useState<number | ''>('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const selectRef = useRef<HTMLButtonElement>(null)
  const onAddedRef = useRef(onAdded)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    onAddedRef.current = onAdded
  }, [onAdded])

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const applyItems = (items: Series[]) => {
          const sorted = [...items].sort((left, right) =>
            left.title.localeCompare(right.title, i18n.resolvedLanguage ?? 'en'))
          setSeriesItems(sorted)
          setSeriesId((current) => (
            current && sorted.some((item) => item.id === current)
              ? current
              : sorted[0] ? String(sorted[0].id) : ''
          ))
        }
        const payload = await apiQuery<{ items: Series[] }>('/api/manuscripts/series/', {
          onBackgroundUpdate: (next) => {
            if (active) applyItems(next.items)
          },
        })
        if (active) {
          applyItems(payload.items)
        }
      } catch (err) {
        if (active) {
          onError(err instanceof Error ? err.message : i18n.t('series.addLoadFailed'))
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [i18n, i18n.resolvedLanguage, onError])

  useEffect(() => {
    if (!loading) selectRef.current?.focus()
  }, [loading])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog, submitting])

  const selectedSeries = useMemo(
    () => seriesItems.find((item) => item.id === seriesId),
    [seriesId, seriesItems],
  )

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || !selectedSeries) return
    setSubmitting(true)
    onError('')
    try {
      const payload = await apiRequest<{ book: Manuscript; series: Series }>(
        `/api/manuscripts/books/${book.id}/series-membership/`,
        {
          method: 'PUT',
          body: JSON.stringify({
            seriesId: selectedSeries.id,
            seriesPosition: position === '' ? null : position,
          }),
        },
      )
      finishAfterExit(() => onAddedRef.current(payload.book, payload.series))
    } catch (err) {
      onError(err instanceof Error ? err.message : t('series.addFailed'))
      setSubmitting(false)
    }
  }

  return (
    <div className={`dialogBackdrop mobileBottomSheetBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) closeDialog()
    }}>
      <div className="createOneShotDialog dialogScrollLayout mobileBottomSheet" role="dialog" aria-modal="true" aria-labelledby="add-to-series-title" ref={setDialogRef}>
        <header>
          <div>
            <h2 id="add-to-series-title">{t('series.addTitle')}</h2>
            <p>{t('series.addLead')}</p>
          </div>
          <button type="button" className="dialogClose booksButton" aria-label={t('manuscripts.close')} onClick={closeDialog} disabled={submitting || closing}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="dialogScrollBody">
          {loading ? (
            <TadpoleLoadingState className="dialogLoadingState" label={t('series.loading')} />
          ) : seriesItems.length ? (
            <>
              <label className="dialogField">
                <span>{t('manuscripts.series')} <strong aria-hidden="true">*</strong></span>
                <CustomSelect ref={selectRef} required value={seriesId} onChange={(event) => setSeriesId(event.target.value)}>
                  {seriesItems.map((item) => (
                    <option key={item.id} value={item.id}>{item.title}</option>
                  ))}
                </CustomSelect>
              </label>
              <label className="dialogField">
                <span>{t('manuscripts.orderInSeries')} <em>{t('manuscripts.optional')}</em></span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={position}
                  placeholder={t('manuscripts.noOrder')}
                  onChange={(event) => setPosition(
                    event.target.value === '' ? '' : Number(event.target.value),
                  )}
                />
                <small>{t('series.orderHint')}</small>
              </label>
            </>
          ) : (
            <p className="dialogEmptyMessage">{t('series.createFirst')}</p>
          )}
          </div>
          <footer>
            <button type="button" className="dialogCancel booksButton" onClick={closeDialog} disabled={submitting || closing}>{t('common.cancel')}</button>
            <button type="submit" className="dialogSubmit booksButton" disabled={submitting || !selectedSeries}>
              {submitting ? t('series.adding') : t('series.addTitle')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
