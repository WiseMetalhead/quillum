export const AUDIO_NOTE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const

export function preferredAudioMimeType(isSupported: (candidate: string) => boolean) {
  return AUDIO_NOTE_MIME_TYPES.find(isSupported) ?? ''
}

export function compressAudioWaveform(values: number[], maximum: number) {
  if (!values.length) return [0]
  const clamped = values.map((value) => Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0)))
  if (values.length <= maximum) {
    return clamped.map(Math.round)
  }
  return Array.from({ length: maximum }, (_, index) => {
    const start = Math.floor((index * clamped.length) / maximum)
    const end = Math.max(start + 1, Math.floor(((index + 1) * clamped.length) / maximum))
    const group = clamped.slice(start, end)
    const squareMean = group.reduce((total, value) => total + value * value, 0) / group.length
    return Math.round(Math.sqrt(squareMean))
  })
}

export function audioWaveformLevel(samples: ArrayLike<number>) {
  if (!samples.length) return 0
  let peak = 0
  let squareSum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    const amplitude = Math.abs(sample)
    peak = Math.max(peak, amplitude)
    squareSum += sample * sample
  }
  const rms = Math.sqrt(squareSum / samples.length)
  const strength = Math.max(rms, peak * 0.25)
  const noiseFloor = 10 ** (-50 / 20)
  if (strength <= noiseFloor) return 0
  const decibels = 20 * Math.log10(strength)
  const normalized = Math.max(0, Math.min(1, (decibels + 50) / 44))
  return Math.round(Math.pow(normalized, 0.85) * 255)
}

export function audioWaveformHeight(value: number) {
  const normalized = Math.max(0, Math.min(1, (Number.isFinite(value) ? value : 0) / 255))
  return Math.max(12, Math.round(Math.pow(normalized, 1.4) * 100))
}

export function formatAudioDuration(valueMs: number) {
  const seconds = Math.max(0, Math.floor(valueMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}
