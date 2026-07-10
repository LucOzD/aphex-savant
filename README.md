# Pocket Sampler

A mobile-first, web-based pocket-operator-style sampler, drum machine and step
sequencer. Built with TypeScript + Vite and the Web Audio API. No backend.

## Run it

```bash
npm install
npm run dev      # open the printed Network URL on your phone (same wifi)
npm run build    # production build to dist/
npm run preview  # serve the production build (has the PWA service worker)
```

The app opens on a **tap-to-start** screen — this is required so the browser lets
us start audio (especially on iOS).

## What works today

- **Audio engine** — Web Audio graph with a proper master chain and shared FX
  sends (see routing below).
- **Two banks** you switch between: a **DRUMS** bank (built-in synth kit, makes
  noise immediately) and a separate **SAMPLES** bank that recordings and loaded
  files go into — so importing audio never overwrites your drum kit. Both banks
  play and sequence together.
- **16 pads** per bank in a 4×4 grid, each a track with its own sound.
- **Tap pads** to finger-drum; tapping also selects a pad for editing.
- **16-step sequencer** per pad with a lookahead scheduler for tight timing,
  plus **swing** and **tempo**.
- **Per-step locks** (P-LOCK mode): pitch, probability (chance), and velocity.
- **Per-pad sound**: volume, pan, filter (cutoff/resonance), pitch, delay send,
  reverb send. Hats choke each other by default.
- **Master FX**: bitcrusher + sample-rate reducer (AudioWorklet), master filter,
  drive/saturation, tempo-synced delay feedback, and a limiter on the output.
- **Performance buttons**: momentary FILTER slam and CRUSH slam (hold to apply).
- **Record from the mic** (getUserMedia + MediaRecorder), then chop the take
  across the SAMPLES bank or drop it on a single sample pad.
- **Sample editor**: a waveform view where you drag to select an exact moment
  (draggable start/end handles), preview the selection, and assign that region
  to any sample pad. Recordings load into it automatically; you can also open a
  file or reuse the last recording.
- **Samples**: "Chop → samples" auto-slices a loop by **transient detection**
  and spreads slices across the sample pads; "Load → sample pad" loads a whole
  file onto one sample pad.
- **PWA**: installable to the home screen, works offline after first load.

## Signal routing

```
per pad:  source → env → filter → pan → gain ─┬────────────→ master.input (dry)
                                              ├→ delaySend → delay bus
                                              └→ reverbSend → reverb bus
master:   input → bitcrush → filter → drive → limiter → output
delay bus:  → delay (+filtered feedback) → back to master.input
reverb bus: → convolver (synthetic IR)   → back to master.input
```

## Project layout

```
src/
  audio/
    AudioEngine.ts   engine: context, transport, tracks, sample loading
    MasterChain.ts   master FX chain + delay/reverb send buses
    Scheduler.ts     lookahead clock for tight step timing
    Track.ts         one pad: sound playback, envelope, filter, sends, choke
    synthDrums.ts    built-in procedurally-generated drum kit
    sampleUtils.ts   decode + transient/grid slicing
    dsp.ts           drive curve, reverb IR, pitch helpers
    types.ts         Step / TrackSettings
  ui/
    App.ts           the whole interface, wired to the engine
    dom.ts           small DOM + slider helpers
  main.ts            bootstrap + tap-to-start + service worker
public/
  worklets/bitcrusher.js   bit-crush / sample-rate-reduce AudioWorklet
  manifest.webmanifest, icon.svg, sw.js
```

## Natural next steps (from the design)

- **Stutter / beat-repeat** and **tape-stop** performance effects (AudioWorklet).
- **Project save/load** to IndexedDB, bundling samples.
- **Live resampling** (record master output back into a new sample to re-chop).
- **Pattern chaining / song mode**, polymeter (per-track lengths), ratchets.
- **MIDI clock + MIDI out** via the Web MIDI API.
- Visual **waveform + slice markers** in a sample-edit page.
```
