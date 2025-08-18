import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './App.module.css';
import FullKeyboardRange from './components/FullKeyboardRange';
import { SOLFEGE_MAP, TEMPO_VALUES, AUTO_PLAY_INTERVAL, DEFAULT_LOW, DEFAULT_HIGH, keysCircle, midiToName, computeRoot } from './solfege';
import { AudioService } from './audio/AudioService';
import { useAudioUnlock } from './hooks/useAudioUnlock';
import { useAutoplayCycle } from './hooks/useAutoplayCycle';
import { UnlockOverlay } from './components';

const App: React.FC = () => {
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null); // state kept for potential UI/debug
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [loadingInstrument, setLoadingInstrument] = useState(false); // mirrors AudioService.isLoading
  const [instrumentLoaded, setInstrumentLoaded] = useState(false); // mirrors AudioService.isLoaded
  const {
    audioUnlocked,
    setAudioUnlocked,
    unlockAttempted,
  setUnlockAttempted,
    heardConfirm,
    setHeardConfirm,
    showDebug,
    setShowDebug,
    debugInfo,
    setDebugInfo,
    beepLooping,
    ctxTime,
    ctxProgressing,
    htmlAudioRef,
    isMobile,
    unlockAudio,
    startBeepLoop,
    stopBeepLoop,
  hardResetAudio
  } = useAudioUnlock({ audioCtxRef, instrumentLoaded, onReset: () => { /* instrument handled via service */ } });

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
  const [isPlayingExternal, setIsPlayingExternal] = useState(false); // removed later; kept for compatibility
  const [htmlPrimed, setHtmlPrimed] = useState(false); // local tracking still used for post-load soft ping

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

  const wrappedUnlock = useCallback(async () => {
    await unlockAudio();
    initInstrument();
  }, [unlockAudio, initInstrument]);


  const hardResetWrapper = useCallback(() => {
    hardResetAudio();
    setAudioCtx(null);
  }, [hardResetAudio]);

  const playHtmlBeep = useCallback(() => {
    try {
      // 440Hz ~250ms generated PCM wav (audible)
      const a = new Audio('data:audio/wav;base64,UklGRl4AAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YU4AAAAA//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f//+f');
      a.play().then(()=>setDebugInfo(d=>d+' | htmlAudio ok')).catch(()=>setDebugInfo(d=>d+' | htmlAudio err'));
    } catch {}
  }, []);

  // Alternate aggressive unlock (mobile troubleshooting). Desktop just returns.
  const altUnlock = useCallback(async () => {
    if (!isMobile) { if (!audioUnlocked) wrappedUnlock(); return; }
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
  }, [audioUnlocked, bufferBeep, beepLooping, startBeepLoop, wrappedUnlock, isMobile]);

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

  const { isPlaying, startSequence, stopPlayback, triggerCadence } = useAutoplayCycle({
    autoPlay,
    repeatCadence,
    autoPlaySpeed,
    scheduleCadence,
    updateRandomNote,
    currentNote,
    playNote,
    instrumentLoaded,
  });

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
  // cadenceSpeed changes only affect future scheduleCadence calls; restart handled by hook for repeatCadence/autoPlaySpeed

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

  // After confirmation + instrument load, ensure at least one piano note actually sounds (guard against route muted)
  useEffect(() => {
    if (heardConfirm && instrumentLoaded) {
      // schedule a very soft root ping (Do) once
      const root = computeRoot(keyCenterRef.current);
      setTimeout(()=> safePlay(root, 0.4), 120);
    }
  }, [heardConfirm, instrumentLoaded, safePlay]);
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
      <UnlockOverlay
        visible={!heardConfirm && isMobile}
        audioUnlocked={audioUnlocked}
        unlockAttempted={unlockAttempted}
        loadingInstrument={loadingInstrument}
        beepLooping={beepLooping}
        instrumentLoaded={instrumentLoaded}
        ctxTime={ctxTime}
        ctxProgressing={ctxProgressing}
        audioCtx={audioCtxRef.current}
        debugInfo={debugInfo}
        showDebug={showDebug}
        onToggleDebug={()=>setShowDebug(s=>!s)}
        onEnable={wrappedUnlock}
        onReplayBeeps={()=>{ if (!beepLooping) startBeepLoop(); }}
        onHeard={()=>{ setHeardConfirm(true); stopBeepLoop(); setAudioUnlocked(true); }}
        onReset={hardResetWrapper}
      />
      <h1>Solfege Ear Trainer</h1>
      <div className={`card ${styles.cardColumn}`}>
        <div className="key-name">Key Center: <strong>{keyDisplay}</strong></div>
        <div className="solfege">{showSolfege || '—'}</div>
        <div className={`muted ${styles.muted}`}>{currentNote!=null ? midiToName(currentNote) : ''}</div>
      </div>

      <div className={`card ${styles.controlsCard}`}>
        <div className={styles.topControls}>
          <button onClick={()=>{ if (isPlaying) { stopPlayback(true); setCurrentNote(null); setShowSolfege(''); } else { startSequence(); } }} disabled={loadingInstrument}>
            {isPlaying ? '■ Stop' : '▶ Play'}
          </button>
          <button className="secondary" onClick={()=>triggerCadence()} disabled={currentNote==null}>Again</button>
          <button className="secondary" onClick={()=>newKeyCenter()}>New Key</button>
          <label className={styles.inlineCheck}><input type="checkbox" checked={autoPlay} onChange={e=>{ setAutoPlay(e.target.checked); if (!e.target.checked) { stopPlayback(); } else if (!isPlaying) { startSequence(); } }} />Autoplay</label>
          <label className={styles.inlineCheck}><input type="checkbox" checked={repeatCadence} onChange={e=>setRepeatCadence(e.target.checked)} />Repeat cadence</label>
        </div>
        <div className={`row ${styles.rowWrap}`}>
          <div className="stack">
            <label className={styles.stackLabel}>
              <span>Note set</span>
              <select value={noteMode} onChange={e=>setNoteMode(e.target.value as any)}>
                <option value="diatonic">Diatonic</option>
                <option value="non">Non-diatonic</option>
                <option value="chromatic">Chromatic</option>
              </select>
            </label>
          </div>
          <div className="stack">
            <label className={styles.stackLabel}>
              <span>Cadence speed</span>
              <select value={cadenceSpeed} onChange={e=>setCadenceSpeed(e.target.value as any)}>
                <option value="slow">slow</option>
                <option value="medium">medium</option>
                <option value="fast">fast</option>
              </select>
            </label>
          </div>
          <div className="stack">
            <label className={styles.stackLabel}>
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
          <fieldset className={styles.fieldset}>
            <legend>Pitch Range (Full 88 Keys)</legend>
            <FullKeyboardRange low={lowPitch} high={highPitch} currentNote={currentNote} onChange={(l,h)=>{setLowPitch(l); setHighPitch(h);}} />
          </fieldset>
        </div>
      </div>

      <div className={`card ${styles.instructions}`}>
        <strong>Instructions:</strong> Press Play to hear the cadence then a random scale degree. Use the options to tailor your practice. Solfege uses movable-Do with chromatic syllables (Ra, Me, Fi, Le, Te).
      </div>

      <div className="footer">Built with Soundfont piano. First interaction may require enabling audio (browser gesture). © 2025</div>
    </div>
  );
};

export default App;
