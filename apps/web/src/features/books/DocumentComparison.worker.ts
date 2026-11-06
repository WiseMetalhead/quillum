/// <reference lib="webworker" />

import type { JSONContent } from '@tiptap/core'
import { compareDocuments } from './DocumentComparisonEngine'

type ComparisonRequest = {
  id: number
  left: JSONContent
  right: JSONContent
}

self.addEventListener('message', (event: MessageEvent<ComparisonRequest>) => {
  const { id, left, right } = event.data
  try {
    self.postMessage({ id, result: compareDocuments(left, right) })
  } catch {
    self.postMessage({ id, error: 'comparison_failed' })
  }
})

export {}
