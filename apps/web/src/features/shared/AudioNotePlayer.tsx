import { useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE } from '../../api/client'
import { Icon } from '../../icons/Icon'
import {
  audioWaveformHeight,
  compressAudioWaveform,
  formatAudioDuration,
} from '../books/audioNoteRecording'
import './AudioNotePlayer.css'

export type AudioPlayback = {
  durationMs: number
  waveform: number[]
  playbackUrl: string
}

type WaveformProps = {
  values: number[]
  progress?: number
  compact?: boolean
  live?: boolean
}

function normalizedBars(values: number[], maximum = 72, stableWidth = false) {
  if (!values.length) return Array.from({ length: stableWidth ? maximum : Math.min(24, maximum) }, () => 18)
  const result = compressAudioWaveform(values, maximum)
  if (!stableWidth || result.length >= maximum) return result
  return [...Array.from({ length: maximum - result.length }, () => 18), ...result]
}

export function AudioWaveform({ values, progress = 0, compact = false, live = false }: WaveformProps) {
  const bars = useMemo(() => normalizedBars(values, compact ? 42 : 96, live), [compact, live, values])
  const renderBars = (active: boolean) => (
    <span className={`audioWaveformBars ${active ? 'active' : ''}`} aria-hidden="true">
      {bars.map((value, index) => (
        <i
          key={index}
          style={{ '--audio-peak': `${audioWaveformHeight(value)}%` } as CSSProperties}
        />
      ))}
    </span>
  )
  return (
    <span className={`audioWaveform ${compact ? 'compact' : ''} ${live ? 'live' : ''}`}>
      {renderBars(false)}
      <span className="audioWaveformPlayed" style={{ '--audio-unplayed': `${100 - Math.max(0, Math.min(100, progress * 100))}%` } as CSSProperties}>
        {renderBars(true)}
      </span>
    </span>
  )
}

export function AudioNotePlayer({
  audio,
  source,
  compact = false,
}: {
  audio: AudioPlayback
  source?: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const elementRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const durationMs = Math.max(1, audio.durationMs)
  const resolvedSource = source ?? `${API_BASE}${audio.playbackUrl}`

  async function togglePlayback() {
    const element = elementRef.current
    if (!element) return
    if (element.paused) {
      try {
        await element.play()
      } catch {
        setPlaying(false)
      }
    } else {
      element.pause()
    }
  }

  function seek(nextMs: number) {
    const element = elementRef.current
    if (!element) return
    element.currentTime = Math.max(0, Math.min(durationMs, nextMs)) / 1000
    setPositionMs(element.currentTime * 1000)
  }

  return (
    <div className={`audioNotePlayer ${compact ? 'compact' : ''}`}>
      <audio
        key={resolvedSource}
        ref={elementRef}
        src={resolvedSource}
        preload="metadata"
        onLoadedMetadata={() => { setPlaying(false); setPositionMs(0) }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPositionMs(0) }}
        onTimeUpdate={(event) => setPositionMs(event.currentTarget.currentTime * 1000)}
      />
      <button
        type="button"
        className="audioNotePlayButton spaceButton"
        aria-label={t(playing ? 'audioNotes.pausePlayback' : 'audioNotes.play')}
        onClick={() => void togglePlayback()}
      >
        <Icon name={playing ? 'pause-light' : 'play-light'} />
      </button>
      <div className="audioNoteTimeline">
        <AudioWaveform
          values={audio.waveform}
          progress={positionMs / durationMs}
          compact={compact}
        />
        {!compact && (
          <input
            type="range"
            min={0}
            max={durationMs}
            step={100}
            value={Math.min(positionMs, durationMs)}
            aria-label={t('audioNotes.seek')}
            onChange={(event) => seek(Number(event.target.value))}
          />
        )}
      </div>
      {!compact && (
        <time className="audioNoteTime">
          {formatAudioDuration(positionMs)} / {formatAudioDuration(durationMs)}
        </time>
      )}
    </div>
  )
}
