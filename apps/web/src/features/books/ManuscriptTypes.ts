export type Manuscript = {
  id: string
  kind: 'oneshot' | 'book'
  status: 'new' | 'in_progress' | 'complete'
  title: string
  synopsis: string
  language: string
  genres: string[]
  documentId: string | null
  structureGeneration: number
  coverThumbnailSmallUrl: string
  coverThumbnailMediumUrl: string
  coverVersion: string
  coverWidth: number | null
  coverHeight: number | null
  createdAt: string
  updatedAt: string
}

export type Series = {
  id: string
  kind: 'series'
  title: string
  synopsis: string
  bookCount: number
  coverThumbnailSmallUrl: string
  coverThumbnailMediumUrl: string
  coverVersion: string
  coverWidth: number | null
  coverHeight: number | null
  createdAt: string
  updatedAt: string
}

export type SeriesBook = Manuscript & {
  kind: 'book'
  seriesPosition: number | null
}

export type LibraryItem = Manuscript | Series

export type AvailableManuscript = Pick<
  Manuscript,
  | 'id'
  | 'kind'
  | 'status'
  | 'title'
  | 'synopsis'
  | 'coverThumbnailSmallUrl'
  | 'coverThumbnailMediumUrl'
  | 'coverVersion'
  | 'coverWidth'
  | 'coverHeight'
  | 'createdAt'
  | 'updatedAt'
> & {
  author: {
    displayName: string
    username: string
    avatarUrl: string
  }
}

export type EditorGrantIdentity = {
  connectionId: number
  displayName: string
  username: string
  avatarUrl: string
}

export type ManuscriptEditorGrant = {
  id: string
  editor: EditorGrantIdentity
  grantedAt: string
}

export type ManuscriptEditorGrantState = {
  eligibleEditors: EditorGrantIdentity[]
  grants: ManuscriptEditorGrant[]
}

export type DrawerItem = LibraryItem & {
  drawerAt: string
}
