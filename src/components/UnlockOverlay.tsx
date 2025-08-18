import React from 'react';

export interface UnlockOverlayProps {
  visible: boolean;
  audioUnlocked: boolean;
  unlockAttempted: boolean;
  loadingInstrument: boolean;
  beepLooping: boolean;
  instrumentLoaded: boolean;
  ctxTime: number;
  ctxProgressing: boolean | null;
  audioCtx: AudioContext | null;
  debugInfo: string;
  showDebug: boolean;
  onToggleDebug: () => void;
  onEnable: () => void;
  onReplayBeeps: () => void;
  onHeard: () => void;
  onReset: () => void;
}

export const UnlockOverlay: React.FC<UnlockOverlayProps> = ({
  visible,
  audioUnlocked,
  unlockAttempted,
  loadingInstrument,
  beepLooping,
  instrumentLoaded,
  ctxTime,
  ctxProgressing,
  audioCtx,
  debugInfo,
  showDebug,
  onToggleDebug,
  onEnable,
  onReplayBeeps,
  onHeard,
  onReset,
}) => {
  if (!visible) return null;
  return (
    <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.82)', color:'#fff', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', zIndex:1000, padding:'1.5rem', textAlign:'center', backdropFilter:'blur(2px)'}}>
      <h2 style={{margin:'0 0 0.75rem'}}>{audioUnlocked ? 'Confirm Sound' : 'Enable Audio'}</h2>
      <p style={{maxWidth:520, fontSize:'0.85rem', lineHeight:1.4}}>
        {audioUnlocked ? 'You should hear soft alternating beeps. If you do, press I Hear It.' : 'Tap Enable Audio to start a repeating soft beep. Turn OFF Silent Mode and raise volume.'}
      </p>
      <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap', justifyContent:'center', marginTop:'0.4rem'}}>
        {!audioUnlocked && (
          <button onClick={onEnable} disabled={loadingInstrument} style={{fontSize:'1.05rem', padding:'0.7rem 1.1rem'}}>
            {loadingInstrument ? 'Loading…' : (unlockAttempted ? 'Try Again' : 'Enable Audio')}
          </button>
        )}
        {audioUnlocked && (
          <>
            {!beepLooping && (
              <button onClick={onReplayBeeps} style={{fontSize:'0.8rem', padding:'0.55rem 0.9rem'}}>Replay Beeps</button>
            )}
            <button onClick={onHeard} style={{fontSize:'1.05rem', padding:'0.7rem 1.1rem', background:'#2d7', color:'#000', fontWeight:600}}>I Hear It</button>
          </>
        )}
        <button onClick={onReset} style={{fontSize:'0.65rem'}}>Reset Audio</button>
        <button onClick={onToggleDebug} style={{fontSize:'0.65rem'}}>{showDebug ? 'Hide Debug' : 'Debug'}</button>
      </div>
      {showDebug && (
        <div style={{marginTop:'0.6rem', fontSize:'0.55rem', opacity:0.7, maxWidth:360, textAlign:'left'}}>
          <div>{debugInfo}</div>
          <div>
            beep {beepLooping?'on':'off'} inst {instrumentLoaded?'yes':'no'} ctxTime {ctxTime.toFixed(2)} progressing {ctxProgressing===null?'?':ctxProgressing?'yes':'no'} state {audioCtx?.state || '?'} sr {audioCtx?.sampleRate || '?'}
          </div>
        </div>
      )}
    </div>
  );
};
