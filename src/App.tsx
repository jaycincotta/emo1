import React, { useCallback, useEffect, useRef, useState } from 'react';
import Soundfont, { Player } from 'soundfont-player';
import FullKeyboardRange from './components/FullKeyboardRange';

// MIDI helpers
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const SOLFEGE_MAP: Record<number, { diatonic: boolean; syllable: string }> = {
  0: { diatonic: true, syllable: 'Do' },
  1: { diatonic: false, syllable: 'Ra' },
  2: { diatonic: true, syllable: 'Re' },
  3: { diatonic: false, syllable: 'Me' },
  4: { diatonic: true, syllable: 'Mi' },
  5: { diatonic: true, syllable: 'Fa' },
  6: { diatonic: false, syllable: 'Fi' },
  7: { diatonic: true, syllable: 'Sol' },
  8: { diatonic: false, syllable: 'Le' },
  9: { diatonic: true, syllable: 'La' },
 10: { diatonic: false, syllable: 'Te' },
 11: { diatonic: true, syllable: 'Ti' },
};

const TEMPO_VALUES: Record<'slow' | 'medium' | 'fast', number> = { slow: 0.9, medium: 0.6, fast: 0.4 };
const AUTO_PLAY_INTERVAL: Record<'slow' | 'medium' | 'fast', number> = { slow: 4000, medium: 3000, fast: 1800 };

