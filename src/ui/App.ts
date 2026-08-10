import type { AudioEngine, EngineSnapshot } from "../audio/AudioEngine.ts";
import type { EffectSlotSettings, EffectType } from "../audio/FxChain.ts";
import type { Track } from "../audio/Track.ts";
import type { Step } from "../audio/types.ts";
import type { SampleEntry } from "../audio/SampleLibrary.ts";
import { isRecordingSupported } from "../audio/Recorder.ts";
import { WaveformEditor } from "./WaveformEditor.ts";
import { MelodicPerformance } from "./MelodicPerformance.ts";
import { el, slider } from "./dom.ts";

type NumericSlotKey = Exclude<keyof EffectSlotSettings, "type" | "filterType">;

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
  private melodic!: MelodicPerformance;

  // Sample editor.
  private editor = new WaveformEditor();
  private editorBuffer: AudioBuffer | null = null;
  private editorReadout!: HTMLElement;
  private editorTarget!: HTMLSelectElement;

  // Per-scene FX panel.
  private masterPanel!: HTMLElement;
  private masterTitle!: HTMLElement;

  // Undo/redo: a list of state snapshots with a pointer into it.
  private history: EngineSnapshot[] = [];
  private historyIndex = -1;
  private readonly historyLimit = 60;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  /** Guards against recording new history while we're applying a restore. */
  private restoring = false;

  // Library drawer.
  private drawer!: HTMLElement;
  private drawerList!: HTMLElement;
  private drawerOpen = false;

  constructor(engine: AudioEngine, root: HTMLElement) {
    this.engine = engine;
    this.root = root;
    // Stop() pushes -1 through here to clear the highlight.
    this.engine.onVisualStep = (s) => this.highlightPlayhead(s);
    this.startVisualLoop();
  }

  /**
   * Animation loop that syncs the on-screen playhead to the audio clock.
   * Running this on rAF (rather than a timer per step) keeps the highlight
   * locked to what you hear and costs nothing when stopped.
   */
  private startVisualLoop() {
    const frame = () => {
      if (this.engine.isPlaying) {
        const step = this.engine.drainVisualStep();
        if (step !== null) this.highlightPlayhead(step);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  mount() {
    this.root.innerHTML = "";
    this.root.append(this.buildTopbar());
    this.melodic = new MelodicPerformance(this.engine, () => this.commit());
    const main = el("main");
    main.append(
      this.buildBankSwitcher(),
      this.buildPads(),
      this.melodic.element,
      this.buildSequencer(),
      this.buildStepPanel(),
      this.buildTrackPanel(),
      this.buildMasterPanel(),
      this.buildPerformance(),
      this.buildSampleTools(),
      this.buildSampleEditor(),
      this.buildExportSection(),
    );
    this.root.append(main);
    this.root.append(this.buildDrawer());
    this.renderPads();
    this.refreshSelection();
    requestAnimationFrame(() => this.editor.redraw());

    // Seed history with the starting state so the first undo has a target.
    this.commit();
    this.installUndoShortcuts();
    this.installSliderCommitTracking();
  }

  /** Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) to redo. */
  private installUndoShortcuts() {
    window.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); this.redo(); }
    });
  }

  /**
   * Sliders fire a stream of `input` events while dragging, which would flood
   * history. Commit once on `change` instead (fires on release), so a whole
   * drag collapses into a single undo step.
   */
  private installSliderCommitTracking() {
    this.root.addEventListener("change", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const isRange = target instanceof HTMLInputElement && target.type === "range";
      const isSelect = target instanceof HTMLSelectElement;
      if (isRange || isSelect) this.commit();
    });
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

    this.undoBtn = el("button", { class: "ctrl", title: "Undo" }, ["↶"]) as HTMLButtonElement;
    this.undoBtn.addEventListener("click", () => this.undo());
    this.redoBtn = el("button", { class: "ctrl", title: "Redo" }, ["↷"]) as HTMLButtonElement;
    this.redoBtn.addEventListener("click", () => this.redo());

    return el("div", { class: "topbar" }, [
      el("span", { class: "title" }, ["POCKET SAMPLER"]),
      playBtn, tempo, swing,
      this.undoBtn, this.redoBtn,
      this.buildLibraryToggle(),
    ]);
  }

  private buildLibraryToggle(): HTMLElement {
    const btn = el("button", { class: "ctrl" }, ["📁 Samples"]) as HTMLButtonElement;
    btn.addEventListener("click", () => this.toggleDrawer());
    return btn;
  }

  private toggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
    this.drawer.classList.toggle("open", this.drawerOpen);
    if (this.drawerOpen) this.refreshDrawer();
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
      const btn = el("button", { class: `ctrl${b.muted ? " muted" : ""}` }, [b.name]) as HTMLButtonElement;
      btn.addEventListener("click", () => this.selectBank(i));

      // Long-press to show context menu (mute/rename/delete).
      let holdTimer: number | null = null;
      const startHold = (e: Event) => {
        e.preventDefault();
        holdTimer = window.setTimeout(() => {
          holdTimer = null;
          this.showBankContextMenu(i);
        }, 500);
      };
      const cancelHold = () => {
        if (holdTimer !== null) { window.clearTimeout(holdTimer); holdTimer = null; }
      };
      btn.addEventListener("pointerdown", startHold);
      btn.addEventListener("pointerup", cancelHold);
      btn.addEventListener("pointerleave", cancelHold);
      btn.addEventListener("pointercancel", cancelHold);

      this.bankBtns.push(btn);
      this.bankRow.append(btn);
    });

    const addBtn = el("button", { class: "ctrl" }, ["+ Drum machine"]) as HTMLButtonElement;
    addBtn.addEventListener("click", () => {
      const idx = this.engine.addDrumBank();
      if (idx < 0) return;
      this.renderBankSwitcher();
      this.selectBank(idx, true);
      this.commit();
    });
    const addSampBtn = el("button", { class: "ctrl" }, ["+ Sample bank"]) as HTMLButtonElement;
    addSampBtn.addEventListener("click", () => {
      const idx = this.engine.addSampleBank();
      if (idx < 0) return;
      this.renderBankSwitcher();
      this.selectBank(idx, true);
      this.commit();
    });
    this.bankRow.append(addBtn, addSampBtn);
    this.refreshBankButtons();
  }

  /** Show an inline context menu for a bank (mute/rename/delete). */
  private showBankContextMenu(bankIndex: number) {
    // Remove any existing menu.
    document.querySelector(".bank-menu")?.remove();

    const bank = this.engine.banks[bankIndex];
    if (!bank) return;

    const muteBtn = el("button", { class: "ctrl" }, [bank.muted ? "Unmute" : "Mute"]) as HTMLButtonElement;
    muteBtn.addEventListener("click", () => {
      bank.muted = !bank.muted;
      menu.remove();
      this.renderBankSwitcher();
      this.commit();
    });

    const renameBtn = el("button", { class: "ctrl" }, ["Rename"]) as HTMLButtonElement;
    renameBtn.addEventListener("click", () => {
      menu.remove();
      const name = prompt("Bank name:", bank.name);
      if (name && name.trim()) {
        bank.name = name.trim();
        this.renderBankSwitcher();
        this.refreshMasterPanel();
        this.commit();
      }
    });

    const delBtn = el("button", { class: "ctrl" }, ["Delete"]) as HTMLButtonElement;
    delBtn.addEventListener("click", () => {
      menu.remove();
      if (!confirm(`Delete "${bank.name}"? This can't be undone.`)) return;
      if (this.engine.deleteBank(bankIndex)) {
        this.selectedBank = Math.min(this.selectedBank, this.engine.banks.length - 1);
        this.selectedPad = 0;
        this.renderBankSwitcher();
        this.renderPads();
        this.refreshSelection();
        this.commit();
      }
    });

    const closeBtn = el("button", { class: "ctrl" }, ["✕"]) as HTMLButtonElement;
    closeBtn.addEventListener("click", () => menu.remove());

    const menu = el("div", { class: "bank-menu" }, [muteBtn, renameBtn, delBtn, closeBtn]);
    this.bankRow.append(menu);

    // Auto-dismiss if user taps elsewhere.
    const dismiss = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) { menu.remove(); window.removeEventListener("pointerdown", dismiss); }
    };
    window.setTimeout(() => window.addEventListener("pointerdown", dismiss), 10);
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
      this.commit();
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

    // Filter type selector.
    const filterType = el("select", { class: "ctrl" }) as HTMLSelectElement;
    for (const t of ["lowpass", "highpass", "bandpass"]) {
      const opt = el("option", { value: t }, [t.toUpperCase()]);
      if (t === s.filterType) opt.setAttribute("selected", "");
      filterType.append(opt);
    }
    filterType.addEventListener("change", () => {
      this.applyTrackSetting((t) => (t.settings.filterType = filterType.value as "lowpass" | "highpass" | "bandpass"));
    });

    // Pad name (editable).
    const nameInput = el("input", {
      type: "text",
      value: s.name,
      class: "pad-name-input",
    }) as HTMLInputElement;
    nameInput.addEventListener("change", () => {
      const val = nameInput.value.trim() || "pad";
      track.settings.name = val;
      // Update the pad label too.
      const padSpan = this.padEls[this.selectedPad]?.querySelector("span");
      if (padSpan) padSpan.textContent = val;
      this.refreshEditorTargets();
      this.commit();
    });

    this.trackPanel.append(
      el("div", { class: "row", style: "justify-content:space-between" }, [
        el("label", { class: "field" }, [el("span", {}, ["PAD NAME"]), nameInput]),
        allBtn,
      ]),
      el("div", { class: "row" }, [
        this.buildMonoToggle(track),
        slider({ label: "VOLUME", min: 0, max: 1, step: 0.01, value: s.gain,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.gain = v)),
        }),
        slider({ label: "PAN", min: -1, max: 1, step: 0.05, value: s.pan,
          format: (v) => v.toFixed(2),
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.pan = v)),
        }),
        slider({ label: "PITCH", min: 0.25, max: 2, step: 0.01, value: s.playbackRate,
          format: (v) => `${v.toFixed(2)}x`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.playbackRate = v)),
        }),
      ]),
      el("div", { class: "row" }, [
        el("label", { class: "field" }, [el("span", {}, ["FILTER"]), filterType]),
        slider({ label: "CUTOFF", min: 100, max: 18000, step: 10, value: s.cutoff,
          format: (v) => `${Math.round(v)}Hz`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.cutoff = v)),
        }),
        slider({ label: "RESO", min: 0.1, max: 20, step: 0.1, value: s.resonance,
          format: (v) => v.toFixed(1),
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.resonance = v)),
        }),
      ]),
      el("div", { class: "row" }, [
        slider({ label: "ATTACK", min: 0.001, max: 0.5, step: 0.001, value: s.attack,
          format: (v) => `${(v * 1000).toFixed(0)} ms`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.attack = v)),
        }),
        slider({ label: "RELEASE", min: 0.01, max: 2, step: 0.01, value: s.release,
          format: (v) => `${(v * 1000).toFixed(0)} ms`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.release = v)),
        }),
      ]),
      el("div", { class: "row" }, [
        slider({ label: "DELAY SEND", min: 0, max: 1, step: 0.01, value: s.delaySend,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => this.applyTrackSetting((t) => (t.settings.delaySend = v)),
        }),
        slider({ label: "REVERB SEND", min: 0, max: 1, step: 0.01, value: s.reverbSend,
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

  private buildMonoToggle(track: Track): HTMLElement {
    const btn = el("button", { class: "ctrl" }, ["MONO"]) as HTMLButtonElement;
    btn.classList.toggle("active", track.settings.mono);
    btn.addEventListener("click", () => {
      this.applyTrackSetting((t) => (t.settings.mono = !t.settings.mono));
      btn.classList.toggle("active", track.settings.mono);
      this.commit();
    });
    return btn;
  }

  // ---- Master FX ----------------------------------------------------------

  private buildMasterPanel(): HTMLElement {
    this.masterPanel = el("div", { class: "panel" });
    this.masterTitle = el("h2", { class: "section-title" }, ["Scene FX"]);
    const section = el("section", {}, [this.masterTitle, this.masterPanel]);
    this.refreshMasterPanel();
    return section;
  }

  /** Rebuild the three-slot insert rack for the selected scene. */
  private refreshMasterPanel() {
    const chain = this.engine.chainFor(this.selectedBank);
    this.masterPanel.innerHTML = "";
    if (!chain) return;

    this.masterTitle.textContent = `Scene FX rack — ${this.bank().name} only`;
    const rack = el("div", { class: "fx-rack" });
    chain.settings.slots.forEach((slot, index) => {
      rack.append(this.buildEffectSlot(index, slot));
    });
    this.masterPanel.append(
      rack,
      el("p", { class: "hint" }, [
        "Signal flows left to right: slot 1 → slot 2 → slot 3. " +
          "Delay/reverb remain per-pad sends in the sound panel.",
      ]),
    );
  }

  private buildEffectSlot(index: number, slot: EffectSlotSettings): HTMLElement {
    const chain = this.engine.chainFor(this.selectedBank)!;
    const typeSelect = el("select", { class: "ctrl fx-type" }) as HTMLSelectElement;
    const choices: EffectType[] = [
      "none", "filter", "drive", "crusher", "phaser", "chorus",
      "grain", "resonate", "tape", "repeater", "space",
      "fold", "dub", "formant", "motion", "transient",
    ];
    for (const type of choices) {
      const label = type === "none" ? "EMPTY" : type.toUpperCase();
      const option = el("option", { value: type }, [label]);
      if (type === slot.type) option.setAttribute("selected", "");
      typeSelect.append(option);
    }
    typeSelect.addEventListener("change", () => {
      chain.setSlotType(index, typeSelect.value as EffectType);
      this.refreshMasterPanel();
    });

    const controls = el("div", { class: "fx-slot-controls" });
    this.appendEffectControls(controls, slot, () => chain.applySettings());

    return el("div", { class: `fx-slot${slot.type === "none" ? " empty" : ""}` }, [
      el("div", { class: "fx-slot-head" }, [
        el("strong", {}, [`SLOT ${index + 1}`]),
        typeSelect,
      ]),
      controls,
    ]);
  }

  private appendEffectControls(
    root: HTMLElement,
    slot: EffectSlotSettings,
    apply: () => void,
  ) {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const set = (key: NumericSlotKey) => (v: number) => {
      slot[key] = v;
      apply();
    };
    const numberSelect = (
      label: string,
      key: NumericSlotKey,
      options: { value: number; label: string }[],
    ) => {
      const select = el("select", { class: "ctrl" }) as HTMLSelectElement;
      for (const item of options) {
        const option = el("option", { value: String(item.value) }, [item.label]);
        if (item.value === slot[key]) option.setAttribute("selected", "");
        select.append(option);
      }
      select.addEventListener("change", () => {
        slot[key] = Number(select.value);
        apply();
      });
      return el("label", { class: "field" }, [el("span", {}, [label]), select]);
    };
    const divisions = [2, 4, 8, 16, 32].map((value) => ({
      value,
      label: `1/${value}`,
    }));

    const midiName = (value: number) => {
      const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
      const note = Math.round(value);
      return `${names[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
    };

    if (slot.type === "none") {
      root.append(el("span", { class: "hint" }, ["Choose an effect"]));
      return;
    }

    if (slot.type === "filter") {
      const mode = el("select", { class: "ctrl" }) as HTMLSelectElement;
      for (const type of ["lowpass", "highpass", "bandpass"] as BiquadFilterType[]) {
        const option = el("option", { value: type }, [type.toUpperCase()]);
        if (type === slot.filterType) option.setAttribute("selected", "");
        mode.append(option);
      }
      mode.addEventListener("change", () => {
        slot.filterType = mode.value as BiquadFilterType;
        apply();
      });
      root.append(
        el("label", { class: "field" }, [el("span", {}, ["MODE"]), mode]),
        slider({ label: "FREQ", min: 100, max: 20000, step: 10, value: slot.frequency,
          format: (v) => `${Math.round(v)}Hz`, onInput: set("frequency") }),
        slider({ label: "Q", min: 0.1, max: 20, step: 0.1, value: slot.q,
          format: (v) => v.toFixed(1), onInput: set("q") }),
      );
    } else if (slot.type === "drive") {
      root.append(
        slider({ label: "AMOUNT", min: 0, max: 1, step: 0.01, value: slot.drive,
          format: pct, onInput: set("drive") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "crusher") {
      root.append(
        slider({ label: "BITS", min: 1, max: 16, step: 1, value: slot.bits,
          onInput: set("bits") }),
        slider({ label: "REDUCE", min: 1, max: 40, step: 1, value: slot.reduction,
          format: (v) => `${v}x`, onInput: set("reduction") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "phaser") {
      root.append(
        slider({ label: "RATE", min: 0.05, max: 8, step: 0.05, value: slot.rate,
          format: (v) => `${v.toFixed(2)}Hz`, onInput: set("rate") }),
        slider({ label: "DEPTH", min: 100, max: 3000, step: 10, value: slot.depth,
          format: (v) => `${Math.round(v)}`, onInput: set("depth") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "chorus") {
      root.append(
        slider({ label: "RATE", min: 0.1, max: 6, step: 0.1, value: slot.rate,
          format: (v) => `${v.toFixed(1)}Hz`, onInput: set("rate") }),
        slider({ label: "DEPTH", min: 0.001, max: 0.015, step: 0.001, value: slot.depth,
          format: (v) => `${(v * 1000).toFixed(1)}ms`, onInput: set("depth") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "grain") {
      root.append(
        slider({ label: "POSITION", min: 0, max: 1, step: 0.01, value: slot.position,
          format: pct, onInput: set("position") }),
        slider({ label: "GRAIN SIZE", min: 0.02, max: 0.5, step: 0.01, value: slot.grainSize,
          format: (v) => `${Math.round(v * 1000)}ms`, onInput: set("grainSize") }),
        slider({ label: "SPRAY", min: 0, max: 1, step: 0.01, value: slot.spray,
          format: pct, onInput: set("spray") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "resonate") {
      root.append(
        slider({ label: "TUNE", min: 24, max: 84, step: 1, value: slot.tune,
          format: midiName, onInput: set("tune") }),
        slider({ label: "DECAY", min: 0, max: 1, step: 0.01, value: slot.decay,
          format: pct, onInput: set("decay") }),
        slider({ label: "COLOR", min: 0, max: 1, step: 0.01, value: slot.color,
          format: pct, onInput: set("color") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "tape") {
      root.append(
        slider({ label: "AGE", min: 0, max: 1, step: 0.01, value: slot.age,
          format: pct, onInput: set("age") }),
        slider({ label: "WOBBLE", min: 0, max: 1, step: 0.01, value: slot.wobble,
          format: pct, onInput: set("wobble") }),
        slider({ label: "DROPOUT", min: 0, max: 1, step: 0.01, value: slot.dropout,
          format: pct, onInput: set("dropout") }),
        slider({ label: "DRIVE", min: 0, max: 1, step: 0.01, value: slot.drive,
          format: pct, onInput: set("drive") }),
      );
    } else if (slot.type === "repeater") {
      root.append(
        numberSelect("DIVISION", "division", divisions),
        slider({ label: "JITTER", min: 0, max: 1, step: 0.01, value: slot.jitter,
          format: pct, onInput: set("jitter") }),
        numberSelect("REVERSE", "reverse", [
          { value: 0, label: "OFF" }, { value: 1, label: "ON" },
        ]),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "space") {
      root.append(
        slider({ label: "SIZE", min: 0, max: 1, step: 0.01, value: slot.size,
          format: pct, onInput: set("size") }),
        slider({ label: "COLOR", min: 0, max: 1, step: 0.01, value: slot.color,
          format: pct, onInput: set("color") }),
        slider({ label: "SHIMMER", min: 0, max: 1, step: 0.01, value: slot.shimmer,
          format: pct, onInput: set("shimmer") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "fold") {
      root.append(
        slider({ label: "FOLD", min: 0, max: 1, step: 0.01, value: slot.fold,
          format: pct, onInput: set("fold") }),
        slider({ label: "BIAS", min: -1, max: 1, step: 0.01, value: slot.bias,
          format: (v) => v.toFixed(2), onInput: set("bias") }),
        slider({ label: "TONE", min: 0, max: 1, step: 0.01, value: slot.tone,
          format: pct, onInput: set("tone") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "dub") {
      root.append(
        numberSelect("TIME", "time", divisions),
        slider({ label: "FEEDBACK", min: 0, max: 0.88, step: 0.01, value: slot.feedback,
          format: pct, onInput: set("feedback") }),
        slider({ label: "TONE", min: 0, max: 1, step: 0.01, value: slot.tone,
          format: pct, onInput: set("tone") }),
        slider({ label: "WOBBLE", min: 0, max: 1, step: 0.01, value: slot.wobble,
          format: pct, onInput: set("wobble") }),
      );
    } else if (slot.type === "formant") {
      root.append(
        slider({ label: "VOWEL", min: 0, max: 4, step: 0.01, value: slot.vowel,
          format: (v) => ["A", "E", "I", "O", "U"][Math.round(v)], onInput: set("vowel") }),
        slider({ label: "SHIFT", min: -24, max: 24, step: 1, value: slot.shift,
          format: (v) => `${v > 0 ? "+" : ""}${v}st`, onInput: set("shift") }),
        slider({ label: "RESONANCE", min: 0, max: 1, step: 0.01, value: slot.resonance,
          format: pct, onInput: set("resonance") }),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "motion") {
      root.append(
        slider({ label: "RATE", min: 0.03, max: 12, step: 0.01, value: slot.rate,
          format: (v) => `${v.toFixed(2)}Hz`, onInput: set("rate") }),
        slider({ label: "DEPTH", min: 0, max: 1, step: 0.01, value: slot.depth,
          format: pct, onInput: set("depth") }),
        numberSelect("SHAPE", "shape", [
          { value: 0, label: "SINE" }, { value: 1, label: "TRIANGLE" },
          { value: 2, label: "SQUARE" },
        ]),
        slider({ label: "MIX", min: 0, max: 1, step: 0.01, value: slot.mix,
          format: pct, onInput: set("mix") }),
      );
    } else if (slot.type === "transient") {
      root.append(
        slider({ label: "ATTACK", min: 0, max: 1, step: 0.01, value: slot.attack,
          format: pct, onInput: set("attack") }),
        slider({ label: "BODY", min: 0, max: 1, step: 0.01, value: slot.body,
          format: pct, onInput: set("body") }),
        slider({ label: "PUNCH", min: 0, max: 1, step: 0.01, value: slot.punch,
          format: pct, onInput: set("punch") }),
        slider({ label: "DIRT", min: 0, max: 1, step: 0.01, value: slot.dirt,
          format: pct, onInput: set("dirt") }),
      );
    }
  }

  // ---- Momentary performance FX ------------------------------------------

  private buildPerformance(): HTMLElement {
    // These slam the selected scene's chain, then fall back to its settings.
    const filterBtn = this.makePerfButton("FILTER", {
      on: () => this.engine.chainFor(this.selectedBank)?.setFilterOverride(400, 6),
      off: () => this.engine.chainFor(this.selectedBank)?.clearOverrides(),
    });
    const crushBtn = this.makePerfButton("CRUSH", {
      on: () => this.engine.chainFor(this.selectedBank)?.setCrushOverride(4, 12, 1),
      off: () => this.engine.chainFor(this.selectedBank)?.clearOverrides(),
    });
    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Performance — hold to apply to this scene"]),
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
      const bank = this.selectedBank;
      const n = await this.engine.loadAndSlice(file, bank);
      this.afterPadsChanged();
      alert(`Chopped into ${n} slices across ${this.engine.banks[bank]?.name}.`);
    });
    const chopBtn = el("button", { class: "ctrl" }, ["Chop file → this scene"]);
    chopBtn.addEventListener("click", () => chopInput.click());

    const padInput = el("input", { type: "file", accept: "audio/*", style: "display:none" }) as HTMLInputElement;
    padInput.addEventListener("change", async () => {
      const file = padInput.files?.[0]; if (!file) return;
      await this.engine.loadOntoPad(this.selectedBank, this.selectedPad, file);
      this.afterPadsChanged();
    });
    const padBtn = el("button", { class: "ctrl" }, ["Load file → selected pad"]);
    padBtn.addEventListener("click", () => padInput.click());

    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Samples"]),
      this.buildRecorder(),
      el("div", { class: "row" }, [chopBtn, padBtn, chopInput, padInput]),
      el("p", { class: "hint" }, [
        "Samples load into the scene you're currently viewing, on the selected pad. " +
        "Chop uses transient detection to auto-slice across that scene's pads. " +
        "Use the sample editor below to open any file and manually select regions.",
      ]),
    ]);
  }

  /** Re-render after pads gain or lose samples, and record an undo point. */
  private afterPadsChanged() {
    this.renderPads();
    this.refreshSelection();
    this.commit();
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

    // Pad picker for the assign target, within the current scene.
    this.editorTarget = el("select", { class: "ctrl" }) as HTMLSelectElement;
    this.refreshEditorTargets();

    const assignBtn = el("button", { class: "ctrl active" }, ["Assign to pad"]);
    assignBtn.addEventListener("click", () => {
      if (!this.editorBuffer) return;
      const pad = Number(this.editorTarget.value);
      const [s, e] = this.editor.getRegion();
      // Assigns into the scene currently being viewed.
      this.engine.assignRegionToPad(this.selectedBank, pad, this.editorBuffer, s, e, `slice ${pad + 1}`);
      this.selectedPad = pad;
      this.afterPadsChanged();
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

  /** Rebuild the assign-target pad list for the current scene. */
  private refreshEditorTargets() {
    if (!this.editorTarget) return;
    const prev = this.editorTarget.value;
    this.editorTarget.innerHTML = "";
    const tracks = this.bank()?.tracks ?? [];
    tracks.forEach((t, i) => {
      this.editorTarget.append(
        el("option", { value: String(i) }, [`${i + 1}: ${t.settings.name}`]),
      );
    });
    if (prev && Number(prev) < tracks.length) this.editorTarget.value = prev;
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
      const n = this.engine.sliceBufferAcrossPads(this.engine.lastRecording, this.selectedBank);
      this.afterPadsChanged();
      status.textContent = `chopped into ${n} slices`;
    });
    padRecBtn.addEventListener("click", () => {
      if (!this.engine.lastRecording) return;
      this.engine.loadBufferOntoPad(
        this.selectedBank, this.selectedPad, this.engine.lastRecording, "recording",
      );
      this.afterPadsChanged();
      status.textContent = `loaded onto ${this.track()?.settings.name}`;
    });
    return el("div", { class: "panel" }, [
      el("div", { class: "row" }, [recBtn, status]),
      el("div", { class: "row" }, [chopRecBtn, padRecBtn]),
    ]);
  }

  // ---- Export / project save-load ------------------------------------------

  private buildExportSection(): HTMLElement {
    const exportBtn = el("button", { class: "ctrl" }, ["Export WAV"]) as HTMLButtonElement;
    exportBtn.addEventListener("click", async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = "rendering…";
      try {
        const blob = await this.engine.exportWav();
        this.downloadBlob(blob, "pocket-sampler-export.wav");
      } catch (err) { console.error(err); alert("Export failed"); }
      exportBtn.disabled = false;
      exportBtn.textContent = "Export WAV";
    });

    const saveBtn = el("button", { class: "ctrl" }, ["Save project"]) as HTMLButtonElement;
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const blob = await this.engine.exportProject();
        this.downloadBlob(blob, "pocket-sampler-project.json");
      } catch (err) { console.error(err); alert("Save failed"); }
      saveBtn.disabled = false;
    });

    const loadInput = el("input", { type: "file", accept: ".json", style: "display:none" }) as HTMLInputElement;
    loadInput.addEventListener("change", async () => {
      const file = loadInput.files?.[0]; if (!file) return;
      try {
        await this.engine.importProject(file);
        this.selectedBank = 0;
        this.selectedPad = 0;
        this.renderBankSwitcher();
        this.renderPads();
        this.refreshSelection();
        // Opening a project resets history to that state.
        this.history.length = 0;
        this.historyIndex = -1;
        this.commit();
      } catch (err) { console.error(err); alert("Failed to open project"); }
    });
    const loadBtn = el("button", { class: "ctrl" }, ["Open project"]) as HTMLButtonElement;
    loadBtn.addEventListener("click", () => loadInput.click());

    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Export & projects"]),
      el("div", { class: "row" }, [exportBtn, saveBtn, loadBtn, loadInput]),
      el("p", { class: "hint" }, [
        "Export WAV renders the sequence as audio. Save/open project preserves patterns, settings, and samples so you can come back later.",
      ]),
    ]);
  }

  private downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Undo / redo ---------------------------------------------------------

  /**
   * Record the current state as a new undo point. Called after a change lands,
   * so the history is a list of states and undo just steps back through it.
   */
  private commit() {
    if (this.restoring) return;
    // Drop any redo entries ahead of the pointer.
    this.history.length = this.historyIndex + 1;
    this.history.push(this.engine.snapshot());
    if (this.history.length > this.historyLimit) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this.refreshUndoButtons();
  }

  private undo() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.applySnapshot(this.history[this.historyIndex]);
  }

  private redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.applySnapshot(this.history[this.historyIndex]);
  }

  private applySnapshot(snap: EngineSnapshot) {
    this.restoring = true;
    try {
      this.engine.restore(snap);
      // Selection may point at a bank/pad that no longer exists.
      this.selectedBank = Math.min(this.selectedBank, this.engine.banks.length - 1);
      const padCount = this.bank()?.tracks.length ?? 0;
      this.selectedPad = Math.min(this.selectedPad, Math.max(0, padCount - 1));
      this.renderBankSwitcher();
      this.renderPads();
      this.refreshSelection();
    } finally {
      this.restoring = false;
    }
    this.refreshUndoButtons();
  }

  private refreshUndoButtons() {
    if (!this.undoBtn) return;
    this.undoBtn.disabled = this.historyIndex <= 0;
    this.redoBtn.disabled = this.historyIndex >= this.history.length - 1;
  }

  // ---- Library drawer (slides in from the right) --------------------------

  private buildDrawer(): HTMLElement {
    this.drawerList = el("div", { class: "drawer-list" });
    const closeBtn = el("button", { class: "ctrl" }, ["✕ Close"]) as HTMLButtonElement;
    closeBtn.addEventListener("click", () => this.toggleDrawer());
    this.drawer = el("aside", { class: "drawer" }, [
      el("div", { class: "drawer-head" }, [
        el("h2", { class: "section-title" }, ["Sample library"]),
        closeBtn,
      ]),
      el("p", { class: "hint" }, ["Tap a sample to load it onto the selected pad."]),
      this.drawerList,
    ]);
    return this.drawer;
  }

  private async refreshDrawer() {
    this.drawerList.innerHTML = "";
    const entries = await this.engine.listLibrary();
    if (entries.length === 0) {
      this.drawerList.append(el("p", { class: "hint" }, ["No samples yet. Record or load a file."]));
      return;
    }
    for (const entry of entries) {
      const delBtn = el("button", { class: "ctrl drawer-del" }, ["✕"]) as HTMLButtonElement;
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (entry.id == null) return;
        await this.engine.library.remove(entry.id);
        this.refreshDrawer();
      });
      const item = el("button", { class: "drawer-item" }, [
        el("span", { class: "drawer-name" }, [entry.name]),
        el("span", { class: "hint" }, [new Date(entry.addedAt).toLocaleDateString()]),
        delBtn,
      ]) as HTMLButtonElement;
      item.addEventListener("click", () => this.loadFromLibrary(entry));
      this.drawerList.append(item);
    }
  }

  private async loadFromLibrary(entry: SampleEntry) {
    // Open the sample in the waveform editor for chopping, don't assign to a pad directly.
    const buffer = await this.engine.loadLibraryEntryToBuffer(entry);
    this.setEditorBuffer(buffer);
    this.toggleDrawer();
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
    this.melodic?.setTarget(this.selectedBank, this.selectedPad);
    // FX are per scene, so this follows the selected bank.
    if (this.masterPanel) this.refreshMasterPanel();
    this.refreshEditorTargets();
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
