import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTO_PLAY_INTERVAL } from '../solfege';

export interface UseAutoplayCycleParams {
  autoPlay: boolean;
  repeatCadence: boolean;
  autoPlaySpeed: 'slow'|'medium'|'fast';
  scheduleCadence: (keyOverride?: string) => number; // returns length seconds
  updateRandomNote: (opts?: { play?: boolean; keyOverride?: string }) => void;
  currentNote: number | null;
  playNote: (midi: number, duration?: number) => void;
  instrumentLoaded: boolean;
}

export interface UseAutoplayCycleReturn {
  isPlaying: boolean;
  startSequence: (causeNewKeyCenter?: boolean, keyOverride?: string) => Promise<void>;
  stopPlayback: (reset?: boolean) => void;
  triggerCadence: () => Promise<void>;
}

export function useAutoplayCycle(params: UseAutoplayCycleParams): UseAutoplayCycleReturn {
  const { autoPlay, repeatCadence, autoPlaySpeed, scheduleCadence, updateRandomNote, currentNote, playNote } = params;
  const [isPlaying, setIsPlaying] = useState(false);
  const cadenceTimeoutRef = useRef<number | null>(null);
  const autoplayTimeoutRef = useRef<number | null>(null);
  const firstPlayRef = useRef(true);

  const clearTimers = () => {
    if (cadenceTimeoutRef.current) window.clearTimeout(cadenceTimeoutRef.current);
    if (autoplayTimeoutRef.current) window.clearTimeout(autoplayTimeoutRef.current);
  };

  const internalStart = useCallback((causeNewKeyCenter: boolean = false, keyOverride?: string) => {
    clearTimers();
    const autoplayMode = autoPlay;
    setIsPlaying(autoplayMode);
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
  }, [autoPlay, autoPlaySpeed, repeatCadence, scheduleCadence, updateRandomNote]);

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
  }, [autoPlay, isPlaying, scheduleCadence, currentNote, playNote, autoPlaySpeed, repeatCadence, updateRandomNote, params.instrumentLoaded]);

  useEffect(() => {
    if (isPlaying) {
      internalStart(false);
    }
  }, [autoPlaySpeed, repeatCadence, scheduleCadence, internalStart, isPlaying]);

  useEffect(() => () => clearTimers(), []);

  return { isPlaying, startSequence, stopPlayback, triggerCadence };
}
