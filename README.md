# Solfege Ear Trainer

A simple React + Vite web app for practicing movable-Do solfege recognition of random pitches relative to a key center. Uses a I–IV–V–I cadence to establish tonality and can include chromatic alterations (Ra, Me, Fi, Le, Te).

## Features
- Plays I IV V I cadence (toggle repeat before each random note)
- Random note within configurable MIDI range
- Shows movable-Do solfege syllable (chromatic syllables for altered tones)
- Toggle inclusion of diatonic and/or non‑diatonic (chromatic) scale degrees
- Auto-play mode with selectable speeds (slow / medium / fast)
- Cadence speed control
- New random key center button (cycle through circle-of-fifths style list)
- Pause / Play / Play single note controls

## Development
Install dependencies:
```
npm install
```
Run dev server:
```
npm run dev
```
Build production bundle:
```
npm run build
```

## Notes
- First audio playback may require a user gesture due to browser autoplay policies.
- Pitch range uses raw MIDI numbers (C4 = 60). Default range: 60–72.
- Key center set drawn from common major keys (including flat/sharp keys) mapped to semitone offsets.

## License
MIT
