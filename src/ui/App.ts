import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";
import type { Step } from "../audio/types.ts";
import { isRecordingSupported } from "../audio/Recorder.ts";
import { WaveformEditor } from "./WaveformEditor.ts";
import { el, slider } from "./dom.ts";

/** Builds and manages the whole UI, wired to an AudioEngine. */
export class App {
  private engine: AudioEngine;
  private root: HTMLElement;

  private selectedBank = 0;
  private selectedPad = 0;
  private selectedStep = 0;
  private plockMode = false;

  // "Universal" apply toggles.
  private applyAllPads = false;
  private applyAllSteps = false;

  // Cached elements.
  private bankBtns: HTMLButtonElement[] = [];
  private bankRow!: HTMLElement;
  private padGrid!: HTMLElement;
  private padEls: HTMLButtonElement[] = [];
  private seqControls!: HTMLElement;
  private stepGrid!: HTMLElement;
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
    main.append(
      this.buildBankSwitcher(),
      this.buildPads(),
      this.buildSequencer(),
      this.buildStepPanel(),
      this.buildTrackPanel(),
      this.buildMasterPanel(),
      this.buildPerformance(),
      this.buildSampleTools(),
      this.buildSampleEditor(),
    );
    this.root.append(main);
    this.renderPads();
    this.refreshSelection();
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
      label: "TEMPO", min: 60, max: 200, step: 1, value: this.engine.bpm,
      format: (v) => `${v} bpm`, onInput: (v) => (this.engine.bpm = v),
    });
    const swing = slider({
      label: "SWING", min: 0, max: 1, step: 0.01, value: this.engine.swing,
      format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => (this.engine.swing = v),
    });

    return el("div", { class: "topbar" }, [
      el("span", { class: "title" }, ["POCKET SAMPLER"]),
      playBtn, tempo, swing,
    ]);
  }

  // ---- Bank switcher ------------------------------------------------------

  private buildBankSwitcher(): HTMLElement {
    this.bankRow = el("div", { class: "row" });
    const section = el("section", {}, [
      el("h2", { class: "section-title" }, ["Banks — separate sequencers"]),
      this.bankRow,
    ]);
    this.renderBankSwitcher();
    return section;
  }

  private renderBankSwitcher() {
    this.bankRow.innerHTML = "";
    this.bankBtns = [];
    this.engine.banks.forEach((b, i) => {
      const btn = el("button", { class: "ctrl" }, [b.name]) as HTMLButtonElement;
      btn.addEventListener("click", () => this.selectBank(i));
      this.bankBtns.push(btn);
      this.bankRow.append(btn);
    });
    const addBtn = el("button", { class: "ctrl" }, ["+ Drum machine"]) as HTMLButtonElement;
    addBtn.addEventListener("click", () => {
      const idx = this.engine.addDrumBank();
      if (idx < 0) return;
      this.renderBankSwitcher();
      this.selectBank(idx, true);
    });
    this.bankRow.append(addBtn);
    this.refreshBankButtons();
  }

  private selectBank(i: number, force = false) {
    if (i === this.selectedBank && !force) return;
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

  // ---- Step sequencer (shared by all banks) -------------------------------

  private buildSequencer(): HTMLElement {
    const plockBtn = el("button", { class: "ctrl" }, ["P-LOCK"]) as HTMLButtonElement;
    plockBtn.addEventListener("click", () => {
      this.plockMode = !this.plockMode;
      plockBtn.classList.toggle("active", this.plockMode);
      this.refreshSteps();
    });
    this.seqControls = el("div", { class: "row" });
    this.stepGrid = el("div", { class: "steps" });
    this.stepEls = [];
    return el("section", {}, [
      el("div", { class: "row", style: "justify-content:space-between" }, [
        el("h2", { class: "section-title" }, ["Sequence"]),
        plockBtn,
      ]),
      this.seqControls,
      this.stepGrid,
    ]);
  }

  private renderStepControls() {
    this.seqControls.innerHTML = "";
    const track = this.track();
    if (!track) return;
    this.seqControls.append(
      slider({
        label: "STEPS (loop length)", min: 1, max: 32, step: 1, value: track.length,
        format: (v) => `${v}`,
        onInput: (v) => {
          this.bank().tracks.forEach((t) => t.setLength(v));
          if (this.selectedStep >= v) this.selectedStep = 0;
          this.renderStepGrid();
        },
      }),
      el("span", { class: "hint" }, ["applies to the whole machine — add more machines for polyrhythms"]),
    );
  }

  private renderStepGrid() {
    this.stepGrid.innerHTML = "";
    this.stepEls = [];
    const track = this.track();
    if (!track) return;
    if (this.selectedStep >= track.length) this.selectedStep = 0;
    for (let i = 0; i < track.length; i++) {
      const step = el("button", {
        class: i % 4 === 0 ? "step beat" : "step",
      }) as HTMLButtonElement;
      step.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.onStepTap(i);
      });
      this.stepEls.push(step);
      this.stepGrid.append(step);
    }
    this.refreshSteps();
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
        el("span", { class: "hint" }, [`Editing ${track.settings.name} · step ${this.selectedStep + 1}`]),
        allBtn,
      ]),
      el("div", { class: "row" }, [
        slider({ label: "PITCH", min: -24, max: 24, step: 1, value: step.pitch,
          format: (v) => `${v > 0 ? "+" : ""}${v} st`,
          onInput: (v) => this.applyStepSetting((s) => (s.pitch = v)),
        }),
        slider({ label: "CHANCE", min: 0, max: 1, step: 0.05, value: step.probability,
          format: (v) => `${Math.round(v * 100)}%`,
          onInput: (v) => this.applyStepSetting((s) => (s.probability = v)),
        }),
        slider({ label: "VELOCITY", min: 0, max: 1, step: 0.05, value: step.velocity,
          format: (v) => `${Math.round(v * 100)}%`,
          onInput: (v) => this.applyStepSetting((s) => (s.velocity = v)),
        }),
      ]),
    );
  }

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
        slider({ label: "VOLUME", min: 0, max: 1, step: 0.01, value: s.gain,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.gain = v)),
        }),
        slider({ label: "PAN", min: -1, max: 1, step: 0.05, value: s.pan,
          format: (v) => v.toFixed(2),
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.pan = v)),
        }),
        slider({ label: "CUTOFF", min: 100, max: 18000, step: 10, value: s.cutoff,
          format: (v) => `${Math.round(v)}Hz`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.cutoff = v)),
        }),
        slider({ label: "RESO", min: 0.1, max: 20, step: 0.1, value: s.resonance,
          format: (v) => v.toFixed(1),
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.resonance = v)),
        }),
        slider({ label: "PITCH", min: 0.25, max: 2, step: 0.01, value: s.playbackRate,
          format: (v) => `${v.toFixed(2)}x`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.playbackRate = v)),
        }),
        slider({ label: "DELAY", min: 0, max: 1, step: 0.01, value: s.delaySend,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.delaySend = v)),
        }),
        slider({ label: "REVERB", min: 0, max: 1, step: 0.01, value: s.reverbSend,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.reverbSend = v)),
        }),
      ]),
    );
  }

  private applyTrackSetting(fn: (t: Track) => void) {
    const current = this.track();
    if (!current) return;
    const targets = this.applyAllPads ? this.bank().tracks : [current];
    targets.forEach((t) => { fn(t); t.applySettings(); });
  }

  // ---- Master FX ----------------------------------------------------------

  private buildMasterPanel(): HTMLElement {
    const panel = el("div", { class: "panel" });
    const m = () => this.engine.master;
    let bits = 16, reduction = 1, crushMix = 1;
    const pushCrush = () => m().setCrush(bits, reduction, crushMix);
    panel.append(
      el("div", { class: "row" }, [
        slider({ label: "CRUSH BITS", min: 1, max: 16, step: 1, value: bits,
          onInput: (v) => { bits = v; pushCrush(); },
        }),
        slider({ label: "SR REDUCE", min: 1, max: 40, step: 1, value: reduction,
          format: (v) => `${v}x`, onInput: (v) => { reduction = v; pushCrush(); },
        }),
        slider({ label: "CRUSH MIX", min: 0, max: 1, step: 0.01, value: crushMix,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => { crushMix = v; pushCrush(); },
        }),
        slider({ label: "MASTER FILTER", min: 200, max: 20000, step: 10, value: 20000,
          format: (v) => `${Math.round(v)}Hz`, onInput: (v) => m().setFilter(v),
        }),
        slider({ label: "DRIVE", min: 0, max: 1, step: 0.01, value: 0,
          format: (v) => `${Math.round(v * 100)}`, onInput: (v) => m().setDrive(v),
        }),
        slider({ label: "DELAY FBK", min: 0, max: 0.95, step: 0.01, value: 0.35,
          format: (v) => `${Math.round(v * 100)}`, onInput: (v) => m().setDelayFeedback(v),
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

  private makePerfButton(label: string, handlers: { on: () => void; off: () => void }): HTMLButtonElement {
    const btn = el("button", { class: "perf" }, [label]) as HTMLButtonElement;
    const press = (e: Event) => { e.preventDefault(); btn.classList.add("held"); handlers.on(); };
    const release = () => { if (!btn.classList.contains("held")) return; btn.classList.remove("held"); handlers.off(); };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
    return btn;
  }

  // ---- Sample loading -----------------------------------------------------

  private buildSampleTools(): HTMLElement {
    const chopInput = el("input", { type: "file", accept: "audio/*", style: "display:none" }) as HTMLInputElement;
    chopInput.addEventListener("change", async () => {
      const file = chopInput.files?.[0]; if (!file) return;
      const n = await this.engine.loadAndSlice(file);
      this.showSampleBank();
      alert(`Chopped into ${n} slices across the SAMPLES bank.`);
    });
    const chopBtn = el("button", { class: "ctrl" }, ["Chop file → samples"]);
    chopBtn.addEventListener("click", () => chopInput.click());

    const padInput = el("input", { type: "file", accept: "audio/*", style: "display:none" }) as HTMLInputElement;
    padInput.addEventListener("change", async () => {
      const file = padInput.files?.[0]; if (!file) return;
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
        "Recordings and loaded files go to the SAMPLES bank — your drum kit is left untouched. Chop uses transient detection to auto-slice across the sample pads.",
      ]),
    ]);
  }

  private sampleTargetPad(): number {
    return this.selectedBank === this.engine.sampleBankIndex ? this.selectedPad : 0;
  }

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

    const fileInput = el("input", { type: "file", accept: "audio/*", style: "display:none" }) as HTMLInputElement;
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0]; if (!file) return;
      const buf = await this.engine.decodeToBuffer(file);
      this.setEditorBuffer(buf);
    });
    const openBtn = el("button", { class: "ctrl" }, ["Open file…"]);
    openBtn.addEventListener("click", () => fileInput.click());

    const useRecBtn = el("button", { class: "ctrl" }, ["Use last recording"]);
    useRecBtn.addEventListener("click", () => {
      if (this.engine.lastRecording) this.setEditorBuffer(this.engine.lastRecording);
    });

    const previewBtn = el("button", { class: "ctrl" }, ["▶ Preview"]);
    previewBtn.addEventListener("click", () => {
      if (!this.editorBuffer) return;
      const [s, e] = this.editor.getRegion();
      this.engine.previewRegion(this.editorBuffer, s, e);
    });

    this.editorTarget = el("select", { class: "ctrl" }) as HTMLSelectElement;
    const sampleTracks = this.engine.banks[this.engine.sampleBankIndex].tracks;
    sampleTracks.forEach((_, i) => {
      this.editorTarget.append(el("option", { value: String(i) }, [`pad ${i + 1}`]));
    });

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
      el("h2", { class: "section-title" }, ["Sample editor — drag to select a region"]),
      this.editor.root,
      el("div", { class: "row" }, [this.editorReadout]),
      el("div", { class: "row" }, [openBtn, useRecBtn, previewBtn, fileInput]),
      el("div", { class: "row" }, [el("span", { class: "hint" }, ["→ target"]), this.editorTarget, assignBtn]),
    ]);
  }

  private setEditorBuffer(buffer: AudioBuffer) {
    this.editorBuffer = buffer;
    this.editor.setBuffer(buffer);
    this.refreshEditorReadout();
  }

  private refreshEditorReadout() {
    if (!this.editorBuffer) { this.editorReadout.textContent = "no sample loaded"; return; }
    const [s, e] = this.editor.getRegion();
    this.editorReadout.textContent = `selection ${s.toFixed(3)}s – ${e.toFixed(3)}s  (${(e - s).toFixed(3)}s)`;
  }

  // ---- Mic recording UI ---------------------------------------------------

  private buildRecorder(): HTMLElement {
    if (!isRecordingSupported()) {
      return el("p", { class: "hint" }, ["Mic recording needs a browser with MediaRecorder over HTTPS."]);
    }
    const recBtn = el("button", { class: "ctrl" }, ["● Record"]) as HTMLButtonElement;
    const status = el("span", { class: "hint" }, ["ready"]);
    const chopRecBtn = el("button", { class: "ctrl" }, ["Chop recording → samples"]) as HTMLButtonElement;
    const padRecBtn = el("button", { class: "ctrl" }, ["Recording → sample pad"]) as HTMLButtonElement;
    chopRecBtn.disabled = true;
    padRecBtn.disabled = true;
    let timer: number | null = null;
    let startedAt = 0;
    const tick = () => { status.textContent = `recording… ${((performance.now() - startedAt) / 1000).toFixed(1)}s`; };

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
          this.setEditorBuffer(buf);
        } catch (err) { console.error(err); status.textContent = "recording failed"; }
        recBtn.disabled = false; recBtn.textContent = "● Record"; recBtn.classList.remove("active");
      } else {
        try { await this.engine.startRecording(); }
        catch (err) { console.error(err); status.textContent = "mic permission denied"; return; }
        recBtn.textContent = "■ Stop"; recBtn.classList.add("active");
        startedAt = performance.now(); timer = window.setInterval(tick, 100);
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
    this.renderStepControls();
    this.renderStepGrid();
    this.refreshStepPanel();
    this.refreshTrackPanel();
  }

  private refreshSteps() {
    const track = this.track();
    if (!track) return;
    this.stepEls.forEach((cell, i) => {
      const step = track.steps[i];
      cell.classList.toggle("on", step.on);
      cell.classList.toggle("selected", this.plockMode && i === this.selectedStep);
      cell.textContent = "";
    });
  }

  private highlightPlayhead(absStep: number) {
    const track = this.track();
    const len = track ? track.length : this.engine.steps;
    const local = absStep < 0 ? -1 : ((absStep % len) + len) % len;
    if (this.lastPlayhead >= 0 && this.stepEls[this.lastPlayhead]) {
      this.stepEls[this.lastPlayhead].classList.remove("playing");
    }
    if (local >= 0 && this.stepEls[local]) {
      this.stepEls[local].classList.add("playing");
    }
    this.lastPlayhead = local;
  }
}
