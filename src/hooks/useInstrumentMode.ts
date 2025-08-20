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
  targetNote: number | null;
  metrics: { attempts: number };
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

  // Detection config
  const DETECT_MIN = 28; // E1
  const DETECT_MAX = 98; // D7

  // Sensitivity profiles + adaptive
  type SensMode = 0 | 1 | 2 | 'auto';
  const loadSens = (): SensMode => {
    try { const raw = localStorage.getItem('etSensitivityMode'); if (raw === 'auto') return 'auto'; if (raw!=null){ const n=Number(raw); if([0,1,2].includes(n)) return n as SensMode; } } catch {}
    return 1;
  };
  const [sensitivity, setSensitivity] = useState<SensMode>(loadSens);
  useEffect(()=>{ try { localStorage.setItem('etSensitivityMode', String(sensitivity)); } catch {} }, [sensitivity]);

  const CLARITY_THRESHOLDS = [0.90, 0.88, 0.84];
  const RMS_THRESHOLDS =    [0.012, 0.009, 0.005];
  const STABLE_FRAMES =     [4, 3, 2];
  const STABLE_MS =         [140, 100, 70];
  const JITTER_SPAN =       [1, 1, 2];
  const CLARITY_RANGE =     [0.050, 0.070, 0.090]; // clarity variance allowed

  const ambientRmsRef = useRef(0.0025);
  const ambientClarityRef = useRef(0.5);
  const ema = (p:number,n:number,a:number)=> p + a*(n-p);
  const isAuto = sensitivity === 'auto';
  const idx = isAuto ? 1 : sensitivity;
  let MIN_CLARITY = CLARITY_THRESHOLDS[idx];
  let AMP_THRESHOLD = RMS_THRESHOLDS[idx];
  let REQUIRED_STABLE_FRAMES = STABLE_FRAMES[idx];
  let REQUIRED_STABLE_MS = STABLE_MS[idx];
  let MAX_JITTER_SPAN = JITTER_SPAN[idx];
  let CLARITY_RANGE_LIMIT = CLARITY_RANGE[idx];
  if (isAuto) {
    const ar = ambientRmsRef.current;
    const ac = ambientClarityRef.current;
    AMP_THRESHOLD = Math.min(0.025, ar * 3 + 0.002);
    MIN_CLARITY = Math.min(0.97, Math.max(0.86, ac + 0.25));
    CLARITY_RANGE_LIMIT = 0.060;
    if (ar < 0.003) { REQUIRED_STABLE_FRAMES = 4; REQUIRED_STABLE_MS = 150; MAX_JITTER_SPAN = 1; }
    else if (ar > 0.015) { REQUIRED_STABLE_FRAMES = 3; REQUIRED_STABLE_MS = 90; MAX_JITTER_SPAN = 2; }
  }

  // Stability + history
  const recentMidiRef = useRef<number[]>([]);
  const clarityHistoryRef = useRef<number[]>([]);
  const stableStartRef = useRef<number | null>(null);
  const lastStableAtRef = useRef<number>(0);
  const CLEAR_ON_IDLE_MS = 1400;
  const [rawMidiState, setRawMidiState] = useState<number | null>(null);
  const [detectedMidiState, setDetectedMidiState] = useState<number | null>(null);
  const [effectiveMidi, setEffectiveMidi] = useState<number | null>(null);

  // Detector loader
  const ensureDetector = useCallback(async () => {
    if (detectorModRef.current) return;
    setState(s=>({...s, loadingDetector:true}));
    try { const mod:any = await import('pitchy'); detectorModRef.current = mod; setState(s=>({...s, loadingDetector:false})); }
    catch { setState(s=>({...s, loadingDetector:false, error:'Failed to load detector'})); }
  }, []);

  const stopDetectionLoop = useCallback(()=>{ if(detectTimerRef.current){ cancelAnimationFrame(detectTimerRef.current); detectTimerRef.current=null; } },[]);
  const cleanupStream = useCallback(()=>{ stopDetectionLoop(); if(mediaStreamRef.current){ mediaStreamRef.current.getTracks().forEach(t=>t.stop()); mediaStreamRef.current=null; } analyserRef.current=null; bufRef.current=null; setState(s=>({...s,listening:false})); },[stopDetectionLoop]);

  const enumerateInputs = useCallback(async()=>{
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d=>d.kind==='audioinput').map(d=>({ deviceId:d.deviceId, label:d.label||'Microphone'}));
      setState(s=>{ let sel = s.selectedDeviceId; if(!sel) sel = inputs[0]?.deviceId||null; return { ...s, devices: inputs, selectedDeviceId: sel }; });
    } catch {}
  },[]);

  const freqToMidi = (f:number)=> Math.round(69 + 12 * Math.log2(f/440));

  const detectionStep = useCallback(()=>{
    const analyser = analyserRef.current; const detector = detectorModRef.current;
    if (analyser && detector) {
      if(!bufRef.current) bufRef.current = new Float32Array(analyser.fftSize as number);
      const buf = bufRef.current as Float32Array;
      (analyser as any).getFloatTimeDomainData(buf);
      let sum=0; for(let i=0;i<buf.length;i++){ const v=buf[i]; sum+=v*v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (now - lastAmpUpdateRef.current > 120){ lastAmpUpdateRef.current=now; setState(s=>({...s, amplitude:rms})); }

      const attemptPitch = rms > AMP_THRESHOLD * 0.45; // permissive pre-gate
      if (attemptPitch){
        try {
          const sr = analyser.context.sampleRate;
          if(!pitchDetectorRef.current){
            pitchDetectorRef.current = detector.PitchDetector.forFloat32Array(buf.length);
            try { pitchDetectorRef.current.minVolumeDecibels(-55); } catch {}
            try { pitchDetectorRef.current.clarityThreshold = MIN_CLARITY; } catch {}
          }
          const [pitch, clarity] = pitchDetectorRef.current.findPitch(buf, sr);
          if (clarity >= MIN_CLARITY && pitch > 40 && pitch < 2500){
            const midi = freqToMidi(pitch);
            if (midi >= DETECT_MIN && midi <= DETECT_MAX){
              setRawMidiState(midi);
              // dynamic amplitude forgiveness for top end
              const dynamicGate = AMP_THRESHOLD * (midi >= 92 ? 0.50 : midi >= 84 ? 0.65 : 1);
              if (rms >= dynamicGate){
                // clarity variance tracking
                const ch = clarityHistoryRef.current; ch.push(clarity); if(ch.length>12) ch.shift();
                const cmax = Math.max(...ch); const cmin = Math.min(...ch); const cRange = cmax - cmin;
                // midi jitter window
                const recent = recentMidiRef.current; recent.push(midi); if(recent.length>6) recent.shift();
                const span = Math.max(...recent) - Math.min(...recent);
                const clarityStable = cRange <= CLARITY_RANGE_LIMIT || recent.length < 4;
                if (span <= MAX_JITTER_SPAN && clarityStable){
                  if (stableStartRef.current == null || (lastDetectedMidiRef.current!==null && lastDetectedMidiRef.current!==midi)) {
                    stableStartRef.current = performance.now();
                  }
                  const framesOK = recent.length >= REQUIRED_STABLE_FRAMES && span <= MAX_JITTER_SPAN;
                  const timeOK = stableStartRef.current!=null && (performance.now() - stableStartRef.current) >= REQUIRED_STABLE_MS;
                  if (framesOK && timeOK){
                    if(lastDetectedMidiRef.current !== midi){
                      lastDetectedMidiRef.current = midi;
                      setDetectedMidiState(midi);
                      lastStableAtRef.current = performance.now();
                    }
                  }
                } else {
                  stableStartRef.current = null; // instability resets
                }
              } else {
                clarityHistoryRef.current.length = 0; // too soft for high pitch
              }
            }
          } else if (isAuto){
            if (clarity < 0.8){
              ambientClarityRef.current = ema(ambientClarityRef.current, clarity, 0.04);
              ambientRmsRef.current = ema(ambientRmsRef.current, rms, 0.05);
            }
          }
        } catch {}
      } else if (isAuto) {
        ambientRmsRef.current = ema(ambientRmsRef.current, rms, 0.02);
      }

      // Idle fade
      const sinceStable = performance.now() - lastStableAtRef.current;
      if (lastStableAtRef.current && sinceStable > CLEAR_ON_IDLE_MS && rms < AMP_THRESHOLD * 0.5){
        lastStableAtRef.current = 0; lastDetectedMidiRef.current = null; setDetectedMidiState(null); setEffectiveMidi(null);
      }
      // Effective highlight (provisional raw after 150ms if no stable yet)
      const stable = lastDetectedMidiRef.current;
      if (stable != null){
        if (effectiveMidi !== stable) setEffectiveMidi(stable);
      } else if (rawMidiState != null){
        if (!stableStartRef.current) stableStartRef.current = performance.now();
        if (performance.now() - stableStartRef.current > 150 && effectiveMidi !== rawMidiState) setEffectiveMidi(rawMidiState);
      } else if (effectiveMidi != null){
        setEffectiveMidi(null);
      }
    }
    detectTimerRef.current = requestAnimationFrame(detectionStep);
  }, [AMP_THRESHOLD, MIN_CLARITY, REQUIRED_STABLE_FRAMES, REQUIRED_STABLE_MS, MAX_JITTER_SPAN, CLARITY_RANGE_LIMIT, isAuto, effectiveMidi, rawMidiState]);

  const startDetectionLoop = useCallback(()=>{ stopDetectionLoop(); detectTimerRef.current = requestAnimationFrame(detectionStep); },[detectionStep, stopDetectionLoop]);

  const initMic = useCallback(async(deviceId?:string)=>{
    if (mediaStreamRef.current){ mediaStreamRef.current.getTracks().forEach(t=>t.stop()); mediaStreamRef.current=null; }
    try {
      const constraints: MediaStreamConstraints = { audio: { deviceId: deviceId?{ exact: deviceId }: undefined, echoCancellation:true, noiseSuppression:true } };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      const ctx = opts.getAudioContext ? (opts.getAudioContext() || new (window.AudioContext || (window as any).webkitAudioContext)()) : new (window.AudioContext || (window as any).webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser); analyserRef.current = analyser;
      setState(s=>({...s,listening:true, selectedDeviceId: deviceId || s.selectedDeviceId}));
      await enumerateInputs();
      startDetectionLoop();
    } catch {
      setState(s=>({...s, error:'Microphone access denied', listening:false }));
    }
  },[enumerateInputs, startDetectionLoop, opts]);

  const startMode = useCallback(async()=>{ await ensureDetector(); await initMic(); setState(s=>({...s, active:true, modeKey:keyCenterRef.current})); },[ensureDetector, initMic, keyCenterRef]);
  const stopMode = useCallback(()=>{ cleanupStream(); setState(s=>({...s, active:false})); },[cleanupStream]);

  useEffect(()=>()=>cleanupStream(),[cleanupStream]);
  useEffect(()=>{ if(state.listening) enumerateInputs(); },[state.listening, enumerateInputs]);

  return {
    ...state,
    startMode,
    stopMode,
    _lastDetectedMidi: lastDetectedMidiRef.current,
    detectedMidiState,
    changeDevice: async (deviceId:string)=>{ await initMic(deviceId); },
    detectionWindow: { min: DETECT_MIN, max: DETECT_MAX },
    sensitivity,
    setSensitivity: (v:SensMode)=> setSensitivity(v),
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
      clarityRangeLimit: CLARITY_RANGE_LIMIT,
    }
  };
}
