import { useEffect, useRef, useState } from 'react'
import type { ImgHTMLAttributes } from 'react'

import { cachedPrivateMediaUrl, loadPrivateMedia } from './privateMediaCache'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string
}

type ResolvedSource = {
  requested: string
  value: string
}

export function PrivateImage({ src, loading, ...props }: Props) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [visibleSource, setVisibleSource] = useState(loading === 'lazy' ? '' : src)
  const shouldLoad = loading !== 'lazy'
    || !('IntersectionObserver' in window)
    || visibleSource === src
  const [resolved, setResolved] = useState<ResolvedSource>(() => ({
    requested: src,
    value: cachedPrivateMediaUrl(src) ?? '',
  }))
  const currentValue = resolved.requested === src
    ? resolved.value
    : cachedPrivateMediaUrl(src) ?? ''

  useEffect(() => {
    if (loading !== 'lazy' || !('IntersectionObserver' in window) || visibleSource === src) return
    const image = imageRef.current
    if (!image) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setVisibleSource(src)
        observer.disconnect()
      },
      { rootMargin: '320px' },
    )
    observer.observe(image)
    return () => observer.disconnect()
  }, [loading, src, visibleSource])

  useEffect(() => {
    if (!shouldLoad) return
    let active = true
    const cached = cachedPrivateMediaUrl(src)
    if (cached) {
      return () => {
        active = false
      }
    }

    void loadPrivateMedia(src)
      .then((value) => {
        if (active) setResolved({ requested: src, value })
      })
      .catch(() => {
        if (active) setResolved({ requested: src, value: src })
      })
    return () => {
      active = false
    }
  }, [shouldLoad, src])

  return <img {...props} ref={imageRef} src={currentValue || undefined} loading={loading} />
}
