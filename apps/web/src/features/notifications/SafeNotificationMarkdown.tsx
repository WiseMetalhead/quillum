import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'

type Props = {
  source: string
  className?: string
}

const allowedElements = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong',
  'ul', 'ol', 'li', 'code', 'pre', 'a',
]

function safeUrlTransform(value: string) {
  if (
    !value.startsWith('//')
    && !/^[a-z][a-z\d+.-]*:/i.test(value)
  ) return value
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
    const url = new URL(value, window.location.origin)
    return url.origin !== window.location.origin
  } catch {
    return false
  }
}

export function SafeNotificationMarkdown({ source, className = '' }: Props) {
  return (
    <div className={`notificationMarkdown ${className}`.trim()}>
      <ReactMarkdown
        allowedElements={allowedElements}
        skipHtml
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
                onClick={(event) => event.stopPropagation()}
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
