import { useTranslation } from 'react-i18next'
import type { User, WorkspaceSearchResult } from '../../types'
import { WorkspaceSearch } from './WorkspaceSearch'
import { EDITOR_WORKSPACE_SEARCH_KINDS } from './workspaceSearchConfig'
import './EditorDashboardPage.css'

type Props = {
  user: User
  onOpenSearchResult: (result: WorkspaceSearchResult) => void
}

export function EditorDashboardPage({ user, onOpenSearchResult }: Props) {
  const { t } = useTranslation()
  const displayName = user.displayName.trim() || user.username
  const greetingKey = greetingPeriodKey(new Date().getHours())

  return (
    <main className="editorWorkspaceHome">
      <section className="editorWorkspaceHero" aria-labelledby="editor-workspace-greeting">
        <div className="editorWorkspaceHeroCopy">
          <h1 id="editor-workspace-greeting">
            {t(`dashboard.greetings.${greetingKey}`, { name: displayName })}
          </h1>
          <p>{t('editorDashboard.lead')}</p>
          <WorkspaceSearch
            endpoint="/api/editor/workspace/search/"
            kinds={EDITOR_WORKSPACE_SEARCH_KINDS}
            placeholder={t('editorDashboard.searchPlaceholder')}
            emptyMessage={t('editorDashboard.searchEmpty')}
            onSelect={onOpenSearchResult}
            showAuthor
          />
        </div>
      </section>
    </main>
  )
}

function greetingPeriodKey(hour: number) {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'day'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}
