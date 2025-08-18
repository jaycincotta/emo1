import React, { useCallback, useMemo, useRef, useLayoutEffect, useState } from 'react';

interface FullKeyboardRangeProps { low: number; high: number; currentNote: number | null; onChange: (low:number, high:number)=>void; }

const A0 = 21;
const C8 = 108;
const BLACKS = new Set([1,3,6,8,10]);
const isBlack = (m:number)=> BLACKS.has(m%12);
const isWhite = (m:number)=> !isBlack(m);
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function midiToName(m:number){
  const name = NOTE_NAMES[m%12];
  const octave = Math.floor(m/12)-1;
  return name+octave;
}

function prevWhite(m:number){ let x=m-1; while(x>=A0 && !isWhite(x)) x--; return x>=A0? x: m; }
function nextWhite(m:number){ let x=m+1; while(x<=C8 && !isWhite(x)) x++; return x<=C8? x: m; }

const FullKeyboardRange: React.FC<FullKeyboardRangeProps> = ({ low, high, currentNote, onChange }) => {
  const scrollRef = useRef<HTMLDivElement|null>(null);
  const [whiteW, setWhiteW] = useState(42); // dynamic width per white key

  const keys = useMemo(()=>{
    const arr: { midi:number; whiteIndex:number; isWhite:boolean }[] = [];
    let whiteCount = 0;
    for (let m=A0; m<=C8; m++) {
      const white = isWhite(m);
      arr.push({ midi:m, whiteIndex: white? whiteCount: whiteCount-1, isWhite: white });
      if (white) whiteCount++;
    }
    return arr;
  }, []);

  const totalWhite = useMemo(()=> keys.filter(k=>k.isWhite).length, [keys]);
  const keyboardPixelWidth = whiteW * totalWhite;

  // Responsive sizing: fill width until key width would drop below half (21px); then clamp and allow scroll
  useLayoutEffect(()=>{
    if (!scrollRef.current) return;
    const el = scrollRef.current;
  const MIN_W = 9; const IDEAL_W = 42; const LEGIBLE_W = 18; // lowered minima for very narrow phones
    const compute = () => {
      const avail = el.clientWidth; // constrained by root container now
      if (avail >= totalWhite * IDEAL_W) {
        setWhiteW(IDEAL_W);
      } else if (avail >= totalWhite * LEGIBLE_W) {
        // scale proportionally between LEGIBLE_W and IDEAL_W
        const w = Math.floor(avail / totalWhite);
        setWhiteW(Math.max(LEGIBLE_W, Math.min(IDEAL_W, w)));
      } else {
        // clamp at MIN_W and allow scroll
        setWhiteW(MIN_W);
      }
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [totalWhite]);

  // Auto boundary selection: choose closest edge (low/high) to clicked white key
  const handleSelectWhite = useCallback((midi:number)=>{
    if (!isWhite(midi)) return;
    const dLow = Math.abs(midi - low);
    const dHigh = Math.abs(midi - high);
    if (dLow <= dHigh) {
      // updating low; ensure still <= high
      if (midi > high) onChange(high, midi); else onChange(midi, high);
    } else {
      if (midi < low) onChange(midi, low); else onChange(low, midi);
    }
  }, [low, high, onChange]);

  const adjust = (which:'low'|'high', dir:'-'|'+') => {
    if (which==='low') { if (dir==='-') { const nw = prevWhite(low); if (nw < high) onChange(nw, high); } else { const nw = nextWhite(low); if (nw <= high) onChange(nw, high); } }
    else { if (dir==='-') { const nh = prevWhite(high); if (nh >= low) onChange(low, nh); } else { const nh = nextWhite(high); if (nh > low) onChange(low, nh); } }
  };

  return (
    <div className="full-piano-wrapper" ref={scrollRef} role="group" aria-label="Full piano 88 keys" data-range={`${midiToName(low)}-${midiToName(high)}`}>
  <div className="full-piano" style={{ width: keyboardPixelWidth, ['--white-w' as any]: whiteW+'px', height: Math.round(whiteW * 3.1) }}>
          {keys.filter(k=>k.isWhite).map(k => {
            const inRange = k.midi>=low && k.midi<=high;
            const edge = k.midi===low || k.midi===high;
            const active = currentNote===k.midi;
            return (
        <div key={k.midi} className={'kp white'+(inRange?' in-range':'')+(edge?' edge':'')+(active?' active':'')}
          onClick={()=>handleSelectWhite(k.midi)} data-midi={k.midi} aria-label={midiToName(k.midi)} />
            );
          })}
          {keys.filter(k=>!k.isWhite).map(k => {
            const prevWhiteIndex = k.whiteIndex; // position left after that white
            const left = (prevWhiteIndex + 0.72) * whiteW;
            const inRange = k.midi>=low && k.midi<=high;
            const active = currentNote===k.midi;
            return (
              <div key={k.midi}
                   className={'kp black'+(inRange?' in-range':'')+(active?' active':'')}
                   style={{ left }}
                   data-midi={k.midi}
                   aria-label={midiToName(k.midi)} />
            );
          })}
    </div>
  </div>
  );
};

export default FullKeyboardRange;
