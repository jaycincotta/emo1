import Soundfont, { Player } from 'soundfont-player';
import { midiToName, computeRoot, TEMPO_VALUES } from '../solfege';

export interface AudioServiceOptions {
  instrument: string;
}

export interface CadenceResult {
  lengthSec: number;
}

export class AudioService {
  private ctx: AudioContext | null = null;
  private instrument: Player | null = null;
  private loading = false;

  constructor(private opts: AudioServiceOptions = { instrument: 'acoustic_grand_piano' }) {}

  get audioContext() { return this.ctx; }
  get isLoaded() { return !!this.instrument; }
  get isLoading() { return this.loading; }

  ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
    }
    return this.ctx!;
  }

  async loadInstrument() {
    if (this.instrument || this.loading) return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    this.loading = true;
    try {
      this.instrument = await Soundfont.instrument(ctx, this.opts.instrument);
    } finally {
      this.loading = false;
    }
  }

  playNote(midi: number, duration = 1) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') { ctx.resume().catch(()=>{}); }
    if (this.instrument) {
      try { this.instrument.play(midiToName(midi), ctx.currentTime + 0.01, { duration }); return; } catch {}
    }
    // fallback oscillator
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  }

  scheduleCadence(key: string, speed: 'slow'|'medium'|'fast'): CadenceResult {
    if (!this.instrument || !this.ctx) return { lengthSec: 0 };
    const root = computeRoot(key);
    const tempo = TEMPO_VALUES[speed];
    const I = [root, root+4, root+7];
    const IV = [root+5, root+9, root+12];
    const V = [root+7, root+11, root+14];
    let rel = 0;
    const chordDuration = 0.9 * tempo;
    const chordGap = 0.1 * tempo;
    const seq = [I, IV, V, I];
    const baseTime = this.ctx.currentTime + 0.05;
    seq.forEach(ch => {
      ch.forEach(n => {
        try { this.instrument!.play(midiToName(n), baseTime + rel, { duration: chordDuration }); } catch {}
      });
      rel += chordDuration + chordGap;
    });
    return { lengthSec: rel };
  }
}
