export type RateLimitUnit = 'second' | 'minute' | 'hour' | 'day'

export type RateLimitDraft = {
  count: string
  period: string
  unit: RateLimitUnit
}

const RATE_LIMIT_PATTERN = /^(\d+)\s*\/\s*(\d+)?(s|m|h|d|second|minute|hour|day)s?$/i

const unitAliases: Record<string, RateLimitUnit> = {
  s: 'second',
  second: 'second',
  m: 'minute',
  minute: 'minute',
  h: 'hour',
  hour: 'hour',
  d: 'day',
  day: 'day',
}

const unitAbbreviations: Record<RateLimitUnit, string> = {
  second: 's',
  minute: 'm',
  hour: 'h',
  day: 'd',
}

export const rateLimitUnits = Object.freeze<RateLimitUnit[]>([
  'second',
  'minute',
  'hour',
  'day',
])

export function parseRateLimit(value: string): RateLimitDraft | null {
  const match = RATE_LIMIT_PATTERN.exec(value.trim())
  if (!match) return null
  const unit = unitAliases[match[3].toLowerCase()]
  if (!unit) return null
  return {
    count: match[1],
    period: match[2] ?? '1',
    unit,
  }
}

export function serializeRateLimit(value: RateLimitDraft): string {
  const count = value.count.trim()
  const period = value.period.trim()
  if (period === '1') return `${count}/${value.unit}`
  return `${count}/${period}${unitAbbreviations[value.unit]}`
}
