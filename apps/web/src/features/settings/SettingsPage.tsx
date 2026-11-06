import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons/Icon'
import type { ServicePageMetadata, SettingsView, User } from '../../types'
import { MobileSectionSelector } from '../shared/MobileSectionSelector'
import { useSensitiveAction } from '../shared/useSensitiveAction'
import { AccountTab } from './AccountTab'
import { AuthorProfileTab } from './AuthorProfileTab'
import { SecurityTab } from './SecurityTab'
import { StorageTab } from './StorageTab'
import { TiersTab } from './TiersTab'
import { NotificationSettingsTab } from './NotificationSettingsTab'
import { FeedSourcesTab } from './FeedSourcesTab'
import { EditorSettingsTab } from './EditorSettingsTab'
import { WorkspaceActivationBanner } from './WorkspaceActivationBanner'
import './SettingsPage.css'

const settingsNavigation: Array<{ view: SettingsView; labelKey: string; icon: IconName }> = [
  { view: 'account', labelKey: 'settings.account', icon: 'user-light' },
  { view: 'security', labelKey: 'settings.security', icon: 'shield-minimalistic-light' },
  { view: 'notifications', labelKey: 'settings.notifications', icon: 'bell-light' },
  { view: 'feed', labelKey: 'settings.feed', icon: 'cheque-light' },
  { view: 'author', labelKey: 'settings.authorProfile', icon: 'pen-light' },
  { view: 'editor', labelKey: 'settings.editor', icon: 'mynaui-pen' },
  { view: 'tiers', labelKey: 'settings.tiers', icon: 'crown-minimalistic-light' },
  { view: 'storage', labelKey: 'settings.storage', icon: 'ssd-round-light' },
]

const settingsViews = new Set<SettingsView>(['account', 'editor', 'security', 'author', 'tiers', 'storage', 'notifications', 'feed'])

function viewFromSearch(routeSearch: string): SettingsView {
  const tab = new URLSearchParams(routeSearch).get('tab')
  return settingsViews.has(tab as SettingsView) ? tab as SettingsView : 'account'
}

type SettingsPageProps = {
  user: User
  localPasswordLoginEnabled: boolean
  routeSearch: string
  onUserChange: (user: User) => void
  onMessage: (message: string) => void
  onError: (message: string) => void
  onAccountDeleted: () => void
  servicePages: ServicePageMetadata[]
}

export function SettingsPage({
  user,
  localPasswordLoginEnabled,
  routeSearch,
  onUserChange,
  onMessage,
  onError,
  onAccountDeleted,
  servicePages,
}: SettingsPageProps) {
  const { t } = useTranslation()
  const visibleNavigation = user.authorWorkspaceEnabled
    ? settingsNavigation
    : settingsNavigation.filter((item) => ['account', 'editor', 'security', 'author'].includes(item.view))
  const requestedView = viewFromSearch(routeSearch)
  const settingsView = visibleNavigation.some((item) => item.view === requestedView)
    ? requestedView
    : 'account'
  const { runSensitiveAction, reauthenticationDialog } = useSensitiveAction()

  function openSettingsView(nextView: SettingsView) {
    window.history.pushState({}, '', `/settings?tab=${nextView}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return (
    <div className="sidebarPage settingsPage">
      <MobileSectionSelector
        items={visibleNavigation.map((item) => ({
          id: item.view,
          label: t(item.labelKey),
          icon: item.icon,
        }))}
        activeId={settingsView}
        ariaLabel={t('settings.navigation')}
        onSelect={openSettingsView}
      />

      <aside className="sectionSidebar settingsSidebar" aria-label={t('settings.navigation')}>
        <nav className="sectionNavigation settingsNavigation" role="tablist" aria-label={t('settings.views')}>
          {visibleNavigation.map((item) => (
            <button
              key={item.view}
              type="button"
              role="tab"
              title={t(item.labelKey)}
              aria-selected={settingsView === item.view}
              className={`sectionNavigationButton ${settingsView === item.view ? 'active' : ''}`}
              onClick={() => openSettingsView(item.view)}
            >
              <Icon name={item.icon} />
              <span>{t(item.labelKey)}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className={`sectionBody settingsBody ${settingsView === 'account' ? 'accountSettingsBody' : ''}`}>
        {settingsView === 'account' && (
          <AccountTab
            user={user}
            localPasswordLoginEnabled={localPasswordLoginEnabled}
            onUserChange={onUserChange}
            onMessage={onMessage}
            onError={onError}
            onSensitiveAction={runSensitiveAction}
            onAccountDeleted={onAccountDeleted}
            servicePages={servicePages}
            showAccountExport={user.authorWorkspaceEnabled}
          />
        )}
        {settingsView === 'editor' && (
          <EditorSettingsTab
            user={user}
            onUserChange={onUserChange}
            onMessage={onMessage}
            onError={onError}
          />
        )}
        {settingsView === 'security' && (
          <SecurityTab
            user={user}
            onUserChange={onUserChange}
            onMessage={onMessage}
            onError={onError}
            onSensitiveAction={runSensitiveAction}
          />
        )}
        {settingsView === 'author' && (
          user.authorWorkspaceEnabled ? (
            <AuthorProfileTab
              user={user}
              onUserChange={onUserChange}
              onMessage={onMessage}
              onError={onError}
            />
          ) : (
            <div className="settingsStack authorProfileStack authorWorkspaceActivationStage">
              <WorkspaceActivationBanner
                workspace="author"
                presentation="promotional"
                onUserChange={onUserChange}
                onMessage={onMessage}
                onError={onError}
              />
            </div>
          )
        )}
        {settingsView === 'tiers' && <TiersTab />}
        {settingsView === 'storage' && <StorageTab onError={onError} onMessage={onMessage} />}
        {settingsView === 'notifications' && (
          <NotificationSettingsTab onError={onError} onMessage={onMessage} />
        )}
        {settingsView === 'feed' && (
          <FeedSourcesTab
            user={user}
            onUserChange={onUserChange}
            onError={onError}
            onMessage={onMessage}
          />
        )}
      </main>

      {reauthenticationDialog}
    </div>
  )
}
