import type { JSONContent } from '@tiptap/core'
import type { ReactNode } from 'react'

type Props = {
  content: JSONContent
  className: string
}

export function NoteContentPreview({ content, className }: Props) {
  const blocks = (content.content ?? []).filter((node) => node.type !== 'illustration')
  if (!blocks.length) return null
  return <div className={className}>{blocks.map(renderBlock)}</div>
}

function renderBlock(node: JSONContent, index: number): ReactNode {
  if (node.type === 'paragraph') return <p key={index}>{(node.content ?? []).map(renderInline)}</p>
  if (node.type === 'bulletList') return <ul key={index}>{(node.content ?? []).map((item, itemIndex) => <li key={itemIndex}>{(item.content ?? []).map((paragraph, paragraphIndex) => <span key={paragraphIndex}>{(paragraph.content ?? []).map(renderInline)}</span>)}</li>)}</ul>
  if (node.type === 'taskList') return <ul key={index} className="noteTaskList">{(node.content ?? []).map((item, itemIndex) => {
    const checked = item.attrs?.checked === true
    return <li key={itemIndex} className={checked ? 'checked' : ''}><span className="noteTaskCheck" aria-hidden="true">{checked ? '✓' : ''}</span><span>{(item.content ?? []).map((paragraph, paragraphIndex) => <span key={paragraphIndex}>{(paragraph.content ?? []).map(renderInline)}</span>)}</span></li>
  })}</ul>
  return null
}

function renderInline(node: JSONContent, index: number): ReactNode {
  if (node.type === 'hardBreak') return <br key={index} />
  if (node.type !== 'text') return null
  let rendered: ReactNode = node.text ?? ''
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') rendered = <strong>{rendered}</strong>
    if (mark.type === 'italic') rendered = <em>{rendered}</em>
    if (mark.type === 'strike') rendered = <s>{rendered}</s>
  }
  return <span key={index}>{rendered}</span>
}
