import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TadpoleIcon from '~icons/svg-spinners/tadpole'
import { ApiError, apiRequest } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type { AdminMaintenancePayload, AdminMaintenanceRun } from '../../types'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'

type MaintenanceAction = 'news' | 'contests'

type MaintenanceTabProps = {
  onMessage: (message: string) => void
  onError: (message: string) => void
}

const POLL_INTERVAL_MS = 1_500
const WATCHED_TASKS_STORAGE_KEY = 'quillum.adminMaintenance.watchedTasks'
const ACTIVE_STATUSES = new Set(['running', 'retrying'])
const ACTIONS: Array<{ id: MaintenanceAction; icon: IconName }> = [
  { id: 'news', icon: 'document-light' },
  { id: 'contests', icon: 'cup-star-light' },
]

function isActive(run: AdminMaintenanceRun | null) {
  return run !== null && ACTIVE_STATUSES.has(run.status)
}

function storedWatchedTaskIds() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(WATCHED_TASKS_STORAGE_KEY) ?? '[]')
    return new Set<string>(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
  } catch {
    return new Set<string>()
  }
}

export function MaintenanceTab({ onMessage, onError }: MaintenanceTabProps) {
  const { t } = useTranslation()
  const [payload, setPayload] = useState<AdminMaintenancePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const watchedTaskIds = useRef(storedWatchedTaskIds())

  const persistWatchedTaskIds = useCallback(() => {
    try {
      window.sessionStorage.setItem(
        WATCHED_TASKS_STORAGE_KEY,
        JSON.stringify(Array.from(watchedTaskIds.current)),
      )
    } catch {
      // The live status still works when session storage is unavailable.
    }
  }, [])

  const applyPayload = useCallback((nextPayload: AdminMaintenancePayload, announce: boolean) => {
    for (const action of ACTIONS) {
      const run = nextPayload.actions[action.id]
      if (run !== null && isActive(run)) {
        watchedTaskIds.current.add(run.taskId)
        persistWatchedTaskIds()
        continue
      }
      if (!announce || run === null || !watchedTaskIds.current.has(run.taskId)) continue
      watchedTaskIds.current.delete(run.taskId)
      persistWatchedTaskIds()
      if (run.status === 'succeeded') {
        onMessage(t(`adminMaintenance.${action.id}.success`))
      } else {
        onError(t(`adminMaintenance.${action.id}.failed`))
      }
    }
    setPayload(nextPayload)
  }, [onError, onMessage, persistWatchedTaskIds, t])

  const loadStatus = useCallback(async (announce = true, reportError = false) => {
    try {
      const nextPayload = await apiRequest<AdminMaintenancePayload>('/api/admin/maintenance/')
      applyPayload(nextPayload, announce)
    } catch {
      if (reportError) {
        onError(t('adminMaintenance.loadFailed'))
      }
    } finally {
      setLoading(false)
    }
  }, [applyPayload, onError, t])

  useEffect(() => {
    let active = true
    void apiRequest<AdminMaintenancePayload>('/api/admin/maintenance/')
      .then((nextPayload) => {
        if (active) applyPayload(nextPayload, true)
      })
      .catch(() => {
        if (active) onError(t('adminMaintenance.loadFailed'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [applyPayload, onError, t])

  const hasActiveAction = useMemo(
    () => payload !== null && ACTIONS.some((action) => isActive(payload.actions[action.id])),
    [payload],
  )

  useEffect(() => {
    if (!hasActiveAction) return undefined
    const intervalId = window.setInterval(() => {
      void loadStatus(true, false)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [hasActiveAction, loadStatus])

  async function runAction(action: MaintenanceAction) {
    if (isActive(payload?.actions[action] ?? null)) return
    try {
      const response = await apiRequest<{ action: MaintenanceAction; run: AdminMaintenanceRun }>(
        `/api/admin/maintenance/${action}/refresh/`,
        { method: 'POST' },
      )
      watchedTaskIds.current.add(response.run.taskId)
      persistWatchedTaskIds()
      applyPayload(
        {
          actions: {
            news: action === 'news' ? response.run : payload?.actions.news ?? null,
            contests: action === 'contests' ? response.run : payload?.actions.contests ?? null,
          },
        },
        true,
      )
    } catch (error) {
      if (error instanceof ApiError && error.code === 'maintenance_already_running') {
        onError(t('adminMaintenance.alreadyRunning'))
        await loadStatus(false, false)
        return
      }
      onError(t('adminMaintenance.queueFailed'))
    }
  }

  if (loading && payload === null) {
    return <TadpoleLoadingState className="adminSettingsLoading" label={t('adminMaintenance.loading')} />
  }

  return (
    <section className="panel adminMaintenancePanel">
      <header className="adminSettingsSectionHeader adminMaintenanceHeader">
        <Icon name="sledgehammer-light" />
        <h2>{t('adminMaintenance.title')}</h2>
      </header>
      <p className="adminSettingsSectionLead">{t('adminMaintenance.description')}</p>

      <div className="adminMaintenanceList" role="list">
        {ACTIONS.map((action) => {
          const running = isActive(payload?.actions[action.id] ?? null)
          return (
            <div className="adminMaintenanceRow" role="listitem" key={action.id}>
              <span className="adminMaintenanceRowIcon" aria-hidden="true">
                <Icon name={action.icon} />
              </span>
              <span className="adminMaintenanceRowCopy">
                <strong>{t(`adminMaintenance.${action.id}.title`)}</strong>
                <small>{t(`adminMaintenance.${action.id}.description`)}</small>
              </span>
              <button
                type="button"
                className="adminMaintenanceAction spaceButton"
                disabled={running}
                aria-busy={running}
                aria-label={t(
                  running
                    ? 'adminMaintenance.refreshingAction'
                    : 'adminMaintenance.refreshAction',
                  { title: t(`adminMaintenance.${action.id}.title`) },
                )}
                onClick={() => void runAction(action.id)}
              >
                {running ? (
                  <TadpoleIcon />
                ) : (
                  <>
                    <Icon name="restart-light" className="adminMaintenanceDesktopActionIcon" />
                    <Icon name="play-light" className="adminMaintenanceMobileActionIcon" />
                  </>
                )}
                <span>
                  {t(running ? 'adminMaintenance.refreshing' : 'adminMaintenance.refresh')}
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
