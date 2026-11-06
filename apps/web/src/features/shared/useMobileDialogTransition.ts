import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const MOBILE_DIALOG_QUERY = '(max-width: 520px)'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const MOBILE_DIALOG_DURATION_MS = 220

type Options = {
  onClose: () => void
  initialFocusRef?: RefObject<HTMLElement | null>
  focusOnDesktop?: boolean
}

export function useMobileDialogTransition({ onClose, initialFocusRef, focusOnDesktop = true }: Options) {
  const [entered, setEntered] = useState(() => !shouldAnimate())
  const [closing, setClosing] = useState(false)
  const dialogElementRef = useRef<HTMLElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const focusTimerRef = useRef<number | null>(null)
  const enterFrameRef = useRef<number | null>(null)
  const enterSecondFrameRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const finishAfterExit = useCallback((complete: () => void) => {
    if (!shouldAnimate()) {
      complete()
      return
    }
    if (closingRef.current) return
    closingRef.current = true
    cancelScheduledEntry()
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      complete()
    }, MOBILE_DIALOG_DURATION_MS)

    function cancelScheduledEntry() {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current)
      if (enterFrameRef.current !== null) window.cancelAnimationFrame(enterFrameRef.current)
      if (enterSecondFrameRef.current !== null) window.cancelAnimationFrame(enterSecondFrameRef.current)
      focusTimerRef.current = null
      enterFrameRef.current = null
      enterSecondFrameRef.current = null
    }
  }, [])

  const close = useCallback(() => {
    finishAfterExit(() => onCloseRef.current())
  }, [finishAfterExit])

  const setDialogRef = useCallback((node: HTMLElement | null) => {
    dialogElementRef.current = node
  }, [])

  useEffect(() => {
    if (!shouldAnimate()) {
      if (focusOnDesktop) initialFocusRef?.current?.focus({ preventScroll: true })
      return
    }

    enterFrameRef.current = window.requestAnimationFrame(() => {
      enterFrameRef.current = null
      enterSecondFrameRef.current = window.requestAnimationFrame(() => {
        enterSecondFrameRef.current = null
        setEntered(true)
      })
    })
    focusTimerRef.current = window.setTimeout(() => {
      focusTimerRef.current = null
      if (!dialogElementRef.current?.contains(document.activeElement)) {
        initialFocusRef?.current?.focus({ preventScroll: true })
      }
    }, MOBILE_DIALOG_DURATION_MS + 60)

    return () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current)
      if (enterFrameRef.current !== null) window.cancelAnimationFrame(enterFrameRef.current)
      if (enterSecondFrameRef.current !== null) window.cancelAnimationFrame(enterSecondFrameRef.current)
    }
  }, [focusOnDesktop, initialFocusRef])

  return {
    backdropStateClass: `${entered ? 'open' : ''} ${closing ? 'closing' : ''}`.trim(),
    close,
    closing,
    setDialogRef,
    finishAfterExit,
  }
}

function shouldAnimate() {
  if (typeof window === 'undefined') return false
  return window.matchMedia(MOBILE_DIALOG_QUERY).matches
    && !window.matchMedia(REDUCED_MOTION_QUERY).matches
}
