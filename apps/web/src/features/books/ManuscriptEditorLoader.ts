type EditorPageModule = {
  default: typeof import('./ManuscriptEditorPage')['ManuscriptEditorPage']
}

let editorPagePromise: Promise<EditorPageModule> | null = null

export function loadManuscriptEditorPage(): Promise<EditorPageModule> {
  editorPagePromise ??= import('./ManuscriptEditorPage').then((module) => ({
    default: module.ManuscriptEditorPage,
  }))
  return editorPagePromise
}

export function preloadManuscriptEditor() {
  void loadManuscriptEditorPage()
}
