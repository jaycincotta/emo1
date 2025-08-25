import React from 'react';

import { QuickTipsProps } from './QuickTipsManual';

import { quickTipsH2Style } from './quickTipsStyles';
// Live mode quick tips (microphone-based pitch production)
export const QuickTipsLive: React.FC<QuickTipsProps> = ({ className, style }) => {
    return (
        <div className={className} style={style}>
            <div><strong>What</strong>: Practice at your piano.</div>
            <div><strong>How</strong>: Press play to start. Try to match the note on your piano then watch the app for feedback. Change modes when you're done to release mic.</div>
            <div><strong>Feedback</strong>: Green exact · Orange correct degree wrong octave · Red wrong degree.</div>

            <h2 style={quickTipsH2Style}>Primary Actions</h2>
            <div><strong>Play / Stop</strong>: Starts or pauses target generation (mic remains active in Live mode).</div>
            <div><strong>Again</strong>: Repeats Cadence + same note.</div>
            <div><strong>New Key</strong>: Immediate different key + cadence + new target.</div>
            <h2 style={quickTipsH2Style}>Primary Settings</h2>
            <div><strong>Strict</strong>: ON resets streak on Orange; OFF allows octave errors.</div>
            <div><strong>Repeat cadence</strong>: Every target (ON) or only first / key changes (OFF).</div>
            <div><strong>Rand Key</strong>: Chance of key change after first-attempt success (cadence always plays).</div>
            <div><strong>Streak</strong>: 10 first-attempt exact targets triggers automatic key change + cadence.</div>
                        <h2 style={quickTipsH2Style}>Additional Settings</h2>
            <div><strong>Range</strong>: Range constrained to E1-D7 by pitch matching library. Click new low & high endpoints on keyboard to further limit selection.</div>
            <div><strong>Sensitivity</strong>: Balance rejection vs responsiveness; profile stats help diagnose noise.</div>
        </div>
    );
};

export default QuickTipsLive;
