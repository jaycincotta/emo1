import React, { useCallback, useEffect, useRef, useState } from 'react';
import FullKeyboardRange from './components/FullKeyboardRange';
import { SOLFEGE_MAP, TEMPO_VALUES, AUTO_PLAY_INTERVAL, DEFAULT_LOW, DEFAULT_HIGH, keysCircle, midiToName, computeRoot } from './solfege';
import { AudioService } from './audio/AudioService';

const App: React.FC = () => {
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null); // state kept for potential UI/debug
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [loadingInstrument, setLoadingInstrument] = useState(false); // mirrors AudioService.isLoading
  const [instrumentLoaded, setInstrumentLoaded] = useState(false); // mirrors AudioService.isLoaded
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [unlockAttempted, setUnlockAttempted] = useState(false);
  const initialIsMobile = typeof navigator !== 'undefined' && /iphone|ipad|ipod|android|mobile/i.test(navigator.userAgent);
  const isMobileRef = useRef<boolean>(initialIsMobile);

  const [keyCenter, setKeyCenter] = useState<string>('C');
  const keyCenterRef = useRef<string>('C');
  const [currentNote, setCurrentNote] = useState<number | null>(null);
  const [showSolfege, setShowSolfege] = useState<string>('');
  // Cadence policy per requirements:
  // - Always cadence on first play or when key center changes.
  // - If autoplay ON: each cycle cadences only if repeatCadence is ON (else just notes after initial/new-key cadence).
  // - If autoplay OFF: Play button yields one event (cadence+note if repeatCadence or first/new-key, else note only).
  const [repeatCadence, setRepeatCadence] = useState(true);
  const [autoPlay, setAutoPlay] = useState(true);
  // Note selection mode: diatonic only, non-diatonic only, or chromatic (both)
  const [noteMode, setNoteMode] = useState<'diatonic' | 'non' | 'chromatic'>('diatonic');
  const [lowPitch, setLowPitch] = useState(DEFAULT_LOW);
  const [highPitch, setHighPitch] = useState(DEFAULT_HIGH);
  const [cadenceSpeed, setCadenceSpeed] = useState<'slow'|'medium'|'fast'>('medium');
  const [autoPlaySpeed, setAutoPlaySpeed] = useState<'slow'|'medium'|'fast'>('medium');
  const [isPlaying, setIsPlaying] = useState(false);
  const cadenceTimeoutRef = useRef<number | null>(null);
  const autoplayTimeoutRef = useRef<number | null>(null);
  const [debugInfo, setDebugInfo] = useState<string>('');
  const [ctxTime, setCtxTime] = useState<number>(0);
  const [ctxProgressing, setCtxProgressing] = useState<boolean | null>(null);
  // Beep loop + confirmation for robust iOS unlock
  const [beepLooping, setBeepLooping] = useState(false);
  const beepIntervalRef = useRef<number | null>(null);
  const beepGainRef = useRef<GainNode | null>(null);
  const [heardConfirm, setHeardConfirm] = useState<boolean>(() => {
    try { return sessionStorage.getItem('earTrainerHeard') === '1'; } catch { return false; }
  });
  const [showDebug, setShowDebug] = useState(false);
  // HTML <audio> priming (can help internal speaker routing on iOS when BT not present)
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);
  const [htmlPrimed, setHtmlPrimed] = useState(false);

  // Initialize audio / instrument lazily (must be called in a user gesture on iOS to succeed)
  const primeAudio = useCallback(async () => {
    if (!audioCtxRef.current) return;
    try {
      const ctx = audioCtxRef.current;
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
    } catch {}
  }, []);

  const audioServiceRef = useRef<AudioService | null>(null);
  if (!audioServiceRef.current) audioServiceRef.current = new AudioService();

  const initInstrument = useCallback(async () => {
    const service = audioServiceRef.current!;
    try {
      const ctx = service.ensureContext();
      audioCtxRef.current = ctx; // keep legacy refs in sync
      setAudioCtx(ctx);
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
      await primeAudio();
      if (service.isLoaded) return;
      setLoadingInstrument(true);
      setDebugInfo(`ctxState=${ctx.state}; unlocked=${audioUnlocked}`);
      await service.loadInstrument();
      if (!audioUnlocked) setAudioUnlocked(true);
      setInstrumentLoaded(true);
    } finally {
      setLoadingInstrument(false);
    }
  }, [primeAudio, audioUnlocked]);

  const safePlay = useCallback((midi: number, duration = 1) => {
    audioServiceRef.current?.playNote(midi, duration);
  }, []);

  // Emergency loud single beep helper (square wave burst) to verify output path
  const loudBeep = useCallback(() => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.42);
    setTimeout(()=>{ try { g.disconnect(); } catch {} }, 500);
  }, []);

  // Render a short beep via OfflineAudioContext then play it to ensure decode+play path works
  const bufferBeep = useCallback(async () => {
    try {
      const sampleRate = 44100;
      const dur = 0.35;
      const offline = new OfflineAudioContext(1, sampleRate * dur, sampleRate);
      const osc = offline.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const gain = offline.createGain();
      gain.gain.setValueAtTime(0.0001, 0);
      gain.gain.exponentialRampToValueAtTime(0.8, 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, dur);
      osc.connect(gain).connect(offline.destination);
      osc.start(); osc.stop(dur);
      const rendered = await offline.startRendering();
      if (!audioCtxRef.current) return;
      const ctx = audioCtxRef.current;
      const src = ctx.createBufferSource();
      src.buffer = rendered;
      src.connect(ctx.destination);
      src.start();
    } catch (e) {
      setDebugInfo(d => d + ' | bufferBeep err');
    }
  }, []);

  // Start a quiet repeating beep (alternating two frequencies) until confirmation
  const startBeepLoop = useCallback(() => {
  if (!audioCtxRef.current) return;
  if (!isMobileRef.current) return; // desktop: never start beep loop
    stopBeepLoop();
    const ctx = audioCtxRef.current;
    const gain = ctx.createGain();
    gain.gain.value = 0.15; // start slightly louder
    gain.connect(ctx.destination);
    beepGainRef.current = gain;
    let flip = false;
    let count = 0;
    const playOne = () => {
      if (!audioCtxRef.current || !beepGainRef.current) return;
      const o = ctx.createOscillator();
      o.type = 'square'; // brighter
      o.frequency.value = flip ? 1046.5 : 880; // C6 / A5 for cut-through
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
      o.connect(g).connect(beepGainRef.current!);
      o.start();
      o.stop(ctx.currentTime + 0.32);
      setTimeout(()=>{ try { g.disconnect(); } catch {} }, 400);
      flip = !flip;
      count++;
      // Every 4 beeps, if user still hasn't confirmed, raise master gain a bit (cap)
      if (count % 4 === 0 && beepGainRef.current) {
        const current = beepGainRef.current.gain.value;
        if (current < 0.4) beepGainRef.current.gain.setValueAtTime(Math.min(0.4, current + 0.05), ctx.currentTime);
      }
    };
    playOne();
    beepIntervalRef.current = window.setInterval(playOne, 600);
    setBeepLooping(true);
  }, []);

  const stopBeepLoop = useCallback(() => {
    if (beepIntervalRef.current) { clearInterval(beepIntervalRef.current); beepIntervalRef.current = null; }
    try { beepGainRef.current?.disconnect(); } catch {}
    beepGainRef.current = null;
    setBeepLooping(false);
  }, []);

  const unlockAudio = useCallback(async () => {
    setUnlockAttempted(true);
    // Create/resume context and produce immediate oscillator ping BEFORE loading instrument for guaranteed audible gesture
    if (!audioCtxRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
      setAudioCtx(ctx);
    }
    if (audioCtxRef.current?.state === 'suspended') {
      try { await audioCtxRef.current.resume(); } catch {}
    }
    // Immediate short ping at middle C (60)
  audioServiceRef.current?.playNote(60, 0.25);
    // Also fire an HTML media element play attempt (some iOS internal speaker cases latch only after a media element play)
    try {
      if (htmlAudioRef.current) {
        htmlAudioRef.current.currentTime = 0;
        htmlAudioRef.current.play().then(()=>setHtmlPrimed(true)).catch(()=>{});
      }
    } catch {}
    // Start repeating audible beeps until user confirms hearing (mobile only). Desktop: auto-confirm silently.
    if (audioCtxRef.current?.state === 'running') {
      if (isMobileRef.current) {
        if (!beepLooping) {
          startBeepLoop();
          setDebugInfo(d=> d + ` | unlock gesture ctx=${audioCtxRef.current?.state}`);
        }
        setAudioUnlocked(true);
      } else {
        // Desktop
        setAudioUnlocked(true);
        if (!heardConfirm) setHeardConfirm(true);
        // Ensure no stray loop
        if (beepLooping) stopBeepLoop();
      }
    }
    // Now asynchronously load instrument (don't block UI)
    initInstrument();
  }, [initInstrument, startBeepLoop, beepLooping, heardConfirm, stopBeepLoop]);


  const hardResetAudio = useCallback(() => {
    try {
      if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} }
      audioCtxRef.current = null;
      setAudioCtx(null);
      setAudioUnlocked(false);
      setDebugInfo('AudioContext reset');
	stopBeepLoop();
  setHeardConfirm(false);
  try { sessionStorage.removeItem('earTrainerHeard'); } catch {}
    } catch {}
  }, []);

  const playHtmlBeep = useCallback(() => {
    try {
      // 440Hz ~250ms generated PCM wav (audible)
      const a = new Audio('data:audio/wav;base64,UklGRl4AAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YU4AAAAA//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f');
      a.play().then(()=>setDebugInfo(d=>d+' | htmlAudio ok')).catch(()=>setDebugInfo(d=>d+' | htmlAudio err'));
    } catch {}
  }, []);

  // Alternate aggressive unlock (mobile troubleshooting). Desktop just returns.
  const altUnlock = useCallback(async () => {
  if (!isMobileRef.current) { if (!audioUnlocked) unlockAudio(); return; }
    try {
      setUnlockAttempted(true);
      if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} }
      const Ctor: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) { setDebugInfo('No AudioContext'); return; }
      const ctx: AudioContext = new Ctor({ latencyHint:'interactive' });
      audioCtxRef.current = ctx; setAudioCtx(ctx);
      for (let i=0;i<3;i++) { if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} } }
      [440,660,880].forEach((f,ix) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type='sine'; o.frequency.value=f;
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5 + ix*0.05);
        o.connect(g).connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 0.55 + ix*0.05);
        setTimeout(()=>{ try { g.disconnect(); } catch {} }, 900);
      });
      bufferBeep();
      if (!beepLooping) startBeepLoop();
      setAudioUnlocked(true);
    } catch {
      setDebugInfo('altUnlock error');
    }
  }, [audioUnlocked, bufferBeep, beepLooping, startBeepLoop, unlockAudio]);

  const getKeyRootMidi = () => computeRoot(keyCenterRef.current);

  const playNote = useCallback((midi: number, duration = 1) => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== 'running') {
      ctx.resume().catch(()=>{});
    }
    if (ctx?.state === 'running' && !audioUnlocked) setAudioUnlocked(true);
    safePlay(midi, duration);
    setDebugInfo(`playNote -> ctx=${ctx?.state}`);
  }, [safePlay, audioUnlocked]);

  const scheduleCadence = useCallback((keyOverride?: string): number => {
    const key = keyOverride ?? keyCenterRef.current;
    const result = audioServiceRef.current?.scheduleCadence(key, cadenceSpeed);
    return result?.lengthSec || 0;
  }, [cadenceSpeed]);

  const chooseRandomNote = useCallback(() => {
    const attempts = 50;
    for (let i=0;i<attempts;i++) {
      const n = Math.floor(Math.random() * (highPitch - lowPitch + 1)) + lowPitch;
      const root = getKeyRootMidi();
      const rel = (n - root + 1200) % 12; // relative distance
      const info = SOLFEGE_MAP[rel as keyof typeof SOLFEGE_MAP];
      if (!info) continue;
      if (noteMode === 'diatonic' && !info.diatonic) continue;
      if (noteMode === 'non' && info.diatonic) continue;
      return n;
    }
    return null;
  }, [highPitch, lowPitch, noteMode]);

  const updateRandomNote = useCallback((options?: { play?: boolean; keyOverride?: string }) => {
    const note = chooseRandomNote();
    if (note == null) return;
    setCurrentNote(note);
    const root = computeRoot(options?.keyOverride ?? keyCenterRef.current);
    const rel = (note - root + 1200) % 12;
    setShowSolfege(SOLFEGE_MAP[rel].syllable);
    if (options?.play) {
      // Short micro-delay to avoid overlapping scheduling with cadence chords start
      setTimeout(() => playNote(note, 1.4), 10);
    }
  }, [chooseRandomNote, playNote]);

  const firstPlayRef = useRef(true);

  const startSequence = useCallback(async (causeNewKeyCenter: boolean = false, keyOverride?: string) => {
    await initInstrument();
    const autoplayMode = autoPlay;
    setIsPlaying(autoplayMode); // only 'playing' when autoplay loop active
    // Clear timers
    if (cadenceTimeoutRef.current) window.clearTimeout(cadenceTimeoutRef.current);
    if (autoplayTimeoutRef.current) window.clearTimeout(autoplayTimeoutRef.current);

    let delay = 0;
    const isFirst = firstPlayRef.current;
  const needCadenceInitial = isFirst || causeNewKeyCenter || (autoplayMode && repeatCadence);

    const playInitial = () => {
      updateRandomNote({ play: true, keyOverride: causeNewKeyCenter ? keyOverride : undefined });
      if (isFirst) firstPlayRef.current = false;
      if (autoplayMode) {
        const scheduleNext = () => {
          if (!autoPlay) return;
            const interval = AUTO_PLAY_INTERVAL[autoPlaySpeed];
            autoplayTimeoutRef.current = window.setTimeout(() => {
              if (repeatCadence) {
                const cadDur = scheduleCadence() * 1000 + 350;
                cadenceTimeoutRef.current = window.setTimeout(() => {
                  updateRandomNote({ play: true });
                  scheduleNext();
                }, cadDur);
              } else {
                updateRandomNote({ play: true });
                scheduleNext();
              }
            }, interval);
        };
        const initialInterval = AUTO_PLAY_INTERVAL[autoPlaySpeed] + delay;
        autoplayTimeoutRef.current = window.setTimeout(scheduleNext, initialInterval);
      }
    };

    if (needCadenceInitial) {
  delay = scheduleCadence(keyOverride) * 1000 + 400;
      cadenceTimeoutRef.current = window.setTimeout(playInitial, delay);
    } else {
      playInitial();
    }
  }, [initInstrument, scheduleCadence, autoPlay, autoPlaySpeed, repeatCadence, updateRandomNote]);

  const stopPlayback = useCallback((reset?: boolean) => {
    setIsPlaying(false);
    if (cadenceTimeoutRef.current) window.clearTimeout(cadenceTimeoutRef.current);
    if (autoplayTimeoutRef.current) window.clearTimeout(autoplayTimeoutRef.current);
    if (reset) {
      setCurrentNote(null);
      setShowSolfege('');
    }
  }, []);

  // Manual cadence trigger: plays cadence for current key. If autoplay active, replay current note after cadence then resume loop timing.
  const triggerCadence = useCallback(async () => {
    await initInstrument();
  if (!instrumentLoaded) return;
    // Clear any pending cadence-only timer
    if (cadenceTimeoutRef.current) window.clearTimeout(cadenceTimeoutRef.current);
    const wasAutoplay = autoPlay && isPlaying;
    if (wasAutoplay && autoplayTimeoutRef.current) {
      window.clearTimeout(autoplayTimeoutRef.current);
    }
    const durSec = scheduleCadence();
    const extraMs = 350; // buffer after chord releases
    cadenceTimeoutRef.current = window.setTimeout(() => {
      if (currentNote != null) {
        // Replay current note after cadence always
        playNote(currentNote, 1.4);
      }
      if (wasAutoplay) {
        const scheduleNext = () => {
          if (!autoPlay) return;
          const interval = AUTO_PLAY_INTERVAL[autoPlaySpeed];
            autoplayTimeoutRef.current = window.setTimeout(() => {
              if (repeatCadence) {
                const cadDur = scheduleCadence() * 1000 + 350;
                cadenceTimeoutRef.current = window.setTimeout(() => {
                  updateRandomNote({ play: true });
                  scheduleNext();
                }, cadDur);
              } else {
                updateRandomNote({ play: true });
                scheduleNext();
              }
            }, interval);
        };
        const interval = AUTO_PLAY_INTERVAL[autoPlaySpeed];
        autoplayTimeoutRef.current = window.setTimeout(scheduleNext, interval);
      }
    }, durSec * 1000 + extraMs);
  }, [initInstrument, autoPlay, isPlaying, scheduleCadence, currentNote, playNote, autoPlaySpeed, repeatCadence, updateRandomNote]);

  const newKeyCenter = useCallback(() => {
    const idx = Math.floor(Math.random() * keysCircle.length);
    const key = keysCircle[idx] as string;
    setKeyCenter(key);
    keyCenterRef.current = key;
    // Clear current note/solfege so old syllable not shown under new key
    setCurrentNote(null);
    setShowSolfege('');
    // Start immediately using override so cadence reflects the new key even before re-render
    startSequence(true, key);
  }, [startSequence]);

  // No initial note; first Play establishes key via cadence then generates first note.

  // Ensure low <= high
  useEffect(() => {
    if (lowPitch > highPitch) setLowPitch(highPitch);
  }, [lowPitch, highPitch]);

  // Immediate effect: when cadence speed changes during active cadence scheduling for next autoplay cycle, nothing to reschedule until next cycle.
  // When autoplay speed changes, restart autoplay timing if currently playing.
  useEffect(() => {
    if (isPlaying) {
      // restart sequence timing but keep current note displayed
      startSequence(false);
    }
  }, [autoPlaySpeed, cadenceSpeed, repeatCadence, startSequence, isPlaying]);

  // If note mode or range changes while not awaiting a cadence, pick a new note immediately (unless there is no note yet)
  useEffect(() => {
    if (currentNote != null) {
      const newNote = chooseRandomNote();
      if (newNote != null) {
        setCurrentNote(newNote);
        const root = computeRoot(keyCenterRef.current);
        const rel = (newNote - root + 1200) % 12;
        setShowSolfege(SOLFEGE_MAP[rel].syllable);
      }
    }
  }, [noteMode, lowPitch, highPitch, chooseRandomNote]);

  // Attempt passive unlock on first pointer interaction (won't show errors if blocked)
  useEffect(() => {
    if (audioUnlocked) return;
    if (!isMobileRef.current) { // desktop usually auto unlocks; attempt silently
      unlockAudio();
      return;
    }
    const handler = () => { unlockAudio(); };
    const resumeHandler = () => { if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume(); };
    document.addEventListener('touchend', handler, { once: true, passive: true });
    document.addEventListener('mousedown', handler, { once: true });
    document.addEventListener('visibilitychange', resumeHandler);
    window.addEventListener('focus', resumeHandler);
    document.addEventListener('touchstart', resumeHandler, { passive: true });
    return () => {
      document.removeEventListener('touchend', handler);
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('visibilitychange', resumeHandler);
      window.removeEventListener('focus', resumeHandler);
      document.removeEventListener('touchstart', resumeHandler);
    };
  }, [audioUnlocked, unlockAudio]);

  useEffect(() => {
    let id: number | null = null;
    const prevRef = { t: audioCtxRef.current?.currentTime };
    const loop = () => {
      if (audioCtxRef.current) {
        const t = audioCtxRef.current.currentTime;
        setCtxProgressing(p => p == null ? null : (t !== prevRef.t));
        setCtxTime(t);
        prevRef.t = t;
      }
      id = window.setTimeout(loop, 600);
    };
    loop();
    return () => { if (id) clearTimeout(id); };
  }, []);

  // Lifecycle + route change listeners to aggressively resume / re-prime
  useEffect(() => {
    const resume = () => {
      if (audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().catch(()=>{});
      }
      if (htmlAudioRef.current && !htmlPrimed) {
        htmlAudioRef.current.play().then(()=>setHtmlPrimed(true)).catch(()=>{});
      }
    };
    const pageShow = () => resume();
    const visibility = () => { if (document.visibilityState === 'visible') resume(); };
    window.addEventListener('pageshow', pageShow);
    document.addEventListener('visibilitychange', visibility);
    // mediaDevices devicechange (not always supported on iOS) to re-prime after unplugging BT
    try { navigator.mediaDevices?.addEventListener('devicechange', resume); } catch {}
    return () => {
      window.removeEventListener('pageshow', pageShow);
      document.removeEventListener('visibilitychange', visibility);
      try { navigator.mediaDevices?.removeEventListener('devicechange', resume); } catch {}
    };
  }, [htmlPrimed]);

  // After confirmation + instrument load, ensure at least one piano note actually sounds (guard against route muted)
  useEffect(() => {
    if (heardConfirm && instrumentLoaded) {
      // schedule a very soft root ping (Do) once
      const root = computeRoot(keyCenterRef.current);
      setTimeout(()=> safePlay(root, 0.4), 120);
    }
  }, [heardConfirm, instrumentLoaded, safePlay]);

  // Auto-stop beep loop once instrument loaded and user confirmed
  useEffect(() => {
    if (instrumentLoaded && heardConfirm && beepLooping) {
      stopBeepLoop();
    }
  }, [instrumentLoaded, heardConfirm, beepLooping, stopBeepLoop]);

  // If not mobile, ensure beep loop never runs (safety in case of state carryover)
  useEffect(() => {
    if (!isMobileRef.current && beepLooping) stopBeepLoop();
  }, [beepLooping, stopBeepLoop]);

  // Persist confirmation
  useEffect(() => {
    if (heardConfirm) {
      try { sessionStorage.setItem('earTrainerHeard', '1'); } catch {}
    }
  }, [heardConfirm]);

  // Recompute solfege if key changes while a note is displayed (e.g., manual key switch without immediate playback)
  useEffect(()=> { keyCenterRef.current = keyCenter; }, [keyCenter]);
  useEffect(() => {
    if (currentNote != null) {
      const root = computeRoot(keyCenterRef.current);
      const rel = (currentNote - root + 1200) % 12;
      if (SOLFEGE_MAP[rel]) setShowSolfege(SOLFEGE_MAP[rel].syllable); else setShowSolfege('');
    }
  }, [currentNote, keyCenter]);

  const keyDisplay = `${keyCenter} Major`;

  return (
    <div>
      {/* Hidden html audio element for internal speaker priming (short base64 sine ~0.25s) */}
      <audio
        ref={htmlAudioRef}
        style={{display:'none'}}
        playsInline
        preload="auto"
        src="data:audio/wav;base64,UklGRl4AAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YU4AAAAA//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f" />
  {!heardConfirm && isMobileRef.current && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.82)', color:'#fff', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', zIndex:1000, padding:'1.5rem', textAlign:'center', backdropFilter:'blur(2px)'}}>
          <h2 style={{margin:'0 0 0.75rem'}}>{audioUnlocked ? 'Confirm Sound' : 'Enable Audio'}</h2>
          <p style={{maxWidth:520, fontSize:'0.85rem', lineHeight:1.4}}>
            {audioUnlocked ? 'You should hear soft alternating beeps. If you do, press I Hear It.' : 'Tap Enable Audio to start a repeating soft beep. Turn OFF Silent Mode and raise volume.'}
          </p>
          <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap', justifyContent:'center', marginTop:'0.4rem'}}>
            {!audioUnlocked && (
              <button onClick={unlockAudio} disabled={loadingInstrument} style={{fontSize:'1.05rem', padding:'0.7rem 1.1rem'}}>
                {loadingInstrument ? 'Loading…' : (unlockAttempted ? 'Try Again' : 'Enable Audio')}
              </button>
            )}
            {audioUnlocked && !heardConfirm && (
              <button onClick={() => { if (!beepLooping) startBeepLoop(); }} style={{fontSize:'0.8rem', padding:'0.55rem 0.9rem'}}>Replay Beeps</button>
            )}
            {audioUnlocked && !heardConfirm && (
              <button onClick={() => { setHeardConfirm(true); stopBeepLoop(); setAudioUnlocked(true); }} style={{fontSize:'1.05rem', padding:'0.7rem 1.1rem', background:'#2d7', color:'#000', fontWeight:600}}>I Hear It</button>
            )}
            <button onClick={hardResetAudio} style={{fontSize:'0.65rem'}}>Reset Audio</button>
            <button onClick={()=>setShowDebug(s=>!s)} style={{fontSize:'0.65rem'}}>{showDebug ? 'Hide Debug' : 'Debug'}</button>
          </div>
          {showDebug && (
            <div style={{marginTop:'0.6rem', fontSize:'0.55rem', opacity:0.7, maxWidth:360, textAlign:'left'}}>
              <div>{debugInfo}</div>
              <div>beep {beepLooping?'on':'off'} inst {instrumentLoaded?'yes':'no'} ctxTime {ctxTime.toFixed(2)} progressing {ctxProgressing===null?'?':ctxProgressing?'yes':'no'} state {audioCtxRef.current?.state || '?'} sr {audioCtxRef.current?.sampleRate || '?'} </div>
            </div>
          )}
        </div>
      )}
      <h1>Solfege Ear Trainer</h1>
      <div className="card" style={{display:'flex', flexDirection:'column', gap:'0.25rem'}}>
        <div className="key-name">Key Center: <strong>{keyDisplay}</strong></div>
        <div className="solfege">{showSolfege || '—'}</div>
        <div className="muted" style={{marginTop:'.25rem'}}>{currentNote!=null ? midiToName(currentNote) : ''}</div>
      </div>

      <div className="card" style={{display:'flex', flexDirection:'column', gap:'0.6rem'}}>
        <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap', alignItems:'center'}}>
          <button onClick={()=>{ if (isPlaying) { stopPlayback(true); } else { startSequence(firstPlayRef.current); } }} disabled={loadingInstrument}>
            {isPlaying ? '■ Stop' : '▶ Play'}
          </button>
          <button className="secondary" onClick={()=>triggerCadence()} disabled={currentNote==null}>Again</button>
          <button className="secondary" onClick={()=>newKeyCenter()}>New Key</button>
          <label style={{fontSize:'.7rem', display:'flex', alignItems:'center', gap:'.25rem'}}><input type="checkbox" checked={autoPlay} onChange={e=>{ setAutoPlay(e.target.checked); if (!e.target.checked) { setIsPlaying(false); } }} />Autoplay</label>
          <label style={{fontSize:'.7rem', display:'flex', alignItems:'center', gap:'.25rem'}}><input type="checkbox" checked={repeatCadence} onChange={e=>setRepeatCadence(e.target.checked)} />Repeat cadence</label>
        </div>
        <div className="row" style={{flexWrap:'wrap', rowGap:'0.5rem'}}>
          <div className="stack">
            <label style={{display:'flex', flexDirection:'column'}}>
              <span>Note set</span>
              <select value={noteMode} onChange={e=>setNoteMode(e.target.value as any)}>
                <option value="diatonic">Diatonic</option>
                <option value="non">Non-diatonic</option>
                <option value="chromatic">Chromatic</option>
              </select>
            </label>
          </div>
          <div className="stack">
            <label style={{display:'flex', flexDirection:'column'}}>
              <span>Cadence speed</span>
              <select value={cadenceSpeed} onChange={e=>setCadenceSpeed(e.target.value as any)}>
                <option value="slow">slow</option>
                <option value="medium">medium</option>
                <option value="fast">fast</option>
              </select>
            </label>
          </div>
          <div className="stack">
            <label style={{display:'flex', flexDirection:'column'}}>
              <span>Autoplay speed</span>
              <select value={autoPlaySpeed} onChange={e=>setAutoPlaySpeed(e.target.value as any)}>
                <option value="slow">slow</option>
                <option value="medium">medium</option>
                <option value="fast">fast</option>
              </select>
            </label>
          </div>
        </div>
        <div>
          <fieldset style={{margin:0}}>
            <legend>Pitch Range (Full 88 Keys)</legend>
            <FullKeyboardRange low={lowPitch} high={highPitch} currentNote={currentNote} onChange={(l,h)=>{setLowPitch(l); setHighPitch(h);}} />
          </fieldset>
        </div>
      </div>

      <div className="card" style={{fontSize:'.75rem', lineHeight:1.4}}>
        <strong>Instructions:</strong> Press Play to hear the cadence then a random scale degree. Use the options to tailor your practice. Solfege uses movable-Do with chromatic syllables (Ra, Me, Fi, Le, Te).
      </div>

      <div className="footer">Built with Soundfont piano. First interaction may require enabling audio (browser gesture). © 2025</div>
    </div>
  );
};

export default App;
