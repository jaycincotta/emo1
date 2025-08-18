declare module 'soundfont-player' {
  export interface PlayerOptions {
    gain?: number;
    duration?: number;
    attack?: number;
    decay?: number;
    sustain?: number;
    release?: number;
  }
  export interface Player {
    play(note: string | number, when?: number, options?: PlayerOptions): void;
    stop(): void;
  }
  export function instrument(ac: AudioContext, name?: string, options?: any): Promise<Player>;
  const _default: { instrument: typeof instrument };
  export default _default;
}
