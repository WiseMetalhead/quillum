import { useCallback, useEffect, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import type { AdminUserRow, AdminUsersPayload, TierId, UserFilters } from '../../types'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { ResponsiveDetailsPanel } from '../shared/ResponsiveDetailsPanel'
import { useMobileViewport } from '../shared/useMobileViewport'
import { formatBytes, userRoleLabels } from './utils'

const EMPTY_USER_FILTERS: UserFilters = {
  search: '',
  role: '',
  active: '',
}

const USER_PAGE_SIZE = 10
type AdminAction = 'block' | 'unblock' | 'delete'
const tierOptions: TierId[] = ['novice', 'author', 'believer', 'god']

type UsersTabProps = {
  currentUserId: number
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
}

export function UsersTab({ currentUserId, onSensitiveAction }: UsersTabProps) {
  const { t, i18n } = useTranslation()
  const isMobile = useMobileViewport()
  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' })
  const dateTimeFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage)
  const [userFilters, setUserFilters] = useState<UserFilters>(EMPTY_USER_FILTERS)
  const [appliedUserFilters, setAppliedUserFilters] = useState<UserFilters>(EMPTY_USER_FILTERS)
  const [adminUsers, setAdminUsers] = useState<AdminUsersPayload | null>(null)
  const [adminUsersError, setAdminUsersError] = useState('')
  const [adminUsersLoading, setAdminUsersLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [pendingAction, setPendingAction] = useState<{
    action: AdminAction
    user: AdminUserRow
  } | null>(null)
  const [tierTarget, setTierTarget] = useState<AdminUserRow | null>(null)
  const [tierDraft, setTierDraft] = useState<TierId>('novice')
  const [roleTarget, setRoleTarget] = useState<AdminUserRow | null>(null)
  const [roleDraft, setRoleDraft] = useState<'user' | 'superuser'>('user')
  const [actionError, setActionError] = useState('')
  const [actionSubmitting, setActionSubmitting] = useState(false)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)

  const loadAdminUsers = useCallback(async (page: number, filters: UserFilters, preserveSelection = false) => {
    setAdminUsersError('')
    setAdminUsersLoading(true)
    if (!preserveSelection) setSelectedUserId(null)
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(USER_PAGE_SIZE),
    })

    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })

    try {
      const payload = await apiRequest<AdminUsersPayload>(`/api/admin/users/?${params}`)
      setAdminUsers(payload)
    } catch (err) {
      setAdminUsersError(err instanceof Error ? err.message : t('admin.usersLoadFailed'))
    } finally {
      setAdminUsersLoading(false)
    }
  }, [setSelectedUserId, t])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAdminUsers(1, EMPTY_USER_FILTERS)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadAdminUsers])

  function handleUserFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAppliedUserFilters(userFilters)
    void loadAdminUsers(1, userFilters)
  }

  function resetFilters() {
    setUserFilters(EMPTY_USER_FILTERS)
    setAppliedUserFilters(EMPTY_USER_FILTERS)
    void loadAdminUsers(1, EMPTY_USER_FILTERS)
  }

  async function handleAdminAction() {
    if (!pendingAction || !adminUsers) return
    setActionError('')
    setActionSubmitting(true)
    try {
      await apiRequest(`/api/admin/users/${pendingAction.user.id}/${pendingAction.action}/`, {
        method: 'POST',
        body: '{}',
      })
      setPendingAction(null)
      await loadAdminUsers(adminUsers.pagination.page, isMobile ? appliedUserFilters : userFilters, true)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.userActionFailed'))
    } finally {
      setActionSubmitting(false)
    }
  }

  function actionTitle(action: AdminAction) {
    if (action === 'delete') return t('admin.deleteUser')
    return action === 'block' ? t('admin.blockUser') : t('admin.unblockUser')
  }

  function openAdminAction(action: AdminAction, user: AdminUserRow) {
    setActionError('')
    setPendingAction({ action, user })
  }

  function openTierDialog(user: AdminUserRow) {
    setActionError('')
    setTierDraft(user.tier)
    setTierTarget(user)
  }

  async function updateTier() {
    if (!tierTarget || !adminUsers) return
    setActionError('')
    setActionSubmitting(true)
    try {
      await apiRequest(`/api/admin/users/${tierTarget.id}/tier/`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: tierDraft }),
      })
      setTierTarget(null)
      await loadAdminUsers(adminUsers.pagination.page, isMobile ? appliedUserFilters : userFilters, true)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.userActionFailed'))
    } finally {
      setActionSubmitting(false)
    }
  }

  function openRoleDialog(user: AdminUserRow) {
    setActionError('')
    setRoleDraft(user.isSuperuser ? 'superuser' : 'user')
    setRoleTarget(user)
  }

  async function updateRole() {
    if (!roleTarget || !adminUsers) return
    setActionError('')
    setActionSubmitting(true)
    try {
      await onSensitiveAction(() =>
        apiRequest(`/api/admin/users/${roleTarget.id}/role/`, {
          method: 'PATCH',
          body: JSON.stringify({ isSuperuser: roleDraft === 'superuser' }),
        }),
      )
      setRoleTarget(null)
      await loadAdminUsers(adminUsers.pagination.page, isMobile ? appliedUserFilters : userFilters, true)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.userActionFailed'))
    } finally {
      setActionSubmitting(false)
    }
  }

  const selectedUser = adminUsers?.items.find((item) => item.id === selectedUserId) ?? null
  const activeFilterCount = Object.values(appliedUserFilters).filter(Boolean).length

  return (
    <div className="adminUsersLayout">
      <div className="adminUsersMain">
        {!isMobile && (
          <form className="panel auditFilters adminUsersFilters" onSubmit={handleUserFilterSubmit}>
            <div className="adminUsersHeader">
              <div className="adminUsersTitle">
                <Icon name="users-group-two-rounded-light" />
                <div><h2>{t('admin.users')}</h2></div>
              </div>
            </div>
            <UserFiltersFormFields filters={userFilters} onChange={setUserFilters} onReset={resetFilters} />
            {adminUsersError && <div className="notice error inline">{adminUsersError}</div>}
          </form>
        )}

        <section className={`panel adminUsersStats ${isMobile ? 'mobile' : ''}`.trim()} aria-label={t('admin.userStatistics')}>
          {adminUsers ? (
            <>
              <AdminUserStat
                icon="users-light"
                label={t('admin.totalRegistered')}
                value={adminUsers.stats.registered}
                numberFormatter={numberFormatter}
              />
              <AdminUserStat
                icon="user-check-rounded-light"
                tone="active"
                label={t('admin.activeUsers')}
                value={adminUsers.stats.active}
                numberFormatter={numberFormatter}
              />
              <AdminUserStat
                icon="user-cross-rounded-light"
                tone="blocked"
                label={t('admin.blockedUsers')}
                value={adminUsers.stats.blocked}
                numberFormatter={numberFormatter}
              />
            </>
          ) : (
            <div className="adminUsersStatsLoading" role="status" aria-label={t('admin.usersLoading')}>
              <TadpoleIcon />
            </div>
          )}
        </section>

        {isMobile && (
          <button
            type="button"
            className="adminAuditMobileFilterRow adminUsersMobileFilterRow spaceButton"
            aria-haspopup="dialog"
            aria-expanded={mobileFiltersOpen}
            onClick={() => {
              setUserFilters(appliedUserFilters)
              setMobileFiltersOpen(true)
            }}
          >
            <span className="adminAuditMobileFilterIcon"><Icon name="filter-linear" /></span>
            <span>
              <strong>{t('admin.userFilters')}</strong>
              <small>{activeFilterCount
                ? t('admin.userActiveFilters', { count: activeFilterCount })
                : t('admin.userNoActiveFilters')}</small>
            </span>
            <Icon name="arrow-right-2" />
          </button>
        )}

        {isMobile && adminUsersError && <div className="notice error inline">{adminUsersError}</div>}

        <section
          className={isMobile ? 'adminUsersMobileListPanel' : 'panel adminUsersTablePanel'}
          aria-busy={adminUsersLoading}
        >
          <div className={isMobile ? 'adminUsersMobileListViewport' : 'adminUsersTableViewport'}>
            {adminUsersLoading && (
              <div className="adminUsersLoading" role="status" aria-label={t('admin.usersLoading')}>
                <TadpoleIcon />
              </div>
            )}
            {!adminUsersLoading && adminUsers && adminUsers.items.length === 0 && (
              <div className="adminUsersEmpty">
                <Icon name="users-light" />
                <strong>{t('admin.noUsersFound')}</strong>
                <span>{t('admin.noUsersFoundLead')}</span>
              </div>
            )}
            {!isMobile && adminUsers && adminUsers.items.length > 0 && (
              <table className="auditTable adminUsersTable">
                <thead>
                  <tr>
                    <th>{t('admin.user')}</th>
                    <th>{t('admin.email')}</th>
                    <th>{t('admin.role')}</th>
                    <th>{t('admin.state')}</th>
                    <th>{t('admin.tier')}</th>
                    <th>{t('admin.joined')}</th>
                    <th aria-label={t('admin.selectUser')} />
                  </tr>
                </thead>
                <tbody>
                  {adminUsers.items.map((item) => (
                    <tr
                      key={item.id}
                      className={selectedUserId === item.id ? 'selected' : ''}
                      tabIndex={0}
                      onClick={() => setSelectedUserId(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelectedUserId(item.id)
                        }
                      }}
                    >
                      <td>
                        <div className="adminUserTableIdentity">
                          <UserAvatar user={item} />
                          <strong>{item.username}</strong>
                        </div>
                      </td>
                      <td>{item.email || t('admin.none')}</td>
                      <td>
                        <div className="adminUserRoleBadges">
                          {userRoleLabels(item, t).map((label) => <span key={label}>{label}</span>)}
                        </div>
                      </td>
                      <td>
                        <span className={`adminUserStatus ${item.isActive ? 'active' : 'blocked'}`}>
                          {item.isActive ? t('admin.active') : t('admin.inactive')}
                        </span>
                      </td>
                      <td>{item.authorWorkspaceEnabled
                        ? t(`tiers.names.${item.tier}`)
                        : t('admin.notApplicable')}</td>
                      <td>{dateFormatter.format(new Date(item.dateJoined))}</td>
                      <td className="adminUsersRowArrow"><Icon name="arrow-right-2" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {isMobile && !adminUsersLoading && adminUsers && adminUsers.items.length > 0 && (
              <div className="adminUsersMobileList">
                {adminUsers.items.map((item) => (
                  <button
                    type="button"
                    className="adminUsersMobileRow spaceButton"
                    key={item.id}
                    onClick={() => setSelectedUserId(item.id)}
                  >
                    <UserAvatar user={item} />
                    <strong>{item.username}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>
          {!adminUsersLoading && adminUsers && (
            <div className="adminUsersTableFooter">
              <span>
                {t('admin.userPageSummary', {
                  from: adminUsers.pagination.totalItems
                    ? (adminUsers.pagination.page - 1) * adminUsers.pagination.pageSize + 1
                    : 0,
                  to: Math.min(
                    adminUsers.pagination.page * adminUsers.pagination.pageSize,
                    adminUsers.pagination.totalItems,
                  ),
                  total: adminUsers.pagination.totalItems,
                })}
              </span>
              <div className="adminUsersPagination">
                <button
                  type="button"
                  className="adminUsersPageButton spaceButton"
                  disabled={!adminUsers.pagination.hasPrevious}
                  title={t('admin.previous')}
                  aria-label={t('admin.previous')}
                  onClick={() => void loadAdminUsers(
                    adminUsers.pagination.page - 1,
                    isMobile ? appliedUserFilters : userFilters,
                  )}
                >
                  <Icon name="arrow-left-1" />
                </button>
                <span>
                  {t('admin.pageValue', {
                    page: adminUsers.pagination.page,
                    total: adminUsers.pagination.totalPages,
                  })}
                </span>
                <button
                  type="button"
                  className="adminUsersPageButton spaceButton"
                  disabled={!adminUsers.pagination.hasNext}
                  title={t('admin.next')}
                  aria-label={t('admin.next')}
                  onClick={() => void loadAdminUsers(
                    adminUsers.pagination.page + 1,
                    isMobile ? appliedUserFilters : userFilters,
                  )}
                >
                  <Icon name="arrow-right-2" />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <ResponsiveDetailsPanel
        open={Boolean(selectedUser)}
        title={t('admin.userDetails')}
        closeLabel={t('common.close')}
        desktopClassName="adminUserDetailsDialog"
        mobileClassName="adminUserMobileDetails"
        backdropClassName={isMobile ? 'adminUserMobileDetailsBackdrop' : ''}
        desktopDialog
        mobileBackLabel={t('common.back')}
        mobileFullViewTransition
        mobileHeaderAction={selectedUser && selectedUser.id !== currentUserId ? (
          <button
            type="button"
            className={`adminUserMobileHeaderAction spaceButton ${mobileActionsOpen ? 'active' : ''}`.trim()}
            aria-label={t('admin.userActions')}
            aria-haspopup="dialog"
            aria-expanded={mobileActionsOpen}
            onClick={() => setMobileActionsOpen(true)}
          >
            <Icon name="menu-dots-light" />
          </button>
        ) : undefined}
        onClose={() => {
          setMobileActionsOpen(false)
          setSelectedUserId(null)
        }}
      >
        {selectedUser ? (
          <AdminUserDetails
            user={selectedUser}
            currentUserId={currentUserId}
            dateTimeFormatter={dateTimeFormatter}
            numberFormatter={numberFormatter}
            locale={i18n.resolvedLanguage ?? 'en'}
            actionSubmitting={actionSubmitting}
            mobile={isMobile}
            onTier={() => openTierDialog(selectedUser)}
            onRole={() => openRoleDialog(selectedUser)}
            onState={() => openAdminAction(selectedUser.isActive ? 'block' : 'unblock', selectedUser)}
            onDelete={() => openAdminAction('delete', selectedUser)}
          />
        ) : (
          <div className="adminUserDetailsPlaceholder">
            <Icon name="users-group-two-rounded-light" />
            <strong>{t('admin.selectUser')}</strong>
            <span>{t('admin.selectUserLead')}</span>
          </div>
        )}
      </ResponsiveDetailsPanel>

      {mobileFiltersOpen && (
        <MobileSettingsSheet
          title={t('admin.userFilters')}
          onClose={() => {
            setUserFilters(appliedUserFilters)
            setMobileFiltersOpen(false)
          }}
        >
          {(close) => (
            <form
              className="adminUsersMobileFilterForm"
              onSubmit={(event) => {
                handleUserFilterSubmit(event)
                close()
              }}
            >
              <UserFiltersFormFields filters={userFilters} onChange={setUserFilters} mobile />
              <div className="adminUsersMobileFilterActions">
                <button
                  type="button"
                  className="secondary spaceButton"
                  onClick={() => {
                    resetFilters()
                    close()
                  }}
                >
                  <Icon name="restart-light" />
                  {t('admin.resetFilters')}
                </button>
                <button type="submit" className="spaceButton">{t('admin.filterUsers')}</button>
              </div>
            </form>
          )}
        </MobileSettingsSheet>
      )}

      <MobileLibraryActionSheet
        open={mobileActionsOpen && Boolean(selectedUser) && selectedUser?.id !== currentUserId}
        title={selectedUser?.username ?? t('admin.userActions')}
        dismissOnSelect
        onClose={() => setMobileActionsOpen(false)}
        actions={selectedUser ? [
          ...(!selectedUser.isSuperuser && selectedUser.authorWorkspaceEnabled ? [{
            key: 'tier',
            label: t('admin.changeTier'),
            icon: <Icon name="crown-minimalistic-light" />,
            onSelect: () => openTierDialog(selectedUser),
          }] : []),
          ...(selectedUser.authorWorkspaceEnabled ? [{
            key: 'role',
            label: t('admin.changeRole'),
            icon: <Icon name="shield-user-light" />,
            onSelect: () => openRoleDialog(selectedUser),
          }] : []),
          {
            key: 'state',
            label: selectedUser.isActive ? t('admin.blockUser') : t('admin.unblockUser'),
            icon: <Icon name={selectedUser.isActive ? 'lock-light' : 'shield-yes-light'} />,
            onSelect: () => openAdminAction(selectedUser.isActive ? 'block' : 'unblock', selectedUser),
          },
          {
            key: 'delete',
            label: t('admin.deleteUser'),
            icon: <Icon name="trash-bin-trash-light" />,
            danger: true,
            onSelect: () => openAdminAction('delete', selectedUser),
          },
        ] : []}
      />

      {pendingAction && isMobile && (
        <MobileSettingsSheet
          title={actionTitle(pendingAction.action)}
          onClose={() => setPendingAction(null)}
          busy={actionSubmitting}
          role={pendingAction.action === 'delete' ? 'alertdialog' : 'dialog'}
        >
          <div className="adminUserMobileOperation">
            <p>
              {pendingAction.action === 'delete'
                ? t('admin.deleteUserConfirm', { username: pendingAction.user.username })
                : t('admin.userStateConfirm', {
                    action: actionTitle(pendingAction.action),
                    username: pendingAction.user.username,
                  })}
            </p>
            {actionError && <div className="notice error">{actionError}</div>}
            <div className="adminUserMobileOperationActions">
              <button type="button" className="secondary spaceButton" onClick={() => setPendingAction(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`spaceButton ${pendingAction.action === 'delete' ? 'danger' : ''}`.trim()}
                disabled={actionSubmitting}
                onClick={() => void handleAdminAction()}
              >
                {actionSubmitting ? t('admin.applying') : actionTitle(pendingAction.action)}
              </button>
            </div>
          </div>
        </MobileSettingsSheet>
      )}

      {pendingAction && !isMobile && (
        <ActionDialog
          title={actionTitle(pendingAction.action)}
          onClose={() => setPendingAction(null)}
          closeLabel={t('common.close')}
          busy={actionSubmitting}
          variant="compact"
          role={pendingAction.action === 'delete' ? 'alertdialog' : 'dialog'}
        >
          <div className="compactDialogSection">
            <p>
              {pendingAction.action === 'delete'
                ? t('admin.deleteUserConfirm', { username: pendingAction.user.username })
                : t('admin.userStateConfirm', {
                    action: actionTitle(pendingAction.action),
                    username: pendingAction.user.username,
                  })}
            </p>
            {actionError && <div className="notice error">{actionError}</div>}
          </div>
          <footer className="compactDialogFooter">
            <button type="button" className="compactDialogSecondaryAction spaceButton" onClick={() => setPendingAction(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={`compactDialogPrimaryAction spaceButton ${pendingAction.action === 'delete' ? 'danger' : ''}`.trim()}
              disabled={actionSubmitting}
              onClick={() => void handleAdminAction()}
            >
              <Icon name="check-circle-1-light" />
              {actionSubmitting ? t('admin.applying') : actionTitle(pendingAction.action)}
            </button>
          </footer>
        </ActionDialog>
      )}

      {tierTarget && isMobile && (
        <MobileSettingsSheet
          title={t('admin.changeTier')}
          onClose={() => setTierTarget(null)}
          busy={actionSubmitting}
        >
          <div className="adminUserMobileOperation">
            <label className="dialogField">
              <span>{t('admin.tier')}</span>
              <CustomSelect value={tierDraft} onChange={(event) => setTierDraft(event.target.value as TierId)}>
                {tierOptions.map((tier) => (
                  <option key={tier} value={tier}>{t(`tiers.names.${tier}`)}</option>
                ))}
              </CustomSelect>
            </label>
            {actionError && <div className="notice error">{actionError}</div>}
            <div className="adminUserMobileOperationActions">
              <button type="button" className="secondary spaceButton" onClick={() => setTierTarget(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="spaceButton" disabled={actionSubmitting} onClick={() => void updateTier()}>
                {actionSubmitting ? t('admin.applying') : t('admin.changeTier')}
              </button>
            </div>
          </div>
        </MobileSettingsSheet>
      )}

      {tierTarget && !isMobile && (
        <ActionDialog
          title={t('admin.changeTier')}
          onClose={() => setTierTarget(null)}
          closeLabel={t('common.close')}
          busy={actionSubmitting}
          variant="compact"
        >
          <div className="compactDialogSection">
            <label className="dialogField">
              <span>{t('admin.tier')}</span>
              <CustomSelect value={tierDraft} onChange={(event) => setTierDraft(event.target.value as TierId)}>
                {tierOptions.map((tier) => (
                  <option key={tier} value={tier}>{t(`tiers.names.${tier}`)}</option>
                ))}
              </CustomSelect>
            </label>
            {actionError && <div className="notice error">{actionError}</div>}
          </div>
          <footer className="compactDialogFooter">
            <button type="button" className="compactDialogSecondaryAction spaceButton" onClick={() => setTierTarget(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="compactDialogPrimaryAction spaceButton" disabled={actionSubmitting} onClick={() => void updateTier()}>
              <Icon name="check-circle-1-light" />
              {actionSubmitting ? t('admin.applying') : t('admin.changeTier')}
            </button>
          </footer>
        </ActionDialog>
      )}

      {roleTarget && isMobile && (
        <MobileSettingsSheet
          title={t('admin.changeRole')}
          onClose={() => setRoleTarget(null)}
          busy={actionSubmitting}
        >
          <div className="adminUserMobileOperation">
            <label className="dialogField">
              <span>{t('admin.role')}</span>
              <CustomSelect
                value={roleDraft}
                onChange={(event) => setRoleDraft(event.target.value as 'user' | 'superuser')}
              >
                <option value="user">{t('admin.user')}</option>
                <option value="superuser">{t('admin.superuser')}</option>
              </CustomSelect>
            </label>
            {actionError && <div className="notice error">{actionError}</div>}
            <div className="adminUserMobileOperationActions">
              <button type="button" className="secondary spaceButton" onClick={() => setRoleTarget(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="spaceButton" disabled={actionSubmitting} onClick={() => void updateRole()}>
                {actionSubmitting ? t('admin.applying') : t('admin.changeRole')}
              </button>
            </div>
          </div>
        </MobileSettingsSheet>
      )}

      {roleTarget && !isMobile && (
        <ActionDialog
          title={t('admin.changeRole')}
          onClose={() => setRoleTarget(null)}
          closeLabel={t('common.close')}
          busy={actionSubmitting}
          variant="compact"
        >
          <div className="compactDialogSection">
            <label className="dialogField">
              <span>{t('admin.role')}</span>
              <CustomSelect
                value={roleDraft}
                onChange={(event) => setRoleDraft(event.target.value as 'user' | 'superuser')}
              >
                <option value="user">{t('admin.user')}</option>
                <option value="superuser">{t('admin.superuser')}</option>
              </CustomSelect>
            </label>
            {actionError && <div className="notice error">{actionError}</div>}
          </div>
          <footer className="compactDialogFooter">
            <button
              type="button"
              className="compactDialogSecondaryAction spaceButton"
              onClick={() => setRoleTarget(null)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="compactDialogPrimaryAction spaceButton"
              disabled={actionSubmitting}
              onClick={() => void updateRole()}
            >
              <Icon name="check-circle-1-light" />
              {actionSubmitting ? t('admin.applying') : t('admin.changeRole')}
            </button>
          </footer>
        </ActionDialog>
      )}
    </div>
  )
}

function UserFiltersFormFields({
  filters,
  onChange,
  onReset,
  mobile = false,
}: {
  filters: UserFilters
  onChange: (filters: UserFilters) => void
  onReset?: () => void
  mobile?: boolean
}) {
  const { t } = useTranslation()
  const fields = (
    <>
      <label>
        <span>{t('admin.search')}</span>
        <input
          type="search"
          name="search"
          value={filters.search}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
        />
      </label>
      <label>
        <span>{t('admin.role')}</span>
        <CustomSelect
          name="role"
          value={filters.role}
          onChange={(event) => onChange({ ...filters, role: event.target.value })}
        >
          <option value="">{t('admin.any')}</option>
          <option value="writer">{t('admin.user')}</option>
          <option value="editor">{t('admin.editor')}</option>
          <option value="combined">{t('admin.combined')}</option>
          <option value="superuser">{t('admin.superuser')}</option>
        </CustomSelect>
      </label>
      <label>
        <span>{t('admin.state')}</span>
        <CustomSelect
          name="active"
          value={filters.active}
          onChange={(event) => onChange({ ...filters, active: event.target.value })}
        >
          <option value="">{t('admin.any')}</option>
          <option value="active">{t('admin.active')}</option>
          <option value="inactive">{t('admin.inactive')}</option>
        </CustomSelect>
      </label>
    </>
  )

  if (mobile) return fields
  return (
    <div className="adminUsersFilterRow">
      {fields}
      <div className="adminUsersFilterActions">
        <button type="submit" className="adminUsersApplyButton spaceButton">{t('admin.filterUsers')}</button>
        <button
          type="button"
          className="adminUsersResetButton spaceButton"
          onClick={onReset}
        >
          <Icon name="restart-light" />
          {t('admin.resetFilters')}
        </button>
      </div>
    </div>
  )
}

function AdminUserStat({
  icon,
  label,
  value,
  tone = '',
  numberFormatter,
}: {
  icon: 'users-light' | 'user-check-rounded-light' | 'user-cross-rounded-light'
  label: string
  value: number
  tone?: string
  numberFormatter: Intl.NumberFormat
}) {
  return (
    <div className="adminUserStat">
      <Icon name={icon} className={`adminUserStatIcon ${tone}`} />
      <div>
        <span>{label}</span>
        <strong>{numberFormatter.format(value)}</strong>
      </div>
    </div>
  )
}

function UserAvatar({ user }: { user: AdminUserRow }) {
  return user.avatarUrl ? (
    <img className="adminUserAvatar" src={`${API_BASE}${user.avatarUrl}`} alt="" />
  ) : (
    <span className="adminUserAvatar adminUserAvatarFallback">{userInitial(user)}</span>
  )
}

function AdminUserDetails({
  user,
  currentUserId,
  dateTimeFormatter,
  numberFormatter,
  locale,
  actionSubmitting,
  mobile = false,
  onTier,
  onRole,
  onState,
  onDelete,
}: {
  user: AdminUserRow
  currentUserId: number
  dateTimeFormatter: Intl.DateTimeFormat
  numberFormatter: Intl.NumberFormat
  locale: string
  actionSubmitting: boolean
  mobile?: boolean
  onTier: () => void
  onRole: () => void
  onState: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className={`adminUserDetails ${mobile ? 'mobile' : ''}`.trim()}>
      <div className="adminUserIdentityPanel">
        <UserAvatar user={user} />
        <div>
          <strong>{user.username}</strong>
          <span>{user.email || t('admin.none')}</span>
          <div className="adminUserBadges">
            {userRoleLabels(user, t).map((label) => <span key={label}>{label}</span>)}
            <span className={user.isActive ? 'active' : 'blocked'}>
              {user.isActive ? t('admin.active') : t('admin.inactive')}
            </span>
            {user.authorWorkspaceEnabled && <span>{t(`tiers.names.${user.tier}`)}</span>}
          </div>
        </div>
      </div>

      <dl className="adminUserDetailsList">
        <div><dt>{t('admin.id')}</dt><dd>{numberFormatter.format(user.id)}</dd></div>
        <div><dt>{t('admin.name')}</dt><dd>{user.displayName || t('admin.none')}</dd></div>
        <div><dt>{t('admin.manuscripts')}</dt><dd>{numberFormatter.format(user.usage.books)}</dd></div>
        <div>
          <dt>{t('admin.tier')}</dt>
          <dd>{user.authorWorkspaceEnabled
            ? t(`tiers.names.${user.tier}`)
            : t('admin.notApplicable')}</dd>
        </div>
        <div><dt>{t('admin.storage')}</dt><dd>{formatBytes(user.usage.storageBytes, locale)}</dd></div>
        <div><dt>{t('admin.lastActivity')}</dt><dd>{formatDateTime(user.lastActivity, dateTimeFormatter, t)}</dd></div>
        <div><dt>{t('admin.registration')}</dt><dd>{formatDateTime(user.dateJoined, dateTimeFormatter, t)}</dd></div>
      </dl>

      {mobile ? (
        user.id === currentUserId
          ? <p className="muted adminSelfActionNotice">{t('admin.selfActionProhibited')}</p>
          : null
      ) : user.id === currentUserId ? (
        <p className="muted adminSelfActionNotice">{t('admin.selfActionProhibited')}</p>
      ) : (
        <div className="adminUserActions adminUserDetailsActions">
          {!user.isSuperuser && user.authorWorkspaceEnabled && (
            <button type="button" className="adminUserActionPrimary spaceButton" disabled={actionSubmitting} onClick={onTier}>
              <Icon name="crown-minimalistic-light" />
              {t('admin.changeTier')}
            </button>
          )}
          {user.authorWorkspaceEnabled && (
            <button
              type="button"
              className="adminUserActionPrimary spaceButton"
              disabled={actionSubmitting}
              onClick={onRole}
            >
              <Icon name="shield-user-light" />
              {t('admin.changeRole')}
            </button>
          )}
          <button type="button" className="adminUserActionSecondary spaceButton" disabled={actionSubmitting} onClick={onState}>
            <Icon name={user.isActive ? 'lock-light' : 'shield-yes-light'} />
            {user.isActive ? t('admin.blockUser') : t('admin.unblockUser')}
          </button>
          <button type="button" className="adminUserActionDanger spaceButton" disabled={actionSubmitting} onClick={onDelete}>
            <Icon name="trash-bin-trash-light" />
            {t('admin.deleteUser')}
          </button>
        </div>
      )}
    </div>
  )
}

function formatDateTime(
  value: string | null,
  formatter: Intl.DateTimeFormat,
  t: ReturnType<typeof useTranslation>['t'],
) {
  return value ? formatter.format(new Date(value)) : t('common.never')
}

function userInitial(user: AdminUserRow) {
  return (user.displayName || user.username || '?').trim().charAt(0).toUpperCase()
}
