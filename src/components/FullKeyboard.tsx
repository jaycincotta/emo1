import React, { useEffect, useMemo, useRef, useState } from 'react';

interface FullKeyboardProps { currentNote: number | null; }

const A0 = 21; const C8 = 108; const BLACKS = new Set([1,3,6,8,10]);
const isBlack = (m:number)=> BLACKS.has(m%12);
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const midiToName = (m:number)=> NOTE_NAMES[m%12] + (Math.floor(m/12)-1);

export const FullKeyboard: React.FC<FullKeyboardProps> = ({ currentNote }) => {
  const wrapperRef = useRef<HTMLDivElement|null>(null);
  const [whiteW, setWhiteW] = useState(42);

  const keys = useMemo(()=>{
    const arr: { midi:number; whiteIndex:number; isWhite:boolean }[] = [];
    let whiteCount = 0;
    for (let m=A0; m<=C8; m++) {
      const white = !isBlack(m);
      arr.push({ midi:m, whiteIndex: white? whiteCount : whiteCount-1, isWhite: white });
      if (white) whiteCount++;
    }
    return arr;
  }, []);

  const totalWhite = useMemo(()=> keys.filter(k=>k.isWhite).length, [keys]);

  useEffect(()=>{
    if (!wrapperRef.current) return;
    const el = wrapperRef.current;
    const calc = () => {
      const avail = el.clientWidth; // already full viewport due to breakout wrapper
      const w = Math.max(8, Math.floor(avail / totalWhite));
      setWhiteW(w);
    };
    calc();
    const ro = new ResizeObserver(calc); ro.observe(el);
    return () => ro.disconnect();
  }, [totalWhite]);

  return (
    <div className="full-piano-wrapper breakout" ref={wrapperRef} aria-label="Full 88-key piano">
      <div className="full-piano" style={{ width: '100%', ['--white-w' as any]: whiteW+'px', height: Math.round(whiteW*3.2) }}>
        {keys.filter(k=>k.isWhite).map(k => {
          const active = currentNote===k.midi;
          return <div key={k.midi} className={'kp white'+(active?' active':'')} data-midi={k.midi} aria-label={midiToName(k.midi)} />;
        })}
        {keys.filter(k=>!k.isWhite).map(k => {
          const prevWhiteIndex = k.whiteIndex;
            const left = (prevWhiteIndex + 0.72) * whiteW;
            const active = currentNote===k.midi;
            return <div key={k.midi} className={'kp black'+(active?' active':'')} style={{ left }} data-midi={k.midi} aria-label={midiToName(k.midi)} />;
        })}
      </div>
    </div>
  );
};

export default FullKeyboard;
