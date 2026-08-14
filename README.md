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

- **Drums / Keys tabs (banks)**, each with its own tracks and FX chain. Start
  with DRUMS (the built-in synth kit) and KEYS (user sample instruments). Add
  more with **+ Drums** / **+ Keys**; all banks stay tempo-locked and play
  together. Older SAMPLES banks are renamed to KEYS when projects open.
- **Long-press a bank button** for its context menu: mute, rename, delete.
- **Tap pads** to finger-drum; tapping also selects a pad for editing. Pads can
  be renamed in the sound panel.
- **Step sequencer** per pad with a lookahead scheduler for tight timing, plus
  **swing** and **tempo**.
- **Per-step locks** (P-LOCK mode): pitch, probability (chance), and velocity.
  Toggle **ALL STEPS** to apply a step edit across every step at once.
- **Polyrhythms**: each bank has its own **loop length** (1–32 steps), shared by
  all pads in that bank. Run two drum machines at 16 and 12 steps and they drift
  against each other. The clock is **tick-based** and monotonic, so banks of
  different lengths loop independently while staying locked to one tempo.
- **Per-pad sound**: volume, pan, pitch, filter (type/cutoff/resonance), attack,
  release, delay send, reverb send, and **MONO** (retriggering cuts off the
  previous hit). **ALL PADS** applies a knob change across the whole bank.
- **Melodic sample performer** on every selected sample pad with **KEYS, SCALE,
  and CHORDS** layouts. Scale mode provides 20 scales × 12 roots on a 4×4 pad
  grid. Chords supports scale-derived triads/7ths/9ths and 20 free chord
  qualities, inversions, open voicing, and cancellable tempo-safe strums.
  Performance state is saved per instrument; playback uses an 8-voice default
  limit through the instrument's existing shared effects path. Choose a 1–8 bar
  length and press **RECORD LOOP** to capture played notes and durations; after
  that many bars, the take loops automatically with the main transport.
- **Per-scene FX rack**: three user-assignable insert slots, ordered left to
  right. Choose from filter, drive, crusher, phaser, chorus, **Grain, Resonate,
  Tape, Repeater, Space, Fold, Dub, Formant, Motion, and Transient**, each with
  focused controls. Moving an effect to another slot preserves its settings,
  and each bank keeps an independent rack. Heavy effects are created lazily so
  unused choices cost no DSP. Per-pad delay/reverb sends remain separate. One
  global limiter sits on the summed output.
- **Performance buttons**: momentary FILTER and CRUSH slams, applied to the
  current scene and released back to its stored settings.
- **Record from the mic** — captured as raw PCM (not MediaRecorder), so it never
  hits a codec/decode failure on mobile.
- **Sample library** in a slide-out drawer: everything you record or load is kept
  in IndexedDB. Tap an entry to open it in the sample editor; delete with ✕.
- **Sample editor**: a waveform view where you drag to select a region, preview
  it, and assign it to a pad **in the current scene**.
- **Samples load into the scene you're viewing**, on the selected pad. Chop
  auto-slices a loop by **transient detection** across that scene's pads.
- **Undo / redo** (↶ ↷ in the top bar, or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z).
  A slider drag collapses into one undo step.
- **Export WAV** (offline render of the sequence) and **save/open project**
  (JSON with samples embedded, so it reopens exactly as you left it).
- **PWA**: installable to the home screen, works offline after first load.

## Signal routing

FX are per bank, so each scene is processed independently and they sum into one
global limiter.

```
per pad:  source → env → filter → pan → gain ─┬───────────→ its bank's chain.input
                                              ├→ delaySend → that bank's delay bus
                                              └→ reverbSend → that bank's reverb bus

per bank: input → [slot 1] → [slot 2] → [slot 3] → output bus
          each slot: empty | filter | drive | crusher | phaser | chorus
                     grain | resonate | tape | repeater | space | fold
                     dub | formant | motion | transient
          delay bus:  → delay (+filtered feedback) → back before slot 1
          reverb bus: → convolver (synthetic IR)   → back before slot 1

global:   output bus (sum of all banks) → limiter → destination
```

## Project layout

```
src/
  audio/
    AudioEngine.ts   engine: context, transport, banks, sample loading, undo
                     snapshots, WAV export, project save/load
    FxChain.ts       one FX chain per bank + its delay/reverb send buses
    Scheduler.ts     lookahead clock for tight step timing
    Track.ts         one pad: polyphonic sample voices, envelope, filter,
                     sends, note-on/off, voice stealing and choke
    musicTheory.ts   dependency-free scales, chords, naming and voicing
    Recorder.ts      mic capture as raw PCM
    SampleLibrary.ts IndexedDB store for recorded/loaded samples
    wavEncode.ts     AudioBuffer → WAV (export + library persistence)
    synthDrums.ts    built-in procedurally-generated drum kit
    sampleUtils.ts   decode + transient/grid slicing
    dsp.ts           drive curve, reverb IR, pitch helpers
    types.ts         Step / TrackSettings
  ui/
    App.ts                 main sampler/sequencer interface
    MelodicPerformance.ts melodic keys, scale pads, chord pads + pickers
    WaveformEditor.ts     waveform display + draggable region selection
    dom.ts                small DOM + slider helpers
  main.ts            bootstrap + tap-to-start + service worker
public/
  worklets/bitcrusher.js    bit-crush / sample-rate-reduce AudioWorklet
  worklets/creative-fx.js   grain, tape, repeater, shimmer + transient DSP
  manifest.webmanifest, icon.svg, sw.js
```

## Natural next steps

- **Live resampling** (record the output back into a new sample to re-chop).
- **Pattern chaining / song mode**, polymeter (per-track lengths), ratchets.
- **MIDI clock + MIDI out** via the Web MIDI API.
- Visual **waveform + slice markers** in a sample-edit page.
```
