import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import type { DrawerItem, LibraryItem } from './ManuscriptTypes'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { LibraryAction } from '../shared/MobileLibraryActionSheet'

type Props = {
  onClose: () => void
  onOpen: (manuscriptId: string) => void
  onOpenSeries: (seriesId: string) => void
  onRestored: (item: LibraryItem) => void
  onError: (error: string) => void
  onMessage: (message: string) => void
}

export function ManuscriptDrawerDialog({
  onClose,
  onOpen,
  onOpenSeries,
  onRestored,
  onError,
  onMessage,
}: Props) {
  const { t, i18n } = useTranslation()
  const [items, setItems] = useState<DrawerItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionItem, setActionItem] = useState<DrawerItem | null>(null)
  const { backdropStateClass, close: closeDialog, finishAfterExit } = useMobileDialogTransition({ onClose })

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const payload = await apiRequest<{ items: DrawerItem[] }>('/api/manuscripts/drawer/')
        if (active) setItems(payload.items)
      } catch (error) {
        if (active) {
          onError(error instanceof Error ? error.message : i18n.t('manuscripts.drawerLoadFailed'))
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [i18n, onError])

  async function restore(item: DrawerItem) {
    if (busyId !== null) return
    setBusyId(item.id)
    try {
      const path = item.kind === 'series'
        ? `/api/manuscripts/drawer/series/${item.id}/`
        : `/api/manuscripts/drawer/manuscripts/${item.id}/`
      await apiRequest(path, { method: 'DELETE' })
      setItems((current) => current.filter((candidate) => (
        candidate.kind !== item.kind || candidate.id !== item.id
      )))
      onRestored(item)
      onMessage(t('manuscripts.restoredFromDrawer', { title: item.title }))
    } catch (error) {
      onError(error instanceof Error ? error.message : t('manuscripts.drawerRestoreFailed'))
    } finally {
      setBusyId(null)
    }
  }

  function actionsFor(item: DrawerItem): LibraryAction[] {
    return [
      {
        key: 'open',
        label: t('manuscripts.open'),
        icon: <Icon name="eye-light" />,
        disabled: busyId !== null,
        onSelect: () => finishAfterExit(() => (
          item.kind === 'series' ? onOpenSeries(item.id) : onOpen(item.id)
        )),
      },
      {
        key: 'restore',
        label: t('manuscripts.restoreFromDrawerAction'),
        icon: <Icon name="arrow-to-top-left-light" />,
        disabled: busyId !== null,
        onSelect: () => void restore(item),
      },
    ]
  }

  return (
    <>
      <ActionDialog
        variant="structured"
        title={t('manuscripts.drawer')}
        description={t('manuscripts.drawerLead')}
        closeLabel={t('manuscripts.close')}
        mobileBackLabel={t('common.back')}
        busy={busyId !== null}
        className="manuscriptDrawerDialog mobileFullView"
        backdropClassName={`mobileFullViewBackdrop ${backdropStateClass}`}
        onClose={closeDialog}
      >
        {loading ? (
          <TadpoleLoadingState className="drawerLoading" label={t('manuscripts.drawerLoading')} />
        ) : items.length ? (
          <div className="drawerItems">
            {items.map((item) => (
              <article className="drawerItem" key={`${item.kind}-${item.id}`}>
                <span className="drawerItemIcon" aria-hidden="true">
                  <Icon name={item.kind === 'series' ? 'library-light' : item.kind === 'book' ? 'books-light' : 'file-document-light'} />
                </span>
                <div className="drawerItemBody">
                  <strong>{item.title}</strong>
                  <span>
                    {drawerKindLabel(item, t)}
                    <span aria-hidden="true"> · </span>
                    {t('manuscripts.putInDrawerAt', {
                      date: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' })
                        .format(new Date(item.drawerAt)),
                    })}
                  </span>
                </div>
                <div className="drawerItemActions">
                  <button
                    type="button"
                    className="spaceButton"
                    aria-label={t('manuscripts.openFromDrawer', { title: item.title })}
                    title={t('manuscripts.open')}
                    disabled={busyId !== null}
                    onClick={() => finishAfterExit(() => item.kind === 'series' ? onOpenSeries(item.id) : onOpen(item.id))}
                  >
                    <Icon name="eye-light" />
                  </button>
                  <button
                    type="button"
                    className="spaceButton"
                    aria-busy={busyId === item.id}
                    aria-label={t('manuscripts.restoreFromDrawer', { title: item.title })}
                    title={t('manuscripts.restoreFromDrawerAction')}
                    disabled={busyId !== null}
                    onClick={() => void restore(item)}
                  >
                    <Icon name="arrow-to-top-left-light" />
                  </button>
                </div>
                <div className="drawerItemMenu manuscriptCardMenu">
                  <button
                    type="button"
                    className={`manuscriptCardMenuButton booksButton ${actionItem?.id === item.id && actionItem.kind === item.kind ? 'active' : ''}`}
                    aria-label={t('manuscripts.actionsFor', { title: item.title })}
                    aria-haspopup="menu"
                    aria-expanded={actionItem?.id === item.id && actionItem.kind === item.kind}
                    disabled={busyId !== null}
                    onClick={() => setActionItem((current) => (
                      current?.id === item.id && current.kind === item.kind ? null : item
                    ))}
                  >
                    <Icon name="menu-dots-light" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="drawerEmpty">
            <Icon name="bedside-table-3-light" />
            <strong>{t('manuscripts.drawerEmpty')}</strong>
            <p>{t('manuscripts.drawerEmptyLead')}</p>
          </div>
        )}
      </ActionDialog>
      {actionItem && (
        <MobileLibraryActionSheet
          open
          title={actionItem.title}
          actions={actionsFor(actionItem)}
          dismissOnSelect
          onClose={() => setActionItem(null)}
        />
      )}
    </>
  )
}

function drawerKindLabel(item: DrawerItem, t: TFunction) {
  if (item.kind === 'series') return t('manuscripts.series')
  return item.kind === 'book' ? t('manuscripts.book') : t('manuscripts.oneShot')
}
