import React from 'react';

export type AppMode = 'manual' | 'autoplay' | 'live';

interface Props {
  mode: AppMode;
}

export const ModeIndicator: React.FC<Props> = ({ mode }) => {
  const label = mode === 'live' ? 'Live' : mode === 'autoplay' ? 'Autoplay' : 'Manual';
  return (
    <div style={{ fontSize: '.55rem', padding: '.25rem .5rem', borderRadius: 6, background: '#243140', color: '#9fb3c8', letterSpacing: '.05em', textTransform: 'uppercase' }}>
      Mode: <span style={{ color:'#fff' }}>{label}</span>
    </div>
  );
};
