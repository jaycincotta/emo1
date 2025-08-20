import React, { useCallback, useMemo, useRef, useLayoutEffect, useState } from 'react';

interface FullKeyboardRangeProps { low: number; high: number; currentNote: number | null; onChange: (low:number, high:number)=>void; detectedNote?: number | null; }

const A0 = 21; const C8 = 108; const MIDDLE_C = 60; // C4
const BLACKS = new Set([1,3,6,8,10]);
const isBlack = (m:number)=> BLACKS.has(m%12);
const isWhite = (m:number)=> !isBlack(m);
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const midiToName = (m:number)=> NOTE_NAMES[m%12]+(Math.floor(m/12)-1);

type KeyObj = { midi:number; whiteIndex:number; isWhite:boolean };

function buildSegment(start:number, end:number): KeyObj[] {
  const arr: KeyObj[] = [];
  let whiteCount = 0;
  for (let m=start; m<=end; m++) {
    const white = isWhite(m);
    arr.push({ midi:m, whiteIndex: white? whiteCount : whiteCount-1, isWhite:white });
    if (white) whiteCount++;
  }
  return arr;
}

const segmentLow = buildSegment(A0, MIDDLE_C - 1); // A0..B3 (59)
const segmentHigh = buildSegment(MIDDLE_C, C8); // C4..C8
const allKeys: KeyObj[] = [...segmentLow, ...segmentHigh];

const DETECT_MIN = 28;
const DETECT_MAX = 98;

const FullKeyboardRange: React.FC<FullKeyboardRangeProps> = ({ low, high, currentNote, onChange, detectedNote }) => {
  const wrapRef = useRef<HTMLDivElement|null>(null);
  const [whiteW, setWhiteW] = useState(42);
  const [wrapped, setWrapped] = useState(false);

  const totalWhite = useMemo(()=> allKeys.filter(k=>k.isWhite).length, []);
  const totalWhiteLow = useMemo(()=> segmentLow.filter(k=>k.isWhite).length, []);
  const totalWhiteHigh = useMemo(()=> segmentHigh.filter(k=>k.isWhite).length, []);

  useLayoutEffect(()=>{
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const MIN_W = 9; const IDEAL_W = 42; const LEGIBLE_W = 18; // portrait legibility target
    const decide = () => {
      const avail = el.clientWidth;
      const isLandscape = window.innerWidth > window.innerHeight;
      if (isLandscape) {
        // In landscape, strongly prefer a single row; accept key widths down to MIN_W before wrapping.
        const perKey = Math.floor(avail / totalWhite);
        if (perKey >= MIN_W) {
          setWrapped(false);
          setWhiteW(Math.min(IDEAL_W, Math.max(MIN_W, perKey)));
          return;
        }
        // fall through to wrapped if truly too narrow
      }
      // Portrait (or too narrow landscape): use legibility threshold logic.
      if (avail >= totalWhite * LEGIBLE_W) {
        setWrapped(false);
        if (avail >= totalWhite * IDEAL_W) setWhiteW(IDEAL_W); else setWhiteW(Math.max(LEGIBLE_W, Math.floor(avail/totalWhite)));
      } else {
        setWrapped(true);
        const maxWhitesPerRow = Math.max(totalWhiteLow, totalWhiteHigh);
        if (avail >= maxWhitesPerRow * IDEAL_W) setWhiteW(IDEAL_W);
        else if (avail >= maxWhitesPerRow * LEGIBLE_W) setWhiteW(Math.max(LEGIBLE_W, Math.floor(avail/maxWhitesPerRow)));
        else setWhiteW(Math.max(MIN_W, Math.floor(avail/maxWhitesPerRow)));
      }
    };
    decide();
    const ro = new ResizeObserver(decide); ro.observe(el);
    window.addEventListener('orientationchange', decide);
    return () => { ro.disconnect(); window.removeEventListener('orientationchange', decide); };
  }, [totalWhite, totalWhiteLow, totalWhiteHigh]);

  const handleSelectWhite = useCallback((midi:number)=>{
    if (!isWhite(midi)) return;
    const dLow = Math.abs(midi - low);
    const dHigh = Math.abs(midi - high);
    if (dLow <= dHigh) {
      if (midi > high) onChange(high, midi); else onChange(midi, high);
    } else {
      if (midi < low) onChange(midi, low); else onChange(low, midi);
    }
  }, [low, high, onChange]);

  // Visual dimensions: white key length (height in our horizontal layout) and black key length.
  // Empirically, real acoustic pianos expose black keys at roughly 60-64% of the visible white key length.
  // Slightly shorter keys in cramped landscape to save vertical pixels.
  const landscape = typeof window !== 'undefined' && window.innerWidth > window.innerHeight;
  const whiteH = Math.round(whiteW * (landscape ? 3.4 : 4.0)); // tuned for on-screen proportions
  const BLACK_LEN_RATIO = 0.52; // adjustable single source of truth
  const blackH = Math.round(whiteH * BLACK_LEN_RATIO);

  // renderRow: when global=true we are rendering allKeys (no wrap) and must offset
  // black key positioning for the upper segment by totalWhiteLow to keep spacing correct.
  const renderRow = (segment:KeyObj[], global=false) => {
    const whites = segment.filter(k=>k.isWhite);
    const rowWidth = whites.length * whiteW;
    return (
      <div className="full-piano" style={{ width: rowWidth, ['--white-w' as any]: whiteW+'px', height: whiteH }}>
        {whites.map(k => {
          const inRange = k.midi>=low && k.midi<=high;
          const inDetectWindow = k.midi>=DETECT_MIN && k.midi<=DETECT_MAX;
          const edge = k.midi===low || k.midi===high;
      const active = currentNote===k.midi;
      const detected = detectedNote===k.midi;
          return (
            <div key={k.midi}
        className={'kp white'+(inRange?' in-range':'')+(edge?' edge':'')+(active?' active':'')+(detected?' detected':'')+(!inDetectWindow?' out-detect':'')}
              onClick={()=>handleSelectWhite(k.midi)}
              data-midi={k.midi}
              aria-label={midiToName(k.midi)} />
          );
        })}
        {segment.filter(k=>!k.isWhite).map(k => {
          const prevWhiteIndex = k.whiteIndex;
          const offset = global && k.midi >= MIDDLE_C ? totalWhiteLow : 0;
          const left = (offset + prevWhiteIndex + 0.72) * whiteW;
          const inRange = k.midi>=low && k.midi<=high;
          const inDetectWindow = k.midi>=DETECT_MIN && k.midi<=DETECT_MAX;
      const active = currentNote===k.midi;
      const detected = detectedNote===k.midi;
          return (
            <div key={k.midi}
        className={'kp black'+(inRange?' in-range':'')+(active?' active':'')+(detected?' detected':'')+(!inDetectWindow?' out-detect':'')}
              style={{ left, height: blackH }}
              data-midi={k.midi}
              aria-label={midiToName(k.midi)} />
          );
        })}
      </div>
    );
  };

  return (
    <div className="full-piano-wrapper" ref={wrapRef} role="group" aria-label="Full piano 88 keys" data-range={`${midiToName(low)}-${midiToName(high)}`}>
      {wrapped ? (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
          {renderRow(segmentLow)}
          {renderRow(segmentHigh)}
        </div>
      ) : (
  renderRow(allKeys, true)
      )}
    </div>
  );
};

export default FullKeyboardRange;
