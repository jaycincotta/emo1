export type ModeName = 'manual' | 'autoplay' | 'live';

export interface TestResultMeta {
  id: number;
  reason: 'play'|'again'|'auto'|'newKey'|'liveNext';
  keyCenter: string;
  targetMidi: number;
  durationMs: number;
  timestamp: number;
}

export interface ControllerContext {
  getCurrentKey(): string;
  setKeyCenter(k: string): void;
  setCurrentNote(midi: number | null): void;
  scheduleStart: (opts: { causeNewKey?: boolean; reason: TestResultMeta['reason'] }) => void;
  chooseTarget: (prev?: number|null) => number | null;
  settingsSnapshot: () => any;
}

export interface ModeController {
  name: ModeName;
  startInitial(): void;
  handleUser(action: 'play'|'stop'|'again'|'newKey'|'exitLive'): void;
  onTestComplete(meta: TestResultMeta): void;
  dispose(): void;
}
