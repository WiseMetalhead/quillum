import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import { SectionSidebarToggle } from '../shared/SectionSidebarToggle'
import {
  manuscriptLibrarySectionIcon,
  editorManuscriptLibrarySections,
  manuscriptLibrarySections,
} from './manuscriptLibraryNavigation'
import type {
  ManuscriptLibraryCounts,
  ManuscriptLibrarySection,
} from './manuscriptLibraryNavigation'

type Props = {
  activeSection: ManuscriptLibrarySection
  counts?: ManuscriptLibraryCounts | null
  onSelectSection: (section: ManuscriptLibrarySection) => void
  onOpenDrawer: () => void
  collapsed: boolean
  onToggle: () => void
  editorMode?: boolean
}

export function ManuscriptLibrarySidebar({
  activeSection,
  counts,
  onSelectSection,
  onOpenDrawer,
  collapsed,
  onToggle,
  editorMode = false,
}: Props) {
  const { t, i18n } = useTranslation()
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage)

  return (
    <aside className="manuscriptLibrarySidebar collapsibleSectionSidebar" aria-label={t(editorMode ? 'editorManuscripts.title' : 'app.manuscripts')}>
      <div className="manuscriptLibrarySidebarBody sectionNavigation">
        <nav className="manuscriptLibraryNavigation">
          {(editorMode ? editorManuscriptLibrarySections : manuscriptLibrarySections).map(([section, labelKey]) => (
            <button
              type="button"
              className={`sectionNavigationButton booksButton ${activeSection === section ? 'active' : ''}`}
              aria-current={activeSection === section ? 'page' : undefined}
              title={t(labelKey)}
              key={section}
              onClick={() => onSelectSection(section)}
            >
              <Icon name={manuscriptLibrarySectionIcon(section)} />
              <span>{t(labelKey)}</span>
              {counts && <small>{numberFormatter.format(counts[section])}</small>}
            </button>
          ))}
        </nav>
        {!editorMode && (
          <>
            <hr />
            <button
              type="button"
              className="manuscriptLibraryDrawer sectionNavigationButton booksButton"
              title={t('manuscripts.drawer')}
              onClick={onOpenDrawer}
            >
              <Icon name="bedside-table-3-light" />
              <span>{t('manuscripts.drawer')}</span>
            </button>
          </>
        )}
      </div>
      <SectionSidebarToggle
        collapsed={collapsed}
        collapseLabel={t('common.collapseSidebar')}
        expandLabel={t('common.expandSidebar')}
        onToggle={onToggle}
      />
    </aside>
  )
}
