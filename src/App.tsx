import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './App.module.css';
// Replaced range-adjustable keyboard with always-full keyboard for simpler mobile layout
import FullKeyboardRange from './components/FullKeyboardRange';
import { SOLFEGE_MAP, DEFAULT_LOW, DEFAULT_HIGH, keysCircle, midiToName, computeRoot } from './solfege';
import { AudioService } from './audio/AudioService';
import { useAudioUnlock } from './hooks/useAudioUnlock';
import { useAutoplayCycle } from './hooks/useAutoplayCycle';
import { UnlockOverlay } from './components';
import { useInstrumentMode } from './hooks/useInstrumentMode';

const App: React.FC = () => {
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
    {/* Removed FullKeyboard component to avoid compile error */ }
    const [repeatCadence, setRepeatCadence] = useState(true);
    const [autoPlay, setAutoPlay] = useState(true);
    // Note selection mode: diatonic only, non-diatonic only, or chromatic (both)
    const [noteMode, setNoteMode] = useState<'diatonic' | 'non' | 'chromatic'>('diatonic');
    // Full keyboard shown; keep existing low/high state for note selection but hide UI controls
    const [lowPitch, setLowPitch] = useState(DEFAULT_LOW);
    const [highPitch, setHighPitch] = useState(DEFAULT_HIGH);
    const [cadenceSpeed, setCadenceSpeed] = useState<'slow' | 'medium' | 'fast'>('medium');
    const [autoPlaySpeed, setAutoPlaySpeed] = useState<'slow' | 'medium' | 'fast'>('medium');
    const [showInstructions, setShowInstructions] = useState(() => { try { return sessionStorage.getItem('etHideInstr') ? false : true; } catch { return true; } });
    const [showHelpModal, setShowHelpModal] = useState(false);
    // removed unused states: isPlayingExternal, htmlPrimed (debug remnants)

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
        } catch { }
    }, []);

    const audioServiceRef = useRef<AudioService | null>(null);
    if (!audioServiceRef.current) audioServiceRef.current = new AudioService();

    const initInstrument = useCallback(async () => {
        const service = audioServiceRef.current!;
        try {
            const ctx = service.ensureContext();
            audioCtxRef.current = ctx; // keep legacy refs in sync
            if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { } }
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

    const wrappedUnlock = useCallback(async () => {
        await unlockAudio();
        initInstrument();
    }, [unlockAudio, initInstrument]);


    const hardResetWrapper = useCallback(() => { hardResetAudio(); }, [hardResetAudio]);

    const getKeyRootMidi = () => computeRoot(keyCenterRef.current);

    const playNote = useCallback((midi: number, duration = 1) => {
        if (!audioCtxRef.current) return;
        const ctx = audioCtxRef.current;
        if (ctx && ctx.state !== 'running') {
            ctx.resume().catch(() => { });
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
        for (let i = 0; i < attempts; i++) {
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
        autoPlay: !instrumentLoaded ? autoPlay : (autoPlay && true),
        repeatCadence,
        autoPlaySpeed,
        scheduleCadence,
        updateRandomNote,
        currentNote,
        playNote,
        instrumentLoaded,
    });

    // Instrument (Live Piano) mode hook integration
    const instrumentMode = useInstrumentMode({
        getKeyRootMidi: () => computeRoot(keyCenterRef.current),
        chooseRandomNote: () => chooseRandomNote(),
        scheduleCadence: (k?: string) => scheduleCadence(k),
        playNote: (m,d) => playNote(m,d),
        keyCenterRef,
        onAutoKeyChange: () => { newKeyCenter(); },
        streakTarget: 10,
    getAudioContext: () => audioCtxRef.current,
    });
    const instrumentActive = instrumentMode.active;

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
            setTimeout(() => safePlay(root, 0.4), 120);
        }
    }, [heardConfirm, instrumentLoaded, safePlay]);
    useEffect(() => {
        if (heardConfirm) {
            try { sessionStorage.setItem('earTrainerHeard', '1'); } catch { }
        }
    }, [heardConfirm]);

    // Recompute solfege if key changes while a note is displayed (e.g., manual key switch without immediate playback)
    useEffect(() => { keyCenterRef.current = keyCenter; }, [keyCenter]);
    useEffect(() => {
        if (currentNote != null) {
            const root = computeRoot(keyCenterRef.current);
            const rel = (currentNote - root + 1200) % 12;
            if (SOLFEGE_MAP[rel]) setShowSolfege(SOLFEGE_MAP[rel].syllable); else setShowSolfege('');
        }
    }, [currentNote, keyCenter]);

    const keyDisplay = `${keyCenter} Major`;

    // Ensure instrument loads automatically once audio is unlocked (desktop auto-unlock path)
    useEffect(() => {
        if (audioUnlocked && !instrumentLoaded) {
            initInstrument();
        }
    }, [audioUnlocked, instrumentLoaded, initInstrument]);

    return (
        <div>
            {/* Hidden html audio element for internal speaker priming (short base64 sine ~0.25s) */}
            <audio
                ref={htmlAudioRef}
                style={{ display: 'none' }}
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
                onToggleDebug={() => setShowDebug(s => !s)}
                onEnable={wrappedUnlock}
                onReplayBeeps={() => { if (!beepLooping) startBeepLoop(); }}
                onHeard={() => { setHeardConfirm(true); stopBeepLoop(); setAudioUnlocked(true); }}
                onReset={hardResetWrapper}
            />
            <h1 className={styles.appHeader}>Solfege Ear Trainer</h1>
            <div className={`card ${styles.cardColumn}`}>
                <div className="key-name">Key Center: <strong>{keyDisplay}</strong></div>
                <div className="solfege">{showSolfege || '—'}</div>
                <div className={`muted ${styles.muted}`}>{currentNote != null ? midiToName(currentNote) : ''}</div>
            </div>

            {/* Full keyboard (range selectable) below solfege */}
            <FullKeyboardRange low={lowPitch} high={highPitch} currentNote={currentNote} detectedNote={instrumentMode._lastDetectedMidi ?? undefined} onChange={(l, h) => { setLowPitch(l); setHighPitch(h); }} />
            <div className={`card ${styles.controlsCard}`}>
                <div className={styles.topControls}>
                    {!instrumentActive && (
                        <button onClick={() => { if (isPlaying) { stopPlayback(true); setCurrentNote(null); setShowSolfege(''); } else { startSequence(); } }} disabled={loadingInstrument}>
                            {isPlaying ? '■ Stop' : '▶ Play'}
                        </button>
                    )}
                    <button className="secondary" onClick={() => triggerCadence()} disabled={currentNote == null}>Again</button>
                    <button className="secondary" onClick={() => newKeyCenter()}>New Key</button>
                    <button className="secondary" onClick={() => { instrumentActive ? instrumentMode.stopMode() : instrumentMode.startMode(); }}>
                        {instrumentActive ? 'Exit Live' : 'Live Piano'}
                    </button>
                    <div className={styles.prominentToggles}>
                        {!instrumentActive && <label className={styles.prominentCheck}>
                            <input type="checkbox" checked={autoPlay} onChange={e => { setAutoPlay(e.target.checked); if (!e.target.checked) { stopPlayback(); } else if (!isPlaying) { startSequence(); } }} />Autoplay
                        </label>}
                        {!instrumentActive && <label className={styles.prominentCheck}>
                            <input type="checkbox" checked={repeatCadence} onChange={e => setRepeatCadence(e.target.checked)} />Repeat cadence
                        </label>}
                        {instrumentActive && <div style={{ fontSize:'.7rem', opacity:.8, padding:'.25rem .5rem' }}>Live mode active</div>}
                        {instrumentActive && instrumentMode.listening && <div style={{ fontSize:'.6rem', background:'#0a4', color:'#fff', padding:'.2rem .4rem', borderRadius:4 }}>Mic</div>}
                        {instrumentActive && instrumentMode.error && <div style={{ fontSize:'.6rem', background:'#a00', color:'#fff', padding:'.2rem .4rem', borderRadius:4 }}>Mic Err</div>}
                    </div>
                </div>
                {!instrumentActive && (
                    <div className={`row ${styles.rowWrap}`}>
                        <div className="stack">
                            <label className={styles.stackLabel}>
                                <span>Autoplay speed</span>
                                <select className={styles.bigSelect} value={autoPlaySpeed} onChange={e => setAutoPlaySpeed(e.target.value as any)}>
                                    <option value="slow">slow</option>
                                    <option value="medium">medium</option>
                                    <option value="fast">fast</option>
                                </select>
                            </label>
                        </div>
                        <div className="stack">
                            <label className={styles.stackLabel}>
                                <span>Cadence speed</span>
                                <select className={styles.bigSelect} value={cadenceSpeed} onChange={e => setCadenceSpeed(e.target.value as any)}>
                                    <option value="slow">slow</option>
                                    <option value="medium">medium</option>
                                    <option value="fast">fast</option>
                                </select>
                            </label>
                        </div>
                        <div className="stack">
                            <label className={styles.stackLabel}>
                                <span>Note set</span>
                                <select className={styles.bigSelect} value={noteMode} onChange={e => setNoteMode(e.target.value as any)}>
                                    <option value="diatonic">Diatonic</option>
                                    <option value="non">Non-diatonic</option>
                                    <option value="chromatic">Chromatic</option>
                                </select>
                            </label>
                        </div>
                    </div>
                )}
                {instrumentActive && (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:'1rem', fontSize:'.7rem', lineHeight:1.3 }} aria-label="Live mode metrics">
                        <div><strong>Attempts</strong><br />{instrumentMode.metrics.attempts}</div>
                        <div><strong>Exact</strong><br />{instrumentMode.metrics.exactCorrect}</div>
                        <div><strong>Near (octave)</strong><br />{instrumentMode.metrics.nearMiss}</div>
                        <div><strong>First‑try Exact</strong><br />{instrumentMode.metrics.firstTryExact}</div>
                        <div><strong>First‑try Near</strong><br />{instrumentMode.metrics.firstTryNearMiss}</div>
                        <div><strong>Streak</strong><br />{instrumentMode.metrics.streak}</div>
                        <div><strong>Key changes</strong><br />{instrumentMode.metrics.keyChanges}</div>
                        <div><strong>Avg s/exact</strong><br />{instrumentMode.avgExactSeconds.toFixed(2)}</div>
                                                <div style={{ minWidth:110 }}>
                                                    <strong>Level</strong><br />
                                                    <div style={{ background:'#243140', width:100, height:8, borderRadius:4, overflow:'hidden', position:'relative' }}>
                                                        <div style={{ position:'absolute', inset:0, transform:`scaleX(${Math.min(1, instrumentMode.amplitude*30)})`, transformOrigin:'left', background: instrumentMode.amplitude>0.08?'#e11d48': instrumentMode.amplitude>0.04?'#f59e0b':'#10b981', transition:'transform .12s linear' }} />
                                                    </div>
                                                </div>
                                                <div style={{ minWidth:150 }}>
                                                    <strong>Mic</strong><br />
                                                    <select style={{ fontSize:'.65rem', maxWidth:180 }} value={instrumentMode.selectedDeviceId ?? ''} onChange={(e)=>instrumentMode.changeDevice(e.target.value)}>
                                                        {instrumentMode.devices.map(d=> <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
                                                    </select>
                                                </div>
                                                {instrumentMode._lastDetectedMidi && <div><strong>Last MIDI</strong><br />{instrumentMode._lastDetectedMidi}</div>}
                    </div>
                )}
            </div>
            {showInstructions && (
                <div className={`card ${styles.instructions}`}>
                    <div className={styles.instructionsDismiss}>
                        <div>
                            <strong>Instructions:</strong> Press Play to hear the cadence then a random scale degree. Use the options to tailor your practice. Solfege uses movable-Do with chromatic syllables (Ra, Me, Fi, Le, Te).
                        </div>
                        <button onClick={() => { setShowInstructions(false); try { sessionStorage.setItem('etHideInstr', '1'); } catch { } }}>hide</button>
                    </div>
                </div>
            )}

            {/* Floating help button */}
            <button aria-label="Help" className={styles.helpButton} onClick={() => setShowHelpModal(true)}>?</button>
            {showHelpModal && (
                <div className={styles.helpModalBackdrop} role="dialog" aria-modal="true" aria-labelledby="helpTitle">
                    <div className={styles.helpModal}>
                        <button aria-label="Close" className={styles.helpClose} onClick={() => setShowHelpModal(false)}>×</button>
                        <h2 id="helpTitle">Quick Tips</h2>
                        <div className={styles.helpSections}>
                            <div><strong>Play</strong>: Plays a cadence (first time or new key) then a random note in range.</div>
                            <div><strong>Autoplay</strong>: Continuously drills random notes. Turn off for manual single-note practice.</div>
                            <div><strong>Repeat cadence</strong>: Keeps reinforcing tonic between autoplay notes. Disable to hear bare tones.</div>
                            <div><strong>Range</strong>: Tap new low/high ends directly on the keyboard.</div>
                            <div><strong>Note set</strong>: Diatonic (scale tones), Non-diatonic (chromatic neighbors), Chromatic (all 12).</div>
                            <div><strong>Speeds</strong>: Cadence speed = cadence pacing; Autoplay speed = delay between drills.</div>
                        </div>
                        <div className={styles.helpFooter}>Movable-Do solfege; chromatic syllables: Ra Me Fi Le Te. © 2025</div>
                    </div>
                </div>
            )}

            {/* <div className="footer">Built with Soundfont piano. First interaction may require enabling audio (browser gesture). © 2025</div> */}
        </div>
    );
};

export default App;
