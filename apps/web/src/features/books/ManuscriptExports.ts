import type { Manuscript } from './ManuscriptTypes'

export type ManuscriptExportFormat = 'markdown' | 'epub2' | 'epub3' | 'docx' | 'odt' | 'fb2'

export type ManuscriptExportStatus = 'pending' | 'building' | 'ready' | 'failed' | 'expired'

export type ManuscriptExportTreeNode = {
  id: string
  kind: 'folder' | 'document'
  title: string
  statusId: string | null
  selected: boolean
  selectedDocumentCount: number
  documentCount: number
  children: ManuscriptExportTreeNode[]
}

export type ManuscriptExportPlanStatus = {
  id: string
  name: string
  color: string
  countsAsComplete: boolean
}

export type ManuscriptExportPlan = {
  manuscript: Manuscript
  defaultSelectedItemIds: string[]
  tree: ManuscriptExportTreeNode[]
  statuses: ManuscriptExportPlanStatus[]
}

export type ManuscriptExportJob = {
  id: string
  manuscriptId: string
  format: 'markdown' | 'epub' | 'docx' | 'odt' | 'fb2'
  epubVersion: number | null
  status: ManuscriptExportStatus
  fileName: string
  byteSize: number
  errorCode: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  downloadUrl: string
}
