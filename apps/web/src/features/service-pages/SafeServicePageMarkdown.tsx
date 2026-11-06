import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'

type Props = {
  source: string
}

const allowedElements = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'hr', 'br',
]

function safeUrlTransform(value: string) {
  if (!value.startsWith('//') && !/^[a-z][a-z\d+.-]*:/i.test(value)) {
    return value
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? defaultUrlTransform(value)
      : ''
  } catch {
    return ''
  }
}

function isExternalUrl(value: string | undefined) {
  if (!value) return false
  try {
    return new URL(value, window.location.origin).origin !== window.location.origin
  } catch {
    return false
  }
}

export function SafeServicePageMarkdown({ source }: Props) {
  return (
    <div className="servicePageMarkdown">
      <ReactMarkdown
        allowedElements={allowedElements}
        skipHtml
        unwrapDisallowed
        urlTransform={safeUrlTransform}
        components={{
          a: ({ href, children, ...props }) => {
            const external = isExternalUrl(href)
            return (
              <a
                {...props}
                href={href}
                target={external ? '_blank' : undefined}
                rel={external ? 'noreferrer' : undefined}
              >
                {children}
              </a>
            )
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
