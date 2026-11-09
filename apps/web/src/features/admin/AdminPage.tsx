import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons/Icon'
import type { AdminView, User } from '../../types'
import { MobileSectionSelector } from '../shared/MobileSectionSelector'
import { SectionSidebarToggle } from '../shared/SectionSidebarToggle'
import { useSensitiveAction } from '../shared/useSensitiveAction'
import { AuditLogTab } from './AuditLogTab'
import { MaintenanceTab } from './MaintenanceTab'
import { SettingsTab } from './SettingsTab'
import { StatusTab } from './StatusTab'
import { UsersTab } from './UsersTab'
import { NotificationsTestTab } from './NotificationsTestTab'
import { ServicePagesTab } from './ServicePagesTab'
import './AdminPage.css'

const adminNavigation: Array<{ view: AdminView; labelKey: string; icon: IconName }> = [
  { view: 'status', labelKey: 'admin.status', icon: 'pulse-light' },
  { view: 'settings', labelKey: 'admin.settings', icon: 'settings-light' },
  { view: 'maintenance', labelKey: 'admin.maintenance', icon: 'sledgehammer-light' },
  { view: 'audit', labelKey: 'admin.auditLog', icon: 'clipboard-list-light' },
  { view: 'users', labelKey: 'admin.users', icon: 'users-light' },
  { view: 'notifications', labelKey: 'admin.notifications', icon: 'bell-light' },
  { view: 'servicePages', labelKey: 'admin.servicePages', icon: 'file-document-light' },
]

type AdminPageProps = {
  user: User
  onMessage: (message: string) => void
  onError: (message: string) => void
  onServicePagesChange: () => Promise<void>
}

export function AdminPage({ user, onMessage, onError, onServicePagesChange }: AdminPageProps) {
  const { t } = useTranslation()
  const [adminView, setAdminView] = useState<AdminView>('status')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { runSensitiveAction, reauthenticationDialog } = useSensitiveAction()
  const stackClass =
    adminView === 'notifications'
      ? 'adminNotificationsStack'
      : adminView === 'servicePages'
        ? 'adminServicePagesStack'
        : adminView === 'users'
          ? 'adminUsersStack'
          : adminView === 'audit'
            ? 'adminAuditStack'
            : adminView === 'settings'
              ? 'adminSettingsPageStack'
              : adminView === 'maintenance'
                ? 'adminMaintenanceStack'
                : 'adminStatusStack'
  if (!user.isSuperuser) {
    return (
      <div className="panel">
        <h2>{t('admin.title')}</h2>
        <p>{t('admin.permissionsRequired')}</p>
      </div>
    )
  }

  return (
    <div className={`sidebarPage adminPage collapsibleSidebarPage ${sidebarCollapsed ? 'sidebarCollapsed' : ''}`.trim()}>
      <MobileSectionSelector
        items={adminNavigation.map((item) => ({
          id: item.view,
          label: t(item.labelKey),
          icon: item.icon,
        }))}
        activeId={adminView}
        ariaLabel={t('admin.navigation')}
        onSelect={setAdminView}
      />

      <aside className="sectionSidebar adminSidebar collapsibleSectionSidebar" aria-label={t('admin.navigation')}>
        <nav className="sectionNavigation adminNavigation" role="tablist" aria-label={t('admin.views')}>
          {adminNavigation.map((item) => (
            <button
              key={item.view}
              type="button"
              role="tab"
              title={t(item.labelKey)}
              aria-selected={adminView === item.view}
              className={`sectionNavigationButton ${adminView === item.view ? 'active' : ''}`}
              onClick={() => setAdminView(item.view)}
            >
              <Icon name={item.icon} />
              <span>{t(item.labelKey)}</span>
            </button>
          ))}
        </nav>
        <SectionSidebarToggle
          collapsed={sidebarCollapsed}
          collapseLabel={t('common.collapseSidebar')}
          expandLabel={t('common.expandSidebar')}
          onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
        />
      </aside>

      <main className="sectionBody adminBody">
        <div className={`adminStack ${stackClass}`}>
          {adminView === 'status' && <StatusTab onOpenAudit={() => setAdminView('audit')} />}
          {adminView === 'settings' && <SettingsTab onSensitiveAction={runSensitiveAction} />}
          {adminView === 'maintenance' && (
            <MaintenanceTab onMessage={onMessage} onError={onError} />
          )}
          {adminView === 'audit' && <AuditLogTab />}
          {adminView === 'users' && (
            <UsersTab
              currentUserId={user.id}
              onSensitiveAction={runSensitiveAction}
            />
          )}
          {adminView === 'notifications' && (
            <NotificationsTestTab
              onSensitiveAction={runSensitiveAction}
              onMessage={onMessage}
              onError={onError}
            />
          )}
          {adminView === 'servicePages' && (
            <ServicePagesTab
              onSensitiveAction={runSensitiveAction}
              onMessage={onMessage}
              onError={onError}
              onPublishedChange={onServicePagesChange}
            />
          )}
        </div>
      </main>
      {reauthenticationDialog}
    </div>
  )
}
