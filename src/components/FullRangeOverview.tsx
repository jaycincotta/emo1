import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';

interface Props {
  low: number;
  high: number;
  onChange: (low: number, high: number) => void;
}

const A0 = 21; // MIDI
const C8 = 108;
const BLACKS = new Set([1,3,6,8,10]);
const isBlack = (m:number) => BLACKS.has(m % 12);
const isWhite = (m:number) => !isBlack(m);

function prevWhite(m:number): number { let x=m-1; while (x>=A0 && !isWhite(x)) x--; return x >= A0 ? x : m; }
function nextWhite(m:number): number { let x=m+1; while (x<=C8 && !isWhite(x)) x++; return x <= C8 ? x : m; }

const FullRangeOverview: React.FC<Props> = ({ low, high, onChange }) => {
  const containerRef = useRef<HTMLDivElement|null>(null);
  const [dragging, setDragging] = useState<null | 'low' | 'high'>(null);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  useEffect(()=>{
    const handle = () => setIsMobile(window.innerWidth < 760);
    handle();
    window.addEventListener('resize', handle);
    return () => window.removeEventListener('resize', handle);
  }, []);

  // Precompute white keys list
  const whiteKeys = useMemo(()=>{
    const arr:number[]=[]; for (let m=A0;m<=C8;m++){ if(isWhite(m)) arr.push(m);} return arr; },[]);

  const whiteIndexFromMidi = useCallback((m:number)=> whiteKeys.indexOf(m), [whiteKeys]);

  const clampToWhite = useCallback((m:number, dir: 'nearest' | 'up' | 'down'='nearest') => {
    if (isWhite(m)) return m;
    if (dir==='up') return nextWhite(m);
    if (dir==='down') return prevWhite(m);
    // nearest: choose whichever closer; prefer up if tie
    let up = nextWhite(m); let down = prevWhite(m);
    if (m - down <= up - m) return down; else return up;
  }, []);

  // Mouse / touch drag
  useEffect(()=>{
    function move(e:MouseEvent | TouchEvent){ if(!dragging || !containerRef.current) return; const rect=containerRef.current.getBoundingClientRect(); const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX; const rel = (clientX - rect.left)/rect.width; // 0..1
      // map to white key index
      let idx = Math.round(rel * (whiteKeys.length-1)); idx = Math.max(0, Math.min(whiteKeys.length-1, idx));
      let midi = whiteKeys[idx];
      if (dragging==='low') { if (midi >= high) midi = prevWhite(high); onChange(midi, high); }
      else { if (midi <= low) midi = nextWhite(low); onChange(low, midi); }
    }
    function up(){ setDragging(null); }
    window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, { passive:false }); window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
    return ()=>{ window.removeEventListener('mousemove', move); window.removeEventListener('touchmove', move); window.removeEventListener('mouseup', up); window.removeEventListener('touchend', up); };
  }, [dragging, whiteKeys, high, low, onChange]);

  const startDrag = (which:'low'|'high') => (e:React.MouseEvent) => { e.preventDefault(); setDragging(which); };

  // Mobile adjustment buttons
  const adjust = (which:'low'|'high', dir:'-'|'+') => {
    if (which==='low') {
      if (dir==='-') { const nw = prevWhite(low); if (nw < high) onChange(nw, high); }
      else { const nw = nextWhite(low); if (nw < high) onChange(nw, high); }
    } else {
      if (dir==='-') { const nh = prevWhite(high); if (nh > low) onChange(low, nh); }
      else { const nh = nextWhite(high); if (nh > low) onChange(low, nh); }
    }
  };

  // Ensure boundaries white
  useEffect(()=>{
    if(!isWhite(low)) onChange(clampToWhite(low,'nearest'), high);
    if(!isWhite(high)) onChange(low, clampToWhite(high,'nearest'));
  }, [low, high, clampToWhite, onChange]);

  const lowIdx = whiteIndexFromMidi(low);
  const highIdx = whiteIndexFromMidi(high);
  const total = whiteKeys.length - 1;
  const leftPct = (lowIdx/total)*100;
  const rightPct = (highIdx/total)*100;

  return (
    <div className="full-range-overview">
      <div className="fro-header">
        <span className="badge">Full 88-Key Range</span>
        <span className="mini-range-label">{`Range: ${low} – ${high}`}</span>
      </div>
      <div className="fro-keyboard" ref={containerRef} aria-label="Full keyboard range overview">
        <div className="fro-highlight" style={{ left: leftPct+'%', width: (rightPct-leftPct)+'%' }}>
          <div className="fro-handle left" onMouseDown={startDrag('low')} role="slider" aria-label="Low boundary" aria-valuemin={21} aria-valuemax={high-1} aria-valuenow={low} />
          <div className="fro-handle right" onMouseDown={startDrag('high')} role="slider" aria-label="High boundary" aria-valuemin={low+1} aria-valuemax={108} aria-valuenow={high} />
        </div>
        {whiteKeys.map((m,i)=>(
          <div key={m} className={'fro-white '+(m===low||m===high?'edge':'')+(m>low&&m<high?' inside':'')} style={{ left: (i/total*100)+'%' }} />
        ))}
      </div>
      {isMobile && (
        <div className="fro-mobile-controls">
          <div className="mc-group">
            <span>Low</span>
            <div>
              <button type="button" onClick={()=>adjust('low','-')} disabled={low<=21}>-</button>
              <button type="button" onClick={()=>adjust('low','+')} disabled={nextWhite(low)>=high}>+</button>
            </div>
          </div>
          <div className="mc-group">
            <span>High</span>
            <div>
              <button type="button" onClick={()=>adjust('high','-')} disabled={prevWhite(high)<=low}>-</button>
              <button type="button" onClick={()=>adjust('high','+')} disabled={high>=108}>+</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FullRangeOverview;
