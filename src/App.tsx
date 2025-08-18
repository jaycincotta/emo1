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
  const [includeDiatonic, setIncludeDiatonic] = useState(true);
  const [includeNonDiatonic, setIncludeNonDiatonic] = useState(false);
  const [lowPitch, setLowPitch] = useState(DEFAULT_LOW);
  const [highPitch, setHighPitch] = useState(DEFAULT_HIGH);
  const [cadenceSpeed, setCadenceSpeed] = useState<'slow'|'medium'|'fast'>('medium');
  const [autoPlaySpeed, setAutoPlaySpeed] = useState<'slow'|'medium'|'fast'>('medium');
  const [isPlaying, setIsPlaying] = useState(false);
  const cadenceTimeoutRef = useRef<number | null>(null);
  const autoplayTimeoutRef = useRef<number | null>(null);

  // Initialize audio / instrument lazily
  const initInstrument = useCallback(async () => {
    if (!audioCtxRef.current) {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      setAudioCtx(ctx); // trigger rerender if needed
    }
    if (instrumentRef.current) return;
    setLoadingInstrument(true);
    const piano = await Soundfont.instrument(audioCtxRef.current!, 'acoustic_grand_piano');
    instrumentRef.current = piano;
    setLoadingInstrument(false);
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
    const when = (ctx?.currentTime || 0) + 0.02;
    instrumentRef.current.play(midiToName(midi), when, { duration });
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
      if (info.diatonic && !includeDiatonic) continue;
      if (!info.diatonic && !includeNonDiatonic) continue;
      return n;
    }
    return null;
  }, [highPitch, lowPitch, includeDiatonic, includeNonDiatonic]);

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
              <label><input type="checkbox" checked={includeDiatonic} onChange={e=>setIncludeDiatonic(e.target.checked)} />Include diatonic</label>
              <label><input type="checkbox" checked={includeNonDiatonic} onChange={e=>setIncludeNonDiatonic(e.target.checked)} />Include non-diatonic</label>
            </div>
            <div className="spacer" />
            <div className="stack">
              <div className="badge">Cadence speed</div>
              <div className="tempo-buttons">
                {(['slow','medium','fast'] as const).map(t => (
                  <button key={t} className={t===cadenceSpeed? 'active':''} onClick={()=>setCadenceSpeed(t)}>{t}</button>
                ))}
              </div>
            </div>
            <div className="stack">
              <div className="badge">Auto play speed</div>
              <div className="tempo-buttons">
                {(['slow','medium','fast'] as const).map(t => (
                  <button key={t} className={t===autoPlaySpeed? 'active':''} onClick={()=>setAutoPlaySpeed(t)}>{t}</button>
                ))}
              </div>
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
          <button className="secondary" onClick={()=>newKeyCenter()}>New Key Center</button>
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
