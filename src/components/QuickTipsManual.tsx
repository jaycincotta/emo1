import React from 'react';

export interface QuickTipsProps {
    className?: string;
    style?: React.CSSProperties;
}

import { quickTipsH2Style } from './quickTipsStyles';
// Manual mode quick tips (single test per Play press)
export const QuickTipsManual: React.FC<QuickTipsProps> = ({ className, style }) => {
    return (
        <div className={className} style={style}>
            <div><strong>What</strong>: Practice anywhere at your own pace.</div>
            <div><strong>How</strong>: Press play and close your eyes. Guess the note then open your eyes to check the Solfege syllable + highlighted piano key. Press Play to continue.</div>
            <h2 style={quickTipsH2Style}>Primary Actions</h2>
            <div><strong>Play</strong>: Plays Cadence + one random scale degree (or just note if cadence already given).</div>
            <div><strong>Again</strong>: Repeats Cadence + same note.</div>
            <div><strong>New Key</strong>: Different key + cadence + new note (no extra Play needed).</div>
            <h2 style={quickTipsH2Style}>Primary Settings</h2>
            <div><strong>Repeat cadence</strong>: Every test (ON) or only first & key changes / forced actions (OFF).</div>
            <div><strong>Rand Key</strong>: Chance after each completed test to switch keys (cadence always precedes the note).</div>
            <h2 style={quickTipsH2Style}>Additional Settings</h2>
            <div><strong>Range</strong>: Full 88-key piano range selected by default. Click new low & high endpoints on keyboard to limit selection.</div>
            <div><strong>Note set</strong>: Filter pool: Diatonic / Non-diatonic / Chromatic.</div>
            <div><strong>Cadence speed</strong>: Chord pacing. Adjust for context memory vs. speed.</div>
        </div>
    );
};

export default QuickTipsManual;
