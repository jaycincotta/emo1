import { useCallback, useEffect, useRef, useState } from 'react';
import { SOLFEGE_MAP } from '../solfege';

export interface InstrumentMetrics {
  attempts: number;
  exactCorrect: number; // correct pitch & octave
  nearMiss: number;     // correct syllable (pitch class relative to key) but wrong octave
  firstTryExact: number;
  firstTryNearMiss: number;
  streak: number;
  keyChanges: number;
  startedAt: number;
  totalExactTimeMs: number; // time from target reveal to exact match (aggregate)
}

export interface InstrumentModeState {
  active: boolean;
  loadingDetector: boolean;
  error?: string;
  metrics: InstrumentMetrics;
  targetNote: number | null;
  modeKey: string; // current key center
  listening: boolean;
  devices: { deviceId: string; label: string }[];
  selectedDeviceId: string | null;
  amplitude: number; // recent RMS level (0..~1)
}

export interface UseInstrumentModeOptions {
  getKeyRootMidi: () => number;
  chooseRandomNote: () => number | null;
  scheduleCadence: (keyOverride?: string) => number; // returns cadence length seconds
  playNote: (midi: number, dur?: number) => void;
  keyCenterRef: React.MutableRefObject<string>;
  onAutoKeyChange?: (newKey: string) => void;
  streakTarget?: number;
  getAudioContext?: () => AudioContext | null;
}

interface DetectionModule {
  // shape of pitchy dynamic import (only what we need)
  PitchDetector: any;
  default?: any;
}

const initialMetrics = (): InstrumentMetrics => ({
  attempts: 0,
  exactCorrect: 0,
  nearMiss: 0,
  firstTryExact: 0,
  firstTryNearMiss: 0,
  streak: 0,
  keyChanges: 0,
  startedAt: performance.now(),
  totalExactTimeMs: 0,
});

