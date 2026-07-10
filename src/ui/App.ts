import type { AudioEngine } from "../audio/AudioEngine.ts";
import { isRecordingSupported } from "../audio/Recorder.ts";
import { el, slider } from "./dom.ts";

/** Builds and manages the whole UI, wired to an AudioEngine. */
export class App {
  private engine: AudioEngine;
  private root: HTMLElement;

  private selectedTrack = 0;
  private selectedStep = 0;
  private plockMode = false;

  // Cached elements we need to update as playback / selection changes.
  private padEls: HTMLButtonElement[] = [];
  private stepEls: HTMLButtonElement[] = [];
  private lastPlayhead = -1;
  private trackPanel!: HTMLElement;
  private stepPanel!: HTMLElement;

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
      this.buildPads(),
      this.buildSequencer(),
      this.buildStepPanel(),
      this.buildTrackPanel(),
      this.buildMasterPanel(),
      this.buildPerformance(),
      this.buildSampleTools(),
    );
    this.root.append(main);
    this.refreshSteps();
    this.refreshSelection();
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

  // ---- Pad grid -----------------------------------------------------------

  private buildPads(): HTMLElement {
    const grid = el("div", { class: "pads" });
    this.padEls = [];
    for (let i = 0; i < this.engine.config.trackCount; i++) {
      const pad = el("button", { class: "pad" }, [
        el("span", {}, [this.engine.tracks[i]?.settings.name ?? `pad ${i + 1}`]),
      ]) as HTMLButtonElement;

      pad.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.selectTrack(i);
        this.engine.padHit(i, 1);
        pad.classList.add("flash");
      });
      const clearFlash = () => pad.classList.remove("flash");
      pad.addEventListener("pointerup", clearFlash);
      pad.addEventListener("pointerleave", clearFlash);
      pad.addEventListener("pointercancel", clearFlash);

      this.padEls.push(pad);
      grid.append(pad);
    }
    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Pads — tap to play, selects track"]),
      grid,
    ]);
  }

  // ---- Step sequencer -----------------------------------------------------

  private buildSequencer(): HTMLElement {
    const plockBtn = el("button", { class: "ctrl" }, ["P-LOCK"]) as HTMLButtonElement;
    plockBtn.addEventListener("click", () => {
      this.plockMode = !this.plockMode;
      plockBtn.classList.toggle("active", this.plockMode);
    });

    const grid = el("div", { class: "steps" });
    this.stepEls = [];
    for (let i = 0; i < this.engine.config.steps; i++) {
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
        el("h2", { class: "section-title" }, ["Sequence"]),
        plockBtn,
      ]),
      grid,
    ]);
  }

  private onStepTap(i: number) {
    const track = this.engine.tracks[this.selectedTrack];
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
    const track = this.engine.tracks[this.selectedTrack];
    this.stepPanel.innerHTML = "";
    if (!track) return;
    const step = track.steps[this.selectedStep];
    this.stepPanel.append(
      el("div", { class: "hint" }, [
        `Editing ${track.settings.name} · step ${this.selectedStep + 1}`,
      ]),
      el("div", { class: "row" }, [
        slider({
          label: "PITCH",
          min: -24,
          max: 24,
          step: 1,
          value: step.pitch,
          format: (v) => `${v > 0 ? "+" : ""}${v} st`,
          onInput: (v) => (step.pitch = v),
        }),
        slider({
          label: "CHANCE",
          min: 0,
          max: 1,
          step: 0.05,
          value: step.probability,
          format: (v) => `${Math.round(v * 100)}%`,
          onInput: (v) => (step.probability = v),
        }),
        slider({
          label: "VELOCITY",
          min: 0,
          max: 1,
          step: 0.05,
          value: step.velocity,
          format: (v) => `${Math.round(v * 100)}%`,
          onInput: (v) => (step.velocity = v),
        }),
      ]),
    );
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
    const track = this.engine.tracks[this.selectedTrack];
    this.trackPanel.innerHTML = "";
    if (!track) return;
    const s = track.settings;
    const apply = () => track.applySettings();
    this.trackPanel.append(
      el("div", { class: "hint" }, [s.name]),
      el("div", { class: "row" }, [
        slider({
          label: "VOLUME",
          min: 0,
          max: 1,
          step: 0.01,
          value: s.gain,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => {
            s.gain = v;
            apply();
          },
        }),
        slider({
          label: "PAN",
          min: -1,
          max: 1,
          step: 0.05,
          value: s.pan,
          format: (v) => v.toFixed(2),
          onInput: (v) => {
            s.pan = v;
            apply();
          },
        }),
        slider({
          label: "CUTOFF",
          min: 100,
          max: 18000,
          step: 10,
          value: s.cutoff,
          format: (v) => `${Math.round(v)}Hz`,
          onInput: (v) => {
            s.cutoff = v;
            apply();
          },
        }),
        slider({
          label: "RESO",
          min: 0.1,
          max: 20,
          step: 0.1,
          value: s.resonance,
          format: (v) => v.toFixed(1),
          onInput: (v) => {
            s.resonance = v;
            apply();
          },
        }),
        slider({
          label: "PITCH",
          min: 0.25,
          max: 2,
          step: 0.01,
          value: s.playbackRate,
          format: (v) => `${v.toFixed(2)}x`,
          onInput: (v) => {
            s.playbackRate = v;
            apply();
          },
        }),
        slider({
          label: "DELAY",
          min: 0,
          max: 1,
          step: 0.01,
          value: s.delaySend,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => {
            s.delaySend = v;
            apply();
          },
        }),
        slider({
          label: "REVERB",
          min: 0,
          max: 1,
          step: 0.01,
          value: s.reverbSend,
          format: (v) => `${Math.round(v * 100)}`,
          onInput: (v) => {
            s.reverbSend = v;
            apply();
          },
        }),
      ]),
    );
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
    // Held buttons that momentarily slam the master chain, then restore.
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
      this.refreshPadLabels();
      this.refreshTrackPanel();
      alert(`Chopped into ${n} slices across the pads.`);
    });
    const chopBtn = el("button", { class: "ctrl" }, ["Chop file → pads"]);
    chopBtn.addEventListener("click", () => chopInput.click());

    const padInput = el("input", {
      type: "file",
      accept: "audio/*",
      style: "display:none",
    }) as HTMLInputElement;
    padInput.addEventListener("change", async () => {
      const file = padInput.files?.[0];
      if (!file) return;
      await this.engine.loadOntoPad(this.selectedTrack, file);
      this.refreshPadLabels();
      this.refreshTrackPanel();
    });
    const padBtn = el("button", { class: "ctrl" }, ["Load → selected pad"]);
    padBtn.addEventListener("click", () => padInput.click());

    return el("section", {}, [
      el("h2", { class: "section-title" }, ["Samples"]),
      this.buildRecorder(),
      el("div", { class: "row" }, [chopBtn, padBtn, chopInput, padInput]),
      el("p", { class: "hint" }, [
        "Record from your mic, or load a file. Chop uses transient detection to " +
          "auto-slice across all pads.",
      ]),
    ]);
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

    // Actions available once a take exists.
    const chopRecBtn = el("button", { class: "ctrl" }, [
      "Chop recording → pads",
    ]) as HTMLButtonElement;
    const padRecBtn = el("button", { class: "ctrl" }, [
      "Recording → selected pad",
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
        // Stop + decode.
        recBtn.disabled = true;
        status.textContent = "processing…";
        if (timer !== null) window.clearInterval(timer);
        try {
          const buf = await this.engine.stopRecording();
          status.textContent = `recorded ${buf.duration.toFixed(1)}s`;
          chopRecBtn.disabled = false;
          padRecBtn.disabled = false;
        } catch (err) {
          console.error(err);
          status.textContent = "recording failed";
        }
        recBtn.disabled = false;
        recBtn.textContent = "● Record";
        recBtn.classList.remove("active");
      } else {
        // Start.
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
      this.refreshPadLabels();
      this.refreshTrackPanel();
      status.textContent = `chopped into ${n} slices`;
    });

    padRecBtn.addEventListener("click", () => {
      if (!this.engine.lastRecording) return;
      this.engine.loadBufferOntoPad(this.selectedTrack, this.engine.lastRecording, "recording");
      this.refreshPadLabels();
      this.refreshTrackPanel();
      status.textContent = `loaded onto ${this.engine.tracks[this.selectedTrack]?.settings.name}`;
    });

    return el("div", { class: "panel" }, [
      el("div", { class: "row" }, [recBtn, status]),
      el("div", { class: "row" }, [chopRecBtn, padRecBtn]),
    ]);
  }

  // ---- Selection + refresh helpers ---------------------------------------

  private selectTrack(i: number) {
    this.selectedTrack = i;
    this.selectedStep = Math.min(this.selectedStep, this.engine.config.steps - 1);
    this.refreshSelection();
  }

  private refreshSelection() {
    this.padEls.forEach((p, i) => p.classList.toggle("selected", i === this.selectedTrack));
    this.refreshSteps();
    this.refreshStepPanel();
    this.refreshTrackPanel();
  }

  private refreshSteps() {
    const track = this.engine.tracks[this.selectedTrack];
    if (!track) return;
    this.stepEls.forEach((cell, i) => {
      cell.classList.toggle("on", track.steps[i].on);
      cell.classList.toggle("selected", this.plockMode && i === this.selectedStep);
    });
  }

  private refreshPadLabels() {
    this.padEls.forEach((pad, i) => {
      const span = pad.querySelector("span");
      if (span) span.textContent = this.engine.tracks[i]?.settings.name ?? `pad ${i + 1}`;
    });
  }

  private highlightPlayhead(step: number) {
    if (this.lastPlayhead >= 0 && this.stepEls[this.lastPlayhead]) {
      this.stepEls[this.lastPlayhead].classList.remove("playing");
    }
    if (step >= 0 && this.stepEls[step]) {
      this.stepEls[step].classList.add("playing");
    }
    this.lastPlayhead = step;
  }
}
