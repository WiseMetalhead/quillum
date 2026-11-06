import { useEffect, useMemo, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { API_BASE, apiQuery, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { UserTierPayload } from '../../types'
import { PrivateImage } from '../shared/PrivateImage'
import { AddToSeriesDialog } from './AddToSeriesDialog'
import { CreateOneShotDialog } from './CreateOneShotDialog'
import { CreateBookDialog } from './CreateBookDialog'
import { DeleteManuscriptDialog } from './DeleteManuscriptDialog'
import { DeleteSeriesDialog } from './DeleteSeriesDialog'
import { EditManuscriptDialog } from './EditManuscriptDialog'
import { ManuscriptExportDialog } from './ManuscriptExportDialog'
import { ManuscriptDrawerDialog } from './ManuscriptDrawerDialog'
import { ManuscriptEditorAccessDialog } from './ManuscriptEditorAccessDialog'
import type { AvailableManuscript, LibraryItem, Manuscript, Series } from './ManuscriptTypes'
import { ManuscriptStatusChip } from './ManuscriptStatusChip'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import type { LibraryAction } from '../shared/MobileLibraryActionSheet'
import { MobileLibraryQueryControls } from './MobileLibraryQueryControls'
import { ManuscriptLibrarySidebar } from './ManuscriptLibrarySidebar'
import {
  manuscriptLibrarySectionIcon,
  manuscriptLibrarySectionLabel,
  editorManuscriptLibrarySections,
  manuscriptLibrarySections,
} from './manuscriptLibraryNavigation'
import type { ManuscriptLibrarySection } from './manuscriptLibraryNavigation'
import { SeriesDialog } from './SeriesDialog'
import './ManuscriptsPage.css'

type ManuscriptsPageProps = {
  mode: 'owner' | 'editor'
  onMessage: (message: string) => void
  onError: (error: string) => void
  onOpen: (manuscriptId: string) => void
  onOpenSeries: (seriesId: string) => void
  activeSection: ManuscriptLibrarySection
  onSelectSection: (section: ManuscriptLibrarySection) => void
}

type SortOrder = 'updated' | 'created' | 'title'
type ManuscriptFilter = ManuscriptLibrarySection

export function ManuscriptsPage({
  mode,
  onMessage,
  onError,
  onOpen,
  onOpenSeries,
  activeSection,
  onSelectSection,
}: ManuscriptsPageProps) {
  const { t, i18n } = useTranslation()
  const editorMode = mode === 'editor'
  const [items, setItems] = useState<Array<LibraryItem | AvailableManuscript>>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortOrder, setSortOrder] = useState<SortOrder>('updated')
  const [coverUploadLimitBytes, setCoverUploadLimitBytes] = useState<number | null>(null)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createBookDialogOpen, setCreateBookDialogOpen] = useState(false)
  const [createSeriesDialogOpen, setCreateSeriesDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LibraryItem | null>(null)
  const [deleting, setDeleting] = useState<LibraryItem | null>(null)
  const [addingToSeries, setAddingToSeries] = useState<Manuscript | null>(null)
  const [exporting, setExporting] = useState<Manuscript | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [puttingInDrawerId, setPuttingInDrawerId] = useState<string | null>(null)
  const [editorAccess, setEditorAccess] = useState<Manuscript | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        if (editorMode) {
          const payload = await apiQuery<{ items: AvailableManuscript[] }>(
            '/api/editor/manuscripts/',
            {
              onBackgroundUpdate: (next) => {
                if (active) setItems(next.items)
              },
            },
          )
          if (active) setItems(payload.items)
          return
        }
        const [oneShots, books, series, tier] = await Promise.all([
          apiQuery<{ items: Manuscript[] }>('/api/manuscripts/oneshots/', {
            onBackgroundUpdate: (payload) => {
              if (active) setItems((current) => [
                ...payload.items,
                ...current.filter((item) => item.kind !== 'oneshot'),
              ])
            },
          }),
          apiQuery<{ items: Manuscript[] }>('/api/manuscripts/books/', {
            onBackgroundUpdate: (payload) => {
              if (active) setItems((current) => [
                ...current.filter((item) => item.kind !== 'book'),
                ...payload.items,
              ])
            },
          }),
          apiQuery<{ items: Series[] }>('/api/manuscripts/series/', {
            onBackgroundUpdate: (payload) => {
              if (active) setItems((current) => [
                ...current.filter((item) => item.kind !== 'series'),
                ...payload.items,
              ])
            },
          }),
          apiQuery<{ tier: UserTierPayload }>('/api/auth/tier/', {
            onBackgroundUpdate: (payload) => {
              if (active) {
                setCoverUploadLimitBytes(
                  payload.tier.quotas.find(
                    (quota) => quota.key === 'image_upload_bytes',
                  )?.limit ?? null,
                )
              }
            },
          }).catch(() => null),
        ])
        if (active) {
          setItems([...oneShots.items, ...books.items, ...series.items])
          setCoverUploadLimitBytes(
            tier?.tier.quotas.find((quota) => quota.key === 'image_upload_bytes')?.limit ?? null,
          )
        }
      } catch (err) {
        if (active) {
          onError(err instanceof Error
            ? err.message
            : i18n.t(editorMode ? 'editorManuscripts.loadFailed' : 'manuscripts.loadFailed'))
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [editorMode, i18n, onError])

  useEffect(() => {
    if (editorMode && activeSection === 'series') onSelectSection('all')
  }, [activeSection, editorMode, onSelectSection])

  useEffect(() => {
    if (!newMenuOpen) {
      return
    }
    function closeMenu(event: MouseEvent) {
      if (
        !menuRef.current?.contains(event.target as Node)
        && !mobileMenuRef.current?.contains(event.target as Node)
      ) {
        setNewMenuOpen(false)
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [newMenuOpen])

  const visibleItems = useMemo(() => {
    const locale = i18n.resolvedLanguage ?? 'en'
    const query = search.trim().toLocaleLowerCase(locale)
    const categoryItems = activeSection === 'all'
      ? items
      : items.filter((item) => item.kind === activeSection)
    const filtered = query
      ? categoryItems.filter((item) =>
          `${item.title}\n${item.synopsis}`.toLocaleLowerCase(locale).includes(query),
        )
      : [...categoryItems]
    return filtered.sort((left, right) => {
      if (sortOrder === 'title') {
        return left.title.localeCompare(right.title, locale)
      }
      const leftDate = Date.parse(sortOrder === 'created' ? left.createdAt : left.updatedAt)
      const rightDate = Date.parse(sortOrder === 'created' ? right.createdAt : right.updatedAt)
      return rightDate - leftDate
    })
  }, [activeSection, i18n.resolvedLanguage, items, search, sortOrder])

  const filterCounts = useMemo(() => ({
    all: items.length,
    oneshot: items.filter((item) => item.kind === 'oneshot').length,
    book: items.filter((item) => item.kind === 'book').length,
    series: items.filter((item) => item.kind === 'series').length,
  }), [items])

  function openCreateDialog() {
    setNewMenuOpen(false)
    setCreateDialogOpen(true)
  }

  function openCreateBookDialog() {
    setNewMenuOpen(false)
    setCreateBookDialogOpen(true)
  }

  function openCreateSeriesDialog() {
    setNewMenuOpen(false)
    setCreateSeriesDialogOpen(true)
  }

  function handleCreated(manuscript: Manuscript) {
    setItems((current) => [manuscript, ...current])
    setCreateDialogOpen(false)
    onMessage(t(manuscript.kind === 'book' ? 'manuscripts.bookCreated' : 'manuscripts.oneShotCreated'))
  }

  function handleSaved(manuscript: Manuscript) {
    setItems((current) => current.map((item) => (
      item.kind !== 'series' && item.id === manuscript.id ? manuscript : item
    )))
    setEditing(null)
    onMessage(t(manuscript.kind === 'book' ? 'manuscripts.bookUpdated' : 'manuscripts.oneShotUpdated'))
  }

  function handleSeriesSaved(series: Series) {
    if (createSeriesDialogOpen) {
      setItems((current) => [series, ...current])
      setCreateSeriesDialogOpen(false)
      onMessage(t('manuscripts.seriesCreated'))
      onOpenSeries(series.id)
      return
    }
    setItems((current) => current.map((item) => (
      item.kind === 'series' && item.id === series.id ? series : item
    )))
    setEditing(null)
    onMessage(t('manuscripts.seriesUpdated'))
  }

  function handleDeleted(manuscript: Manuscript) {
    setItems((current) => current.filter((item) => (
      item.kind === 'series' || item.id !== manuscript.id
    )))
    setDeleting(null)
    onMessage(t(manuscript.kind === 'book' ? 'manuscripts.bookDeleted' : 'manuscripts.oneShotDeleted'))
  }

  function handleSeriesDeleted(series: Series, detachedBooks: Manuscript[]) {
    setItems((current) => [
      ...detachedBooks,
      ...current.filter((item) => (
        !(item.kind === 'series' && item.id === series.id)
      )),
    ])
    setDeleting(null)
    onMessage(t('manuscripts.seriesDeleted'))
  }

  function handleAddedToSeries(book: Manuscript, series: Series) {
    setItems((current) => current
      .filter((item) => item.kind === 'series' || item.id !== book.id)
      .map((item) => (
        item.kind === 'series' && item.id === series.id ? series : item
      )))
    setAddingToSeries(null)
    onMessage(t('manuscripts.addedToSeries', { title: series.title }))
  }

  async function putInDrawer(item: LibraryItem) {
    if (puttingInDrawerId !== null) return
    setPuttingInDrawerId(item.id)
    try {
      const path = item.kind === 'series'
        ? `/api/manuscripts/drawer/series/${item.id}/`
        : `/api/manuscripts/drawer/manuscripts/${item.id}/`
      await apiRequest(path, { method: 'PUT' })
      setItems((current) => current.filter((candidate) => (
        candidate.kind !== item.kind || candidate.id !== item.id
      )))
      onMessage(t('manuscripts.putInDrawerSuccess', { title: item.title }))
    } catch (error) {
      onError(error instanceof Error ? error.message : t('manuscripts.putInDrawerFailed'))
    } finally {
      setPuttingInDrawerId(null)
    }
  }

  return (
    <div className="manuscriptsPage">
      <ManuscriptLibrarySidebar
        activeSection={activeSection}
        counts={filterCounts}
        onSelectSection={onSelectSection}
        onOpenDrawer={() => setDrawerOpen(true)}
        editorMode={editorMode}
      />
      <main className="manuscriptPanel manuscriptLibraryMain" aria-labelledby="manuscripts-heading">
        <div className="manuscriptToolbar">
          <h1 id="manuscripts-heading">
            {editorMode && activeSection === 'all'
              ? t('editorManuscripts.title')
              : manuscriptLibrarySectionLabel(activeSection, t)}
          </h1>

          <div className="manuscriptControls">
            <label className="manuscriptSearch">
              <span className="srOnly">{t('manuscripts.search')}</span>
              <SearchIcon />
              <input
                type="search"
                placeholder={t('manuscripts.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="manuscriptSort">
              <span className="srOnly">{t('manuscripts.sort')}</span>
              <CustomSelect
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value as SortOrder)}
              >
                <option value="updated">{t('manuscripts.recentlyUpdated')}</option>
                <option value="created">{t('manuscripts.recentlyCreated')}</option>
                <option value="title">{t('manuscripts.titleAscending')}</option>
              </CustomSelect>
            </label>
            {!editorMode && <div className="newManuscript" ref={menuRef}>
              <button
                type="button"
                className="newManuscriptButton booksButton"
                aria-haspopup="menu"
                aria-expanded={newMenuOpen}
                onClick={() => setNewMenuOpen((isOpen) => !isOpen)}
              >
                <PlusIcon />
                {t('manuscripts.new')}
                <ChevronIcon open={newMenuOpen} />
              </button>
              {newMenuOpen && (
                <div className="newManuscriptMenu" role="menu">
                  <button type="button" className="booksButton" role="menuitem" onClick={openCreateDialog}>
                    <span className="newManuscriptMenuIcon" aria-hidden="true">
                      <Icon name="file-document-light" />
                    </span>
                    <span>
                      <strong>{t('manuscripts.newOneShot')}</strong>
                      <small>{t('manuscripts.newOneShotLead')}</small>
                    </span>
                  </button>
                  <button type="button" className="booksButton" role="menuitem" onClick={openCreateBookDialog}>
                    <span className="newManuscriptMenuIcon" aria-hidden="true">
                      <Icon name="books-light" />
                    </span>
                    <span>
                      <strong>{t('manuscripts.newBook')}</strong>
                      <small>{t('manuscripts.newBookLead')}</small>
                    </span>
                  </button>
                  <button type="button" className="booksButton" role="menuitem" onClick={openCreateSeriesDialog}>
                    <span className="newManuscriptMenuIcon" aria-hidden="true">
                      <Icon name="library-light" />
                    </span>
                    <span>
                      <strong>{t('manuscripts.newSeries')}</strong>
                      <small>{t('manuscripts.newSeriesLead')}</small>
                    </span>
                  </button>
                </div>
              )}
            </div>}
          </div>

        </div>

        <div className={`manuscriptList ${visibleItems.length ? 'hasItems' : ''}`}>
          {loading ? (
            <TadpoleLoadingState className="booksLoading" label={t('manuscripts.loading')} />
          ) : visibleItems.length ? (
            visibleItems.map((item) => (
              <LibraryCard
                key={`${item.kind}-${item.id}`}
                item={item}
                onOpen={onOpen}
                onOpenSeries={onOpenSeries}
                onEdit={setEditing}
                onDelete={setDeleting}
                onAddToSeries={setAddingToSeries}
                onExport={setExporting}
                onPutInDrawer={putInDrawer}
                drawerBusy={puttingInDrawerId === item.id}
                readOnly={editorMode}
                onEditorialAccess={setEditorAccess}
              />
            ))
          ) : items.length ? (
            <div className="booksEmptyState compact">
              <span className="booksEmptyIcon" aria-hidden="true">
                <Icon name={search.trim() ? 'sad-square-light' : filterIcon(activeSection)} />
              </span>
              <h2>
                {search.trim()
                  ? t('manuscripts.noMatches')
                  : t('manuscripts.noFilterItems', { items: filterLabel(activeSection, t) })}
              </h2>
              <p>
                {search.trim()
                  ? t('manuscripts.tryDifferentSearch')
                  : editorMode
                    ? t('editorManuscripts.noFilterLead')
                    : t('manuscripts.createFilterItem', { item: singularFilterLabel(activeSection, t) })}
              </p>
            </div>
          ) : (
            <div className="booksEmptyState">
              <span className="booksEmptyIcon" aria-hidden="true">
                <Icon name="documents-light" />
              </span>
              <h2>{t(editorMode ? 'editorManuscripts.emptyTitle' : 'manuscripts.noManuscripts')}</h2>
              <p>{t(editorMode ? 'editorManuscripts.emptyLead' : 'manuscripts.emptyLead')}</p>
              {!editorMode && <div className="emptyCreateActions">
                <button type="button" className="emptyCreateButton booksButton" onClick={openCreateDialog}>
                  <Icon name="file-document-light" />
                  {t('manuscripts.createOneShot')}
                </button>
                <button type="button" className="emptyCreateButton secondary booksButton" onClick={openCreateBookDialog}>
                  <Icon name="books-light" />
                  {t('manuscripts.createBook')}
                </button>
                <button type="button" className="emptyCreateButton secondary booksButton" onClick={openCreateSeriesDialog}>
                  <Icon name="library-light" />
                  {t('manuscripts.createSeries')}
                </button>
              </div>}
            </div>
          )}
        </div>
      </main>

      <nav className={`mobileLibraryBottomBar ${editorMode ? 'editorAvailableLibrary' : ''}`} aria-label={t(editorMode ? 'editorManuscripts.title' : 'app.manuscripts')}>
        <div className="mobileLibraryBottomBarSurface">
          <MobileManuscriptCategorySelector
            filter={activeSection}
            counts={filterCounts}
            onChange={onSelectSection}
            editorMode={editorMode}
          />
          {!editorMode && <button
            type="button"
            className="mobileManuscriptDrawerButton mobileLibraryBarButton booksButton"
            title={t('manuscripts.drawer')}
            aria-label={t('manuscripts.drawer')}
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="bedside-table-3-light" />
          </button>}
          {!editorMode && <div className="newManuscript mobileNewManuscript" ref={mobileMenuRef}>
            <button
              type="button"
              className="mobileLibraryCreateButton booksButton"
              title={t('manuscripts.new')}
              aria-label={t('manuscripts.new')}
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              onClick={() => setNewMenuOpen((isOpen) => !isOpen)}
            >
              <PlusIcon />
            </button>
            {newMenuOpen && (
              <div className="newManuscriptMenu mobileNewManuscriptMenu" role="menu">
                <button type="button" className="booksButton" role="menuitem" onClick={openCreateDialog}>
                  <span className="newManuscriptMenuIcon" aria-hidden="true"><Icon name="file-document-light" /></span>
                  <span><strong>{t('manuscripts.newOneShot')}</strong><small>{t('manuscripts.newOneShotLead')}</small></span>
                </button>
                <button type="button" className="booksButton" role="menuitem" onClick={openCreateBookDialog}>
                  <span className="newManuscriptMenuIcon" aria-hidden="true"><Icon name="books-light" /></span>
                  <span><strong>{t('manuscripts.newBook')}</strong><small>{t('manuscripts.newBookLead')}</small></span>
                </button>
                <button type="button" className="booksButton" role="menuitem" onClick={openCreateSeriesDialog}>
                  <span className="newManuscriptMenuIcon" aria-hidden="true"><Icon name="library-light" /></span>
                  <span><strong>{t('manuscripts.newSeries')}</strong><small>{t('manuscripts.newSeriesLead')}</small></span>
                </button>
              </div>
            )}
          </div>}
          <MobileLibraryQueryControls
            search={search}
            searchLabel={t('manuscripts.search')}
            searchPlaceholder={t('manuscripts.searchPlaceholder')}
            sort={sortOrder}
            sortLabel={t('manuscripts.sort')}
            sortOptions={[
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
        <CreateOneShotDialog
          onClose={() => setCreateDialogOpen(false)}
          onCreated={handleCreated}
          onError={onError}
          coverUploadLimitBytes={coverUploadLimitBytes}
        />
      )}
      {createBookDialogOpen && (
        <CreateBookDialog
          onClose={() => setCreateBookDialogOpen(false)}
          onCreated={(manuscript) => {
            handleCreated(manuscript)
            setCreateBookDialogOpen(false)
          }}
          onError={onError}
          coverUploadLimitBytes={coverUploadLimitBytes}
        />
      )}
      {createSeriesDialogOpen && (
        <SeriesDialog
          onClose={() => setCreateSeriesDialogOpen(false)}
          onSaved={handleSeriesSaved}
          onError={onError}
          coverUploadLimitBytes={coverUploadLimitBytes}
        />
      )}
      {editing?.kind !== 'series' && editing && (
        <EditManuscriptDialog
          manuscript={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onError={onError}
          coverUploadLimitBytes={coverUploadLimitBytes}
        />
      )}
      {editing?.kind === 'series' && (
        <SeriesDialog
          series={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSeriesSaved}
          onError={onError}
          coverUploadLimitBytes={coverUploadLimitBytes}
        />
      )}
      {deleting?.kind !== 'series' && deleting && (
        <DeleteManuscriptDialog
          manuscript={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={handleDeleted}
          onError={onError}
        />
      )}
      {deleting?.kind === 'series' && (
        <DeleteSeriesDialog
          series={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={handleSeriesDeleted}
          onError={onError}
        />
      )}
      {addingToSeries && (
        <AddToSeriesDialog
          book={addingToSeries}
          onClose={() => setAddingToSeries(null)}
          onAdded={handleAddedToSeries}
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
      {drawerOpen && (
        <ManuscriptDrawerDialog
          onClose={() => setDrawerOpen(false)}
          onOpen={onOpen}
          onOpenSeries={onOpenSeries}
          onRestored={(item) => setItems((current) => [
            item,
            ...current.filter((candidate) => (
              candidate.kind !== item.kind || candidate.id !== item.id
            )),
          ])}
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
    </div>
  )
}

function MobileManuscriptCategorySelector({
  filter,
  counts,
  onChange,
  editorMode,
}: {
  filter: ManuscriptFilter
  counts: Record<ManuscriptFilter, number>
  onChange: (filter: ManuscriptFilter) => void
  editorMode: boolean
}) {
  const { t, i18n } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const selectorRef = useRef<HTMLDivElement>(null)
  const sections = editorMode ? editorManuscriptLibrarySections : manuscriptLibrarySections
  const active = sections.find(([value]) => value === filter) ?? sections[0]
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage)

  useEffect(() => {
    if (!menuOpen) return

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!selectorRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  return (
    <div className="mobileManuscriptCategorySelector" ref={selectorRef}>
      <button
        type="button"
        className={`mobileManuscriptCategoryTrigger booksButton ${menuOpen ? 'active' : ''}`}
        title={t(active[1])}
        aria-label={t(active[1])}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Icon name={manuscriptLibrarySectionIcon(active[0])} />
        <span>{t(active[1])}</span>
        <small>{numberFormatter.format(counts[active[0]])}</small>
        <Icon name="arrow-down-2" className={menuOpen ? 'open' : ''} />
      </button>
      {menuOpen && (
        <div className="mobileManuscriptCategoryMenu" role="menu">
          {sections.map(([value, labelKey]) => (
            <button
              type="button"
              className={`booksButton ${filter === value ? 'active' : ''}`}
              role="menuitemradio"
              aria-checked={filter === value}
              key={value}
              onClick={() => {
                onChange(value)
                setMenuOpen(false)
              }}
            >
              <Icon name={manuscriptLibrarySectionIcon(value)} />
              <span>{t(labelKey)}</span>
              <small>{numberFormatter.format(counts[value])}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LibraryCard({
  item,
  onOpen,
  onOpenSeries,
  onEdit,
  onDelete,
  onAddToSeries,
  onExport,
  onPutInDrawer,
  drawerBusy,
  readOnly,
  onEditorialAccess,
}: {
  item: LibraryItem | AvailableManuscript
  onOpen: (manuscriptId: string) => void
  onOpenSeries: (seriesId: string) => void
  onEdit: (item: LibraryItem) => void
  onDelete: (item: LibraryItem) => void
  onAddToSeries: (book: Manuscript) => void
  onExport: (manuscript: Manuscript) => void
  onPutInDrawer: (item: LibraryItem) => Promise<void>
  drawerBusy: boolean
  readOnly: boolean
  onEditorialAccess: (manuscript: Manuscript) => void
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

  const authorName = 'author' in item
    ? item.author.displayName.trim() || item.author.username
    : ''
  const authorInitial = Array.from(authorName)[0]?.toLocaleUpperCase() || '?'

  const actions: LibraryAction[] = readOnly ? [] : [
    {
      key: 'drawer',
      label: drawerBusy ? t('manuscripts.puttingInDrawer') : t('manuscripts.putInDrawer'),
      icon: <Icon name="bedside-table-3-light" />,
      disabled: drawerBusy,
      onSelect: () => void onPutInDrawer(item as LibraryItem).then(() => setMenuOpen(false)),
    },
    ...(item.kind === 'book' ? [{
      key: 'add-to-series',
      label: t('manuscripts.addToSeries'),
      icon: <Icon name="library-light" />,
      onSelect: () => { setMenuOpen(false); onAddToSeries(item as Manuscript) },
    }] : []),
    ...(item.kind !== 'series' ? [{
      key: 'export',
      label: t('manuscripts.export'),
      icon: <Icon name="archive-light" />,
      onSelect: () => { setMenuOpen(false); onExport(item as Manuscript) },
    }, {
      key: 'editorial-access',
      label: t('editorAccess.action'),
      icon: <Icon name="pen-light" />,
      onSelect: () => { setMenuOpen(false); onEditorialAccess(item as Manuscript) },
    }] : []),
    {
      key: 'edit',
      label: t('manuscripts.editDetails'),
      icon: <Icon name="edit-light" />,
      onSelect: () => { setMenuOpen(false); onEdit(item as LibraryItem) },
    },
    {
      key: 'delete',
      label: t('manuscripts.delete'),
      icon: <Icon name="trash-bin-trash-light" />,
      danger: true,
      onSelect: () => { setMenuOpen(false); onDelete(item as LibraryItem) },
    },
  ]

  const cardContent = (
    <>
      <div className="oneShotCover">
        {item.coverThumbnailMediumUrl ? (
          <PrivateImage src={`${API_BASE}${item.coverThumbnailMediumUrl}?v=${item.coverVersion}`} alt="" loading="lazy" decoding="async" />
        ) : (
          <Icon name={
            item.kind === 'book'
              ? 'books-light'
              : item.kind === 'series'
                ? 'library-light'
                : 'file-document-light'
          } />
        )}
      </div>
      <div className="oneShotCardBody">
        <div className="manuscriptCardBadges">
          <span className="oneShotKind">{kindLabel(item, t)}</span>
          {item.kind !== 'series' && <ManuscriptStatusChip status={item.status} />}
        </div>
        <h2>{item.title}</h2>
        {'author' in item && (
          <span className="editorManuscriptAuthor">
            <span className="editorManuscriptAuthorAvatar" aria-hidden="true">
              {item.author.avatarUrl ? (
                <PrivateImage src={`${API_BASE}${item.author.avatarUrl}`} alt="" />
              ) : authorInitial}
            </span>
            <span className="editorManuscriptAuthorName">{authorName}</span>
          </span>
        )}
        <p>{item.synopsis || t('manuscripts.noSynopsis')}</p>
        {item.kind === 'series' && (
          <span className="seriesBookCount">
            {t('manuscripts.bookCount', { count: item.bookCount })}
          </span>
        )}
        <time dateTime={item.updatedAt}>
          {t('manuscripts.updated', {
            date: formatDate(item.updatedAt, i18n.resolvedLanguage),
          })}
        </time>
      </div>
    </>
  )

  return (
    <article className={`oneShotCard ${item.kind === 'series' ? 'series' : ''} ${readOnly ? 'editorAvailable' : ''}`.trim()}>
      {readOnly ? (
        <button
          type="button"
          className="oneShotCardOpen editorAvailableManuscriptCard booksButton"
          onClick={() => onOpen(item.id)}
        >
          {cardContent}
        </button>
      ) : (
        <button
          type="button"
          className="oneShotCardOpen booksButton"
          onClick={() => item.kind === 'series' ? onOpenSeries(item.id) : onOpen(item.id)}
        >
          {cardContent}
        </button>
      )}
      {!readOnly && <div className="manuscriptCardMenu" ref={menuRef}>
        <button type="button" className={`manuscriptCardMenuButton booksButton ${menuOpen ? 'active' : ''}`} aria-label={t('manuscripts.actionsFor', { title: item.title })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
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
      </div>}
      {!readOnly && menuOpen && (
        <MobileLibraryActionSheet
          open
          title={item.title}
          actions={actions}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </article>
  )
}

function kindLabel(item: LibraryItem | AvailableManuscript, t: TFunction) {
  if (item.kind === 'series') return t('manuscripts.series')
  return item.kind === 'book' ? t('manuscripts.book') : t('manuscripts.oneShot')
}

function filterLabel(filter: ManuscriptFilter, t: TFunction) {
  if (filter === 'series') return t('manuscripts.filterSeries')
  if (filter === 'book') return t('manuscripts.filterBooks')
  if (filter === 'oneshot') return t('manuscripts.filterOneShots')
  return t('manuscripts.filterManuscripts')
}

function singularFilterLabel(filter: ManuscriptFilter, t: TFunction) {
  if (filter === 'series') return t('manuscripts.singularSeries')
  if (filter === 'book') return t('manuscripts.singularBook')
  return t('manuscripts.singularOneShot')
}

function filterIcon(filter: ManuscriptFilter) {
  return manuscriptLibrarySectionIcon(filter)
}

function formatDate(value: string, locale: string | undefined) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value))
}

export function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg className={open ? 'open' : ''} viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></svg>
}
