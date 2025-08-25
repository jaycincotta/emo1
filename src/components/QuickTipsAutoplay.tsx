import React from 'react';

import { QuickTipsProps } from './QuickTipsManual';

import { quickTipsH2Style } from './quickTipsStyles';
// Autoplay mode quick tips (continuous drilling)
export const QuickTipsAutoplay: React.FC<QuickTipsProps> = ({ className, style }) => {
    return (
        <div className={className} style={style}>
            <div><strong>What</strong>: Practice anywhere, hands-free.</div>
            <div><strong>How</strong>: Press play to start. Close your eyes as the note plays. Then open your eyes to check the Solfege syllable + highlighted piano key. Continues automatically until you Press Stop.</div>

            <h2 style={quickTipsH2Style}>Primary Actions</h2>
            <div><strong>Play / Stop</strong>: Start or pause the loop (remains in Autoplay mode when paused).</div>
            <div><strong>Again</strong>: Repeats Cadence + same note.</div>
            <div><strong>New Key</strong>: Immediate different key + cadence + new note (interrupts cycle).</div>
            <h2 style={quickTipsH2Style}>Primary Settings</h2>
            <div><strong>Repeat cadence</strong>: Cadence every test (ON) or only first & key changes / forced actions (OFF).</div>
            <div><strong>Rand Key</strong>: Chance after each test to switch key; cadence always precedes the next note on change.</div>
            <h2 style={quickTipsH2Style}>Additional Settings</h2>
            <div><strong>Range</strong>: Full 88-key piano range selected by default. Click new low & high endpoints on keyboard to limit selection.</div>
            <div><strong>Note set</strong>: Filter pool: Diatonic / Non-diatonic / Chromatic.</div>
            <div><strong>Cadence speed</strong>: Chord pacing. Adjust for context memory vs. speed.</div>
        </div>
    );
};

export default QuickTipsAutoplay;