export function useInstrumentMode(opts: UseInstrumentModeOptions) {
  const { getKeyRootMidi, chooseRandomNote, scheduleCadence, playNote, keyCenterRef, onAutoKeyChange, streakTarget = 10 } = opts;
  const [state, setState] = useState<InstrumentModeState>({
    active: false,
    loadingDetector: false,
    metrics: initialMetrics(),
    targetNote: null,
    modeKey: keyCenterRef.current,
    listening: false,
  devices: [],
  selectedDeviceId: null,
  amplitude: 0,
  });
  const detectorModRef = useRef<DetectionModule | null>(null);
  const targetStartRef = useRef<number>(0);
  const firstAttemptRef = useRef<boolean>(true);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufRef = useRef<Float32Array | null>(null);
  const detectTimerRef = useRef<number | null>(null);
  const stableMidiRef = useRef<number | null>(null);
  const stableCountRef = useRef(0);
  const lastClassifyTimeRef = useRef<number>(0);
  const suppressMicUntilRef = useRef<number>(0);
  const pitchDetectorRef = useRef<any>(null);
  const lastDetectedMidiRef = useRef<number | null>(null);
  const lastAmpUpdateRef = useRef<number>(0);

  // Configurable thresholds (could expose later)
  const STABLE_FRAMES = 3; // required consecutive identical midi estimates
  const MIN_CLARITY = 0.82; // pitchy clarity threshold (tunable)
  const AMP_THRESHOLD = 0.004; // RMS amplitude to ignore silence/background
  const CLASSIFY_COOLDOWN_MS = 450;
  const SUPPRESS_AFTER_TARGET_MS = 850; // ignore mic immediately after playing target to avoid speaker bleed

  const resetMetrics = useCallback(() => {
    setState(s => ({ ...s, metrics: initialMetrics(), targetNote: null }));
  }, []);

  // Lazy-load pitch detection lib only when needed
  const ensureDetector = useCallback(async () => {
    if (detectorModRef.current) return;
    setState(s => ({ ...s, loadingDetector: true }));
    try {
  const mod: any = await import('pitchy');
  detectorModRef.current = mod;
    } catch (e:any) {
      setState(s => ({ ...s, error: 'Failed to load detector', loadingDetector: false }));
      return;
    }
    setState(s => ({ ...s, loadingDetector: false }));
  }, []);

  const stopDetectionLoop = useCallback(() => {
    if (detectTimerRef.current) {
      cancelAnimationFrame(detectTimerRef.current);
      detectTimerRef.current = null;
    }
  }, []);

  const cleanupStream = useCallback(() => {
    stopDetectionLoop();
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    analyserRef.current = null;
    bufRef.current = null;
    setState(s => ({ ...s, listening: false }));
  }, [stopDetectionLoop]);

  const enumerateInputs = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }));
      if ((window as any).__DEBUG_PITCH) console.debug('[mic] inputs', inputs);
      setState(s => {
        let selected = s.selectedDeviceId;
        if (!selected) {
          const nonKrisp = inputs.find(i => !/krisp/i.test(i.label));
          selected = nonKrisp?.deviceId || inputs[0]?.deviceId || null;
        }
        return { ...s, devices: inputs, selectedDeviceId: selected };
      });
    } catch (e) {
      if ((window as any).__DEBUG_PITCH) console.warn('[mic] enumerate failed', e);
    }
  }, []);

  const freqToMidi = (f: number) => Math.round(69 + 12 * Math.log2(f / 440));

  const detectionStep = useCallback(() => {
    const analyser = analyserRef.current;
    const detector = detectorModRef.current;
    if (analyser && detector) {
  if (!bufRef.current) bufRef.current = new Float32Array(analyser.fftSize as number);
  const buf = bufRef.current as Float32Array;
  // Cast analyser to any to avoid TS lib mismatch edge case
  (analyser as any).getFloatTimeDomainData(buf);
      // Compute RMS amplitude
      let sum = 0;
      for (let i=0;i<buf.length;i++){ const v = buf[i]; sum += v*v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (now - lastAmpUpdateRef.current > 120) {
        lastAmpUpdateRef.current = now;
        setState(s => ({ ...s, amplitude: rms }));
      }
  if (rms > AMP_THRESHOLD) {
        if ((window as any).__DEBUG_PITCH) console.debug('[pitch] RMS', rms.toFixed(4));
        try {
          const sampleRate = analyser.context.sampleRate;
            if (!pitchDetectorRef.current) {
              pitchDetectorRef.current = detector.PitchDetector.forFloat32Array(buf.length);
              // slightly lower min volume to allow softer singing
              try { pitchDetectorRef.current.minVolumeDecibels(-55); } catch {}
              try { pitchDetectorRef.current.clarityThreshold = MIN_CLARITY; } catch {}
            }
            const [pitch, clarity] = pitchDetectorRef.current.findPitch(buf, sampleRate);
            if (clarity >= MIN_CLARITY && pitch > 40 && pitch < 2500) {
              const midi = freqToMidi(pitch);
              lastDetectedMidiRef.current = midi;
              if ((window as any).__DEBUG_PITCH) console.debug('[pitch] candidate', { pitch: pitch.toFixed(2), clarity: clarity.toFixed(3), midi });
              // Only attempt classification when mode is active (target chosen)
              if (state.active) {
                const now = performance.now();
                if (now > suppressMicUntilRef.current) {
                  if (stableMidiRef.current === midi) {
                    stableCountRef.current += 1;
                  } else {
                    stableMidiRef.current = midi;
                    stableCountRef.current = 1;
                  }
                  if ((window as any).__DEBUG_PITCH) console.debug('[pitch] stability', { midi: stableMidiRef.current, count: stableCountRef.current });
                  if (stableCountRef.current >= STABLE_FRAMES && (now - lastClassifyTimeRef.current) > CLASSIFY_COOLDOWN_MS) {
                    lastClassifyTimeRef.current = now;
                    classifyAttempt(midi);
                    // reset stability after classification to avoid repeats
                    stableMidiRef.current = null;
                    stableCountRef.current = 0;
                  }
                }
              }
            }
        } catch {}
      }
    }
    detectTimerRef.current = requestAnimationFrame(detectionStep);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active]);

  const startDetectionLoop = useCallback(() => {
    stopDetectionLoop();
    detectTimerRef.current = requestAnimationFrame(detectionStep);
  }, [detectionStep, stopDetectionLoop]);

  const initMic = useCallback(async (deviceId?: string) => {
    // Always rebuild stream when changing device
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    try {
      const constraints: MediaStreamConstraints = { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true } };
      if ((window as any).__DEBUG_PITCH) console.debug('[mic] getUserMedia', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
  if ((window as any).__DEBUG_PITCH) console.debug('[mic] stream tracks', stream.getAudioTracks().map(t=>({label:t.label, enabled:t.enabled, id:t.id}))); 
      const ctx = opts.getAudioContext ? (opts.getAudioContext() || new (window.AudioContext || (window as any).webkitAudioContext)()) : new (window.AudioContext || (window as any).webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      analyserRef.current = analyser;
      setState(s => ({ ...s, listening: true, selectedDeviceId: deviceId || state.selectedDeviceId || null }));
      await enumerateInputs();
      startDetectionLoop();
    } catch (e:any) {
      setState(s => ({ ...s, error: 'Microphone access denied', listening: false }));
    }
  }, [opts, startDetectionLoop, enumerateInputs, state.selectedDeviceId]);

  const startMode = useCallback(async () => {
  if ((window as any).__DEBUG_PITCH) console.debug('[live] startMode invoked');
    await ensureDetector();
    await initMic();
    resetMetrics();
    // Play initial cadence+note
    const cadenceLen = scheduleCadence();
  if ((window as any).__DEBUG_PITCH) console.debug('[live] cadence length sec', cadenceLen);
    // choose target after cadence delay
    setTimeout(() => {
      const note = chooseRandomNote();
      if (note != null) {
        playNote(note, 1.4);
        targetStartRef.current = performance.now();
        suppressMicUntilRef.current = performance.now() + SUPPRESS_AFTER_TARGET_MS;
        setState(s => ({ ...s, active: true, targetNote: note, modeKey: keyCenterRef.current }));
        firstAttemptRef.current = true;
    if ((window as any).__DEBUG_PITCH) console.debug('[live] target set', { note });
      }
    }, cadenceLen * 1000 + 80);
  }, [ensureDetector, initMic, resetMetrics, scheduleCadence, chooseRandomNote, playNote, keyCenterRef]);

  const stopMode = useCallback(() => {
    cleanupStream();
    setState(s => ({ ...s, active: false }));
  }, [cleanupStream]);

  const classifyAttempt = useCallback((playedMidi: number) => {
    setState(s => {
      if (!s.active || s.targetNote == null) return s;
      const { targetNote, metrics } = s;
      const newMetrics = { ...metrics };
      newMetrics.attempts += 1;
      const exact = playedMidi === targetNote;
      const root = getKeyRootMidi();
      const relTarget = (targetNote - root + 1200) % 12;
      const relPlayed = (playedMidi - root + 1200) % 12;
      const sameSyllable = !!SOLFEGE_MAP[relTarget as keyof typeof SOLFEGE_MAP] && relTarget === relPlayed;
      const elapsed = performance.now() - targetStartRef.current;
  if ((window as any).__DEBUG_PITCH) console.debug('[classify]', { playedMidi, targetNote, relTarget, relPlayed, exact, sameSyllable, elapsedMs: Math.round(elapsed) });
      if (exact) {
        newMetrics.exactCorrect += 1;
        newMetrics.totalExactTimeMs += elapsed;
        if (firstAttemptRef.current) newMetrics.firstTryExact += 1; else if (firstAttemptRef.current === false) { /* already recorded miss */ }
      } else if (sameSyllable) {
        newMetrics.nearMiss += 1;
        if (firstAttemptRef.current) newMetrics.firstTryNearMiss += 1;
        // treat near miss like a miss for streak purposes (or configurable later)
      }
      // streak logic: only increment on exact
      if (exact) newMetrics.streak += 1; else newMetrics.streak = 0;
      // After exact, advance to next note (and maybe key change)
      let nextState: InstrumentModeState = { ...s, metrics: newMetrics };
      if (exact) {
        // auto key change on streak
        if (newMetrics.streak >= streakTarget) {
          nextState = { ...nextState, metrics: { ...newMetrics, keyChanges: newMetrics.keyChanges + 1, streak: 0 } };
          if (onAutoKeyChange) onAutoKeyChange('AUTO'); // caller will handle assigning real new key
        }
        // schedule next target
        setTimeout(() => {
          const note = chooseRandomNote();
          if (note != null) {
            const cadenceAgainLen = scheduleCadence(nextState.modeKey);
            setTimeout(() => {
              playNote(note, 1.4);
              targetStartRef.current = performance.now();
              suppressMicUntilRef.current = performance.now() + SUPPRESS_AFTER_TARGET_MS;
              firstAttemptRef.current = true;
              setState(s2 => ({ ...s2, targetNote: note }));
            }, cadenceAgainLen * 1000 + 60);
          }
        }, 350);
      } else {
        // first attempt consumed
        if (firstAttemptRef.current) firstAttemptRef.current = false;
      }
      return nextState;
    });
  }, [chooseRandomNote, getKeyRootMidi, onAutoKeyChange, playNote, scheduleCadence, streakTarget]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupStream();
    };
  }, [cleanupStream]);

  // Refresh device list if permissions change (focus back to tab)
  useEffect(() => {
    if (state.listening) enumerateInputs();
  }, [state.listening, enumerateInputs]);

  // Average seconds per exact correct
  const avgExactSeconds = state.metrics.exactCorrect ? (state.metrics.totalExactTimeMs / state.metrics.exactCorrect) / 1000 : 0;

  return {
    ...state,
    startMode,
    stopMode,
    classifyAttempt, // to be invoked by real detection loop later
    avgExactSeconds,
  _lastDetectedMidi: lastDetectedMidiRef.current,
    refreshDevices: enumerateInputs,
    changeDevice: async (deviceId: string) => {
      await initMic(deviceId);
    },
  };
}
