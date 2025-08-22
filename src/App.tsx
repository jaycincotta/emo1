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
    const instrumentMode = useInstrumentMode({ keyCenterRef, getAudioContext: () => audioCtxRef.current });
    const instrumentActive = instrumentMode.active;

    // Live training workflow state (only used when instrumentActive)
    type AttemptFeedback = 'idle' | 'awaiting' | 'correct' | 'near' | 'wrong';
    const [liveTarget, setLiveTarget] = useState<number | null>(null);
    const [liveFeedback, setLiveFeedback] = useState<AttemptFeedback>('idle');
    const [liveAttemptsOnCurrent, setLiveAttemptsOnCurrent] = useState(0); // attempts (stable note evaluations) on current target
    const [liveFirstAttemptRecorded, setLiveFirstAttemptRecorded] = useState(false); // first attempt has been evaluated (counts toward metrics)
    const [liveTotalTargets, setLiveTotalTargets] = useState(0); // number of distinct targets introduced (metrics denominator)
    const [liveFirstAttemptCorrectCount, setLiveFirstAttemptCorrectCount] = useState(0); // number of targets where first attempt was correct
    const [liveStreak, setLiveStreak] = useState(0); // streak of first-attempt correct targets
    const [liveCongrats, setLiveCongrats] = useState(false);
    const [liveSyllable, setLiveSyllable] = useState<string>('');
    const evaluationDisableUntilRef = useRef<number>(0); // timestamp until which we ignore detections (during cadence/target playback)
    const lastEvaluatedMidiRef = useRef<number | null>(null); // to avoid re-evaluating same sustained note
    const lastDetectedNullAtRef = useRef<number>(performance.now());
    const NEAR_MISS_DISTANCE = 1; // semitone threshold for Near Miss
    const PROVISIONAL_NOTE_DELAY_MS = 200; // wait after target note playback begins before enabling detection buffer

    const resetLiveState = useCallback(() => {
        setLiveTarget(null);
        setLiveFeedback('idle');
        setLiveAttemptsOnCurrent(0);
        setLiveFirstAttemptRecorded(false);
        setLiveSyllable('');
        lastEvaluatedMidiRef.current = null;
    }, []);

    // Choose a target note (same constraints as random note selection) but only one at a time for live mode
    const chooseLiveTarget = useCallback(() => {
        const attempts = 60;
        for (let i = 0; i < attempts; i++) {
            const n = Math.floor(Math.random() * (highPitch - lowPitch + 1)) + lowPitch;
            const root = computeRoot(keyCenterRef.current);
            const rel = (n - root + 1200) % 12;
            const info = SOLFEGE_MAP[rel as keyof typeof SOLFEGE_MAP];
            if (!info) continue;
            if (noteMode === 'diatonic' && !info.diatonic) continue;
            if (noteMode === 'non' && info.diatonic) continue;
            return n;
        }
        return null;
    }, [highPitch, lowPitch, noteMode]);

    // Start a new target (schedules cadence + target note playback)
    const startNewLiveTarget = useCallback((reuseSame = false) => {
        const doStart = (targetMidi: number) => {
            setLiveTarget(targetMidi);
            setLiveFeedback('awaiting');
            setLiveAttemptsOnCurrent(0);
            setLiveFirstAttemptRecorded(false);
            setLiveSyllable('');
            lastEvaluatedMidiRef.current = null;
        };
        const tgt = reuseSame ? liveTarget : chooseLiveTarget();
        if (tgt == null) return;
        if (!reuseSame) {
            // metrics: each BRAND NEW target increases totalTargets
            setLiveTotalTargets(t => t + 1);
        }
        // schedule cadence then note
        const cadenceSeconds = scheduleCadence();
        const startTime = performance.now();
        evaluationDisableUntilRef.current = startTime + cadenceSeconds * 1000 + 1500; // disable until note has sounded and decayed a bit
        // set target immediately so UI knows what's awaited
        doStart(tgt);
        // play target after cadence ends
        setTimeout(() => {
            playNote(tgt, 1.4);
            // after short delay, allow evaluation (but keep guard if user is still hearing note from speakers)
            evaluationDisableUntilRef.current = performance.now() + PROVISIONAL_NOTE_DELAY_MS + 650; // allow earlier detection but still buffer
        }, cadenceSeconds * 1000 + 120);
    }, [chooseLiveTarget, scheduleCadence, playNote, liveTarget]);

    // Handle detection evaluation in live mode
    useEffect(() => {
        if (!instrumentActive) return;
        const stable = instrumentMode.detectedMidiState; // stable note only
        const now = performance.now();
        if (stable == null) {
            if (lastDetectedNullAtRef.current + 350 < now) {
                lastEvaluatedMidiRef.current = null; // allow same note again after silence
            }
            return;
        }
        if (now < evaluationDisableUntilRef.current) return; // don't evaluate during playback phase
        if (!liveTarget) return;
        if (liveFeedback === 'correct') return; // already resolved, waiting for next cycle
        if (stable === lastEvaluatedMidiRef.current) return; // ignore sustained duplicates
        lastEvaluatedMidiRef.current = stable;

        // Evaluate attempt
        const distance = Math.abs(stable - liveTarget);
        const root = computeRoot(keyCenterRef.current);
        const rel = (liveTarget - root + 1200) % 12;
        const solfInfo = SOLFEGE_MAP[rel as keyof typeof SOLFEGE_MAP];
        if (!liveFirstAttemptRecorded) {
            // First attempt at this target
            setLiveAttemptsOnCurrent(a => a + 1);
            setLiveFirstAttemptRecorded(true);
            if (distance === 0) {
                // First-attempt correct
                setLiveFeedback('correct');
                setLiveSyllable(solfInfo ? solfInfo.syllable : '');
                setLiveFirstAttemptCorrectCount(c => c + 1);
                setLiveStreak(s => s + 1);
                // schedule next target or key transition
                setTimeout(() => {
                    if (liveStreak + 1 >= 10) {
                        setLiveCongrats(true);
                        setTimeout(() => {
                            setLiveCongrats(false);
                            // change key
                            newKeyCenter();
                            setLiveStreak(0);
                            startNewLiveTarget(false);
                        }, 2200);
                    } else {
                        startNewLiveTarget(false);
                    }
                }, 850);
            } else {
                // Not correct on first attempt
                if (distance <= NEAR_MISS_DISTANCE) {
                    setLiveFeedback('near');
                } else {
                    setLiveFeedback('wrong');
                }
                // streak broken
                if (liveStreak !== 0) setLiveStreak(0);
            }
        } else {
            // Second (or later) attempt on this same target
            setLiveAttemptsOnCurrent(a => a + 1);
            if (distance === 0) {
                setLiveFeedback('correct');
                setLiveSyllable(solfInfo ? solfInfo.syllable : '');
                // Do NOT increment streak or metrics (first attempt already counted)
                setTimeout(() => startNewLiveTarget(false), 900);
            } else {
                // Another wrong; if this is second attempt since last feedback change (i.e., attemptsOnCurrent >=2 and current attempt still wrong), replay cadence & same note
                if (liveAttemptsOnCurrent + 1 >= 2) {
                    // repeat cadence and same target; do not create new metrics entry
                    startNewLiveTarget(true);
                }
            }
        }
    }, [instrumentActive, instrumentMode.detectedMidiState, liveTarget, liveFeedback, liveFirstAttemptRecorded, liveAttemptsOnCurrent, liveStreak, startNewLiveTarget, keyCenterRef]);

    // When entering live mode, initialize workflow
    useEffect(() => {
        if (instrumentActive) {
            // stop autoplay playback if running
            if (isPlaying) stopPlayback(true);
            resetLiveState();
            startNewLiveTarget(false);
        } else {
            // leaving live mode
            resetLiveState();
        }
    }, [instrumentActive]);

    const liveAccuracy = liveTotalTargets > 0 ? (liveFirstAttemptCorrectCount / liveTotalTargets) : 0;

    const newKeyCenter = useCallback(() => {
        const idx = Math.floor(Math.random() * keysCircle.length);
        const key = keysCircle[idx] as string;
        setKeyCenter(key);
        keyCenterRef.current = key;
        setCurrentNote(null);
        setShowSolfege('');
        // In live (instrument) mode we do NOT invoke autoplay sequence (prevents stray cadences/notes)
        if (!instrumentActive) {
            startSequence(true, key);
        }
    }, [startSequence, instrumentActive]);

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

            {/* Live mode prominent feedback banner */}
            {instrumentActive && (
                <div style={{margin:'0.5rem 0 0.75rem',padding:'0.75rem 0.9rem',borderRadius:8,background: liveFeedback==='correct' ? '#064e3b' : liveFeedback==='near' ? '#78350f' : liveFeedback==='wrong' ? '#7f1d1d' : '#1e293b', color:'#fff', display:'flex',flexWrap:'wrap',alignItems:'center',gap:'1rem'}}>
                    <div style={{fontSize:'1.15rem',fontWeight:600,minWidth:120}}>
                        {liveFeedback==='awaiting' && 'Sing the note'}
                        {liveFeedback==='correct' && 'Correct'}
                        {liveFeedback==='near' && 'Near Miss'}
                        {liveFeedback==='wrong' && 'Try Again'}
                        {liveFeedback==='idle' && '…'}
                    </div>
                    <div style={{fontSize:'.85rem',opacity:.9,minWidth:90}}>Target: <strong>{liveFeedback==='correct' && liveTarget!=null ? midiToName(liveTarget) : '—'}</strong></div>
                    <div style={{fontSize:'.85rem',opacity:.9,minWidth:90}}>Syllable: <strong>{liveSyllable || (liveFeedback==='correct' ? '' : '—')}</strong></div>
                    {/* Streak progress (10 first-attempt correct to key change) */}
                    <div style={{display:'flex',alignItems:'center',gap:6}} aria-label="Streak progress">
                        {[...Array(10)].map((_,i)=> <div key={i} style={{width:18,height:18,borderRadius:4,background: i<liveStreak ? '#10b981' : '#334155',border:'1px solid #475569',boxShadow: i<liveStreak ? '0 0 4px 1px rgba(16,185,129,.6)' : 'none',transition:'background .25s'}} />)}
                        <div style={{fontSize:'.65rem',marginLeft:4}}>Streak {liveStreak}/10</div>
                    </div>
                    <div style={{fontSize:'.65rem',opacity:.8}}>First-attempt: {(liveFirstAttemptCorrectCount)}/{liveTotalTargets} ({(liveAccuracy*100).toFixed(0)}%)</div>
                    {liveCongrats && <div style={{fontSize:'.75rem',background:'#2563eb',padding:'.35rem .55rem',borderRadius:4}}>Key change incoming…</div>}
                </div>
            )}

            {/* Full keyboard (range selectable) below solfege */}
            <div className={liveFeedback==='near' ? 'quality-near' : liveFeedback==='wrong' ? 'quality-wrong' : liveFeedback==='correct' ? 'quality-correct' : ''}>
                <FullKeyboardRange
                    low={instrumentActive ? instrumentMode.detectionWindow.min : lowPitch}
                    high={instrumentActive ? instrumentMode.detectionWindow.max : highPitch}
                    currentNote={instrumentActive ? null : currentNote}
                    detectedNote={instrumentActive ? (instrumentMode.effectiveMidi ?? instrumentMode.detectedMidiState ?? undefined) : undefined}
                    onChange={(l, h) => { if (!instrumentActive) { setLowPitch(l); setHighPitch(h); } }}
                />
            </div>
            <div className={`card ${styles.controlsCard}`}>
                <div className={styles.topControls}>
                    {!instrumentActive && (
                        <button onClick={() => { if (isPlaying) { stopPlayback(true); setCurrentNote(null); setShowSolfege(''); } else { startSequence(); } }} disabled={loadingInstrument}>
                            {isPlaying ? '■ Stop' : '▶ Play'}
                        </button>
                    )}
                    {!instrumentActive && <button className="secondary" onClick={() => triggerCadence()} disabled={currentNote == null}>Again</button>}
                    {!instrumentActive && <button className="secondary" onClick={() => newKeyCenter()}>New Key</button>}
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
                                                {instrumentActive && <div style={{ fontSize:'.7rem', opacity:.8, padding:'.25rem .5rem' }}>Live mode</div>}
                        {instrumentActive && instrumentMode.listening && <div style={{ fontSize:'.55rem', background:'#0a4', color:'#fff', padding:'.18rem .4rem', borderRadius:4 }}>Mic</div>}
                        {instrumentActive && instrumentMode.error && <div style={{ fontSize:'.55rem', background:'#a00', color:'#fff', padding:'.18rem .4rem', borderRadius:4 }}>Mic Err</div>}
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
                    <div style={{ display:'flex', flexWrap:'wrap', gap:'1rem', fontSize:'.7rem', lineHeight:1.3 }} aria-label="Live mode technical panel">
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
                                                {instrumentMode.rawMidiState && <div><strong>Raw</strong><br />{instrumentMode.rawMidiState}</div>}
                                                {instrumentMode._lastDetectedMidi && <div><strong>Stable</strong><br />{instrumentMode._lastDetectedMidi}</div>}
                                                <div style={{ minWidth:150 }}>
                                                    <strong>Sensitivity</strong><br />
                                                    <select style={{ fontSize:'.65rem' }} value={instrumentMode.sensitivity as any} onChange={e=>instrumentMode.setSensitivity(e.target.value === 'auto' ? 'auto' : Number(e.target.value) as any)}>
                                                        <option value="auto">Auto</option>
                                                        <option value={0}>Low (strict)</option>
                                                        <option value={1}>Med</option>
                                                        <option value={2}>High</option>
                                                    </select>
                                                </div>
                                                <div style={{ minWidth:190 }}>
                                                    <strong>Profile</strong><br />
                                                    <div style={{ fontSize:'.55rem', lineHeight:1.15, opacity:.8 }}>
                                                        {instrumentMode.sensitivityProfile.mode==='auto' && <span style={{ display:'block' }}>amb rms {instrumentMode.sensitivityProfile.ambientRms.toFixed(3)} clr {instrumentMode.sensitivityProfile.ambientClarity.toFixed(2)}</span>}
                                                        clr {instrumentMode.sensitivityProfile.clarity.toFixed(2)} | rms {instrumentMode.sensitivityProfile.rms.toFixed(3)}<br />
                                                        fr {instrumentMode.sensitivityProfile.frames} / {instrumentMode.sensitivityProfile.stableMs}ms | jit ±{instrumentMode.sensitivityProfile.jitterSpan}
                                                    </div>
                                                </div>
                                                <div style={{ flexBasis:'100%', height:0 }} />
                                                {/* Target / feedback moved to banner; keep minimal tech stats here */}
                                                <div style={{ minWidth:150 }}>
                                                    <strong>First-attempt</strong><br />
                                                    <span style={{ fontSize:'.55rem' }}>{liveFirstAttemptCorrectCount}/{liveTotalTargets} ({(liveAccuracy*100).toFixed(0)}%)</span>
                                                </div>
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