function midiToName(midi: number) {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

const DEFAULT_LOW = 21; // A0 full range start
const DEFAULT_HIGH = 108; // C8 full range end

const keysCircle = ['C','G','D','A','E','B','F#','Db','Ab','Eb','Bb','F'] as const;

// Explicit mapping for major key tonics to semitone (C = 0)
const KEY_TO_SEMITONE: Record<string, number> = {
  C:0, G:7, D:2, A:9, E:4, B:11, 'F#':6, Db:1, Ab:8, Eb:3, Bb:10, F:5
};

const App: React.FC = () => {
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null); // state kept for potential UI/debug
  const audioCtxRef = useRef<AudioContext | null>(null);
  const instrumentRef = useRef<Player | null>(null);
  const [loadingInstrument, setLoadingInstrument] = useState(false);
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

  // Initialize audio / instrument lazily (must be called in a user gesture on iOS to succeed)
  const primeAudio = useCallback(async () => {
    if (!audioCtxRef.current) return;
    try {
      const ctx = audioCtxRef.current;
      // 1-frame buffer trick
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
      // Low gain short oscillator (inaudible) to fully unlock
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
    } catch {}
  }, []);

  const initInstrument = useCallback(async () => {
    try {
      if (!audioCtxRef.current) {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = ctx;
        setAudioCtx(ctx); // trigger rerender if needed
      }
      if (audioCtxRef.current?.state === 'suspended') {
        try { await audioCtxRef.current.resume(); } catch {}
      }
      await primeAudio();
      if (audioCtxRef.current?.state === 'running') setAudioUnlocked(true);
      if (instrumentRef.current) return;
      setLoadingInstrument(true);
  setDebugInfo(`ctxState=${audioCtxRef.current?.state}; unlocked=${audioUnlocked}`);
      const piano = await Soundfont.instrument(audioCtxRef.current!, 'acoustic_grand_piano');
      instrumentRef.current = piano;
    } finally {
      setLoadingInstrument(false);
    }
  }, [primeAudio]);

  const unlockAudio = useCallback(async () => {
    setUnlockAttempted(true);
    await initInstrument();
    // simple feedback: play an ultra-short quiet note (middle C) if unlocked to reassure user
    if (audioCtxRef.current?.state === 'running' && instrumentRef.current) {
      setAudioUnlocked(true);
  try { instrumentRef.current.play('C4', undefined as any, { duration: 0.3 }); } catch {}
  if (audioCtxRef.current) setDebugInfo(`unlock gesture -> state=${audioCtxRef.current.state}`);
    }
  }, [initInstrument]);

  const hardResetAudio = useCallback(() => {
    try {
      instrumentRef.current = null;
      if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} }
      audioCtxRef.current = null;
      setAudioCtx(null);
      setAudioUnlocked(false);
      setDebugInfo('AudioContext reset');
    } catch {}
  }, []);

  const playHtmlBeep = useCallback(() => {
    try {
      const a = new Audio('data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAIlYAABAAAAABAAgAZGF0YQAAAAA=');
      a.play().then(()=>setDebugInfo(d=>d+' | htmlAudio ok')).catch(()=>setDebugInfo(d=>d+' | htmlAudio err'));
    } catch {}
  }, []);

  const computeRoot = (key: string) => {
    const base = 60; // anchor at C4 octave
    const baseSemitone = base % 12;
    const semitone = KEY_TO_SEMITONE[key] ?? 0;
    const offset = (semitone - baseSemitone + 12) % 12;
    return base + offset;
  };
  const getKeyRootMidi = () => computeRoot(keyCenterRef.current);

  const playNote = useCallback((midi: number, duration = 1) => {
    if (!instrumentRef.current) return;
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== 'running') {
      ctx.resume().catch(()=>{});
    }
  if (ctx?.state === 'running' && !audioUnlocked) setAudioUnlocked(true);
    const when = (ctx?.currentTime || 0) + 0.02;
    instrumentRef.current.play(midiToName(midi), when, { duration });
  setDebugInfo(`playNote -> ctx=${ctx?.state} t=${when.toFixed(2)}`);
  }, []);

  const scheduleCadence = useCallback((keyOverride?: string): number => {
    const ctx = audioCtxRef.current;
    if (!instrumentRef.current || !ctx) return 0;
    const root = computeRoot(keyOverride ?? keyCenterRef.current);
    const tempo = TEMPO_VALUES[cadenceSpeed];
    // triads: root position simple
    const I = [root, root+4, root+7];
    const IV = [root+5, root+9, root+12];
    const V = [root+7, root+11, root+14];

    let rel = 0; // relative seconds from start
    const chordDuration = 0.9 * tempo;
    const chordGap = 0.1 * tempo;
    const seq: number[][] = [I, IV, V, I];
    const baseTime = ctx.currentTime + 0.05; // slight offset to avoid scheduling in past
    seq.forEach(ch => {
      ch.forEach(n => instrumentRef.current!.play(midiToName(n), baseTime + rel, { duration: chordDuration }));
      rel += chordDuration + chordGap;
    });
  // console.debug('Cadence scheduled', { root, totalSeconds: rel, keyOverride });
    return rel; // total length in seconds
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
    if (!instrumentRef.current) return;
    // Clear any pending cadence-only timer
    if (cadenceTimeoutRef.current) window.clearTimeout(cadenceTimeoutRef.current);
    const wasAutoplay = autoPlay && isPlaying;
    if (wasAutoplay && autoplayTimeoutRef.current) {
      window.clearTimeout(autoplayTimeoutRef.current);
    }
    const durSec = scheduleCadence();
    const extraMs = 350; // buffer after chord releases
    if (wasAutoplay && currentNote != null) {
      cadenceTimeoutRef.current = window.setTimeout(() => {
        // Replay current note (same syllable) then schedule next loop
        playNote(currentNote, 1.4);
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
        // Start next cycle after normal interval from this repeated note
        const interval = AUTO_PLAY_INTERVAL[autoPlaySpeed];
        autoplayTimeoutRef.current = window.setTimeout(scheduleNext, interval);
      }, durSec * 1000 + extraMs);
    }
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
  {!audioUnlocked && isMobileRef.current && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.82)', color:'#fff', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', zIndex:1000, padding:'1.5rem', textAlign:'center', backdropFilter:'blur(2px)'}}>
          <h2 style={{margin:'0 0 1rem'}}>Enable Audio</h2>
          <p style={{maxWidth:520, fontSize:'0.85rem', lineHeight:1.4}}>
            Tap Enable Audio (and possibly Test Tone) to unlock sound. Turn OFF Silent Mode and raise volume. Stay on this page for a moment if the clock is not advancing.
          </p>
          <button onClick={unlockAudio} disabled={loadingInstrument} style={{fontSize:'1.05rem', padding:'0.7rem 1.1rem', marginTop:'0.6rem'}}>
            {loadingInstrument ? 'Loading…' : (unlockAttempted ? 'Try Again' : 'Enable Audio')}
          </button>
          <div style={{display:'flex', gap:'0.4rem', marginTop:'0.6rem', flexWrap:'wrap', justifyContent:'center'}}>
            <button onClick={() => {
              if (!audioCtxRef.current) return; const ctx = audioCtxRef.current; if (ctx.state==='suspended') ctx.resume();
              const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value=0.04; osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime+0.3); setTimeout(()=>gain.disconnect(), 500); setDebugInfo(`testTone ctx=${ctx.state}`);
              setAudioUnlocked(ctx.state==='running');
            }} style={{fontSize:'0.65rem'}}>Test Tone</button>
            <button onClick={playHtmlBeep} style={{fontSize:'0.65rem'}}>HTML Beep</button>
            <button onClick={hardResetAudio} style={{fontSize:'0.65rem'}}>Reset</button>
          </div>
          <div style={{marginTop:'0.75rem', fontSize:'0.55rem', opacity:0.7, maxWidth:340}}>
            <div>{debugInfo}</div>
            <div>ctxTime {ctxTime.toFixed(2)} progressing {ctxProgressing===null?'?':ctxProgressing?'yes':'no'} state {audioCtxRef.current?.state || '?'} sr {audioCtxRef.current?.sampleRate || '?'} </div>
          </div>
        </div>
      )}
      <h1>Solfege Ear Trainer</h1>
      <div className="card" style={{display:'flex', flexDirection:'column', gap:'0.25rem'}}>
        <div className="key-name">Key Center: <strong>{keyDisplay}</strong></div>
        <div className="solfege">{showSolfege || '—'}</div>
        <div className="muted" style={{marginTop:'.25rem'}}>{currentNote!=null ? midiToName(currentNote) : ''}</div>
      </div>

      <div className="card">
        <fieldset>
          <legend>Playback</legend>
          <div className="row">
            <div className="stack">
              <label><input type="checkbox" checked={autoPlay} onChange={e=>{ setAutoPlay(e.target.checked); if (!e.target.checked) { setIsPlaying(false); } }} />Autoplay</label>
              <label><input type="checkbox" checked={repeatCadence} onChange={e=>setRepeatCadence(e.target.checked)} />Repeat cadence</label>
            </div>
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
            <div className="spacer" />
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
        </fieldset>

        <fieldset>
          <legend>Pitch Range (Full 88 Keys)</legend>
          <FullKeyboardRange low={lowPitch} high={highPitch} currentNote={currentNote} onChange={(l,h)=>{setLowPitch(l); setHighPitch(h);}} />
        </fieldset>

        <div>
          <button onClick={()=>{ if (isPlaying) { stopPlayback(true); } else { startSequence(firstPlayRef.current); } }} disabled={loadingInstrument}>
            {isPlaying ? '■ Stop' : '▶ Play'}
          </button>
          <button className="secondary" onClick={()=>triggerCadence()}>Cadence</button>
          <button className="secondary" onClick={()=>newKeyCenter()}>New Key</button>
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
