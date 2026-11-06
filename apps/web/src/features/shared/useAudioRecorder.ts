import { useEffect, useRef, useState } from 'react'
import {
  audioWaveformLevel,
  compressAudioWaveform,
  preferredAudioMimeType,
} from '../books/audioNoteRecording'

const MAX_DURATION_MS = 60 * 60 * 1000

export type AudioRecorderState = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopped' | 'error'
export type AudioRecorderError = 'unsupported' | 'permissionDenied' | 'recordingFailed' | 'emptyRecording'

export type AudioRecordingResult = {
  blob: Blob
  durationMs: number
  waveform: number[]
  source: string
}

type Options = {
  onStopped: (result: AudioRecordingResult) => void
  onError: (error: AudioRecorderError) => void
}

export function useAudioRecorder({ onStopped, onError }: Options) {
  const [state, setState] = useState<AudioRecorderState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [waveform, setWaveform] = useState<number[]>([])
  const [result, setResult] = useState<AudioRecordingResult | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationRef = useRef<number | null>(null)
  const attemptRef = useRef(0)
  const chunksRef = useRef<Blob[]>([])
  const peaksRef = useRef<number[]>([])
  const accumulatedMsRef = useRef(0)
  const segmentStartedRef = useRef(0)
  const sampleAtRef = useRef(0)
  const intentionalStopRef = useRef(false)
  const reducedMotionRef = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const onStoppedRef = useRef(onStopped)
  const onErrorRef = useRef(onError)
  const sourceRef = useRef('')
  onStoppedRef.current = onStopped
  onErrorRef.current = onError

  function stopCaptureResources() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    animationRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
  }

  function cleanupRecorder() {
    intentionalStopRef.current = true
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    stopCaptureResources()
  }

  function fail(error: AudioRecorderError) {
    cleanupRecorder()
    setState('error')
    onErrorRef.current(error)
  }

  function startVisualizer(stream: MediaStream) {
    const context = new AudioContext()
    void context.resume()
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    context.createMediaStreamSource(stream).connect(analyser)
    audioContextRef.current = context
    const samples = new Float32Array(analyser.fftSize)
    function frame(now: number) {
      if (recorderRef.current?.state === 'recording') {
        const currentElapsed = accumulatedMsRef.current + now - segmentStartedRef.current
        setElapsedMs(currentElapsed)
        if (now - sampleAtRef.current >= 50) {
          analyser.getFloatTimeDomainData(samples)
          peaksRef.current.push(audioWaveformLevel(samples))
          if (!reducedMotionRef.current) setWaveform(peaksRef.current.slice(-96))
          sampleAtRef.current = now
        }
        if (currentElapsed >= MAX_DURATION_MS) {
          stop()
          return
        }
      }
      animationRef.current = requestAnimationFrame(frame)
    }
    animationRef.current = requestAnimationFrame(frame)
  }

  async function start() {
    const attempt = attemptRef.current + 1
    attemptRef.current = attempt
    cleanupRecorder()
    if (sourceRef.current) {
      URL.revokeObjectURL(sourceRef.current)
      sourceRef.current = ''
    }
    setResult(null)
    setElapsedMs(0)
    setWaveform([])
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
      fail('unsupported')
      return
    }
    setState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
        },
        video: false,
      })
      if (attemptRef.current !== attempt) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const mimeType = preferredAudioMimeType((candidate) => MediaRecorder.isTypeSupported(candidate))
      if (!mimeType) throw new Error('audio_type_unsupported')
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 })
      streamRef.current = stream
      recorderRef.current = recorder
      intentionalStopRef.current = false
      chunksRef.current = []
      peaksRef.current = []
      accumulatedMsRef.current = 0
      sampleAtRef.current = 0
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data) }
      recorder.onerror = () => fail('recordingFailed')
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (!intentionalStopRef.current) fail('recordingFailed')
        }, { once: true })
      })
      recorder.onstop = () => {
        stopCaptureResources()
        const blob = new Blob(chunksRef.current, { type: (recorder.mimeType || mimeType).split(';', 1)[0] })
        if (!blob.size) {
          fail('emptyRecording')
          return
        }
        const compressed = compressAudioWaveform(peaksRef.current, 256)
        const source = URL.createObjectURL(blob)
        sourceRef.current = source
        const next = {
          blob,
          durationMs: Math.max(1, Math.round(accumulatedMsRef.current)),
          waveform: compressed,
          source,
        }
        setWaveform(compressed)
        setResult(next)
        setState('stopped')
        onStoppedRef.current(next)
      }
      recorder.start(1000)
      segmentStartedRef.current = performance.now()
      setState('recording')
      startVisualizer(stream)
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      if (attemptRef.current === attempt) fail(denied ? 'permissionDenied' : 'recordingFailed')
    }
  }

  function pause() {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== 'recording') return
    accumulatedMsRef.current += performance.now() - segmentStartedRef.current
    setElapsedMs(accumulatedMsRef.current)
    recorder.pause()
    setState('paused')
  }

  function resume() {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== 'paused') return
    segmentStartedRef.current = performance.now()
    recorder.resume()
    setState('recording')
  }

  function stop() {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    if (recorder.state === 'recording') {
      accumulatedMsRef.current += performance.now() - segmentStartedRef.current
    }
    accumulatedMsRef.current = Math.min(MAX_DURATION_MS, Math.max(1, accumulatedMsRef.current))
    setElapsedMs(accumulatedMsRef.current)
    intentionalStopRef.current = true
    recorder.stop()
  }

  function discard() {
    attemptRef.current += 1
    cleanupRecorder()
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current)
    sourceRef.current = ''
    setState('idle')
    setElapsedMs(0)
    setWaveform([])
    setResult(null)
  }

  useEffect(() => () => {
    attemptRef.current += 1
    cleanupRecorder()
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current)
    // Recorder resources intentionally live for the hook lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    state,
    elapsedMs,
    waveform,
    result,
    start,
    pause,
    resume,
    stop,
    discard,
  }
}
