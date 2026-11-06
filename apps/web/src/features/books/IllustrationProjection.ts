type IllustrationProjection = {
  assetId: string
  alt: string
  caption: string
  alignment: string
  displayWidth: number
}

export function illustrationProjection(value: unknown): IllustrationProjection[] {
  const result: IllustrationProjection[] = []

  function visit(candidate: unknown) {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== 'object') return

    const record = candidate as Record<string, unknown>
    if (record.type === 'illustration') {
      const attrs = record.attrs && typeof record.attrs === 'object'
        ? record.attrs as Record<string, unknown>
        : {}
      const width = Number(attrs.displayWidth ?? 80)
      result.push({
        assetId: String(attrs.assetId ?? ''),
        alt: String(attrs.alt ?? ''),
        caption: String(attrs.caption ?? ''),
        alignment: String(attrs.alignment ?? 'center'),
        displayWidth: Number.isFinite(width) ? width : 80,
      })
      return
    }

    Object.values(record).forEach(visit)
  }

  visit(value)
  return result
}
