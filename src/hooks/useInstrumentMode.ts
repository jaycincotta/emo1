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
  const lastAmpUpdateRef = useRef<number>(0);

  const DETECT_MIN = 21;
  const DETECT_MAX = 108;
  const MIN_CLARITY = 0.82;
  const AMP_THRESHOLD = 0.004;

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
              lastDetectedMidiRef.current = midi;
            }
          }
        } catch { }
      }
    }
    detectTimerRef.current = requestAnimationFrame(detectionStep);
  }, [AMP_THRESHOLD, MIN_CLARITY]);

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
    changeDevice: async (deviceId: string) => { await initMic(deviceId); },
    detectionWindow: { min: DETECT_MIN, max: DETECT_MAX },
  };
}
