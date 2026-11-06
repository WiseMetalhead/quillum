import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { User } from '../../types'
import { Icon, type IconName } from '../../icons/Icon'
import { NewsFeed } from '../news/NewsPage'
import { MobileSectionSelector } from '../shared/MobileSectionSelector'
import { ContestFeed } from './ContestFeed'
import './FeedPage.css'

type FeedSection = 'news' | 'contests'

type FeedPageProps = {
  user: User
  onError: (message: string) => void
}

export function FeedPage({ user, onError }: FeedPageProps) {
  const { t } = useTranslation()
  const sections: Array<{ id: FeedSection; label: string; icon: IconName }> = []
  if (user.newsEnabled) {
    sections.push({ id: 'news', label: t('news.title'), icon: 'cheque-light' })
  }
  if (user.contestsEnabled) {
    sections.push({ id: 'contests', label: t('contests.title'), icon: 'cup-star-light' })
  }
  const [activeSection, setActiveSection] = useState<FeedSection>(
    user.newsEnabled ? 'news' : 'contests',
  )
  const resolvedSection = sections.some((section) => section.id === activeSection)
    ? activeSection
    : sections[0]?.id

  if (!resolvedSection) return null

  return (
    <div className="feedPage sidebarPage">
      <MobileSectionSelector
        items={sections}
        activeId={resolvedSection}
        ariaLabel={t('feed.navigation')}
        onSelect={setActiveSection}
      />

      <aside className="sectionSidebar feedSidebar" aria-label={t('feed.navigation')}>
        <nav className="sectionNavigation" aria-label={t('feed.categories')}>
          {sections.map((section) => (
            <button
              type="button"
              className={`sectionNavigationButton ${resolvedSection === section.id ? 'active' : ''}`}
              aria-current={resolvedSection === section.id ? 'page' : undefined}
              title={section.label}
              key={section.id}
              onClick={() => setActiveSection(section.id)}
            >
              <Icon name={section.icon} />
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="feedBody">
        {resolvedSection === 'news' && <NewsFeed onError={onError} />}
        {resolvedSection === 'contests' && <ContestFeed onError={onError} />}
      </main>
    </div>
  )
}
