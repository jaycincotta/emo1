import React, { useState, useEffect, useCallback } from 'react';

interface PianoRangeSelectorProps {
  low: number;
  high: number;
  onChange: (low: number, high: number) => void;
  min?: number;
  max?: number;
}

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function midiToName(midi: number) {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

const PianoRangeSelector: React.FC<PianoRangeSelectorProps> = ({ low, high, onChange, min = 48, max = 84 }) => {
  const [activeBound, setActiveBound] = useState<'low'|'high'>('low');

  useEffect(()=>{
    if (low < min) onChange(min, high);
    if (high > max) onChange(low, max);
    if (low > high) onChange(low, low);
  }, [low, high, min, max, onChange]);

  const handleKeyClick = useCallback((midi:number) => {
    if (activeBound === 'low') {
      let newLow = Math.min(midi, high); // keep <= high
      onChange(newLow, Math.max(high, newLow));
      setActiveBound('high');
    } else {
      let newHigh = Math.max(midi, low);
      onChange(Math.min(low, newHigh), newHigh);
      setActiveBound('low');
    }
  }, [activeBound, high, low, onChange]);

  const keys: number[] = [];
  for (let m=min; m<=max; m++) keys.push(m);

  return (
    <div className="piano-range-wrapper">
      <div className="piano-range-header">
        <div className="bound-buttons">
          <button type="button" className={activeBound==='low'? 'active':''} onClick={()=>setActiveBound('low')}>Set Low ({midiToName(low)})</button>
          <button type="button" className={activeBound==='high'? 'active':''} onClick={()=>setActiveBound('high')}>Set High ({midiToName(high)})</button>
        </div>
        <div className="range-label">Range: {midiToName(low)} – {midiToName(high)}</div>
      </div>
      <div className="piano-scroll" role="group" aria-label="Select pitch range">
        <div className="piano-keys">
          {keys.map(midi => {
            const rel = midi % 12;
            const isBlack = [1,3,6,8,10].includes(rel);
            const inRange = midi >= low && midi <= high;
            // Edge highlighting removed; range conveyed by greying outside keys
            return (
              <div
                key={midi}
                className={'piano-key ' + (isBlack? 'black':'white') + (inRange? ' in-range':'')}
                onClick={()=>handleKeyClick(midi)}
                title={midiToName(midi)}
                aria-label={`Key ${midiToName(midi)} ${inRange? 'inside range':'outside range'}`}
              >
                <span className="vis-label">{NOTE_NAMES[midi%12].replace('#','♯')}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="piano-help">Tap keys to set <strong>{activeBound==='low'? 'LOW':'HIGH'}</strong> boundary. Buttons toggle which boundary you are adjusting. Scroll sideways on small screens.</div>
    </div>
  );
};

export default PianoRangeSelector;
