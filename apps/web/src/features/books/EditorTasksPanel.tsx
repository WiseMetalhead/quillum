import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PlannerTasks } from './PlannerTasks'
import type { PlannerData } from './PlannerTypes'

type Props = {
  manuscriptId: string
  selectedItemId: string | null
  planner: PlannerData | null
  onChange: (planner: PlannerData) => void
  onError: (error: string) => void
}

export function EditorTasksPanel({ manuscriptId, selectedItemId, planner, onChange, onError }: Props) {
  const { t } = useTranslation()
  const scopeIds = useMemo(() => {
    if (!planner) return []
    const itemById = new Map(planner.plan.items.map((item) => [item.id, item]))
    let itemId = selectedItemId ?? planner.plan.items.find((item) => item.kind === 'document')?.id ?? null
    const result: string[] = []
    const visited = new Set<string>()
    while (itemId && !visited.has(itemId)) {
      visited.add(itemId)
      result.push(itemId)
      itemId = itemById.get(itemId)?.parentId ?? null
    }
    return result
  }, [planner, selectedItemId])

  if (!planner) return <div className="editorTasksState">{t('editorShell.tasksUnavailable')}</div>

  return <PlannerTasks
    key={scopeIds.join(':')}
    manuscriptId={manuscriptId}
    tasks={planner.tasks}
    items={planner.plan.items}
    variant="editor"
    initialScopeItemIds={scopeIds}
    defaultAssociatedItemId={scopeIds[0]}
    onChange={(tasks) => onChange({ ...planner, tasks })}
    onError={onError}
  />
}
