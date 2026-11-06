import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { API_BASE, apiQuery } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { StorageGroupKey, StorageItem, StoragePayload } from '../../types'
import { MobileLibraryActionSheet } from './MobileLibraryActionSheet'
import { PrivateImage } from './PrivateImage'
import { useMobileDialogTransition } from './useMobileDialogTransition'
import './StorageImagePickerDialog.css'

const groups: Array<Extract<StorageGroupKey, 'all' | 'covers' | 'illustrations' | 'ideas' | 'notes' | 'glossary'>> = ['all', 'covers', 'illustrations', 'ideas', 'notes', 'glossary']
const groupIcons: Record<(typeof groups)[number], IconName> = {
  all: 'box-light',
  covers: 'books-light',
  illustrations: 'gallery-light',
  ideas: 'lightbulb-light',
  notes: 'notes-light',
  glossary: 'notebook-light',
}

type Props = {
  open: boolean
  onClose: () => void
  onSelect: (item: StorageItem) => void
  onUpload?: () => void
}

export function StorageImagePickerDialog({ open, onClose, onSelect, onUpload }: Props) {
  if (!open) return null

  return <StorageImagePickerView onClose={onClose} onSelect={onSelect} onUpload={onUpload} />
}

function StorageImagePickerView({ onClose, onSelect, onUpload }: Omit<Props, 'open'>) {
  const { t } = useTranslation()
  const [group, setGroup] = useState<(typeof groups)[number]>('all')
  const [items, setItems] = useState<StorageItem[]>([])
  const [selected, setSelected] = useState<StorageItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const { backdropStateClass, close: closeDialog, closing, setDialogRef, finishAfterExit } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      if (!active) return
      setLoading(true)
      void apiQuery<StoragePayload>(
        `/api/auth/storage/?${new URLSearchParams({ group, page: '1', pageSize: '48' })}`,
        {
          onBackgroundUpdate: (payload) => {
            if (!active) return
            const available = payload.items.filter((item) => item.id.startsWith('media:'))
            setItems(available)
            setSelected((current) => (
              available.find((item) => item.id === current?.id) ?? available[0] ?? null
            ))
          },
        },
      )
        .then((payload) => {
          if (!active) return
          const available = payload.items.filter((item) => item.id.startsWith('media:'))
          setItems(available)
          setSelected(available[0] ?? null)
        })
        .catch(() => {
          if (active) {
            setItems([])
            setSelected(null)
          }
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [group])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || filterOpen) return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeDialog()
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [closeDialog, filterOpen])

  return createPortal(
    <div className={`storagePickerBackdrop mobileFullViewBackdrop ${backdropStateClass}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeDialog()
    }}>
      <section className="storagePickerDialog mobileFullView" role="dialog" aria-modal="true" aria-labelledby="storage-picker-title" ref={setDialogRef}>
        <header>
          <button type="button" className="mobileDialogBack spaceButton" aria-label={t('common.back')} onClick={closeDialog} disabled={closing}>
            <Icon name="arrow-left-1" />
          </button>
          <div className="mobileDialogHeaderCopy">
            <h2 id="storage-picker-title">{t('mediaPicker.title')}</h2>
            <p>{t('mediaPicker.lead')}</p>
          </div>
          <button type="button" className="storagePickerClose spaceButton" aria-label={t('common.close')} onClick={closeDialog} disabled={closing}>
            <Icon name="close-square-light" />
          </button>
        </header>
        <div className="storagePickerGroups" role="tablist" aria-label={t('storage.groups')}>
          {groups.map((item) => (
            <button key={item} type="button" className={`storagePickerGroup spaceButton ${group === item ? 'active' : ''}`} role="tab" aria-selected={group === item} onClick={() => { setLoading(true); setGroup(item) }}>
              {t(`storage.groupsMap.${item}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="storagePickerMobileFilterRow spaceButton"
          aria-haspopup="dialog"
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen(true)}
        >
          <span className="storagePickerMobileFilterIcon"><Icon name="filter-linear" /></span>
          <span className="storagePickerMobileFilterCopy">
            <strong>{t('storage.groups')}</strong>
            <small>{t(`storage.groupsMap.${group}`)}</small>
          </span>
          <Icon name="arrow-right-2" />
        </button>
        <div className="storagePickerGrid" aria-busy={loading}>
          {!loading && items.length === 0 && <span className="storagePickerEmpty">{t('mediaPicker.empty')}</span>}
          {items.map((item) => (
            <button key={item.id} type="button" className={`storagePickerTile spaceButton ${selected?.id === item.id ? 'active' : ''}`} onClick={() => setSelected(item)} aria-label={item.title || t(`storage.mediaTypes.${item.mediaType}`, { defaultValue: item.mediaType })}>
              <PrivateImage src={`${API_BASE}${item.previewUrl}`} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
          {loading && <div className="storagePickerLoading" role="status" aria-label={t('mediaPicker.loading')}><TadpoleIcon /></div>}
        </div>
        <footer>
          <button type="button" className="storagePickerSecondaryAction storagePickerCancel spaceButton" onClick={closeDialog} disabled={closing}>{t('common.cancel')}</button>
          {onUpload && <button type="button" className="storagePickerSecondaryAction spaceButton" onClick={onUpload}>{t('mediaPicker.upload')}</button>}
          <button type="button" className="storagePickerPrimaryAction spaceButton" disabled={!selected || closing} onClick={() => selected && finishAfterExit(() => onSelect(selected))}><Icon name="check-circle-1-light" /> {t('mediaPicker.select')}</button>
        </footer>
      </section>
      <MobileLibraryActionSheet
        open={filterOpen}
        title={t('storage.groups')}
        actions={groups.map((item) => ({
          key: item,
          label: t(`storage.groupsMap.${item}`),
          icon: <Icon name={groupIcons[item]} />,
          selected: group === item,
          onSelect: () => {
            if (group === item) return
            setLoading(true)
            setGroup(item)
          },
        }))}
        dismissOnSelect
        backdropClassName="storagePickerFilterBackdrop"
        onClose={() => setFilterOpen(false)}
      />
    </div>,
    document.body,
  )
}
