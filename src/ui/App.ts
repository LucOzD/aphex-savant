import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";
import type { Step } from "../audio/types.ts";
import { isRecordingSupported } from "../audio/Recorder.ts";
import { isBlackKey, midiToName } from "../audio/music.ts";
import { WaveformEditor } from "./WaveformEditor.ts";
import { PianoRoll } from "./PianoRoll.ts";
import { el, slider } from "./dom.ts";

/** Fixed range of the on-screen keyboard (C3–C5). */
const KEY_LOW = 48;
const KEY_HIGH = 72;

/** Pitch range of the piano roll (C3–C6). */
const ROLL_LOW = 48;
const ROLL_HIGH = 84;

/** Builds and manages the whole UI, wired to an AudioEngine. */
export class App {
  private engine: AudioEngine;
  private root: HTMLElement;

  private selectedBank = 0;
  private selectedPad = 0;
  private selectedStep = 0;
  private plockMode = false;

  // Melodic keyboard + piano roll.
  private activeNote = 60;
  private keysPanel!: HTMLElement;
  private keyEls: { note: number; el: HTMLButtonElement }[] = [];
  private pianoRoll = new PianoRoll(ROLL_LOW, ROLL_HIGH);

  // Section elements toggled between drum (step) and melodic (piano-roll) views.
  private keysSection!: HTMLElement;
  private rollSection!: HTMLElement;
  private stepSection!: HTMLElement;
  private stepPanelSection!: HTMLElement;

  // "Universal" apply toggles.
  private applyAllPads = false;
  private applyAllSteps = false;

  // Cached elements we need to update as playback / selection changes.
  private bankBtns: HTMLButtonElement[] = [];
  private padGrid!: HTMLElement;
  private padEls: HTMLButtonElement[] = [];
  private stepEls: HTMLButtonElement[] = [];
  private lastPlayhead = -1;
  private trackPanel!: HTMLElement;
  private stepPanel!: HTMLElement;

  // Sample editor.
  private editor = new WaveformEditor();
  private editorBuffer: AudioBuffer | null = null;
  private editorReadout!: HTMLElement;
  private editorTarget!: HTMLSelectElement;

  constructor(engine: AudioEngine, root: HTMLElement) {
    this.engine = engine;
    this.root = root;
    this.engine.onVisualStep = (s) => this.highlightPlayhead(s);
  }

  mount() {
    this.root.innerHTML = "";
    this.root.append(this.buildTopbar());
    const main = el("main");
    this.keysSection = this.buildKeyboard();
    this.rollSection = this.buildPianoRoll();
    this.stepSection = this.buildSequencer();
    this.stepPanelSection = this.buildStepPanel();
    main.append(
      this.buildBankSwitcher(),
      this.buildPads(),
      this.keysSection,
      this.rollSection,
      this.stepSection,
      this.stepPanelSection,
      this.buildTrackPanel(),
      this.buildMasterPanel(),
      this.buildPerformance(),
      this.buildSampleTools(),
      this.buildSampleEditor(),
    );
    this.root.append(main);
    this.renderPads();
    this.refreshSelection();
    // Draw the (empty) waveform once it has a real width.
    requestAnimationFrame(() => this.editor.redraw());
  }

  // ---- Convenience --------------------------------------------------------

  private bank() {
    return this.engine.banks[this.selectedBank];
  }
  private track(): Track | undefined {
    return this.bank()?.tracks[this.selectedPad];
  }

  // ---- Topbar / transport -------------------------------------------------

  private buildTopbar(): HTMLElement {
    const playBtn = el("button", { class: "ctrl play" }, ["▶"]) as HTMLButtonElement;
    playBtn.addEventListener("click", () => {
      if (this.engine.isPlaying) {
        this.engine.stop();
        playBtn.textContent = "▶";
        playBtn.classList.remove("on");
      } else {
        this.engine.play();
        playBtn.textContent = "■";
        playBtn.classList.add("on");
      }
    });

    const tempo = slider({
      label: "TEMPO",
      min: 60,
      max: 200,
      step: 1,
      value: this.engine.bpm,
      format: (v) => `${v} bpm`,
      onInput: (v) => (this.engine.bpm = v),
    });

    const swing = slider({
      label: "SWING",
      min: 0,
      max: 1,
      step: 0.01,
      value: this.engine.swing,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => (this.engine.swing = v),
    });

    return el("div", { class: "topbar" }, [
      el("span", { class: "title" }, ["POCKET SAMPLER"]),
      playBtn,
      tempo,
      swing,
    ]);
  }

