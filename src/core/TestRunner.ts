import { AudioService } from '../audio/AudioService';

export type RunnerState = 'idle' | 'cadence' | 'note' | 'postPause' | 'canceled';

export interface SettingsSnapshot {
  id: number;
  timestamp: number;
  cadenceSpeed: 'slow'|'medium'|'fast';
  autoPlaySpeed: 'slow'|'medium'|'fast';
  repeatCadence: boolean;
  randomKeyChance: number;
  noteMode: 'diatonic'|'non'|'chromatic';
  low: number;
  high: number;
  liveStrict?: boolean;
  liveRepeatCadence?: boolean;
}

export interface TestDescriptor {
  keyCenter: string;
  targetMidi: number;
  playCadence: boolean;
  reason: 'play'|'again'|'auto'|'newKey'|'liveNext';
  snapshot: SettingsSnapshot;
  flags?: { keyChanged?: boolean };
}

export interface TestRunnerCallbacks {
  scheduleCadence: (key: string, speed: 'slow'|'medium'|'fast') => number; // returns seconds length
  playNote: (midi: number, duration?: number) => void;
  onCadenceStart?: (desc: TestDescriptor) => void;
  onNoteStart?: (desc: TestDescriptor) => void;
  onComplete?: (desc: TestDescriptor, meta: { durationMs: number }) => void;
  onCanceled?: (desc: TestDescriptor | null, reason: string) => void;
}

export class TestRunner {
  private state: RunnerState = 'idle';
  private current: TestDescriptor | null = null;
  private cadenceTimer: number | null = null;
  private noteTimer: number | null = null;
  private postTimer: number | null = null;
  private canceled = false;
  private startMs = 0;
  private idCounter = 0;

  constructor(private cb: TestRunnerCallbacks) {}

  getState(): RunnerState { return this.state; }
  getCurrent(): TestDescriptor | null { return this.current; }

  start(desc: TestDescriptor) {
    if (this.state !== 'idle') {
      // Soft cancel existing then start new
      this.cancel('preempt');
    }
    this.canceled = false;
    this.current = desc;
    this.startMs = performance.now();
    if (desc.playCadence) {
      this.runCadence(desc);
    } else {
      this.runNote(desc, 0);
    }
  }

  private runCadence(desc: TestDescriptor) {
    if (this.canceled || !this.current) return;
    this.state = 'cadence';
    this.cb.onCadenceStart?.(desc);
    const cadLenSec = this.cb.scheduleCadence(desc.keyCenter, desc.snapshot.cadenceSpeed);
    // schedule note after small buffer (~400ms)
    this.cadenceTimer = window.setTimeout(() => this.runNote(desc, cadLenSec), cadLenSec * 1000 + 380);
  }

  private runNote(desc: TestDescriptor, cadenceSeconds: number) {
    if (this.canceled || !this.current) return;
    this.state = 'note';
    this.cb.onNoteStart?.(desc);
    this.cb.playNote(desc.targetMidi, 1.4);
    // Fixed assumed playback length ~1.55s then complete (controller may schedule post pause externally)
    this.noteTimer = window.setTimeout(() => this.finish(), 1550);
  }

  // Controllers implement delay logic after onComplete; runner stops at note end.
  private finish() {
    if (!this.current) return;
    const desc = this.current;
    if (!this.canceled) {
      this.state = 'idle';
      const dur = performance.now() - this.startMs;
      this.cb.onComplete?.(desc, { durationMs: dur });
      this.current = null;
    }
  }

  cancel(reason: string) {
    if (this.state === 'idle' && !this.current) {
      this.cb.onCanceled?.(null, reason);
      return;
    }
    this.canceled = true;
    if (this.cadenceTimer) window.clearTimeout(this.cadenceTimer);
    if (this.noteTimer) window.clearTimeout(this.noteTimer);
    if (this.postTimer) window.clearTimeout(this.postTimer);
    const desc = this.current;
    this.current = null;
    this.state = 'canceled';
    this.cb.onCanceled?.(desc, reason);
    this.state = 'idle';
  }
}
