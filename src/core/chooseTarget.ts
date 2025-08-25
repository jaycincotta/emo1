import { SOLFEGE_MAP } from '../solfege';

export interface ChooseTargetParams {
  low: number; high: number;
  noteMode: 'diatonic'|'non'|'chromatic';
  keyRoot: number;
  prev?: number | null;
  maxAttempts?: number;
}

export function chooseTarget({ low, high, noteMode, keyRoot, prev, maxAttempts = 80 }: ChooseTargetParams): number | null {
  for (let i=0;i<maxAttempts;i++) {
    const cand = Math.floor(Math.random() * (high - low + 1)) + low;
    if (cand === prev) continue; // avoid immediate repeat
    const rel = (cand - keyRoot + 1200) % 12;
    const info = SOLFEGE_MAP[rel as keyof typeof SOLFEGE_MAP];
    if (!info) continue;
    if (noteMode === 'diatonic' && !info.diatonic) continue;
    if (noteMode === 'non' && info.diatonic) continue;
    return cand;
  }
  return null;
}