  // ---- Bank switcher ------------------------------------------------------

  private buildBankSwitcher(): HTMLElement {
    this.bankBtns = [];
    const row = el("div", { class: "row" });
    this.engine.banks.forEach((b, i) => {
      const btn = el("button", { class: "ctrl" }, [b.name]) as HTMLButtonElement;
      btn.addEventListener("click", () => this.selectBank(i));
      this.bankBtns.push(btn);
      row.append(btn);
    });
    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Bank"]),
      row,
    ]);
  }

  private selectBank(i: number) {
    if (i === this.selectedBank) return;
    this.selectedBank = i;
    this.selectedPad = 0;
    this.renderPads();
    this.refreshSelection();
  }

  // ---- Pad grid -----------------------------------------------------------

  private buildPads(): HTMLElement {
    this.padGrid = el("div", { class: "pads" });
    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Pads — tap to play, selects pad"]),
      this.padGrid,
    ]);
  }

  /** (Re)build the pad buttons for the currently selected bank. */
  private renderPads() {
    this.padGrid.innerHTML = "";
    this.padEls = [];
    const tracks = this.bank()?.tracks ?? [];
    tracks.forEach((track, i) => {
      const pad = el("button", { class: "pad" }, [
        el("span", {}, [track.settings.name]),
      ]) as HTMLButtonElement;
      if (!track.buffer) pad.classList.add("empty");

      pad.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.selectPad(i);
        this.engine.padHit(this.selectedBank, i, 1);
        pad.classList.add("flash");
      });
      const clearFlash = () => pad.classList.remove("flash");
      pad.addEventListener("pointerup", clearFlash);
      pad.addEventListener("pointerleave", clearFlash);
      pad.addEventListener("pointercancel", clearFlash);

      this.padEls.push(pad);
      this.padGrid.append(pad);
    });
  }

  private selectPad(i: number) {
    this.selectedPad = i;
    this.refreshSelection();
  }

  // ---- Step sequencer -----------------------------------------------------

  private buildSequencer(): HTMLElement {
    const plockBtn = el("button", { class: "ctrl" }, ["P-LOCK"]) as HTMLButtonElement;
    plockBtn.addEventListener("click", () => {
      this.plockMode = !this.plockMode;
      plockBtn.classList.toggle("active", this.plockMode);
      this.refreshSteps();
    });

    const grid = el("div", { class: "steps" });
    this.stepEls = [];
    for (let i = 0; i < this.engine.steps; i++) {
      const step = el("button", {
        class: i % 4 === 0 ? "step beat" : "step",
      }) as HTMLButtonElement;
      step.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.onStepTap(i);
      });
      this.stepEls.push(step);
      grid.append(step);
    }

    return el("section", {}, [
      el("div", { class: "row", style: "justify-content:space-between" }, [
        el("h2", { class: "section-title" }, ["Sequence (drums)"]),
        plockBtn,
      ]),
      grid,
    ]);
  }

  private onStepTap(i: number) {
    const track = this.track();
    if (!track) return;
    if (this.plockMode) {
      this.selectedStep = i;
      this.refreshStepPanel();
    } else {
      track.steps[i].on = !track.steps[i].on;
    }
    this.refreshSteps();
  }

  // ---- Piano roll (melodic) ----------------------------------------------

  private buildPianoRoll(): HTMLElement {
    this.pianoRoll.onAudition = (pitch) => {
      this.activeNote = pitch;
      this.engine.playNote(this.selectedBank, this.selectedPad, pitch, 1);
      this.refreshKeyHighlights();
    };
    return el("section", {}, [
      el("h2", { class: "section-title" }, [
        "Piano roll — tap to place notes, tap a note to remove",
      ]),
      this.pianoRoll.root,
    ]);
  }

  // ---- Melodic keyboard ---------------------------------------------------

  private buildKeyboard(): HTMLElement {
    this.keysPanel = el("div", { class: "panel" });
    const section = el("section", {}, [
      el("h2", { class: "section-title" }, [
        "Keyboard — set a base pitch, then play/sequence the sample chromatically",
      ]),
      this.keysPanel,
    ]);
    this.renderKeysPanel();
    return section;
  }

  private renderKeysPanel() {
    const track = this.track();
    this.keysPanel.innerHTML = "";
    this.keyEls = [];
    if (!track) return;

    // Base-pitch (root) control. The root note plays the sample untransposed.
    const rootRow = el("div", { class: "row" }, [
      slider({
        label: "BASE PITCH (ROOT)",
        min: KEY_LOW,
        max: KEY_HIGH,
        step: 1,
        value: track.settings.rootNote,
        format: (v) => midiToName(v),
        onInput: (v) => {
          this.applyTrackSetting((t) => (t.settings.rootNote = v));
          this.refreshKeyHighlights();
        },
      }),
      el("span", { class: "hint" }, ["Tap keys to audition · KEYS mode writes notes to steps"]),
    ]);

    const keyboard = el("div", { class: "keys" });
    for (let n = KEY_LOW; n <= KEY_HIGH; n++) {
      const key = el("button", {
        class: `key ${isBlackKey(n) ? "black" : "white"}`,
      }, [midiToName(n)]) as HTMLButtonElement;
      key.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.activeNote = n;
        this.engine.playNote(this.selectedBank, this.selectedPad, n, 1);
        this.refreshKeyHighlights();
      });
      this.keyEls.push({ note: n, el: key });
      keyboard.append(key);
    }

    this.keysPanel.append(rootRow, keyboard);
    this.refreshKeyHighlights();
  }

  private refreshKeyHighlights() {
    const track = this.track();
    const root = track?.settings.rootNote ?? 60;
    this.keyEls.forEach(({ note, el: keyEl }) => {
      keyEl.classList.toggle("root", note === root);
      keyEl.classList.toggle("active", note === this.activeNote);
    });
  }

  // ---- Per-step detail panel ---------------------------------------------

  private buildStepPanel(): HTMLElement {
    this.stepPanel = el("div", { class: "panel" });
    const section = el("section", {}, [
      el("h2", { class: "section-title" }, ["Step lock (P-LOCK mode + tap a step)"]),
      this.stepPanel,
    ]);
    this.refreshStepPanel();
    return section;
  }

  private refreshStepPanel() {
    const track = this.track();
    this.stepPanel.innerHTML = "";
    if (!track) return;
    const step = track.steps[this.selectedStep];

    const allBtn = el("button", { class: "ctrl" }, ["ALL STEPS"]) as HTMLButtonElement;
    allBtn.classList.toggle("active", this.applyAllSteps);
    allBtn.addEventListener("click", () => {
      this.applyAllSteps = !this.applyAllSteps;
      allBtn.classList.toggle("active", this.applyAllSteps);
    });

    this.stepPanel.append(
      el("div", { class: "row", style: "justify-content:space-between" }, [
        el("span", { class: "hint" }, [
          `Editing ${track.settings.name} · step ${this.selectedStep + 1}`,
        ]),
        allBtn,
      ]),
      el("div", { class: "row" }, [
        slider({
          label: "PITCH",
          min: -24,
          max: 24,
          step: 1,
          value: step.pitch,
          format: (v) => `${v > 0 ? "+" : ""}${v} st`,
          onInput: (v) => this.applyStepSetting((s) => (s.pitch = v)),
        }),
        slider({
          label: "CHANCE",
          min: 0,
          max: 1,
          step: 0.05,
          value: step.probability,
          format: (v) => `${Math.round(v * 100)}%`,
          onInput: (v) => this.applyStepSetting((s) => (s.probability = v)),
        }),
        slider({
          label: "VELOCITY",
          min: 0,
          max: 1,
          step: 0.05,
          value: step.velocity,
          format: (v) => `${Math.round(v * 100)}%`,
          onInput: (v) => this.applyStepSetting((s) => (s.velocity = v)),
        }),
      ]),
    );
  }

  /** Apply a step edit to just the selected step, or all steps if ALL STEPS is on. */
  private applyStepSetting(fn: (s: Step) => void) {
    const track = this.track();
    if (!track) return;
    const targets = this.applyAllSteps ? track.steps : [track.steps[this.selectedStep]];
    targets.forEach(fn);
    this.refreshSteps();
  }

  // ---- Per-track sound panel ---------------------------------------------

  private buildTrackPanel(): HTMLElement {
    this.trackPanel = el("div", { class: "panel" });
    const section = el("section", {}, [
      el("h2", { class: "section-title" }, ["Selected pad sound"]),
      this.trackPanel,
    ]);
    this.refreshTrackPanel();
    return section;
  }

  private refreshTrackPanel() {
    const track = this.track();
    this.trackPanel.innerHTML = "";
    if (!track) return;
    const s = track.settings;

    const allBtn = el("button", { class: "ctrl" }, ["ALL PADS"]) as HTMLButtonElement;
    allBtn.classList.toggle("active", this.applyAllPads);
    allBtn.addEventListener("click", () => {
      this.applyAllPads = !this.applyAllPads;
      allBtn.classList.toggle("active", this.applyAllPads);
    });

    this.trackPanel.append(
      el("div", { class: "row", style: "justify-content:space-between" }, [
        el("span", { class: "hint" }, [`${s.name} — ${this.bank().name} bank`]),
        allBtn,
      ]),
      el("div", { class: "row" }, [
        slider({
          label: "VOLUME",
          min: 0,
          max: 1,
          step: 0.01,
          value: s.gain,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.gain = v)),
        }),
        slider({
          label: "PAN",
          min: -1,
          max: 1,
          step: 0.05,
          value: s.pan,
          format: (v) => v.toFixed(2),
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.pan = v)),
        }),
        slider({
          label: "CUTOFF",
          min: 100,
          max: 18000,
          step: 10,
          value: s.cutoff,
          format: (v) => `${Math.round(v)}Hz`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.cutoff = v)),
        }),
        slider({
          label: "RESO",
          min: 0.1,
          max: 20,
          step: 0.1,
          value: s.resonance,
          format: (v) => v.toFixed(1),
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.resonance = v)),
        }),
        slider({
          label: "PITCH",
          min: 0.25,
          max: 2,
          step: 0.01,
          value: s.playbackRate,
          format: (v) => `${v.toFixed(2)}x`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.playbackRate = v)),
        }),
        slider({
          label: "DELAY",
          min: 0,
          max: 1,
          step: 0.01,
          value: s.delaySend,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.delaySend = v)),
        }),
        slider({
          label: "REVERB",
          min: 0,
          max: 1,
          step: 0.01,
          value: s.reverbSend,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.reverbSend = v)),
        }),
      ]),
    );
  }

  /** Apply a sound edit to just the selected pad, or all pads in the bank if ALL PADS is on. */
  private applyTrackSetting(fn: (t: Track) => void) {
    const current = this.track();
    if (!current) return;
    const targets = this.applyAllPads ? this.bank().tracks : [current];
    targets.forEach((t) => {
      fn(t);
      t.applySettings();
    });
  }

  // ---- Master FX ----------------------------------------------------------

  private buildMasterPanel(): HTMLElement {
    const panel = el("div", { class: "panel" });
    const m = () => this.engine.master;

    // Local crush state so the three params can be set together.
    let bits = 16;
    let reduction = 1;
    let crushMix = 1;
    const pushCrush = () => m().setCrush(bits, reduction, crushMix);

    panel.append(
      el("div", { class: "row" }, [
        slider({
          label: "CRUSH BITS",
          min: 1,
          max: 16,
          step: 1,
          value: bits,
          onInput: (v) => {
            bits = v;
            pushCrush();
          },
        }),
        slider({
          label: "SR REDUCE",
          min: 1,
          max: 40,
          step: 1,
          value: reduction,
          format: (v) => `${v}x`,
          onInput: (v) => {
            reduction = v;
            pushCrush();
          },
        }),
        slider({
          label: "CRUSH MIX",
          min: 0,
          max: 1,
          step: 0.01,
          value: crushMix,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => {
            crushMix = v;
            pushCrush();
          },
        }),
        slider({
          label: "MASTER FILTER",
          min: 200,
          max: 20000,
          step: 10,
          value: 20000,
          format: (v) => `${Math.round(v)}Hz`,
          onInput: (v) => m().setFilter(v),
        }),
        slider({
          label: "DRIVE",
          min: 0,
          max: 1,
          step: 0.01,
          value: 0,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => m().setDrive(v),
        }),
        slider({
          label: "DELAY FBK",
          min: 0,
          max: 0.95,
          step: 0.01,
          value: 0.35,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => m().setDelayFeedback(v),
        }),
      ]),
    );
    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Master FX"]),
      panel,
    ]);
  }

  // ---- Momentary performance FX ------------------------------------------

  private buildPerformance(): HTMLElement {
    const filterBtn = this.makePerfButton("FILTER", {
      on: () => this.engine.master.setFilter(400, 6),
      off: () => this.engine.master.setFilter(20000, 0.7),
    });
    const crushBtn = this.makePerfButton("CRUSH", {
      on: () => this.engine.master.setCrush(4, 12, 1),
      off: () => this.engine.master.setCrush(16, 1, 1),
    });

    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Performance — hold to apply"]),
      el("div", { class: "row" }, [filterBtn, crushBtn]),
    ]);
  }

  private makePerfButton(
    label: string,
    handlers: { on: () => void; off: () => void },
  ): HTMLButtonElement {
    const btn = el("button", { class: "perf" }, [label]) as HTMLButtonElement;
    const press = (e: Event) => {
      e.preventDefault();
      btn.classList.add("held");
      handlers.on();
    };
    const release = () => {
      if (!btn.classList.contains("held")) return;
      btn.classList.remove("held");
      handlers.off();
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
    return btn;
  }

  // ---- Sample loading -----------------------------------------------------

  private buildSampleTools(): HTMLElement {
    const chopInput = el("input", {
      type: "file",
      accept: "audio/*",
      style: "display:none",
    }) as HTMLInputElement;
    chopInput.addEventListener("change", async () => {
      const file = chopInput.files?.[0];
      if (!file) return;
      const n = await this.engine.loadAndSlice(file);
      this.showSampleBank();
      alert(`Chopped into ${n} slices across the SAMPLES bank.`);
    });
    const chopBtn = el("button", { class: "ctrl" }, ["Chop file → samples"]);
    chopBtn.addEventListener("click", () => chopInput.click());

    const padInput = el("input", {
      type: "file",
      accept: "audio/*",
      style: "display:none",
    }) as HTMLInputElement;
    padInput.addEventListener("change", async () => {
      const file = padInput.files?.[0];
      if (!file) return;
      const pad = this.sampleTargetPad();
      await this.engine.loadOntoPad(pad, file);
      this.showSampleBank(pad);
    });
    const padBtn = el("button", { class: "ctrl" }, ["Load file → sample pad"]);
    padBtn.addEventListener("click", () => padInput.click());

    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Samples"]),
      this.buildRecorder(),
      el("div", { class: "row" }, [chopBtn, padBtn, chopInput, padInput]),
      el("p", { class: "hint" }, [
        "Recordings and loaded files go to the SAMPLES bank — your drum kit is " +
          "left untouched. Chop uses transient detection to auto-slice across the " +
          "sample pads.",
      ]),
    ]);
  }

  /** Which sample pad to load onto: the selected one if we're on the sample bank. */
  private sampleTargetPad(): number {
    return this.selectedBank === this.engine.sampleBankIndex ? this.selectedPad : 0;
  }

  /** Switch the view to the SAMPLES bank and refresh everything. */
  private showSampleBank(pad = 0) {
    this.selectedBank = this.engine.sampleBankIndex;
    this.selectedPad = pad;
    this.renderPads();
    this.refreshSelection();
    this.refreshBankButtons();
  }

  // ---- Sample editor (waveform + slice markers) ---------------------------

  private buildSampleEditor(): HTMLElement {
    this.editorReadout = el("span", { class: "hint" }, ["no sample loaded"]);

    this.editor.onChange = () => this.refreshEditorReadout();

    // Open a file directly into the editor.
    const fileInput = el("input", {
      type: "file",
      accept: "audio/*",
      style: "display:none",
    }) as HTMLInputElement;
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const buf = await this.engine.decodeToBuffer(file);
      this.setEditorBuffer(buf);
    });
    const openBtn = el("button", { class: "ctrl" }, ["Open file…"]);
    openBtn.addEventListener("click", () => fileInput.click());

    // Use whatever the last recording was.
    const useRecBtn = el("button", { class: "ctrl" }, ["Use last recording"]);
    useRecBtn.addEventListener("click", () => {
      if (this.engine.lastRecording) this.setEditorBuffer(this.engine.lastRecording);
    });

    // Preview the selected region.
    const previewBtn = el("button", { class: "ctrl" }, ["▶ Preview"]);
    previewBtn.addEventListener("click", () => {
      if (!this.editorBuffer) return;
      const [s, e] = this.editor.getRegion();
      this.engine.previewRegion(this.editorBuffer, s, e);
    });

    // Target sample pad picker.
    this.editorTarget = el("select", { class: "ctrl" }) as HTMLSelectElement;
    const sampleTracks = this.engine.banks[this.engine.sampleBankIndex].tracks;
    sampleTracks.forEach((_, i) => {
      this.editorTarget.append(el("option", { value: String(i) }, [`pad ${i + 1}`]));
    });

    // Assign the selection to the chosen sample pad.
    const assignBtn = el("button", { class: "ctrl active" }, ["Assign to pad"]);
    assignBtn.addEventListener("click", () => {
      if (!this.editorBuffer) return;
      const pad = Number(this.editorTarget.value);
      const [s, e] = this.editor.getRegion();
      this.engine.assignRegionToPad(pad, this.editorBuffer, s, e, `slice ${pad + 1}`);
      this.showSampleBank(pad);
      this.engine.previewRegion(this.editorBuffer, s, e);
    });

    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Sample editor — drag to select a moment"]),
      this.editor.root,
      el("div", { class: "row" }, [this.editorReadout]),
      el("div", { class: "row" }, [openBtn, useRecBtn, previewBtn, fileInput]),
      el("div", { class: "row" }, [
        el("span", { class: "hint" }, ["→ target"]),
        this.editorTarget,
        assignBtn,
      ]),
    ]);
  }

  private setEditorBuffer(buffer: AudioBuffer) {
    this.editorBuffer = buffer;
    this.editor.setBuffer(buffer);
    this.refreshEditorReadout();
  }

  private refreshEditorReadout() {
    if (!this.editorBuffer) {
      this.editorReadout.textContent = "no sample loaded";
      return;
    }
    const [s, e] = this.editor.getRegion();
    this.editorReadout.textContent = `selection ${s.toFixed(3)}s – ${e.toFixed(3)}s  (${(
      e - s
    ).toFixed(3)}s)`;
  }

  // ---- Mic recording UI ---------------------------------------------------

  private buildRecorder(): HTMLElement {
    if (!isRecordingSupported()) {
      return el("p", { class: "hint" }, [
        "Mic recording needs a browser with MediaRecorder over HTTPS.",
      ]);
    }

    const recBtn = el("button", { class: "ctrl" }, ["● Record"]) as HTMLButtonElement;
    const status = el("span", { class: "hint" }, ["ready"]);

    const chopRecBtn = el("button", { class: "ctrl" }, [
      "Chop recording → samples",
    ]) as HTMLButtonElement;
    const padRecBtn = el("button", { class: "ctrl" }, [
      "Recording → sample pad",
    ]) as HTMLButtonElement;
    chopRecBtn.disabled = true;
    padRecBtn.disabled = true;

    let timer: number | null = null;
    let startedAt = 0;
    const tick = () => {
      const secs = (performance.now() - startedAt) / 1000;
      status.textContent = `recording… ${secs.toFixed(1)}s`;
    };

    recBtn.addEventListener("click", async () => {
      if (this.engine.isRecording) {
        recBtn.disabled = true;
        status.textContent = "processing…";
        if (timer !== null) window.clearInterval(timer);
        try {
          const buf = await this.engine.stopRecording();
          status.textContent = `recorded ${buf.duration.toFixed(1)}s`;
          chopRecBtn.disabled = false;
          padRecBtn.disabled = false;
          this.setEditorBuffer(buf); // load the take into the waveform editor
        } catch (err) {
          console.error(err);
          status.textContent = "recording failed";
        }
        recBtn.disabled = false;
        recBtn.textContent = "● Record";
        recBtn.classList.remove("active");
      } else {
        try {
          await this.engine.startRecording();
        } catch (err) {
          console.error(err);
          status.textContent = "mic permission denied";
          return;
        }
        recBtn.textContent = "■ Stop";
        recBtn.classList.add("active");
        startedAt = performance.now();
        timer = window.setInterval(tick, 100);
      }
    });

    chopRecBtn.addEventListener("click", () => {
      if (!this.engine.lastRecording) return;
      const n = this.engine.sliceBufferAcrossPads(this.engine.lastRecording);
      this.showSampleBank();
      status.textContent = `chopped into ${n} slices`;
    });

    padRecBtn.addEventListener("click", () => {
      if (!this.engine.lastRecording) return;
      const pad = this.sampleTargetPad();
      this.engine.loadBufferOntoPad(pad, this.engine.lastRecording, "recording");
      this.showSampleBank(pad);
      status.textContent = "loaded onto sample pad";
    });

    return el("div", { class: "panel" }, [
      el("div", { class: "row" }, [recBtn, status]),
      el("div", { class: "row" }, [chopRecBtn, padRecBtn]),
    ]);
  }

  // ---- Selection + refresh helpers ---------------------------------------

  private refreshBankButtons() {
    this.bankBtns.forEach((b, i) => b.classList.toggle("active", i === this.selectedBank));
  }

  private refreshSelection() {
    this.refreshBankButtons();
    this.padEls.forEach((p, i) => p.classList.toggle("selected", i === this.selectedPad));

    // Drum bank shows the step grid; sample bank shows the melodic piano roll.
    const melodic = this.bank()?.kind === "sample";
    if (this.keysSection) {
      this.keysSection.style.display = melodic ? "" : "none";
      this.rollSection.style.display = melodic ? "" : "none";
      this.stepSection.style.display = melodic ? "none" : "";
      this.stepPanelSection.style.display = melodic ? "none" : "";
    }

    if (melodic) {
      const track = this.track();
      if (track) this.pianoRoll.setTrack(track);
      if (this.keysPanel) this.renderKeysPanel();
    } else {
      this.refreshSteps();
      this.refreshStepPanel();
    }
    this.refreshTrackPanel();
  }

  private refreshSteps() {
    const track = this.track();
    if (!track) return;
    const root = track.settings.rootNote;
    this.stepEls.forEach((cell, i) => {
      const step = track.steps[i];
      cell.classList.toggle("on", step.on);
      cell.classList.toggle("selected", this.plockMode && i === this.selectedStep);
      // Show the note name on any repitched step.
      const showNote = step.on && step.pitch !== 0;
      cell.textContent = showNote ? midiToName(root + step.pitch) : "";
    });
  }

  private highlightPlayhead(absStep: number) {
    const melodic = this.bank()?.kind === "sample";
    if (melodic) {
      // Clear the step grid highlight if it was showing, then drive the roll.
      if (this.lastPlayhead >= 0 && this.stepEls[this.lastPlayhead]) {
        this.stepEls[this.lastPlayhead].classList.remove("playing");
      }
      this.lastPlayhead = -1;
      const track = this.track();
      if (absStep < 0 || !track) {
        this.pianoRoll.setPlayhead(-1);
        return;
      }
      const len = track.length;
      this.pianoRoll.setPlayhead(((absStep % len) + len) % len);
      return;
    }

    // Drum step grid: wrap by the bar length.
    const steps = this.engine.steps;
    const local = absStep < 0 ? -1 : ((absStep % steps) + steps) % steps;
    if (this.lastPlayhead >= 0 && this.stepEls[this.lastPlayhead]) {
      this.stepEls[this.lastPlayhead].classList.remove("playing");
    }
    if (local >= 0 && this.stepEls[local]) {
      this.stepEls[local].classList.add("playing");
    }
    this.lastPlayhead = local;
  }
}
