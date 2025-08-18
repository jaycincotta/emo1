import { useCallback, useEffect, useRef, useState } from 'react';

interface UseAudioUnlockParams {
  audioCtxRef: React.MutableRefObject<AudioContext | null>;
  instrumentLoaded: boolean;
  onReset?: () => void;
}

export function useAudioUnlock({ audioCtxRef, instrumentLoaded, onReset }: UseAudioUnlockParams) {
  const initialIsMobile = typeof navigator !== 'undefined' && /iphone|ipad|ipod|android|mobile/i.test(navigator.userAgent);
  const isMobileRef = useRef<boolean>(initialIsMobile);

  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [unlockAttempted, setUnlockAttempted] = useState(false);
  const [heardConfirm, setHeardConfirm] = useState<boolean>(() => {
    try { return sessionStorage.getItem('earTrainerHeard') === '1'; } catch { return false; }
  });
  const [showDebug, setShowDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState('');
  const [htmlPrimed, setHtmlPrimed] = useState(false);
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);

  const [beepLooping, setBeepLooping] = useState(false);
  const beepIntervalRef = useRef<number | null>(null);
  const beepGainRef = useRef<GainNode | null>(null);

  const [ctxTime, setCtxTime] = useState(0);
  const [ctxProgressing, setCtxProgressing] = useState<boolean | null>(null);

  const startBeepLoop = useCallback(() => {
    if (!audioCtxRef.current) return;
    if (!isMobileRef.current) return;
    if (beepIntervalRef.current) return;
    const ctx = audioCtxRef.current;
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    gain.connect(ctx.destination);
    beepGainRef.current = gain;
    let flip = false;
    let count = 0;
    const playOne = () => {
      if (!audioCtxRef.current || !beepGainRef.current) return;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = flip ? 1046.5 : 880;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
      o.connect(g).connect(beepGainRef.current!);
      o.start();
      o.stop(ctx.currentTime + 0.32);
      setTimeout(()=>{ try { g.disconnect(); } catch {} }, 400);
      flip = !flip;
      count++;
      if (count % 4 === 0 && beepGainRef.current) {
        const current = beepGainRef.current.gain.value;
        if (current < 0.4) beepGainRef.current.gain.setValueAtTime(Math.min(0.4, current + 0.05), ctx.currentTime);
      }
    };
    playOne();
    beepIntervalRef.current = window.setInterval(playOne, 600);
    setBeepLooping(true);
  }, [audioCtxRef]);

  const stopBeepLoop = useCallback(() => {
    if (beepIntervalRef.current) { clearInterval(beepIntervalRef.current); beepIntervalRef.current = null; }
    try { beepGainRef.current?.disconnect(); } catch {}
    beepGainRef.current = null;
    setBeepLooping(false);
  }, []);

  const primeHtmlAudio = useCallback(() => {
    try {
      if (htmlAudioRef.current) {
        htmlAudioRef.current.currentTime = 0;
        htmlAudioRef.current.play().then(()=>setHtmlPrimed(true)).catch(()=>{});
      }
    } catch {}
  }, []);

  const unlockAudio = useCallback(async () => {
    setUnlockAttempted(true);
    if (!audioCtxRef.current) {
      const Ctor: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return;
      audioCtxRef.current = new Ctor();
    }
    if (audioCtxRef.current?.state === 'suspended') {
      try { await audioCtxRef.current.resume(); } catch {}
    }
    try {
      if (audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = 261.63;
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        osc.connect(g).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch {}
    primeHtmlAudio();
    if (audioCtxRef.current?.state === 'running') {
      if (isMobileRef.current) {
        if (!beepLooping) startBeepLoop();
        setAudioUnlocked(true);
      } else {
        setAudioUnlocked(true);
        if (!heardConfirm) setHeardConfirm(true);
        if (beepLooping) stopBeepLoop();
      }
    }
  }, [audioCtxRef, primeHtmlAudio, startBeepLoop, stopBeepLoop, beepLooping, heardConfirm]);

  const hardResetAudio = useCallback(() => {
    try {
      if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} }
      audioCtxRef.current = null;
      setAudioUnlocked(false);
      setDebugInfo('AudioContext reset');
      stopBeepLoop();
      setHeardConfirm(false);
      try { sessionStorage.removeItem('earTrainerHeard'); } catch {}
      onReset?.();
    } catch {}
  }, [audioCtxRef, stopBeepLoop, onReset]);

  useEffect(() => {
    if (audioUnlocked) return;
    if (!isMobileRef.current) { unlockAudio(); return; }
    const handler = () => { unlockAudio(); };
    const resumeHandler = () => { if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume(); };
    document.addEventListener('touchend', handler, { once: true, passive: true });
    document.addEventListener('mousedown', handler, { once: true });
    document.addEventListener('visibilitychange', resumeHandler);
    window.addEventListener('focus', resumeHandler);
    document.addEventListener('touchstart', resumeHandler, { passive: true });
    return () => {
      document.removeEventListener('touchend', handler);
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('visibilitychange', resumeHandler);
      window.removeEventListener('focus', resumeHandler);
      document.removeEventListener('touchstart', resumeHandler);
    };
  }, [audioUnlocked, unlockAudio]);

  useEffect(() => {
    let id: number | null = null;
    const prev = { t: audioCtxRef.current?.currentTime };
    const loop = () => {
      if (audioCtxRef.current) {
        const t = audioCtxRef.current.currentTime;
        setCtxProgressing(p => p == null ? null : (t !== prev.t));
        setCtxTime(t);
        prev.t = t;
      }
      id = window.setTimeout(loop, 600);
    };
    loop();
    return () => { if (id) clearTimeout(id); };
  }, [audioCtxRef]);

  useEffect(() => {
    const resume = () => {
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(()=>{});
      if (htmlAudioRef.current && !htmlPrimed) {
        htmlAudioRef.current.play().then(()=>setHtmlPrimed(true)).catch(()=>{});
      }
    };
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
    try { navigator.mediaDevices?.addEventListener('devicechange', resume); } catch {}
    return () => {
      window.removeEventListener('pageshow', resume);
      try { navigator.mediaDevices?.removeEventListener('devicechange', resume); } catch {}
    };
  }, [htmlPrimed, audioCtxRef]);

  useEffect(() => {
    if (heardConfirm) {
      try { sessionStorage.setItem('earTrainerHeard', '1'); } catch {}
    }
  }, [heardConfirm]);

  useEffect(() => {
    if (instrumentLoaded && heardConfirm && beepLooping) stopBeepLoop();
  }, [instrumentLoaded, heardConfirm, beepLooping, stopBeepLoop]);

  useEffect(() => {
    if (!isMobileRef.current && beepLooping) stopBeepLoop();
  }, [beepLooping, stopBeepLoop]);

  return {
    audioUnlocked,
    setAudioUnlocked,
    unlockAttempted,
  setUnlockAttempted,
    heardConfirm,
    setHeardConfirm,
    showDebug,
    setShowDebug,
    debugInfo,
    setDebugInfo,
    beepLooping,
    ctxTime,
    ctxProgressing,
    htmlAudioRef,
    isMobile: isMobileRef.current,
    unlockAudio,
    startBeepLoop,
    stopBeepLoop,
    hardResetAudio,
  };
}
