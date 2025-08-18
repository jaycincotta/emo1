import React, { useCallback, useEffect, useRef, useState } from 'react';
import Soundfont, { Player } from 'soundfont-player';

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

const DEFAULT_LOW = 60; // C4
const DEFAULT_HIGH = 72; // C5

const keysCircle = ['C','G','D','A','E','B','F#','Db','Ab','Eb','Bb','F'] as const;

// Explicit mapping for major key tonics to semitone (C = 0)
const KEY_TO_SEMITONE: Record<string, number> = {
  C:0, G:7, D:2, A:9, E:4, B:11, 'F#':6, Db:1, Ab:8, Eb:3, Bb:10, F:5
};

const App: React.FC = () => {
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const instrumentRef = useRef<Player | null>(null);
  const [loadingInstrument, setLoadingInstrument] = useState(false);

  const [keyCenter, setKeyCenter] = useState<string>('C');
  const [currentNote, setCurrentNote] = useState<number | null>(null);
  const [showSolfege, setShowSolfege] = useState<string>('');
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
    if (instrumentRef.current) return;
    if (!audioCtx) {
      const ctx = new AudioContext();
      setAudioCtx(ctx);
    }
    const ctx = audioCtx || new AudioContext();
    setLoadingInstrument(true);
    const piano = await Soundfont.instrument(ctx, 'acoustic_grand_piano');
    instrumentRef.current = piano;
    setLoadingInstrument(false);
  }, [audioCtx]);

  // Cadence pattern (I IV V I) relative to key center root midi
  const getKeyRootMidi = useCallback(() => {
    const base = 60; // C4
    const semitone = KEY_TO_SEMITONE[keyCenter] ?? 0;
    const baseSemitone = base % 12;
    const offset = (semitone - baseSemitone + 12) % 12;
    return base + offset;
  }, [keyCenter]);

  const playNote = useCallback((midi: number, duration = 1) => {
    if (!instrumentRef.current) return;
    // Ensure audio context running (some browsers suspend after inactivity)
    if (audioCtx && audioCtx.state !== 'running') {
      audioCtx.resume().catch(()=>{});
    }
    const when = (audioCtx?.currentTime || 0) + 0.02; // slight offset ensures retrigger even if same pitch
    instrumentRef.current.play(midiToName(midi), when, { duration });
  }, [audioCtx]);

  const scheduleCadence = useCallback((): number => {
    if (!instrumentRef.current || !audioCtx) return 0;
    const root = getKeyRootMidi();
    const tempo = TEMPO_VALUES[cadenceSpeed];
    // triads: root position simple
    const I = [root, root+4, root+7];
    const IV = [root+5, root+9, root+12];
    const V = [root+7, root+11, root+14];

    let rel = 0; // relative seconds from start
    const chordDuration = 0.9 * tempo;
    const chordGap = 0.1 * tempo;
    const seq: number[][] = [I, IV, V, I];
    const baseTime = audioCtx.currentTime + 0.05; // slight offset to avoid scheduling in past
    seq.forEach(ch => {
      ch.forEach(n => instrumentRef.current!.play(midiToName(n), baseTime + rel, { duration: chordDuration }));
      rel += chordDuration + chordGap;
    });
    return rel; // total length in seconds
  }, [cadenceSpeed, getKeyRootMidi, audioCtx]);

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
  }, [highPitch, lowPitch, getKeyRootMidi, includeDiatonic, includeNonDiatonic]);

  const updateRandomNote = useCallback((options?: { play?: boolean }) => {
    const note = chooseRandomNote();
    if (note == null) return;
    setCurrentNote(note);
    const root = getKeyRootMidi();
    const rel = (note - root + 1200) % 12;
    setShowSolfege(SOLFEGE_MAP[rel].syllable);
    if (options?.play) {
      // Short micro-delay to avoid overlapping scheduling with cadence chords start
      setTimeout(() => playNote(note, 1.4), 10);
    }
  }, [chooseRandomNote, getKeyRootMidi, playNote]);

  const startSequence = useCallback(async () => {
    await initInstrument();
    setIsPlaying(true);
    // Clear timers
    if (cadenceTimeoutRef.current) window.clearTimeout(cadenceTimeoutRef.current);
    if (autoplayTimeoutRef.current) window.clearTimeout(autoplayTimeoutRef.current);

    let delay = 0;
    if (repeatCadence) {
      delay = scheduleCadence() * 1000 + 400;
      cadenceTimeoutRef.current = window.setTimeout(() => {
        updateRandomNote({ play: true });
      }, delay);
    } else {
      updateRandomNote({ play: true });
    }

    if (autoPlay) {
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
      // first after initial
      const initialInterval = AUTO_PLAY_INTERVAL[autoPlaySpeed] + delay;
      autoplayTimeoutRef.current = window.setTimeout(scheduleNext, initialInterval);
    }
  }, [initInstrument, repeatCadence, scheduleCadence, autoPlay, autoPlaySpeed, updateRandomNote]);

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
    const key = keysCircle[idx];
    setKeyCenter(key as string);
    if (isPlaying) {
      startSequence();
    } else {
      updateRandomNote();
    }
  }, [isPlaying, startSequence, updateRandomNote]);

  useEffect(() => {
    // On mount choose first note
    updateRandomNote();
  }, []); // eslint-disable-line

  // Ensure low <= high
  useEffect(() => {
    if (lowPitch > highPitch) setLowPitch(highPitch);
  }, [lowPitch, highPitch]);

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
              <label><input type="checkbox" checked={repeatCadence} onChange={e=>setRepeatCadence(e.target.checked)} />Repeat cadence</label>
              <label><input type="checkbox" checked={autoPlay} onChange={e=>setAutoPlay(e.target.checked)} />Auto play next</label>
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
          <legend>Pitch Range</legend>
          <div className="row">
            <div>
              <label>Lowest MIDI <input type="number" min={0} max={120} value={lowPitch} onChange={e=>setLowPitch(parseInt(e.target.value)||0)} style={{width:'5rem'}} /></label>
            </div>
            <div>
              <label>Highest MIDI <input type="number" min={0} max={120} value={highPitch} onChange={e=>setHighPitch(parseInt(e.target.value)||0)} style={{width:'5rem'}} /></label>
            </div>
            <div className="muted">Current range: {midiToName(lowPitch)} – {midiToName(highPitch)}</div>
          </div>
        </fieldset>

        <div>
          <button disabled={isPlaying && loadingInstrument} onClick={()=>startSequence()}>{isPlaying? 'Restart':'Play'}</button>
          <button className="secondary" onClick={()=>{stopPlayback();}} disabled={!isPlaying}>Pause</button>
          <button className="danger" onClick={()=>stopPlayback(true)}>Stop</button>
          <button onClick={()=>newKeyCenter()}>New Key Center</button>
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
