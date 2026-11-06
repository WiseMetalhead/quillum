export type PlannerSettings = {
  deadline: string | null
  dailyWordGoal: number
  manuscriptWordGoal: number
}

export type PlannerStatus = {
  id: string
  name: string
  color: string
  position: number
  countsAsComplete: boolean
}

export type PlannerItem = {
  id: string
  parentId: string | null
  kind: 'folder' | 'document'
  title: string
  position: number
  role: 'untyped' | 'act' | 'chapter' | 'scene'
  synopsis: string
  deadline: string | null
  wordGoal: number
  statusId: string | null
  completedDate: string | null
  wordCount: number
}

export type PlannerTaskPriority = 'low' | 'medium' | 'high'

export type PlannerTask = {
  id: string
  title: string
  description: string
  deadline: string | null
  priority: PlannerTaskPriority
  associatedItemId: string | null
  pinned: boolean
  completed: boolean
  createdAt: string
  updatedAt: string
}

export type PlannerContestPhase = {
  key: string
  kind: string
  label: string
  startsOn: string | null
  endsOn: string | null
  deadlineAt: string | null
  precision: 'exact' | 'month' | 'month_range' | 'approximate'
}

export type PlannerContestDeadline = {
  contestId: string
  contestTitle: string
  phases: PlannerContestPhase[]
}

export type PlannerData = {
  manuscriptTitle: string
  settings: PlannerSettings
  statistics: {
    today: string
    wordsToday: number
    totalWords: number
  }
  plan: {
    items: PlannerItem[]
    statuses: PlannerStatus[]
    structureGeneration: number
    plannerGeneration: number
  }
  tasks: PlannerTask[]
  contestDeadlines: PlannerContestDeadline[]
}
