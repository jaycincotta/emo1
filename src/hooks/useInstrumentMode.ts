import { useCallback, useEffect, useRef, useState } from 'react';

// Highlight-only live mode hook (no target selection or classification).

export interface InstrumentModeState {
  active: boolean;
  loadingDetector: boolean;
  error?: string;
  listening: boolean;
  devices: { deviceId: string; label: string }[];
  selectedDeviceId: string | null;
  amplitude: number;
  modeKey: string;
  targetNote: number | null; // kept for compatibility (always null)
  metrics: { attempts: number }; // minimal stub
}

export interface UseInstrumentModeOptions {
  keyCenterRef: React.MutableRefObject<string>;
  getAudioContext?: () => AudioContext | null;
}

interface DetectionModule { PitchDetector: any; }

export function useInstrumentMode(opts: UseInstrumentModeOptions) {
  const { keyCenterRef } = opts;
  const [state, setState] = useState<InstrumentModeState>({
    active: false,
    loadingDetector: false,
    error: undefined,
    listening: false,
    devices: [],
    selectedDeviceId: null,
    amplitude: 0,
    modeKey: keyCenterRef.current,
    targetNote: null,
    metrics: { attempts: 0 },
  });

  const detectorModRef = useRef<DetectionModule | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufRef = useRef<Float32Array | null>(null);
  const detectTimerRef = useRef<number | null>(null);
  const pitchDetectorRef = useRef<any>(null);
  const lastDetectedMidiRef = useRef<number | null>(null);
  const [detectedMidiState, setDetectedMidiState] = useState<number | null>(null);
  const lastAmpUpdateRef = useRef<number>(0);

  const DETECT_MIN = 28; // limit to empirically reliable low end (E1)
  const DETECT_MAX = 98; // D7
  // Sensitivity profile (0=Low strict,1=Med,2=High permissive,'auto'=adaptive)
  type SensMode = 0 | 1 | 2 | 'auto';
  const loadSens = (): SensMode => {
    try {
      const raw = localStorage.getItem('etSensitivityMode');
      if (raw === 'auto') return 'auto';
      if (raw != null) {
        const n = Number(raw);
        if ([0,1,2].includes(n)) return n as SensMode;
      }
    } catch { }
    return 1;
  };
  const [sensitivity, setSensitivity] = useState<SensMode>(loadSens);
  useEffect(()=>{ try { localStorage.setItem('etSensitivityMode', String(sensitivity)); } catch { } }, [sensitivity]);
  // Base thresholds (arrays indexed by numeric modes)
  const CLARITY_THRESHOLDS = [0.90, 0.88, 0.84];
  const RMS_THRESHOLDS = [0.012, 0.009, 0.005];
  const STABLE_FRAMES_THRESHOLDS = [4, 3, 2];
  const STABLE_MS_THRESHOLDS = [120, 95, 65];
  const JITTER_SPAN_LIMIT = [1, 1, 2]; // acceptable semitone spread in recent window
  // Ambient baselines for auto mode
  const ambientRmsRef = useRef<number>(0.0025);
  const ambientClarityRef = useRef<number>(0.5);
  const ema = (prev:number, next:number, a:number)=> prev + a*(next-prev);
  const isAuto = sensitivity === 'auto';
  const baseIndex = isAuto ? 1 : sensitivity; // reference to medium for auto adjustments
  let MIN_CLARITY = CLARITY_THRESHOLDS[baseIndex];
  let AMP_THRESHOLD = RMS_THRESHOLDS[baseIndex];
  let REQUIRED_STABLE_FRAMES = STABLE_FRAMES_THRESHOLDS[baseIndex];
  let REQUIRED_STABLE_MS = STABLE_MS_THRESHOLDS[baseIndex];
  let MAX_JITTER_SPAN = JITTER_SPAN_LIMIT[baseIndex];
  if (isAuto) {
    const ar = ambientRmsRef.current;
    const ac = ambientClarityRef.current;
    AMP_THRESHOLD = Math.min(0.025, ar * 3 + 0.002); // scale with environment
    MIN_CLARITY = Math.min(0.97, Math.max(0.86, ac + 0.25));
    if (ar < 0.003) { // quiet room -> stricter stability
      REQUIRED_STABLE_FRAMES = 4; REQUIRED_STABLE_MS = 130; MAX_JITTER_SPAN = 1;
    } else if (ar > 0.015) { // noisy room -> speed up acceptance a little
      REQUIRED_STABLE_FRAMES = 3; REQUIRED_STABLE_MS = 90; MAX_JITTER_SPAN = 2;
    }
  }
  // Jitter bookkeeping
  const recentMidiRef = useRef<number[]>([]);
  const stableStartRef = useRef<number | null>(null);
  // Raw candidate (pre-stability) state exposure
  const [rawMidiState, setRawMidiState] = useState<number | null>(null);
  const lastStableAtRef = useRef<number>(0);
  const CLEAR_ON_IDLE_MS = 1400; // time since last stable before clearing highlight
  const [effectiveMidi, setEffectiveMidi] = useState<number | null>(null);

  const ensureDetector = useCallback(async () => {
    if (detectorModRef.current) return;
    setState(s => ({ ...s, loadingDetector: true }));
    try {
      const mod: any = await import('pitchy');
      detectorModRef.current = mod;
      setState(s => ({ ...s, loadingDetector: false }));
    } catch {
      setState(s => ({ ...s, error: 'Failed to load detector', loadingDetector: false }));
    }
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
      setState(s => {
        let sel = s.selectedDeviceId;
        if (!sel) sel = inputs[0]?.deviceId || null;
        return { ...s, devices: inputs, selectedDeviceId: sel };
      });
    } catch { /* ignore */ }
  }, []);

  const freqToMidi = (f: number) => Math.round(69 + 12 * Math.log2(f / 440));

  const detectionStep = useCallback(() => {
    const analyser = analyserRef.current;
    const detector = detectorModRef.current;
    if (analyser && detector) {
      if (!bufRef.current) bufRef.current = new Float32Array(analyser.fftSize as number);
      const buf = bufRef.current as Float32Array;
      (analyser as any).getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (now - lastAmpUpdateRef.current > 120) {
        lastAmpUpdateRef.current = now;
        setState(s => ({ ...s, amplitude: rms }));
      }
      if (rms > AMP_THRESHOLD) {
        try {
          const sampleRate = analyser.context.sampleRate;
          if (!pitchDetectorRef.current) {
            pitchDetectorRef.current = detector.PitchDetector.forFloat32Array(buf.length);
            try { pitchDetectorRef.current.minVolumeDecibels(-55); } catch { }
            try { pitchDetectorRef.current.clarityThreshold = MIN_CLARITY; } catch { }
          }
          const [pitch, clarity] = pitchDetectorRef.current.findPitch(buf, sampleRate);
          if (clarity >= MIN_CLARITY && pitch > 40 && pitch < 2500) {
            const midi = freqToMidi(pitch);
            if (midi >= DETECT_MIN && midi <= DETECT_MAX) {
              setRawMidiState(midi);
              // Jitter window update
              const recent = recentMidiRef.current;
              recent.push(midi);
              if (recent.length > 6) recent.shift();
              const span = Math.max(...recent) - Math.min(...recent);
              if (span > MAX_JITTER_SPAN) {
                // Too unstable, reset stability timing & skip
                stableStartRef.current = null;
              } else {
                // Stability timing
                // Only reset stability timer if it's the first frame OR we already had a prior stable note and midi changed.
                if (stableStartRef.current == null || (lastDetectedMidiRef.current !== null && lastDetectedMidiRef.current !== midi)) {
                  stableStartRef.current = performance.now();
                }
                const stableFrames = recent.length >= REQUIRED_STABLE_FRAMES && span <= MAX_JITTER_SPAN;
                const stableTimeOk = stableStartRef.current != null && (performance.now() - stableStartRef.current) >= REQUIRED_STABLE_MS;
                if (stableFrames && stableTimeOk) {
                  if (lastDetectedMidiRef.current !== midi) {
                    lastDetectedMidiRef.current = midi;
                    setDetectedMidiState(midi);
                      lastStableAtRef.current = performance.now();
                  }
                }
              }
            }
          } else if (isAuto) {
            // update ambient clarity baseline with low clarity samples (speech/noise)
            if (clarity < 0.8) {
              ambientClarityRef.current = ema(ambientClarityRef.current, clarity, 0.04);
              ambientRmsRef.current = ema(ambientRmsRef.current, rms, 0.05);
            }
          }
        } catch { }
      } else if (isAuto) {
        // below amplitude gate => treat as ambient noise sample
        ambientRmsRef.current = ema(ambientRmsRef.current, rms, 0.02);
      }
      // Idle clearing logic: no stable update recently & low amplitude
      const sinceStable = performance.now() - lastStableAtRef.current;
      if (lastStableAtRef.current && sinceStable > CLEAR_ON_IDLE_MS && rms < AMP_THRESHOLD*0.5) {
        lastStableAtRef.current = 0;
        lastDetectedMidiRef.current = null;
        setDetectedMidiState(null);
      }
      // Effective note logic: prefer stable; else if raw present for >150ms and no stable yet, use raw
      const stable = lastDetectedMidiRef.current;
      if (stable !== null) {
        if (effectiveMidi !== stable) setEffectiveMidi(stable);
      } else if (rawMidiState != null) {
        // Use timestamp encoded in recentMidiRef length growth start
        if (!stableStartRef.current) stableStartRef.current = performance.now();
        if (performance.now() - stableStartRef.current > 150 && effectiveMidi !== rawMidiState) {
          setEffectiveMidi(rawMidiState);
        }
      } else if (effectiveMidi !== null) {
        setEffectiveMidi(null);
      }
    }
    detectTimerRef.current = requestAnimationFrame(detectionStep);
  }, [AMP_THRESHOLD, MIN_CLARITY, REQUIRED_STABLE_FRAMES, REQUIRED_STABLE_MS, MAX_JITTER_SPAN, isAuto]);

  const startDetectionLoop = useCallback(() => {
    stopDetectionLoop();
    detectTimerRef.current = requestAnimationFrame(detectionStep);
  }, [detectionStep, stopDetectionLoop]);

  const initMic = useCallback(async (deviceId?: string) => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    try {
      const constraints: MediaStreamConstraints = { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true } };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      const ctx = opts.getAudioContext ? (opts.getAudioContext() || new (window.AudioContext || (window as any).webkitAudioContext)()) : new (window.AudioContext || (window as any).webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      analyserRef.current = analyser;
      setState(s => ({ ...s, listening: true, selectedDeviceId: deviceId || s.selectedDeviceId }));
      await enumerateInputs();
      startDetectionLoop();
    } catch {
      setState(s => ({ ...s, error: 'Microphone access denied', listening: false }));
    }
  }, [enumerateInputs, startDetectionLoop, opts]);

  const startMode = useCallback(async () => {
    await ensureDetector();
    await initMic();
    setState(s => ({ ...s, active: true, modeKey: keyCenterRef.current }));
  }, [ensureDetector, initMic, keyCenterRef]);

  const stopMode = useCallback(() => {
    cleanupStream();
    setState(s => ({ ...s, active: false }));
  }, [cleanupStream]);

  useEffect(() => () => cleanupStream(), [cleanupStream]);
  useEffect(() => { if (state.listening) enumerateInputs(); }, [state.listening, enumerateInputs]);

  return {
    ...state,
    startMode,
    stopMode,
    _lastDetectedMidi: lastDetectedMidiRef.current,
  detectedMidiState,
    changeDevice: async (deviceId: string) => { await initMic(deviceId); },
    detectionWindow: { min: DETECT_MIN, max: DETECT_MAX },
    sensitivity,
    setSensitivity: (v: SensMode)=> setSensitivity(v),
  rawMidiState,
  effectiveMidi,
    sensitivityProfile: {
      mode: sensitivity,
      clarity: MIN_CLARITY,
      rms: AMP_THRESHOLD,
      frames: REQUIRED_STABLE_FRAMES,
      stableMs: REQUIRED_STABLE_MS,
      jitterSpan: MAX_JITTER_SPAN,
      ambientRms: ambientRmsRef.current,
      ambientClarity: ambientClarityRef.current,
    }
  };
}
