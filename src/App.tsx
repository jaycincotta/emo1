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
import { ControllerManager } from './core/controllers/ControllerManager';
import { ModeController } from './core/controllers/ControllerTypes';
import { chooseTarget as chooseTargetHelper } from './core/chooseTarget';

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
    const lastPlayedNoteRef = useRef<number | null>(null);
    const [showSolfege, setShowSolfege] = useState<string>('');
    // Debounce lock for Again / New Key actions
    const [disableActionButtons, setDisableActionButtons] = useState(false);
    const disableActionButtonsRef = useRef(false);
    useEffect(()=> { disableActionButtonsRef.current = disableActionButtons; }, [disableActionButtons]);
    // Cadence policy per requirements:
    // - Always cadence on first play or when key center changes.
    // - If autoplay ON: each cycle cadences only if repeatCadence is ON (else just notes after initial/new-key cadence).
    {/* Removed FullKeyboard component to avoid compile error */ }
    const [repeatCadence, setRepeatCadence] = useState(true);
    // Unified mode selector replaces separate autoplay checkbox + Live button
    const [mode, setMode] = useState<'manual'|'autoplay'|'live'>('autoplay');
    const autoPlay = mode === 'autoplay';
    // Note selection mode: diatonic only, non-diatonic only, or chromatic (both)
    const [noteMode, setNoteMode] = useState<'diatonic' | 'non' | 'chromatic'>('diatonic');
    // Full keyboard shown; keep existing low/high state for note selection but hide UI controls
    const [lowPitch, setLowPitch] = useState(DEFAULT_LOW);
    const [highPitch, setHighPitch] = useState(DEFAULT_HIGH);
    const [cadenceSpeed, setCadenceSpeed] = useState<'slow' | 'medium' | 'fast'>('medium');
    const [autoPlaySpeed, setAutoPlaySpeed] = useState<'slow' | 'medium' | 'fast'>('medium');
    const [showInstructions, setShowInstructions] = useState(() => { try { return sessionStorage.getItem('etHideInstr') ? false : true; } catch { return true; } });
    const [showHelpModal, setShowHelpModal] = useState(false);
    // Random key probability slider (0,25,50,75,100). 0 = disabled
    const [randomKeyChance, setRandomKeyChance] = useState<number>(0);
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

    // Sequencing guards to ensure only one test (cadence+note) runs at a time
    const cadenceActiveRef = useRef(false);
    const noteActiveRef = useRef(false);
    const pendingRandomKeyRef = useRef(false);
    const autoplayResumeRef = useRef(false); // retained for now (legacy) but no longer used to stop/resume autoplay on key roll
    // Manual mode: track a single user-triggered test window for random key chance
    const manualUserActionRef = useRef(false);
    // Queue for manual Play pressed while note still sounding
    const pendingManualPlayRef = useRef(false);

    // Refs for values defined later (avoid forward dependency issues in updateRandomNote)
    const isPlayingRef = useRef(false);
    const stopPlaybackRef = useRef<(() => void) | null>(null);
    const newKeyCenterFnRef = useRef<(() => void) | null>(null);
    const randomKeyChangeFnRef = useRef<((resumeAuto:boolean)=>void) | null>(null);

    const scheduleCadence = useCallback((keyOverride?: string): number => {
        const key = keyOverride ?? keyCenterRef.current;
        const result = audioServiceRef.current?.scheduleCadence(key, cadenceSpeed);
        const len = result?.lengthSec || 0;
        if (len > 0) {
            cadenceActiveRef.current = true;
            setTimeout(() => { cadenceActiveRef.current = false; }, len * 1000 + 50);
        }
        return len;
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

    // We'll capture instrumentActive via ref updated in effect to avoid dependency ordering issues
    const instrumentActiveRef = useRef(false);
    const updateRandomNote = useCallback((options?: { play?: boolean; keyOverride?: string; fromRandomKey?: boolean; initial?: boolean }) => {
        // Prevent overlapping tests: if cadence or note active, ignore this trigger
        if (cadenceActiveRef.current || noteActiveRef.current) return;
        const note = chooseRandomNote();
        if (note == null) return;
        setCurrentNote(note);
    lastPlayedNoteRef.current = note;
        const root = computeRoot(options?.keyOverride ?? keyCenterRef.current);
        const rel = (note - root + 1200) % 12;
        setShowSolfege(SOLFEGE_MAP[rel].syllable);
        if (options?.play) {
            setTimeout(() => {
                playNote(note, 1.4);
                noteActiveRef.current = true;
                setTimeout(() => {
                    noteActiveRef.current = false;
                    console.log('[autoplay] note finished', {pendingRandomKey: pendingRandomKeyRef.current, isPlaying: isPlayingRef.current});
                    if (pendingRandomKeyRef.current) {
                        pendingRandomKeyRef.current = false;
                        randomKeyChangeFnRef.current?.(true); // always treat as resume in autoplay
                    } else if (pendingManualPlayRef.current) {
                        // Manual queued play request
                        pendingManualPlayRef.current = false;
                        manualUserActionRef.current = true;
                        startSequence(false);
                    } else if (isPlayingRef.current) {
                        console.log('[autoplay] calling onNoteComplete');
                        onNoteComplete();
                    }
                    // Unlock action buttons after note completes (covers Again/New Key debounce)
                    if (disableActionButtonsRef.current) {
                        setDisableActionButtons(false);
                    }
                }, 1550);
            }, 10);
        }
        // Random key chance logic:
        // Autoplay: evaluate each test.
        // Manual: evaluate only once per user-triggered test (manualUserActionRef gate) to avoid chaining into pseudo-autoplay.
        if (!instrumentActiveRef.current && randomKeyChance > 0 && !options?.fromRandomKey && !pendingRandomKeyRef.current) {
            const allow = isPlayingRef.current || manualUserActionRef.current;
            if (allow) {
                const rolled = Math.random() * 100 < randomKeyChance;
                if (rolled) {
                    // Autoplay: no longer stop playback; just flag pending key change handled after note
                    if (isPlayingRef.current) {
                        console.log('[autoplay] random key rolled (autoplay)');
                    } else {
                        console.log('[manual] random key rolled');
                    }
                    pendingRandomKeyRef.current = true;
                }
                if (!isPlayingRef.current) manualUserActionRef.current = false; // consume manual window
            }
        }
    }, [chooseRandomNote, playNote, randomKeyChance]);

    const { isPlaying, startSequence, stopPlayback, triggerCadence, onNoteComplete, markKeyChange, syncAutoplayFlag, interruptCycle, replaySameNoteWithCadence, setReplayCompleteHandler } = useAutoplayCycle({
        autoPlay: !instrumentLoaded ? autoPlay : (autoPlay && true),
        repeatCadence,
        autoPlaySpeed,
        scheduleCadence,
        updateRandomNote,
        currentNote,
        playNote,
        instrumentLoaded,
        applyKeyCenter: (k:string) => {
            setKeyCenter(k);
            keyCenterRef.current = k;
            setCurrentNote(null);
            setShowSolfege('');
        }
    });

    // Controller layer integration (phase migration)
    const controllerManagerRef = useRef<ControllerManager | null>(null);
    const activeControllerRef = useRef<ModeController | null>(null);

    const settingsSnapshot = useCallback(() => ({
        cadenceSpeed,
        autoPlaySpeed,
        repeatCadence,
        randomKeyChance,
        noteMode,
        low: lowPitch,
        high: highPitch,
    }), [cadenceSpeed, autoPlaySpeed, repeatCadence, randomKeyChance, noteMode, lowPitch, highPitch]);

    // (moved below instrumentActive for proper ordering)

    // Keep refs in sync for guarded callbacks
    useEffect(() => { isPlayingRef.current = isPlaying; stopPlaybackRef.current = stopPlayback; }, [isPlaying, stopPlayback]);

    // Instrument (Live Piano) mode hook integration
    const instrumentMode = useInstrumentMode({ keyCenterRef, getAudioContext: () => audioCtxRef.current });
    const instrumentActive = instrumentMode.active; // underlying mic state
    // Live mode play/stop (targets) controlled separately from mic active
    const [liveRunning, setLiveRunning] = useState(false);
    const liveRunningRef = useRef(false);
    useEffect(()=> { liveRunningRef.current = liveRunning; }, [liveRunning]);
    // keep ref in sync for updateRandomNote callback
    useEffect(()=> { instrumentActiveRef.current = instrumentActive; }, [instrumentActive]);

    // Controller layer (relocated)
    const controllerContext = useRef({
        getCurrentKey: () => keyCenterRef.current,
        setKeyCenter: (k: string) => { markKeyChange(k); },
        setCurrentNote: (m: number | null) => setCurrentNote(m),
        scheduleStart: ({ causeNewKey, reason }: { causeNewKey?: boolean; reason: 'play'|'again'|'auto'|'newKey'|'liveNext' }) => {
            if (reason === 'again') {
                if (currentNote != null) { triggerCadence(); } else { startSequence(!!causeNewKey); }
                return;
            }
            if (causeNewKey) {
                let key = keyCenterRef.current;
                if (keysCircle.length > 1) {
                    for (let i=0;i<30;i++) {
                        const cand = keysCircle[Math.floor(Math.random()*keysCircle.length)] as string;
                        if (cand !== keyCenterRef.current) { key = cand; break; }
                    }
                }
                markKeyChange(key);
                startSequence(true, key);
            } else {
                startSequence(false);
            }
        },
        chooseTarget: (prev?: number|null) => chooseTargetHelper({
            low: lowPitch,
            high: highPitch,
            noteMode,
            keyRoot: computeRoot(keyCenterRef.current),
            prev: prev ?? null,
        }) || 0,
        settingsSnapshot,
    });

    useEffect(() => {
        const desired: 'manual'|'autoplay'|'live' = instrumentActive ? 'live' : (autoPlay ? 'autoplay' : 'manual');
        console.log('[mode] switching controller ->', desired);
        if (!controllerManagerRef.current) {
            controllerManagerRef.current = new ControllerManager(controllerContext.current as any);
        }
        const mgr = controllerManagerRef.current;
        const c = mgr.switch(desired);
        activeControllerRef.current = c;
    }, [autoPlay, instrumentActive]);

    // Respond to mode selector changes: start/stop live mic, reset liveRunning
    useEffect(() => {
        if (mode === 'live') {
            if (!instrumentActive) instrumentMode.startMode();
            setLiveRunning(false); // will start on Play
        } else {
            if (instrumentActive) instrumentMode.stopMode();
            setLiveRunning(false);
        }
    }, [mode]);

    const handlePlayClick = useCallback(() => {
        if (mode === 'live') {
            // Live mode Play/Stop toggles target cycle (mic already handled by mode switch)
            console.log('[ui] Live mode Play click', { liveRunning });
            if (liveRunning) {
                setLiveRunning(false);
                setLiveFeedback('idle');
                setDisableActionButtons(false);
                return;
            } else {
                resetLiveState();
                setLiveRunning(true);
                startNewLiveTarget(false);
                return;
            }
        }
        if (instrumentActive) return; // safety
        console.log('[ui] Play click', { isPlaying, autoPlay, noteActive: noteActiveRef.current });
        if (isPlaying) {
            console.log('[stop] stopping playback');
            stopPlayback(true);
            setCurrentNote(null);
            setShowSolfege('');
            setDisableActionButtons(false);
            // Autoplay Stop now acts like pause: remain in autoplay mode (no mode switch)
            return;
        }
        if (noteActiveRef.current) {
            pendingManualPlayRef.current = true;
            console.log('[manual] queued play until current note completes');
            return;
        }
        manualUserActionRef.current = true;
        const runManual = () => {
            console.log('[manual] starting single test');
            const safetyRefired = { fired: false };
            const safetyTimeout = window.setTimeout(() => {
                if (safetyRefired.fired) return;
                if (!cadenceActiveRef.current && !noteActiveRef.current) {
                    safetyRefired.fired = true;
                    console.log('[manual][fallback] idle after play -> forcing test');
                    markKeyChange(keyCenterRef.current);
                    startSequence(false);
                }
            }, 1200);
            startSequence(false).then(() => {
                const checkKick = () => {
                    if (cadenceActiveRef.current || noteActiveRef.current) {
                        window.clearTimeout(safetyTimeout);
                        safetyRefired.fired = true;
                    } else if (!safetyRefired.fired) {
                        setTimeout(checkKick, 150);
                    }
                };
                setTimeout(checkKick, 120);
            });
        };
        const runAutoplay = () => {
            console.log('[autoplay][ui] starting autoplay sequence');
            syncAutoplayFlag(true);
            startSequence(false);
        };
        if (!autoPlay) {
            if(!instrumentLoaded){ initInstrument().then(runManual); } else { runManual(); }
        } else {
            if(!instrumentLoaded){ initInstrument().then(runAutoplay); } else { runAutoplay(); }
        }
    }, [isPlaying, instrumentActive, instrumentLoaded, initInstrument, stopPlayback, autoPlay, syncAutoplayFlag, startSequence, mode, liveRunning]);
    // ...handlers moved below live mode helpers to avoid forward reference issues...

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
    const [liveStrict, setLiveStrict] = useState(true); // if false: octave (near) does not break streak
    const [liveRepeatCadence, setLiveRepeatCadence] = useState(true); // repeat cadence between targets
    const evaluationDisableUntilRef = useRef<number>(0); // timestamp until which we ignore detections (during cadence/target playback)
    const lastEvaluatedMidiRef = useRef<number | null>(null); // to avoid re-evaluating same sustained note
    const lastDetectedNullAtRef = useRef<number>(performance.now());
    // 'Near' (orange) now represents correct scale degree in a different octave
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
        // Intersect user-selected range with detection window so pitchy can actually recognize the target
        const detMin = instrumentMode.detectionWindow.min;
        const detMax = instrumentMode.detectionWindow.max;
        const effLow = Math.max(lowPitch, detMin);
        const effHigh = Math.min(highPitch, detMax);
        if (effLow > effHigh) return null; // no overlap
        const attempts = 80;
        for (let i = 0; i < attempts; i++) {
            const n = Math.floor(Math.random() * (effHigh - effLow + 1)) + effLow;
            const root = computeRoot(keyCenterRef.current);
            const rel = (n - root + 1200) % 12;
            const info = SOLFEGE_MAP[rel as keyof typeof SOLFEGE_MAP];
            if (!info) continue;
            if (noteMode === 'diatonic' && !info.diatonic) continue;
            if (noteMode === 'non' && info.diatonic) continue;
            return n;
        }
        return null;
    }, [highPitch, lowPitch, noteMode, instrumentMode.detectionWindow.min, instrumentMode.detectionWindow.max]);

    // Start a new target (schedules cadence + target note playback)
    const startNewLiveTarget = useCallback((reuseSame = false, suppressCadence = false) => {
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
            setLiveTotalTargets(t => t + 1);
        }
        doStart(tgt);
        if (!suppressCadence) {
            const cadenceSeconds = scheduleCadence();
            const startTime = performance.now();
            evaluationDisableUntilRef.current = startTime + cadenceSeconds * 1000 + 1500;
            setTimeout(() => {
                playNote(tgt, 1.4);
                evaluationDisableUntilRef.current = performance.now() + PROVISIONAL_NOTE_DELAY_MS + 650;
            }, cadenceSeconds * 1000 + 120);
        } else {
            // direct target note without cadence
            const blockMs = 550;
            evaluationDisableUntilRef.current = performance.now() + blockMs;
            setTimeout(() => {
                playNote(tgt, 1.4);
                evaluationDisableUntilRef.current = performance.now() + PROVISIONAL_NOTE_DELAY_MS + 650;
            }, 80);
        }
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
    const root = computeRoot(keyCenterRef.current);
    const targetRel = (liveTarget - root + 1200) % 12;
    const userRel = (stable - root + 1200) % 12;
    const sameDegreeDifferentOctave = (stable !== liveTarget) && (userRel === targetRel);
    const distance = Math.abs(stable - liveTarget); // still used for other logic (exact match check)
    const solfInfo = SOLFEGE_MAP[targetRel as keyof typeof SOLFEGE_MAP];
        if (!liveFirstAttemptRecorded) {
            // First attempt at this target
            setLiveAttemptsOnCurrent(a => a + 1);
            setLiveFirstAttemptRecorded(true);
            const firstAttemptSuccess = distance === 0 || (sameDegreeDifferentOctave && !liveStrict);
            if (firstAttemptSuccess) {
                setLiveFeedback('correct');
                setLiveSyllable(solfInfo ? solfInfo.syllable : '');
                if (distance === 0) {
                    setLiveFirstAttemptCorrectCount(c => c + 1);
                    setLiveStreak(s => s + 1);
                }
                setTimeout(() => {
                    const prospectiveStreak = distance===0 ? liveStreak + 1 : liveStreak;
                    if (prospectiveStreak >= 10) {
                        setLiveCongrats(true);
                        setTimeout(() => {
                            setLiveCongrats(false);
                            newKeyCenter();
                            setLiveStreak(0);
                            startNewLiveTarget(false, !liveRepeatCadence);
                        }, 2200);
                        return;
                    }
                    // Random key chance roll (preserve streak). Always cadence on key change.
                    if (randomKeyChance > 0 && Math.random()*100 < randomKeyChance) {
                        newKeyCenter();
                        startNewLiveTarget(false, false);
                    } else {
                        startNewLiveTarget(false, !liveRepeatCadence);
                    }
                }, 850);
            } else {
                if (sameDegreeDifferentOctave) {
                    setLiveFeedback('near');
                    if (liveStrict && liveStreak !== 0) setLiveStreak(0);
                } else {
                    setLiveFeedback('wrong');
                    if (liveStreak !== 0) setLiveStreak(0);
                }
            }
        } else {
            // Second (or later) attempt on this same target
            setLiveAttemptsOnCurrent(a => a + 1);
            if (distance === 0) {
                setLiveFeedback('correct');
                setLiveSyllable(solfInfo ? solfInfo.syllable : '');
                // Do NOT increment streak or metrics (first attempt already counted)
                setTimeout(() => startNewLiveTarget(false, !liveRepeatCadence), 900);
            } else {
                // Another wrong; if this is second attempt since last feedback change (i.e., attemptsOnCurrent >=2 and current attempt still wrong), replay cadence & same note
                if (liveAttemptsOnCurrent + 1 >= 2) {
                    // repeat same target; cadence optional
                    startNewLiveTarget(true, !liveRepeatCadence);
                }
            }
        }
    }, [instrumentActive, instrumentMode.detectedMidiState, liveTarget, liveFeedback, liveFirstAttemptRecorded, liveAttemptsOnCurrent, liveStreak, startNewLiveTarget, keyCenterRef, liveStrict, liveRepeatCadence]);

    // When entering live mode, initialize workflow
    useEffect(() => {
        if (instrumentActive) {
            if (isPlaying) stopPlayback(true);
            resetLiveState();
            // defer target start until user presses Play in live mode
        } else {
            resetLiveState();
        }
    }, [instrumentActive]);

    const liveAccuracy = liveTotalTargets > 0 ? (liveFirstAttemptCorrectCount / liveTotalTargets) : 0;

    const newKeyCenter = useCallback(() => {
        // Always enforce different key per requirement
        let key = keyCenterRef.current;
        if (keysCircle.length > 1) {
            for (let i=0;i<30;i++) {
                const cand = keysCircle[Math.floor(Math.random()*keysCircle.length)] as string;
                if (cand !== keyCenterRef.current) { key = cand; break; }
            }
        }
        if (!instrumentActive) {
            // Always initiate a test (cadence + note) on New Key button regardless of autoplay state
            manualUserActionRef.current = true; // start new manual window
            markKeyChange(key); // ensure cadence even if repeatCadence off; actual key apply deferred to cadence
            startSequence(true, key);
        }
    }, [instrumentActive, startSequence]);

    useEffect(() => { newKeyCenterFnRef.current = newKeyCenter; }, [newKeyCenter]);

    // Random key change invoked after a note completes (chance roll). In manual mode: change key only. In autoplay: restart sequence with cadence + note.
    const randomKeyChange = useCallback((resumeAuto:boolean) => {
        let key = keyCenterRef.current;
        if (keysCircle.length > 1) {
            for (let i=0;i<30;i++) {
                const cand = keysCircle[Math.floor(Math.random()*keysCircle.length)] as string;
                if (cand !== keyCenterRef.current) { key = cand; break; }
            }
        }
        if (!instrumentActive) {
            if (resumeAuto || isPlayingRef.current) {
                // Autoplay context: mark key change; let onNoteComplete schedule cadence & next note
                console.log('[autoplay] randomKeyChange defer scheduling', { key });
                markKeyChange(key); // no immediate internalStart
                onNoteComplete();
            } else {
                // Manual: do NOT auto-start; user must press Play. Mark pending; key apply deferred to cadence of next Play.
                manualUserActionRef.current = false;
                markKeyChange(key);
            }
        }
    }, [instrumentActive, onNoteComplete]);

    useEffect(()=> { randomKeyChangeFnRef.current = randomKeyChange; }, [randomKeyChange]);

    const newKeyCenterDifferent = useCallback(() => {
        let key = keyCenterRef.current;
        if (keysCircle.length > 1) {
            for (let i=0;i<30;i++) {
                const cand = keysCircle[Math.floor(Math.random()*keysCircle.length)] as string;
                if (cand !== keyCenterRef.current) { key = cand; break; }
            }
        }
        setKeyCenter(key);
        keyCenterRef.current = key;
        setCurrentNote(null);
        setShowSolfege('');
        return key;
    }, []);

    // No initial note; first Play establishes key via cadence then generates first note.

    // Ensure low <= high
    useEffect(() => {
        if (lowPitch > highPitch) setLowPitch(highPitch);
    }, [lowPitch, highPitch]);

    // Immediate effect: when cadence speed changes during active cadence scheduling for next autoplay cycle, nothing to reschedule until next cycle.
    // When autoplay speed changes, restart autoplay timing if currently playing.
    // cadenceSpeed changes only affect future scheduleCadence calls; restart handled by hook for repeatCadence/autoPlaySpeed

    // Removed automatic note refresh on setting changes to isolate test triggers to buttons & autoplay timer.

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

    // Unified mode change handler: ensures current controller/test stops cleanly
    const changeMode = useCallback((next: 'manual'|'autoplay'|'live') => {
        if (next === mode) return;
        // If leaving autoplay while playing, stop but remain in autoplay until cleanup done
        if (mode === 'autoplay' && isPlaying) {
            console.log('[modeChange] stopping autoplay before switching to', next);
            stopPlayback(true);
            setCurrentNote(null);
            setShowSolfege('');
        }
        if (mode === 'live') {
            // Stop live target flow
            setLiveRunning(false);
        }
        setMode(next);
    }, [mode, isPlaying, stopPlayback]);

    const keyDisplay = `${keyCenter} Major`;

    // Unified Again / New Key handlers (placed after all dependencies declared)
    const handleAgainClick = useCallback(() => {
    if (disableActionButtonsRef.current) return; // already locked
        if (mode === 'live') {
            if (!liveRunning || liveTarget == null) return;
        setDisableActionButtons(true);
        // Conservative timeout unlock (cadence + note ~ up to 4s worst case slow)
        setTimeout(()=> { if (disableActionButtonsRef.current) setDisableActionButtons(false); }, 4000);
            startNewLiveTarget(true, false);
            return;
        }
        if (mode === 'manual') {
            if (currentNote == null) { console.log('[again][manual] ignored (no currentNote)'); return; }
        setDisableActionButtons(true);
            // Manual replay: schedule cadence then current note; unlock after note
            const cadSec = scheduleCadence();
            setTimeout(() => {
                if (currentNote != null) {
                    playNote(currentNote, 1.4);
                    setTimeout(() => { setDisableActionButtons(false); }, 1550);
                } else {
                    setDisableActionButtons(false);
                }
            }, cadSec * 1000 + 350);
            return;
        }
        if (mode === 'autoplay') {
            const noteToReplay = currentNote ?? lastPlayedNoteRef.current;
            if (noteToReplay == null) { console.log('[again][autoplay] ignored (no note available)'); return; }
        setDisableActionButtons(true);
        console.log('[again][autoplay] replay request');
        // Safety fallback in case completion callback not fired (should rarely happen)
        setTimeout(()=> { if (disableActionButtonsRef.current) { console.log('[again][autoplay] safety unlock'); setDisableActionButtons(false); } }, 6000);
        setReplayCompleteHandler(() => { console.log('[again][autoplay] replay complete'); setDisableActionButtons(false); setReplayCompleteHandler(null); });
            replaySameNoteWithCadence(noteToReplay);
        }
    }, [mode, liveRunning, liveTarget, currentNote, scheduleCadence, playNote, replaySameNoteWithCadence, startNewLiveTarget, setReplayCompleteHandler]);

    const handleNewKeyClick = useCallback(() => {
    if (disableActionButtonsRef.current) return;
        let key = keyCenterRef.current;
        if (keysCircle.length > 1) {
            for (let i=0;i<30;i++) {
                const cand = keysCircle[Math.floor(Math.random()*keysCircle.length)] as string;
                if (cand !== keyCenterRef.current) { key = cand; break; }
            }
        }
        if (mode === 'live') {
        setDisableActionButtons(true);
        setTimeout(()=> { if (disableActionButtonsRef.current) setDisableActionButtons(false); }, 4200);
            newKeyCenterDifferent();
            if (liveRunning) startNewLiveTarget(false, false);
            return;
        }
        markKeyChange(key);
        if (mode === 'manual') {
        setDisableActionButtons(true);
            const launch = () => {
                startSequence(true, key).then(() => { /* unlock via note completion */ });
                // Fallback unlock if nothing happens (e.g., instrument load delay) in 5s
                setTimeout(()=> { if (disableActionButtonsRef.current) setDisableActionButtons(false); }, 5000);
            };
            if (!instrumentLoaded) { initInstrument().then(launch); } else { launch(); }
        } else if (mode === 'autoplay') {
        setDisableActionButtons(true);
            interruptCycle();
            const launch = () => {
                startSequence(true, key).then(()=>{/* unlock after note completion */});
                setTimeout(()=> { if (disableActionButtonsRef.current) setDisableActionButtons(false); }, 5000);
            };
            if (!instrumentLoaded) { initInstrument().then(launch); } else { launch(); }
        }
    }, [mode, liveRunning, startSequence, interruptCycle, newKeyCenterDifferent, startNewLiveTarget, instrumentLoaded, initInstrument]);

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
            <div className={`card ${styles.cardColumn}`}
                 style={{position:'relative', ...(instrumentActive ? {background: liveFeedback==='correct' ? '#053424' : liveFeedback==='near' ? '#442a07' : liveFeedback==='wrong' ? '#401414' : '#1b1f27', transition:'background .25s'} : {})}}>
                <div style={{position:'absolute', top:8, right:8, display:'flex', gap:6, zIndex:2, alignItems:'center'}}>
                    <div style={{display:'flex', alignItems:'center', gap:6}}>
                        <span style={{fontSize:'.6rem', fontWeight:700, letterSpacing:'.5px', color:'#cbd5e1'}}>Mode:</span>
                        <div style={{display:'inline-flex', background:'#1e293b', padding:4, borderRadius:6}}>
                            {['manual','autoplay','live'].map(m => (
                                <button key={m}
                                    onClick={() => { if (m !== mode) changeMode(m as any); }}
                                    style={{
                                        background: m===mode ? '#059669' : 'transparent',
                                        color: m===mode ? '#fff':'#cbd5e1',
                                        border:'1px solid '+(m===mode ? '#10b981':'#334155'),
                                        fontSize:'.6rem',
                                        padding:'.4rem .75rem',
                                        borderRadius:4,
                                        cursor:'pointer',
                                        fontWeight:700,
                                        textTransform:'uppercase',
                                        letterSpacing:'.5px',
                                        minWidth:70,
                                        transition:'background .15s,border-color .15s'
                                    }}>{m}</button>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="key-name">Key Center: <strong>{keyDisplay}</strong></div>
                <div className="solfege">
                    {instrumentActive ? (
                        liveFeedback==='correct' ? (
                            <span style={{display:'inline-flex',alignItems:'baseline',gap:'1.1rem'}}>
                                <span style={{lineHeight:1}}>{liveSyllable || '—'}</span>
                                {liveTarget!=null && <span style={{fontSize:'1.45rem',lineHeight:1,opacity:.92}}>{midiToName(liveTarget)}</span>}
                            </span>
                        ) : '—'
                    ) : (showSolfege || '—')}
                </div>
                <div className={`muted ${styles.muted}`}>
                    {!instrumentActive && currentNote != null ? midiToName(currentNote) : ''}
                </div>
                {instrumentActive && (
                    <div style={{marginTop:'.55rem', display:'flex', flexWrap:'wrap', alignItems:'center', gap:'0.85rem'}}>
                        <div style={{fontSize:'.85rem', fontWeight:600, minWidth:90}}>
                            {liveFeedback==='awaiting' && 'Play the note'}
                            {liveFeedback==='correct' && 'Correct'}
                            {liveFeedback==='near' && 'Wrong Octave'}
                            {liveFeedback==='wrong' && 'Try Again'}
                            {liveFeedback==='idle' && '…'}
                        </div>
                        <div style={{display:'flex', alignItems:'center', gap:6}} aria-label="Streak progress">
                            {[...Array(10)].map((_,i)=> <div key={i} style={{width:18,height:18,borderRadius:4,background: i<liveStreak ? '#10b981' : '#334155',border:'1px solid #475569',boxShadow: i<liveStreak ? '0 0 5px 1px rgba(16,185,129,.6)' : 'none',transition:'background .25s'}} />)}
                            <div style={{fontSize:'.75rem', fontWeight:600, marginLeft:4}}>Streak {liveStreak}/10</div>
                        </div>
                        <div style={{fontSize:'.75rem', fontWeight:600}}>
                            First-attempt: {liveFirstAttemptCorrectCount}/{liveTotalTargets} ({(liveAccuracy*100).toFixed(0)}%)
                        </div>
                        {liveCongrats && (
                            <div style={{fontSize:'.65rem', background:'#2563eb', padding:'.3rem .55rem', borderRadius:6}}>Key change incoming…</div>
                        )}
                    </div>
                )}
            </div>

            {/* Full keyboard (range selectable) below solfege */}
            {(() => {
                const detMin = instrumentMode.detectionWindow.min;
                const detMax = instrumentMode.detectionWindow.max;
                let liveLow = instrumentActive ? Math.max(lowPitch, detMin) : lowPitch;
                let liveHigh = instrumentActive ? Math.min(highPitch, detMax) : highPitch;
                if (instrumentActive && liveLow > liveHigh) { // no overlap -> fallback to detection window
                    liveLow = detMin; liveHigh = detMax;
                }
                return (
                    <div className={liveFeedback==='near' ? 'quality-near' : liveFeedback==='wrong' ? 'quality-wrong' : liveFeedback==='correct' ? 'quality-correct' : ''}>
                        <FullKeyboardRange
                            low={instrumentActive ? liveLow : lowPitch}
                            high={instrumentActive ? liveHigh : highPitch}
                            currentNote={instrumentActive ? null : currentNote}
                            detectedNote={instrumentActive ? (instrumentMode.effectiveMidi ?? instrumentMode.detectedMidiState ?? undefined) : undefined}
                            detectionActive={instrumentActive}
                            onChange={(l, h) => { setLowPitch(l); setHighPitch(h); }}
                        />
                    </div>
                );
            })()}
            <div className={`card ${styles.controlsCard}`}>
                <div className={styles.topControls}>
                    <button onClick={handlePlayClick} disabled={loadingInstrument}>
                        {mode==='live' ? (liveRunning ? '■ Stop' : '▶ Play') : (isPlaying ? '■ Stop' : '▶ Play')}
                    </button>
                    {mode!=='live' && <button className="secondary" onClick={handleAgainClick} disabled={(mode!=='autoplay' && currentNote == null) || disableActionButtons}>Again</button>}
                    {mode==='live' && <button className="secondary" onClick={handleAgainClick} disabled={!liveRunning || !liveTarget || disableActionButtons}>Again</button>}
                    {mode!=='live' && <button className="secondary" onClick={handleNewKeyClick} disabled={disableActionButtons}>New Key</button>}
                    {mode==='live' && <button className="secondary" onClick={handleNewKeyClick} disabled={disableActionButtons}>New Key</button>}
                    {mode==='live' && (
                        <>
                            <label className={styles.prominentCheck} style={{ fontSize:'.55rem', padding:'.25rem .55rem' }}>
                                <input type="checkbox" checked={liveStrict} onChange={e=>setLiveStrict(e.target.checked)} />Strict
                            </label>
                            <label className={styles.prominentCheck} style={{ fontSize:'.55rem', padding:'.25rem .55rem' }}>
                                <input type="checkbox" checked={liveRepeatCadence} onChange={e=>setLiveRepeatCadence(e.target.checked)} />Repeat cadence
                            </label>
                        </>
                    )}
                    <div className={styles.prominentToggles}>
                        {mode!=='live' && <label className={styles.prominentCheck}>
                            <input type="checkbox" checked={repeatCadence} onChange={e => setRepeatCadence(e.target.checked)} />Repeat cadence
                        </label>}
                        {!instrumentActive && (
                            <label className={styles.prominentCheck} style={{display:'flex',alignItems:'center',gap:4}}>
                                <span style={{fontSize:'.55rem'}}>Rand Key</span>
                                <input type="range" min={0} max={100} step={25} value={randomKeyChance} onChange={e=> setRandomKeyChance(Number(e.target.value))} style={{width:70}} />
                                <span style={{fontSize:'.55rem', minWidth:24, textAlign:'right'}}>{randomKeyChance===0?'Off': randomKeyChance+'%'}</span>
                            </label>
                        )}
                        {instrumentActive && <div style={{ fontSize:'.7rem', opacity:.8, padding:'.25rem .5rem' }}>Live mode</div>}
                        {instrumentActive && instrumentMode.listening && <div style={{ fontSize:'.55rem', background:'#0a4', color:'#fff', padding:'.18rem .4rem', borderRadius:4 }}>Mic</div>}
                        {instrumentActive && instrumentMode.error && <div style={{ fontSize:'.55rem', background:'#a00', color:'#fff', padding:'.18rem .4rem', borderRadius:4 }}>Mic Err</div>}
                        {instrumentActive && (
                            <label className={styles.prominentCheck} style={{display:'flex',alignItems:'center',gap:4}}>
                                <span style={{fontSize:'.55rem'}}>Rand Key</span>
                                <input type="range" min={0} max={100} step={25} value={randomKeyChance} onChange={e=> setRandomKeyChance(Number(e.target.value))} style={{width:70}} />
                                <span style={{fontSize:'.55rem', minWidth:24, textAlign:'right'}}>{randomKeyChance===0?'Off': randomKeyChance+'%'}</span>
                            </label>
                        )}
                    </div>
                </div>
                {mode!=='live' && (
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
                {mode==='live' && (
                    <div style={{ marginTop:'.6rem', display:'flex', flexWrap:'wrap', gap:'1rem', fontSize:'.7rem', lineHeight:1.3 }} aria-label="Live mode technical panel">
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
                                                {/* Metrics moved to top card; technical stats only here */}
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
                        <h2 id="helpTitle">Quick Tips – {instrumentActive ? 'Live Piano' : 'Normal'} Mode</h2>
                        {instrumentActive ? (
                            <div className={styles.helpSections} style={{ maxHeight:'52vh', overflowY:'auto', paddingRight:'.4rem' }}>
                                <div><strong>Goal</strong>: Sing or play the hidden target note. It reveals only when you match pitch exactly (green).</div>
                                <div><strong>Feedback colors</strong>: Green = exact pitch; Orange = correct scale degree different octave (Wrong Octave); Red = wrong degree.</div>
                                <div><strong>Streak</strong>: Counts consecutive targets you nail on the first attempt. 10 first-attempt wins triggers an automatic key change.</div>
                                <div><strong>Rand Key</strong>: Slider sets % chance (0–100) of an automatic different key after a first-attempt success (Wrong Octave also counts if Strict is off). Streak is preserved. A cadence always plays so you can re-orient.</div>
                                <div><strong>First-attempt %</strong>: How often your very first stable pitch on a target was correct.</div>
                                <div><strong>Strict</strong>: When ON, a Wrong Octave (orange) resets streak. When OFF, orange is forgiven (streak continues).</div>
                                <div><strong>Repeat cadence</strong>: ON = cadence each target. OFF = cadence only for the first (then just target tones).</div>
                                <div><strong>Again</strong>: Replays cadence (if enabled) and the SAME hidden target so you can re-attempt.</div>
                                <div><strong>New Key</strong>: Changes key center and generates a fresh target immediately.</div>
                                <div><strong>Wrong twice?</strong>: After two evaluated wrong attempts the same target is replayed (with cadence if enabled) to refocus your ear.</div>
                                <div><strong>Range vs detection window</strong>: Greyed keys lie outside the mic detection window (approx 28–98). Your broader practice range is preserved for normal mode.</div>
                                <div><strong>Sensitivity</strong>: Auto adapts to room sound. Manual levels trade rejection (Low) vs responsiveness (High).</div>
                                <div><strong>Profile stats</strong>: Clarity / RMS / stability frames help diagnose noise. Higher clarity & lower ambient RMS = easier detection.</div>
                                <div><strong>Key change banner</strong>: Blue notice appears right before automatic key change after streak completes.</div>
                                <div style={{opacity:.75}}><strong>Tip</strong>: Play a clean, moderately firm attack and let the note ring briefly. Very soft or repeated staccato taps (or heavy sustain pedal blur) can delay stable detection.</div>
                            </div>
                        ) : (
                            <div className={styles.helpSections} style={{ maxHeight:'52vh', overflowY:'auto', paddingRight:'.4rem' }}>
                                <div><strong>Play</strong>: Cadence (if first time or after New Key) then a random note within your range & note set.</div>
                                <div><strong>Autoplay</strong>: Continuous stream of random drill notes. Turn off for single-shot manual practice (use Play each time).</div>
                                <div><strong>Repeat cadence</strong>: Reinforces tonic each autoplay cycle. Disable for bare tones after the first cadence.</div>
                                <div><strong>Rand Key</strong>: After each drill note (manual or autoplay) there's a % chance of an automatic different key. A cadence always plays on change so you can orient before the next note.</div>
                                <div><strong>Again</strong>: Replays cadence and (if autoplay off) the most recent note so you can re-listen.</div>
                                <div><strong>New Key</strong>: Picks a different key center and immediately cadences before resuming drills.</div>
                                <div><strong>Range</strong>: Tap new low/high endpoints directly on the keyboard (full A0–C8 always selectable here).</div>
                                <div><strong>Note set</strong>: Diatonic (scale tones), Non-diatonic (chromatic neighbors only), Chromatic (all 12) controls selection pool.</div>
                                <div><strong>Speeds</strong>: Cadence speed = chord pacing; Autoplay speed = delay between drills.</div>
                                <div><strong>Solfege display</strong>: Movable-Do syllable appears with each played note (hidden in live mode until correct).</div>
                                <div><strong>Transition to Live</strong>: Use Live Piano (top-right) to switch into microphone training workflow.</div>
                                <div style={{opacity:.75}}><strong>Tip</strong>: Start diatonic first. Add non-diatonic tones once scale degrees feel automatic.</div>
                            </div>
                        )}
                        <div className={styles.helpFooter}>Movable-Do solfege; chromatic syllables: Ra Me Fi Le Te. © 2025</div>
                    </div>
                </div>
            )}

            {/* <div className="footer">Built with Soundfont piano. First interaction may require enabling audio (browser gesture). © 2025</div> */}
        </div>
    );
};

export default App;
