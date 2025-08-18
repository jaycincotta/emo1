// Centralized musical/solfege constants & helpers
// Keeping naming identical to previous inlined constants to minimize refactor churn.

export const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export const SOLFEGE_MAP: Record<number, { diatonic: boolean; syllable: string }> = {
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

export type CadenceSpeed = 'slow' | 'medium' | 'fast';
export type AutoPlaySpeed = CadenceSpeed;

export const TEMPO_VALUES: Record<CadenceSpeed, number> = { slow: 0.9, medium: 0.6, fast: 0.4 };
export const AUTO_PLAY_INTERVAL: Record<AutoPlaySpeed, number> = { slow: 4000, medium: 3000, fast: 1800 };

export const DEFAULT_LOW = 21;  // A0
export const DEFAULT_HIGH = 108; // C8

export const keysCircle = ['C','G','D','A','E','B','F#','Db','Ab','Eb','Bb','F'] as const;

export const KEY_TO_SEMITONE: Record<string, number> = {
  C:0, G:7, D:2, A:9, E:4, B:11, 'F#':6, Db:1, Ab:8, Eb:3, Bb:10, F:5
};

export function midiToName(midi: number) {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export function computeRoot(key: string) {
  const base = 60; // anchor at C4 octave
  const baseSemitone = base % 12;
  const semitone = KEY_TO_SEMITONE[key] ?? 0;
  const offset = (semitone - baseSemitone + 12) % 12;
  return base + offset;
}
