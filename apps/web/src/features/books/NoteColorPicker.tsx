import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import './NoteColorPicker.css'

type Hsv = { hue: number; saturation: number; value: number }
type PickerPosition = { left: number; top: number }

const POPOVER_WIDTH = 246
const VIEWPORT_GAP = 8

type Props = {
  value: string
  onChange: (value: string) => void
}

export function NoteColorPicker({ value, onChange }: Props) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<PickerPosition | null>(null)
  const [dragging, setDragging] = useState<'surface' | 'hue' | null>(null)
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(normalizeHex(value) ?? '#dbeafe'))
  const [draftHex, setDraftHex] = useState(() => normalizeHex(value) ?? '#dbeafe')

  useEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const trigger = triggerRef.current
      const popover = popoverRef.current
      if (!trigger || !popover) return
      const anchor = trigger.getBoundingClientRect()
      const height = popover.getBoundingClientRect().height
      const left = clamp(
        anchor.right - POPOVER_WIDTH,
        VIEWPORT_GAP,
        Math.max(VIEWPORT_GAP, window.innerWidth - POPOVER_WIDTH - VIEWPORT_GAP),
      )
      const below = window.innerHeight - anchor.bottom - VIEWPORT_GAP
      const top = below >= height || anchor.top < height + VIEWPORT_GAP
        ? anchor.bottom + VIEWPORT_GAP
        : anchor.top - height - VIEWPORT_GAP
      setPosition({ left, top: Math.max(VIEWPORT_GAP, top) })
    }

    const frame = window.requestAnimationFrame(updatePosition)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    if (!dragging) return
    const updateFromPointer = (event: PointerEvent) => {
      if (dragging === 'surface') updateSurface(event)
      else updateHue(event)
    }
    const stopDragging = () => setDragging(null)
    window.addEventListener('pointermove', updateFromPointer)
    window.addEventListener('pointerup', stopDragging, { once: true })
    return () => {
      window.removeEventListener('pointermove', updateFromPointer)
      window.removeEventListener('pointerup', stopDragging)
    }
  })

  function applyHsv(next: Hsv) {
    const normalized = {
      hue: ((next.hue % 360) + 360) % 360,
      saturation: clamp(next.saturation, 0, 1),
      value: clamp(next.value, 0, 1),
    }
    const hex = hsvToHex(normalized)
    setHsv(normalized)
    setDraftHex(hex)
    onChange(hex)
  }

  function togglePicker() {
    if (!open) {
      const nextHex = normalizeHex(value) ?? '#dbeafe'
      setDraftHex(nextHex)
      setHsv(hexToHsv(nextHex))
      setPosition(null)
    }
    setOpen((current) => !current)
  }

  function updateSurface(event: PointerEvent | ReactPointerEvent<HTMLDivElement>) {
    const surface = surfaceRef.current
    if (!surface) return
    const bounds = surface.getBoundingClientRect()
    applyHsv({
      ...hsv,
      saturation: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      value: 1 - clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
    })
  }

  function updateHue(event: PointerEvent | ReactPointerEvent<HTMLDivElement>) {
    const hue = hueRef.current
    if (!hue) return
    const bounds = hue.getBoundingClientRect()
    applyHsv({ ...hsv, hue: clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * 360 })
  }

  function handleSurfaceKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.05
    if (event.key === 'ArrowRight') applyHsv({ ...hsv, saturation: hsv.saturation + step })
    else if (event.key === 'ArrowLeft') applyHsv({ ...hsv, saturation: hsv.saturation - step })
    else if (event.key === 'ArrowUp') applyHsv({ ...hsv, value: hsv.value + step })
    else if (event.key === 'ArrowDown') applyHsv({ ...hsv, value: hsv.value - step })
    else return
    event.preventDefault()
  }

  function handleHueKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft' && event.key !== 'ArrowDown') return
    applyHsv({ ...hsv, hue: hsv.hue + (event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 5 : -5) })
    event.preventDefault()
  }

  function commitHex() {
    const nextHex = normalizeHex(draftHex)
    if (!nextHex) {
      setDraftHex(hsvToHex(hsv))
      return
    }
    setDraftHex(nextHex)
    setHsv(hexToHsv(nextHex))
    onChange(nextHex)
  }

  const customColor = normalizeHex(value)
  const popoverStyle = position
    ? { left: position.left, top: position.top, visibility: 'visible' as const }
    : { visibility: 'hidden' as const }

  return (
    <div ref={rootRef} className="noteColorPicker">
      <button
        ref={triggerRef}
        type="button"
        className={`spaceButton noteCustomColorTrigger ${customColor ? 'selected' : ''}`}
        aria-label={t('notes.customColor')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={togglePicker}
      />
      {open && (
        <div ref={popoverRef} className="noteColorPopover" role="dialog" aria-label={t('notes.customColorDialog')} style={popoverStyle}>
          <div className="noteColorPopoverHeader">
            <strong>{t('notes.customColorDialog')}</strong>
            <button type="button" className="spaceButton" aria-label={t('notes.closeColorPicker')} onClick={() => setOpen(false)}><Icon name="close-light" /></button>
          </div>
          <div
            ref={surfaceRef}
            className="noteColorSurface"
            role="slider"
            tabIndex={0}
            aria-label={t('notes.colorSaturationBrightness')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv.value * 100)}
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.hue} 100% 50%))` }}
            onPointerDown={(event) => { setDragging('surface'); updateSurface(event) }}
            onKeyDown={handleSurfaceKeyDown}
          >
            <span style={{ left: `${hsv.saturation * 100}%`, top: `${(1 - hsv.value) * 100}%` }} />
          </div>
          <div
            ref={hueRef}
            className="noteColorHue"
            role="slider"
            tabIndex={0}
            aria-label={t('notes.colorHue')}
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.hue)}
            onPointerDown={(event) => { setDragging('hue'); updateHue(event) }}
            onKeyDown={handleHueKeyDown}
          >
            <span style={{ left: `${(hsv.hue / 360) * 100}%` }} />
          </div>
          <label className="noteColorHexField">
            <span>{t('notes.hexColor')}</span>
            <input
              type="text"
              value={draftHex}
              maxLength={7}
              spellCheck={false}
              aria-label={t('notes.hexColor')}
              onChange={(event) => setDraftHex(event.target.value)}
              onBlur={commitHex}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitHex() } }}
            />
          </label>
        </div>
      )}
    </div>
  )
}

function normalizeHex(value: string) {
  const normalized = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized
  if (/^#[0-9a-f]{3}$/.test(normalized)) return `#${normalized.slice(1).split('').map((part) => part + part).join('')}`
  return null
}

function hexToHsv(hex: string): Hsv {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (max === green) hue = 60 * ((blue - red) / delta + 2)
    else hue = 60 * ((red - green) / delta + 4)
  }
  return { hue: (hue + 360) % 360, saturation: max ? delta / max : 0, value: max }
}

function hsvToHex({ hue, saturation, value }: Hsv) {
  const chroma = value * saturation
  const segment = hue / 60
  const second = chroma * (1 - Math.abs((segment % 2) - 1))
  const match = value - chroma
  const [red, green, blue] = segment < 1
    ? [chroma, second, 0]
    : segment < 2
      ? [second, chroma, 0]
      : segment < 3
        ? [0, chroma, second]
        : segment < 4
          ? [0, second, chroma]
          : segment < 5
            ? [second, 0, chroma]
            : [chroma, 0, second]
  return `#${[red, green, blue].map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0')).join('')}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
