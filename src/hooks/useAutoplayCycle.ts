import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTO_PLAY_INTERVAL } from '../solfege';

export interface UseAutoplayCycleParams {
  autoPlay: boolean;
  repeatCadence: boolean;
  autoPlaySpeed: 'slow'|'medium'|'fast';
  scheduleCadence: (keyOverride?: string) => number; // returns length seconds
  updateRandomNote: (opts?: { play?: boolean; keyOverride?: string; initial?: boolean }) => void; // initial marks first note after cadence/key change
  currentNote: number | null;
  playNote: (midi: number, duration?: number) => void;
  instrumentLoaded: boolean;
}

export interface UseAutoplayCycleReturn {
  isPlaying: boolean;
  startSequence: (causeNewKeyCenter?: boolean, keyOverride?: string) => Promise<void>;
  stopPlayback: (reset?: boolean) => void;
  triggerCadence: () => Promise<void>;
  onNoteComplete: () => void; // call after a drill note (and any random-key handling) fully finishes
  markKeyChange: (newKey: string, immediate?: boolean) => void; // register a key change so next cycle/play forces cadence
}

export function useAutoplayCycle(params: UseAutoplayCycleParams): UseAutoplayCycleReturn {
  const { autoPlay, repeatCadence, autoPlaySpeed, scheduleCadence, updateRandomNote, currentNote, playNote, instrumentLoaded } = params;
  const [isPlaying, setIsPlaying] = useState(false);
  const cadenceTimeoutRef = useRef<number | null>(null);
  const autoplayTimeoutRef = useRef<number | null>(null);
  const firstPlayRef = useRef(true);
  const pendingStartRef = useRef<{ causeNewKeyCenter: boolean; keyOverride?: string } | null>(null);

  // Dynamic config refs to avoid restarting sequence on setting changes
  const repeatCadenceRef = useRef(repeatCadence);
  const autoPlaySpeedRef = useRef(autoPlaySpeed);
  const scheduleCadenceRef = useRef(scheduleCadence);
  const updateRandomNoteRef = useRef(updateRandomNote);
  const autoPlayRef = useRef(autoPlay);
  const lastKeyRef = useRef<string | null>(null);
  const pendingKeyChangeRef = useRef<string | null>(null); // set externally via scheduleCadence keyOverride usage

  useEffect(() => { repeatCadenceRef.current = repeatCadence; }, [repeatCadence]);
  useEffect(() => { autoPlaySpeedRef.current = autoPlaySpeed; }, [autoPlaySpeed]);
  useEffect(() => { scheduleCadenceRef.current = scheduleCadence; }, [scheduleCadence]);
  useEffect(() => { updateRandomNoteRef.current = updateRandomNote; }, [updateRandomNote]);
  useEffect(() => { autoPlayRef.current = autoPlay; }, [autoPlay]);

  const clearTimers = () => {
    if (cadenceTimeoutRef.current) window.clearTimeout(cadenceTimeoutRef.current);
    if (autoplayTimeoutRef.current) window.clearTimeout(autoplayTimeoutRef.current);
  };

  const internalStart = useCallback((causeNewKeyCenter: boolean = false, keyOverride?: string) => {
    if (!instrumentLoaded) {
      // Defer until instrument is ready to ensure proper piano timbre (avoid oscillator fallback)
      pendingStartRef.current = { causeNewKeyCenter, keyOverride };
      return;
    }
    clearTimers();
  const autoplayMode = autoPlayRef.current;
    setIsPlaying(autoplayMode);
    let delay = 0;
    const isFirst = firstPlayRef.current;
  // Cadence conditions:
  // - First test ever
  // - Explicit key change
  // - Repeat cadence enabled (now applies in manual mode too)
  const needCadenceInitial = isFirst || causeNewKeyCenter || repeatCadenceRef.current;

    const playInitial = () => {
      if (causeNewKeyCenter && keyOverride) lastKeyRef.current = keyOverride; else if (lastKeyRef.current == null) lastKeyRef.current = keyOverride || lastKeyRef.current;
      updateRandomNoteRef.current({ play: true, keyOverride: causeNewKeyCenter ? keyOverride : undefined, initial: true });
      if (isFirst) firstPlayRef.current = false;
    };

    if (needCadenceInitial) {
      delay = scheduleCadenceRef.current(keyOverride) * 1000 + 400;
      cadenceTimeoutRef.current = window.setTimeout(playInitial, delay);
    } else {
      playInitial();
    }
  }, [instrumentLoaded]);

  const startSequence = useCallback(async (causeNewKeyCenter: boolean = false, keyOverride?: string) => {
    internalStart(causeNewKeyCenter, keyOverride);
  }, [internalStart]);

  const stopPlayback = useCallback((reset?: boolean) => {
    setIsPlaying(false);
    clearTimers();
    if (reset) {
      // parent handles clearing displayed note
    }
  }, []);

  const triggerCadence = useCallback(async () => {
    if (!params.instrumentLoaded) return;
    clearTimers();
    const wasAutoplay = autoPlay && isPlaying;
    const durSec = scheduleCadence();
    const extraMs = 350;
    cadenceTimeoutRef.current = window.setTimeout(() => {
      if (currentNote != null) {
        playNote(currentNote, 1.4);
      }
      // Autoplay chaining now handled after each note completes (post-note pause) outside cadence trigger.
    }, durSec * 1000 + extraMs);
  }, [autoPlay, isPlaying, scheduleCadence, currentNote, playNote, autoPlaySpeed, repeatCadence, updateRandomNote, params.instrumentLoaded]);

  // Callback to be invoked by caller after a note fully finishes (ensures consistent pause logic)
  const onNoteComplete = useCallback(() => {
    if (!autoPlayRef.current || !isPlaying) return;
    const interval = AUTO_PLAY_INTERVAL[autoPlaySpeedRef.current];
    autoplayTimeoutRef.current = window.setTimeout(() => {
      if (!autoPlayRef.current) return;
      const nextKey = lastKeyRef.current; // key center managed externally; if it changed, caller will have invoked startSequence
      // Always cadence if repeatCadence OR a key change is pending (tracked via pendingKeyChangeRef)
      const needCadence = repeatCadenceRef.current || (pendingKeyChangeRef.current !== null && pendingKeyChangeRef.current !== lastKeyRef.current);
      if (needCadence) {
        const rawKey = pendingKeyChangeRef.current || nextKey;
        if (pendingKeyChangeRef.current) { lastKeyRef.current = pendingKeyChangeRef.current; pendingKeyChangeRef.current = null; }
        const usedKey: string | undefined = rawKey || undefined;
        const cadDurSec = scheduleCadenceRef.current(usedKey) + 0.35; // include buffer
        cadenceTimeoutRef.current = window.setTimeout(() => {
          updateRandomNoteRef.current({ play: true, keyOverride: usedKey });
        }, cadDurSec * 1000);
      } else {
        updateRandomNoteRef.current({ play: true });
      }
    }, interval);
  }, []);

  // Removed auto-restart on setting changes to isolate tests to user actions or existing timers.

  // When instrument finishes loading, execute any pending start
  useEffect(() => {
    if (instrumentLoaded && pendingStartRef.current) {
      const p = pendingStartRef.current; pendingStartRef.current = null;
      internalStart(p.causeNewKeyCenter, p.keyOverride);
    }
  }, [instrumentLoaded, internalStart]);

  useEffect(() => () => clearTimers(), []);

  // External registration of a key change. If immediate && autoplay running, restart sequence now.
  const markKeyChange = useCallback((newKey: string, immediate?: boolean) => {
    // If autoplay active and immediate requested, restart with cadence now
    if (immediate && autoPlayRef.current && isPlaying) {
      pendingKeyChangeRef.current = null;
      internalStart(true, newKey);
      return;
    }
    // Otherwise mark for next manual Play or next autoplay cycle
    pendingKeyChangeRef.current = newKey;
  }, [internalStart, isPlaying]);

  // Enhance internalStart to honor any pending key change if caller didn't explicitly pass causeNewKeyCenter
  const originalInternalStart = internalStart; // preserve reference (already stable via useCallback)
  // We can't redefine internalStart itself post-declaration; instead wrap startSequence logic below

  const wrappedStartSequence = useCallback(async (causeNewKeyCenter: boolean = false, keyOverride?: string) => {
    // If no explicit key change flag but we have a pending key change, elevate it
    if (!causeNewKeyCenter && pendingKeyChangeRef.current) {
      causeNewKeyCenter = true;
      keyOverride = pendingKeyChangeRef.current;
      pendingKeyChangeRef.current = null;
    }
    await originalInternalStart(causeNewKeyCenter, keyOverride);
  }, [originalInternalStart]);

  return { isPlaying, startSequence: wrappedStartSequence, stopPlayback, triggerCadence, onNoteComplete, markKeyChange };
}
