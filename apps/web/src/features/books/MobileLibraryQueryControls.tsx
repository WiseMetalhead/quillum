import { useEffect, useId, useRef, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import { Icon } from '../../icons/Icon'

type MobileLibraryQueryControlsProps<T extends string> = {
  search: string
  searchLabel: string
  searchPlaceholder: string
  sort: T
  sortLabel: string
  sortOptions: Array<{ value: T; label: string }>
  onSearchChange: (value: string) => void
  onSortChange: (value: T) => void
}

type QueryPanel = 'search' | 'sort'

export function MobileLibraryQueryControls<T extends string>({
  search,
  searchLabel,
  searchPlaceholder,
  sort,
  sortLabel,
  sortOptions,
  onSearchChange,
  onSortChange,
}: MobileLibraryQueryControlsProps<T>) {
  const [activePanel, setActivePanel] = useState<QueryPanel | null>(null)
  const [lastPanel, setLastPanel] = useState<QueryPanel>('search')
  const controlsRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sortRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!activePanel) return

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!controlsRef.current?.contains(event.target as Node)) setActivePanel(null)
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setActivePanel(null)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [activePanel])

  function togglePanel(panel: QueryPanel) {
    if (activePanel === panel) {
      setActivePanel(null)
      return
    }
    setLastPanel(panel)
    setActivePanel(panel)
    window.requestAnimationFrame(() => {
      if (panel === 'search') searchRef.current?.focus()
      else sortRef.current?.focus()
    })
  }

  return (
    <div className="mobileLibraryQueryControls" ref={controlsRef}>
      <div className="mobileLibraryQueryButtons">
        <button
          type="button"
          className={`mobileLibraryQueryButton booksButton ${activePanel === 'search' ? 'active' : ''}`}
          title={searchLabel}
          aria-label={searchLabel}
          aria-expanded={activePanel === 'search'}
          aria-controls={panelId}
          onClick={() => togglePanel('search')}
        >
          <Icon name="magnifer-outline" />
        </button>
        <button
          type="button"
          className={`mobileLibraryQueryButton booksButton ${activePanel === 'sort' ? 'active' : ''}`}
          title={sortLabel}
          aria-label={sortLabel}
          aria-expanded={activePanel === 'sort'}
          aria-controls={panelId}
          onClick={() => togglePanel('sort')}
        >
          <Icon name="tuning-2-light" />
        </button>
      </div>

      <div
        className={`mobileLibraryQueryPanel ${activePanel ? 'open' : ''}`}
        id={panelId}
        aria-hidden={!activePanel}
      >
        <div className="mobileLibraryQueryPanelInner">
          {lastPanel === 'search' ? (
            <label className="mobileLibrarySearchField">
              <span className="srOnly">{searchLabel}</span>
              <Icon name="magnifer-outline" />
              <input
                type="search"
                value={search}
                placeholder={searchPlaceholder}
                tabIndex={activePanel ? 0 : -1}
                ref={searchRef}
                onChange={(event) => onSearchChange(event.currentTarget.value)}
              />
            </label>
          ) : (
            <label className="mobileLibrarySortField">
              <span className="srOnly">{sortLabel}</span>
              <CustomSelect
                value={sort}
                tabIndex={activePanel ? 0 : -1}
                ref={sortRef}
                onChange={(event) => onSortChange(event.currentTarget.value as T)}
              >
                {sortOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </CustomSelect>
            </label>
          )}
        </div>
      </div>
    </div>
  )
}
