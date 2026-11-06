import { useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import { useTranslation } from 'react-i18next'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { API_BASE, apiQuery } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { UserTierPayload } from '../../types'
import { PrivateImage } from '../shared/PrivateImage'
import { CreateBookDialog } from './CreateBookDialog'
import { DeleteManuscriptDialog } from './DeleteManuscriptDialog'
import { EditManuscriptDialog } from './EditManuscriptDialog'
import type { Manuscript, Series, SeriesBook } from './ManuscriptTypes'
import { ManuscriptExportDialog } from './ManuscriptExportDialog'
import { ManuscriptDrawerDialog } from './ManuscriptDrawerDialog'
import { ManuscriptEditorAccessDialog } from './ManuscriptEditorAccessDialog'
import { ManuscriptLibrarySidebar } from './ManuscriptLibrarySidebar'
import type {
  ManuscriptLibraryCounts,
  ManuscriptLibrarySection,
} from './manuscriptLibraryNavigation'
import { ManuscriptStatusChip } from './ManuscriptStatusChip'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { LibraryAction } from '../shared/MobileLibraryActionSheet'
import { MobileLibraryQueryControls } from './MobileLibraryQueryControls'
import { RemoveFromSeriesDialog } from './RemoveFromSeriesDialog'
import './ManuscriptsPage.css'

type Props = {
  seriesId: string
  onBack: () => void
  onSelectSection: (section: ManuscriptLibrarySection) => void
  onOpenBook: (manuscriptId: string) => void
  onOpenSeries: (seriesId: string) => void
  onMessage: (message: string) => void
  onError: (error: string) => void
}

type SeriesSortOrder = 'order' | 'updated' | 'created' | 'title'

export function SeriesPage({
  seriesId,
  onBack,
  onSelectSection,
  onOpenBook,
  onOpenSeries,
  onMessage,
  onError,
}: Props) {
  const { t, i18n } = useTranslation()
  const [series, setSeries] = useState<Series | null>(null)
  const [books, setBooks] = useState<SeriesBook[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortOrder, setSortOrder] = useState<SeriesSortOrder>('order')
  const [coverUploadLimitBytes, setCoverUploadLimitBytes] = useState<number | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editing, setEditing] = useState<SeriesBook | null>(null)
  const [deleting, setDeleting] = useState<SeriesBook | null>(null)
  const [removing, setRemoving] = useState<SeriesBook | null>(null)
  const [exporting, setExporting] = useState<SeriesBook | null>(null)
  const [editorAccess, setEditorAccess] = useState<SeriesBook | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [libraryCounts, setLibraryCounts] = useState<ManuscriptLibraryCounts | null>(null)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      try {
        const [payload, tier, library] = await Promise.all([
          apiQuery<{ series: Series; books: SeriesBook[] }>(
            `/api/manuscripts/series/${seriesId}/`,
            {
              onBackgroundUpdate: (next) => {
                if (active) {
                  setSeries(next.series)
                  setBooks(next.books)
                }
              },
            },
          ),
          apiQuery<{ tier: UserTierPayload }>('/api/auth/tier/', {
            onBackgroundUpdate: (next) => {
              if (active) {
                setCoverUploadLimitBytes(
                  next.tier.quotas.find(
                    (quota) => quota.key === 'image_upload_bytes',
                  )?.limit ?? null,
                )
              }
            },
          }).catch(() => null),
          Promise.all([
            apiQuery<{ items: Manuscript[] }>('/api/manuscripts/oneshots/'),
            apiQuery<{ items: Manuscript[] }>('/api/manuscripts/books/'),
            apiQuery<{ items: Series[] }>('/api/manuscripts/series/'),
          ]).catch(() => null),
        ])
        if (active) {
          setSeries(payload.series)
          setBooks(payload.books)
          setCoverUploadLimitBytes(
            tier?.tier.quotas.find((quota) => quota.key === 'image_upload_bytes')?.limit ?? null,
          )
          if (library) {
            const [oneShots, standaloneBooks, allSeries] = library
            setLibraryCounts({
              all: oneShots.items.length + standaloneBooks.items.length + allSeries.items.length,
              oneshot: oneShots.items.length,
              book: standaloneBooks.items.length,
              series: allSeries.items.length,
            })
          }
        }
      } catch (err) {
        if (active) {
          onError(err instanceof Error ? err.message : i18n.t('series.loadFailed'))
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [i18n, onError, seriesId])

  const visibleBooks = useMemo(() => {
    const locale = i18n.resolvedLanguage ?? 'en'
    const query = search.trim().toLocaleLowerCase(locale)
    const filtered = query
      ? books.filter((book) =>
          `${book.title}\n${book.synopsis}`.toLocaleLowerCase(locale).includes(query),
        )
      : [...books]
    return filtered.sort((left, right) => {
      const leftNumbered = left.seriesPosition !== null
      const rightNumbered = right.seriesPosition !== null
      if (leftNumbered !== rightNumbered) return leftNumbered ? -1 : 1
      if (sortOrder === 'order') {
        if (left.seriesPosition !== null && right.seriesPosition !== null) {
          return left.seriesPosition - right.seriesPosition
        }
        return left.title.localeCompare(right.title, locale)
      }
      if (sortOrder === 'title') return left.title.localeCompare(right.title, locale)
      const leftDate = Date.parse(sortOrder === 'created' ? left.createdAt : left.updatedAt)
      const rightDate = Date.parse(sortOrder === 'created' ? right.createdAt : right.updatedAt)
      return rightDate - leftDate
    })
  }, [books, i18n.resolvedLanguage, search, sortOrder])

  const numberedBooks = visibleBooks.filter((book) => book.seriesPosition !== null)
  const unnumberedBooks = visibleBooks.filter((book) => book.seriesPosition === null)
  const nextPosition = useMemo(
    () => Math.max(
      0,
      ...books.flatMap((book) => (
        book.seriesPosition === null ? [] : [book.seriesPosition]
      )),
    ) + 1,
    [books],
  )

  function handleCreated(manuscript: Manuscript) {
    const book = manuscript as SeriesBook
    setBooks((current) => [...current, book])
    setSeries((current) => current ? { ...current, bookCount: current.bookCount + 1 } : current)
    setCreateDialogOpen(false)
    onMessage(t('series.bookCreated'))
  }

  function handleSaved(manuscript: Manuscript) {
    const book = manuscript as SeriesBook
    setBooks((current) => current.map((item) => item.id === book.id ? book : item))
    setEditing(null)
    onMessage(t('manuscripts.bookUpdated'))
  }

  function handleDeleted(manuscript: Manuscript) {
    setBooks((current) => current.filter((item) => item.id !== manuscript.id))
    setSeries((current) => current ? {
      ...current,
      bookCount: Math.max(0, current.bookCount - 1),
    } : current)
    setDeleting(null)
    onMessage(t('manuscripts.bookDeleted'))
  }

  function handleRemoved(manuscript: Manuscript) {
    setBooks((current) => current.filter((item) => item.id !== manuscript.id))
    setSeries((current) => current ? {
      ...current,
      bookCount: Math.max(0, current.bookCount - 1),
    } : current)
    setRemoving(null)
    onMessage(t('series.bookRemoved'))
  }

  return (
    <div className="manuscriptsPage seriesPage">
      <ManuscriptLibrarySidebar
        activeSection="series"
        counts={libraryCounts}
        onSelectSection={onSelectSection}
        onOpenDrawer={() => setDrawerOpen(true)}
      />
      <main className="manuscriptPanel manuscriptLibraryMain" aria-labelledby="series-heading">
        <div className="manuscriptToolbar seriesToolbar">
          <div className="seriesToolbarIdentity">
            <button type="button" className="seriesBackButton booksButton" onClick={onBack}>
              <Icon name="arrow-left-1" />
              {t('series.back')}
            </button>
            <h1 id="series-heading">{series?.title ?? t('manuscripts.series')}</h1>
          </div>

          <div className="manuscriptControls">
            <label className="manuscriptSearch">
              <span className="srOnly">{t('series.search')}</span>
              <SearchIcon />
              <input
                type="search"
                placeholder={t('series.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="manuscriptSort">
              <span className="srOnly">{t('series.sort')}</span>
              <CustomSelect
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value as SeriesSortOrder)}
              >
                <option value="order">{t('series.inOrder')}</option>
                <option value="updated">{t('manuscripts.recentlyUpdated')}</option>
                <option value="created">{t('manuscripts.recentlyCreated')}</option>
                <option value="title">{t('manuscripts.titleAscending')}</option>
              </CustomSelect>
            </label>
            <button
              type="button"
              className="newManuscriptButton seriesNewBookButton booksButton"
              onClick={() => setCreateDialogOpen(true)}
            >
              <Icon name="books-light" />
              {t('series.newBook')}
            </button>
          </div>
        </div>

        <div className={`seriesBookList ${visibleBooks.length ? 'hasItems' : ''}`}>
          {loading ? (
            <TadpoleLoadingState className="booksLoading" label={t('series.loadingBooks')} />
          ) : visibleBooks.length ? (
            <>
              {numberedBooks.map((book) => (
                <SeriesBookCard
                  key={book.id}
                  book={book}
                  onOpen={onOpenBook}
                  onEdit={setEditing}
                  onExport={setExporting}
                  onEditorialAccess={setEditorAccess}
                  onRemove={setRemoving}
                  onDelete={setDeleting}
                />
              ))}
              {unnumberedBooks.length > 0 && (
                <section className="seriesUnnumberedBooks" aria-labelledby="unnumbered-books-heading">
                  <h2 id="unnumbered-books-heading">{t('series.unnumberedBooks')}</h2>
                  <div className="seriesUnnumberedBookList">
                    {unnumberedBooks.map((book) => (
                      <SeriesBookCard
                        key={book.id}
                        book={book}
                        onOpen={onOpenBook}
                        onEdit={setEditing}
                        onExport={setExporting}
                        onEditorialAccess={setEditorAccess}
                        onRemove={setRemoving}
                        onDelete={setDeleting}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          ) : books.length ? (
            <div className="booksEmptyState compact">
              <h2>{t('series.noMatches')}</h2>
              <p>{t('manuscripts.tryDifferentSearch')}</p>
            </div>
          ) : (
            <div className="booksEmptyState">
              <span className="booksEmptyIcon" aria-hidden="true">
                <Icon name="books-light" />
              </span>
              <h2>{t('series.noBooks')}</h2>
              <p>{t('series.noBooksLead')}</p>
              <button type="button" className="emptyCreateButton booksButton" onClick={() => setCreateDialogOpen(true)}>
                <Icon name="books-light" />
                {t('series.newBook')}
              </button>
            </div>
          )}
        </div>
      </main>

      <nav className="mobileLibraryBottomBar mobileSeriesBottomBar" aria-label={series?.title ?? t('manuscripts.series')}>
        <div className="mobileLibraryBottomBarSurface mobileSeriesBottomBarSurface">
          <button
            type="button"
            className="mobileSeriesBackButton mobileLibraryBarButton booksButton"
            title={t('series.back')}
            aria-label={t('series.back')}
            onClick={onBack}
          >
            <Icon name="arrow-left-1" />
          </button>
          <button
            type="button"
            className="mobileLibraryCreateButton booksButton"
            title={t('series.newBook')}
            aria-label={t('series.newBook')}
            onClick={() => setCreateDialogOpen(true)}
          >
            <PlusIcon />
          </button>
          <MobileLibraryQueryControls
            search={search}
            searchLabel={t('series.search')}
            searchPlaceholder={t('series.searchPlaceholder')}
            sort={sortOrder}
            sortLabel={t('series.sort')}
            sortOptions={[
              { value: 'order', label: t('series.inOrder') },
              { value: 'updated', label: t('manuscripts.recentlyUpdated') },
              { value: 'created', label: t('manuscripts.recentlyCreated') },
              { value: 'title', label: t('manuscripts.titleAscending') },
            ]}
            onSearchChange={setSearch}
            onSortChange={setSortOrder}
          />
        </div>
      </nav>

      {createDialogOpen && (
        <CreateBookDialog
          seriesId={seriesId}
          initialSeriesPosition={nextPosition}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={handleCreated}
          onError={onError}
          coverUploadLimitBytes={coverUploadLimitBytes}
        />
      )}
      {editing && (
        <EditManuscriptDialog
          manuscript={editing}
          seriesId={seriesId}
          seriesPosition={editing.seriesPosition}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onError={onError}
          coverUploadLimitBytes={coverUploadLimitBytes}
        />
      )}
      {deleting && (
        <DeleteManuscriptDialog
          manuscript={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={handleDeleted}
          onError={onError}
        />
      )}
      {removing && (
        <RemoveFromSeriesDialog
          book={removing}
          seriesTitle={series?.title ?? t('series.thisSeries')}
          onClose={() => setRemoving(null)}
          onRemoved={handleRemoved}
          onError={onError}
        />
      )}
      {exporting && (
        <ManuscriptExportDialog
          manuscript={exporting}
          onClose={() => setExporting(null)}
          onError={onError}
          onMessage={onMessage}
        />
      )}
      {editorAccess && (
        <ManuscriptEditorAccessDialog
          manuscript={editorAccess}
          onClose={() => setEditorAccess(null)}
          onError={onError}
          onMessage={onMessage}
        />
      )}
      {drawerOpen && (
        <ManuscriptDrawerDialog
          onClose={() => setDrawerOpen(false)}
          onOpen={onOpenBook}
          onOpenSeries={onOpenSeries}
          onRestored={(item) => {
            setLibraryCounts((current) => current ? {
              ...current,
              all: current.all + 1,
              [item.kind]: current[item.kind] + 1,
            } : current)
          }}
          onError={onError}
          onMessage={onMessage}
        />
      )}
    </div>
  )
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}

function SeriesBookCard({
  book,
  onOpen,
  onEdit,
  onExport,
  onEditorialAccess,
  onRemove,
  onDelete,
}: {
  book: SeriesBook
  onOpen: (manuscriptId: string) => void
  onEdit: (book: SeriesBook) => void
  onExport: (book: SeriesBook) => void
  onEditorialAccess: (book: SeriesBook) => void
  onRemove: (book: SeriesBook) => void
  onDelete: (book: SeriesBook) => void
}) {
  const { t, i18n } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function closeMenu(event: MouseEvent) {
      if (window.matchMedia('(max-width: 520px)').matches) return
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const actions: LibraryAction[] = [
    {
      key: 'edit',
      label: t('manuscripts.editDetails'),
      icon: <Icon name="edit-light" />,
      onSelect: () => { setMenuOpen(false); onEdit(book) },
    },
    {
      key: 'export',
      label: t('manuscripts.export'),
      icon: <Icon name="archive-light" />,
      onSelect: () => { setMenuOpen(false); onExport(book) },
    },
    {
      key: 'editorial-access',
      label: t('editorAccess.action'),
      icon: <Icon name="pen-light" />,
      onSelect: () => { setMenuOpen(false); onEditorialAccess(book) },
    },
    {
      key: 'remove-from-series',
      label: t('series.removeFromSeries'),
      icon: <Icon name="move-to-folder-light" />,
      onSelect: () => { setMenuOpen(false); onRemove(book) },
    },
    {
      key: 'delete',
      label: t('common.delete'),
      icon: <Icon name="trash-bin-trash-light" />,
      danger: true,
      onSelect: () => { setMenuOpen(false); onDelete(book) },
    },
  ]

  return (
    <article className="seriesBookCard">
      <button type="button" className="seriesBookCardOpen booksButton" onClick={() => onOpen(book.id)}>
        <div className="seriesBookCover">
          {book.coverThumbnailMediumUrl ? (
            <PrivateImage src={`${API_BASE}${book.coverThumbnailMediumUrl}?v=${book.coverVersion}`} alt="" loading="lazy" decoding="async" />
          ) : (
            <Icon name="books-light" />
          )}
        </div>
        <div className="seriesBookBody">
          <div className="seriesBookMeta">
            <span className="oneShotKind">
              {book.seriesPosition === null
                ? t('manuscripts.book')
                : t('series.bookPosition', { position: book.seriesPosition })}
            </span>
            <ManuscriptStatusChip status={book.status} />
          </div>
          <h2>{book.title}</h2>
          <p>{book.synopsis || t('manuscripts.noSynopsis')}</p>
          <time dateTime={book.updatedAt}>
            {t('manuscripts.updated', {
              date: formatDate(book.updatedAt, i18n.resolvedLanguage),
            })}
          </time>
        </div>
      </button>
      <div className="manuscriptCardMenu" ref={menuRef}>
        <button type="button" className={`manuscriptCardMenuButton booksButton ${menuOpen ? 'active' : ''}`} aria-label={t('manuscripts.actionsFor', { title: book.title })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <Icon name="menu-dots-light" />
        </button>
        {menuOpen && (
          <div className="manuscriptCardMenuPopover" role="menu">
            {actions.map((action) => (
              <button type="button" className={`${action.danger ? 'danger ' : ''}booksButton`} role="menuitem" disabled={action.disabled} key={action.key} onClick={action.onSelect}>
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {menuOpen && (
        <MobileLibraryActionSheet
          open
          title={book.title}
          actions={actions}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </article>
  )
}

function formatDate(value: string, locale: string | undefined) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value))
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></svg>
}
