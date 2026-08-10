import type { AudioEngine, NoteHandle } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";
import type { PlayingLayout } from "../audio/types.ts";
import {
  CHORDS,
  SCALES,
  buildDiatonicChord,
  chordName,
  degreeLabel,
  getChord,
  getScale,
  midiForPitchClass,
  noteName,
  pitchClassName,
  scalePadNotes,
  voiceChord,
} from "../audio/musicTheory.ts";
import { el } from "./dom.ts";

interface ActiveGesture {
  handles: NoteHandle[];
  button: HTMLButtonElement;
}

interface PickerOption {
  value: string;
  label: string;
}

interface PickerGroup {
  label?: string;
  options: PickerOption[];
}

/** Mobile performance surface for the currently selected sample pad. */
export class MelodicPerformance {
  readonly element: HTMLElement;

  private readonly engine: AudioEngine;
  private readonly onStateChange: () => void;
  private readonly panel: HTMLElement;
  private bankIndex = -1;
  private padIndex = -1;
  private targetTrack: Track | null = null;
  private advancedOpen = false;
  private picker: HTMLElement | null = null;
  private chordReadout = "Play a chord";
  private active = new Map<number, ActiveGesture>();

  constructor(engine: AudioEngine, onStateChange: () => void) {
    this.engine = engine;
    this.onStateChange = onStateChange;
    this.panel = el("div", { class: "panel melodic-panel" });
    this.element = el("section", { class: "melodic-section" }, [
      el("h2", { class: "section-title" }, ["Melodic sample performer"]),
      this.panel,
    ]);

    window.addEventListener("pointerup", (event) => this.releasePointer(event.pointerId));
    window.addEventListener("pointercancel", (event) => this.releasePointer(event.pointerId));
    window.addEventListener("blur", () => this.panic());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.panic();
    });
  }

  setTarget(bankIndex: number, padIndex: number) {
    const bank = this.engine.banks[bankIndex];
    const nextTrack = bank?.tracks[padIndex] ?? null;
    if (nextTrack !== this.targetTrack) this.panic();
    this.bankIndex = bankIndex;
    this.padIndex = padIndex;
    this.targetTrack = nextTrack;
    this.element.hidden = bank?.kind !== "sample";
    if (!this.element.hidden) this.render();
  }

  panic() {
    for (const pointerId of [...this.active.keys()]) this.releasePointer(pointerId);
    if (this.targetTrack) this.targetTrack.allNotesOff(this.engine.ctx.currentTime, true);
  }

  private render() {
    const track = this.targetTrack;
    if (!track) return;
    const settings = track.settings;
    this.panel.innerHTML = "";

    const tabs = el("div", { class: "layout-tabs", role: "tablist" });
    (["keys", "scale", "chords"] as PlayingLayout[]).forEach((layout) => {
      const button = el("button", {
        class: `ctrl${settings.playLayout === layout ? " active" : ""}`,
        role: "tab",
        "aria-selected": String(settings.playLayout === layout),
      }, [layout.toUpperCase()]) as HTMLButtonElement;
      button.addEventListener("click", () => {
        if (settings.playLayout === layout) return;
        this.panic();
        settings.playLayout = layout;
        this.render();
        this.onStateChange();
      });
      tabs.append(button);
    });

    this.panel.append(tabs, this.buildToolbar());
    if (this.advancedOpen) this.panel.append(this.buildAdvanced());

    const surface = el("div", { class: "instrument-surface" });
    if (settings.playLayout === "keys") this.buildKeys(surface);
    else if (settings.playLayout === "scale") this.buildScale(surface);
    else this.buildChords(surface);
    if (!track.buffer) {
      surface.classList.add("disabled");
      surface.prepend(el("p", { class: "hint melodic-empty" }, [
        "Load or assign a sample to this pad before playing it melodically.",
      ]));
    }
    this.panel.append(surface);
  }

  private buildToolbar(): HTMLElement {
    const settings = this.targetTrack!.settings;
    const root = el("button", { class: "ctrl melodic-choice" }, [
      el("small", {}, ["ROOT"]),
      el("strong", {}, [pitchClassName(settings.scaleRoot)]),
    ]) as HTMLButtonElement;
    root.addEventListener("click", () => this.openRootPicker());

    const scale = getScale(settings.scaleId);
    const scaleButton = el("button", { class: "ctrl melodic-choice scale-choice" }, [
      el("small", {}, ["SCALE"]),
      el("strong", {}, [scale.name]),
    ]) as HTMLButtonElement;
    scaleButton.addEventListener("click", () => this.openScalePicker());

    const down = el("button", {
      class: "ctrl octave-button",
      "aria-label": "Octave down",
    }, ["−"]) as HTMLButtonElement;
    const up = el("button", {
      class: "ctrl octave-button",
      "aria-label": "Octave up",
    }, ["+"]) as HTMLButtonElement;
    down.disabled = settings.performanceOctave <= 1;
    up.disabled = settings.performanceOctave >= 6;
    down.addEventListener("click", () => this.changeOctave(-1));
    up.addEventListener("click", () => this.changeOctave(1));
    const octave = el("div", { class: "octave-readout", "aria-label": `Octave ${settings.performanceOctave}` }, [
      el("small", {}, ["OCT"]),
      el("strong", {}, [String(settings.performanceOctave)]),
    ]);

    const advanced = el("button", {
      class: `ctrl settings-button${this.advancedOpen ? " active" : ""}`,
      "aria-label": "Performance settings",
      "aria-expanded": String(this.advancedOpen),
    }, ["⚙"]) as HTMLButtonElement;
    advanced.addEventListener("click", () => {
      this.advancedOpen = !this.advancedOpen;
      this.render();
    });

    return el("div", { class: "melodic-toolbar" }, [
      root,
      scaleButton,
      el("div", { class: "octave-control" }, [down, octave, up]),
      advanced,
    ]);
  }

  private buildAdvanced(): HTMLElement {
    const settings = this.targetTrack!.settings;
    const rootValue = el("span", { class: "val" }, [noteName(settings.sampleRootMidi)]);
    const rootInput = el("input", {
      type: "range", min: "0", max: "127", step: "1",
      value: String(settings.sampleRootMidi),
      "aria-label": "Sample root MIDI note",
    }) as HTMLInputElement;
    rootInput.addEventListener("input", () => {
      settings.sampleRootMidi = Number(rootInput.value);
      rootValue.textContent = noteName(settings.sampleRootMidi);
    });
    rootInput.addEventListener("change", (event) => {
      event.stopPropagation();
      this.render();
      this.onStateChange();
    });

    const polyValue = el("span", { class: "val" }, [String(settings.polyphony)]);
    const polyInput = el("input", {
      type: "range", min: "1", max: "16", step: "1",
      value: String(settings.polyphony),
      "aria-label": "Maximum polyphony",
    }) as HTMLInputElement;
    polyInput.addEventListener("input", () => {
      settings.polyphony = Number(polyInput.value);
      polyValue.textContent = polyInput.value;
    });
    polyInput.addEventListener("change", (event) => {
      event.stopPropagation();
      this.onStateChange();
    });

    const advanced = el("div", { class: "melodic-advanced" }, [
      el("label", { class: "field wide" }, [
        el("span", {}, ["SAMPLE ROOT"]), rootInput, rootValue,
      ]),
      el("label", { class: "field wide" }, [
        el("span", {}, ["POLYPHONY"]), polyInput, polyValue,
      ]),
    ]);

    if (settings.playLayout === "chords") {
      const inversionValue = el("span", { class: "val" }, [String(settings.chordInversion)]);
      const inversion = el("input", {
        type: "range", min: "0", max: "4", step: "1",
        value: String(settings.chordInversion),
      }) as HTMLInputElement;
      inversion.addEventListener("input", () => {
        settings.chordInversion = Number(inversion.value);
        inversionValue.textContent = inversion.value;
      });
      inversion.addEventListener("change", (event) => {
        event.stopPropagation();
        this.render();
        this.onStateChange();
      });

      const strumValue = el("span", { class: "val" }, [`${settings.chordStrumMs}ms`]);
      const strum = el("input", {
        type: "range", min: "0", max: "200", step: "5",
        value: String(settings.chordStrumMs),
      }) as HTMLInputElement;
      strum.addEventListener("input", () => {
        settings.chordStrumMs = Number(strum.value);
        strumValue.textContent = `${strum.value}ms`;
      });
      strum.addEventListener("change", (event) => {
        event.stopPropagation();
        this.onStateChange();
      });

      const close = this.settingToggle("CLOSE", settings.chordVoicing === "close", () => {
        settings.chordVoicing = "close";
      });
      const open = this.settingToggle("OPEN", settings.chordVoicing === "open", () => {
        settings.chordVoicing = "open";
      });
      advanced.append(
        el("label", { class: "field wide" }, [el("span", {}, ["INVERSION"]), inversion, inversionValue]),
        el("div", { class: "field" }, [el("span", {}, ["VOICING"]), el("div", { class: "segmented" }, [close, open])]),
        el("label", { class: "field wide" }, [el("span", {}, ["STRUM"]), strum, strumValue]),
      );
    }
    return advanced;
  }

  private buildKeys(root: HTMLElement) {
    const settings = this.targetTrack!.settings;
    root.append(el("div", { class: "keys-info" }, [
      el("span", {}, [`Octave ${settings.performanceOctave}`]),
      el("span", {}, [`Sample root ${noteName(settings.sampleRootMidi)}`]),
    ]));

    const keyboard = el("div", { class: "piano-keys", role: "group", "aria-label": "Chromatic keyboard" });
    const whiteLayer = el("div", { class: "white-keys" });
    const whiteNotes = [0, 2, 4, 5, 7, 9, 11];
    for (const pitchClass of whiteNotes) {
      const midi = midiForPitchClass(pitchClass, settings.performanceOctave);
      whiteLayer.append(this.noteButton(midi, "piano-key white-key"));
    }
    keyboard.append(whiteLayer);

    const blackBoundaries = [1, 2, 4, 5, 6];
    const blackNotes = [1, 3, 6, 8, 10];
    blackNotes.forEach((pitchClass, index) => {
      const midi = midiForPitchClass(pitchClass, settings.performanceOctave);
      const button = this.noteButton(midi, "piano-key black-key");
      button.style.left = `${(blackBoundaries[index] / 7) * 100}%`;
      keyboard.append(button);
    });
    root.append(keyboard);
  }

  private buildScale(root: HTMLElement) {
    const settings = this.targetTrack!.settings;
    const scale = getScale(settings.scaleId);
    const grid = el("div", { class: "scale-grid", role: "group", "aria-label": `${scale.name} scale pads` });
    for (const item of scalePadNotes(settings.scaleRoot, scale, settings.performanceOctave, 16)) {
      const button = el("button", {
        class: `scale-pad${item.isRoot ? " root-note" : ""}`,
        "aria-label": `${noteName(item.midi)}, scale degree ${item.degree}`,
      }, [
        el("strong", {}, [noteName(item.midi)]),
        el("small", {}, [`DEG ${item.degree}`]),
      ]) as HTMLButtonElement;
      this.bindPlayable(button, [item.midi]);
      grid.append(button);
    }
    root.append(grid);
  }

  private buildChords(root: HTMLElement) {
    const settings = this.targetTrack!.settings;
    const modeRow = el("div", { class: "chord-mode-row" });
    const diatonic = this.settingToggle("DIATONIC", settings.chordSubmode === "diatonic", () => {
      this.panic();
      settings.chordSubmode = "diatonic";
    });
    const free = this.settingToggle("FREE", settings.chordSubmode === "free", () => {
      this.panic();
      settings.chordSubmode = "free";
    });
    modeRow.append(diatonic, free);

    const choice = el("button", { class: "ctrl chord-choice" }, [
      settings.chordSubmode === "diatonic"
        ? settings.chordExtension.toUpperCase()
        : getChord(settings.chordQuality).name,
    ]) as HTMLButtonElement;
    choice.addEventListener("click", () => {
      if (settings.chordSubmode === "diatonic") this.openExtensionPicker();
      else this.openChordPicker();
    });
    modeRow.append(choice);

    const readout = el("div", { class: "chord-readout", "aria-live": "polite" }, [this.chordReadout]);
    const grid = el("div", { class: "chord-grid", role: "group", "aria-label": "Chord pads" });
    if (settings.chordSubmode === "diatonic") this.buildDiatonicPads(grid, readout);
    else this.buildFreePads(grid, readout);
    root.append(modeRow, readout, grid);
  }

  private buildDiatonicPads(grid: HTMLElement, readout: HTMLElement) {
    const settings = this.targetTrack!.settings;
    const scale = getScale(settings.scaleId);
    for (let degree = 0; degree < scale.intervals.length; degree++) {
      const closeNotes = buildDiatonicChord(
        settings.scaleRoot, scale, settings.performanceOctave, degree, settings.chordExtension,
      );
      const rootMidi = closeNotes[0];
      const intervals = closeNotes.map((note) => note - rootMidi);
      const voiced = voiceChord(rootMidi, intervals, settings.chordInversion, settings.chordVoicing);
      const name = chordName(closeNotes);
      const button = el("button", {
        class: `chord-pad${degree === 0 ? " root-note" : ""}`,
        "aria-label": `${degreeLabel(degree)} ${name}`,
      }, [el("small", {}, [degreeLabel(degree)]), el("strong", {}, [name])]) as HTMLButtonElement;
      this.bindPlayable(button, voiced, () => this.showChord(readout, name, voiced), settings.chordStrumMs);
      grid.append(button);
    }
  }

  private buildFreePads(grid: HTMLElement, readout: HTMLElement) {
    const settings = this.targetTrack!.settings;
    const chord = getChord(settings.chordQuality);
    const tonic = midiForPitchClass(settings.scaleRoot, settings.performanceOctave);
    for (let offset = 0; offset < 12; offset++) {
      const rootMidi = tonic + offset;
      const voiced = voiceChord(rootMidi, chord.intervals, settings.chordInversion, settings.chordVoicing);
      const name = `${pitchClassName(rootMidi)}${chord.symbol}`;
      const button = el("button", {
        class: `chord-pad${offset === 0 ? " root-note" : ""}`,
        "aria-label": `${name} chord`,
      }, [el("strong", {}, [name]), el("small", {}, [chord.name])]) as HTMLButtonElement;
      this.bindPlayable(button, voiced, () => this.showChord(readout, name, voiced), settings.chordStrumMs);
      grid.append(button);
    }
  }

  private showChord(readout: HTMLElement, name: string, notes: readonly number[]) {
    this.chordReadout = `${name}: ${notes.map((note) => noteName(note)).join(" · ")}`;
    readout.textContent = this.chordReadout;
  }

  private noteButton(midi: number, className: string): HTMLButtonElement {
    const button = el("button", {
      class: className,
      "aria-label": noteName(midi),
    }, [el("span", {}, [noteName(midi)])]) as HTMLButtonElement;
    this.bindPlayable(button, [midi]);
    return button;
  }

  private bindPlayable(
    button: HTMLButtonElement,
    notes: readonly number[],
    onPress?: () => void,
    strumMs = 0,
  ) {
    button.disabled = !this.targetTrack?.buffer;
    button.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      this.releasePointer(event.pointerId);
      try { button.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
      const handles: NoteHandle[] = [];
      notes.forEach((midi, index) => {
        const handle = this.engine.noteOn(
          this.bankIndex,
          this.padIndex,
          midi,
          1,
          index * Math.max(0, strumMs) / 1000,
        );
        if (handle) handles.push(handle);
      });
      this.active.set(event.pointerId, { handles, button });
      button.classList.add("pressed");
      onPress?.();
    });
    const release = (event: PointerEvent) => this.releasePointer(event.pointerId);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    button.addEventListener("pointerleave", release);
  }

  private releasePointer(pointerId: number) {
    const gesture = this.active.get(pointerId);
    if (!gesture) return;
    this.active.delete(pointerId);
    gesture.handles.forEach((handle) => this.engine.noteOff(handle));
    gesture.button.classList.remove("pressed");
    try {
      if (gesture.button.hasPointerCapture(pointerId)) gesture.button.releasePointerCapture(pointerId);
    } catch { /* element may have been replaced */ }
  }

  private settingToggle(label: string, active: boolean, apply: () => void): HTMLButtonElement {
    const button = el("button", { class: `ctrl${active ? " active" : ""}` }, [label]) as HTMLButtonElement;
    button.addEventListener("click", () => {
      if (active) return;
      apply();
      this.render();
      this.onStateChange();
    });
    return button;
  }

  private changeOctave(delta: number) {
    const settings = this.targetTrack!.settings;
    settings.performanceOctave = Math.max(1, Math.min(5, settings.performanceOctave + delta));
    this.render();
    this.onStateChange();
  }

  private openRootPicker() {
    const settings = this.targetTrack!.settings;
    this.openPicker("Root note", [{
      options: Array.from({ length: 12 }, (_, pitchClass) => ({
        value: String(pitchClass), label: pitchClassName(pitchClass),
      })),
    }], String(settings.scaleRoot), (value) => {
      settings.scaleRoot = Number(value);
      this.render();
      this.onStateChange();
    });
  }

  private openScalePicker() {
    const settings = this.targetTrack!.settings;
    const categories = ["Common", "Modes", "Symmetric", "World"] as const;
    this.openPicker("Scale", categories.map((category) => ({
      label: category,
      options: SCALES.filter((scale) => scale.category === category)
        .map((scale) => ({ value: scale.id, label: scale.name })),
    })), settings.scaleId, (value) => {
      settings.scaleId = getScale(value).id as typeof settings.scaleId;
      this.render();
      this.onStateChange();
    });
  }

  private openExtensionPicker() {
    const settings = this.targetTrack!.settings;
    this.openPicker("Chord extension", [{ options: [
      { value: "triad", label: "Triad" },
      { value: "7th", label: "7th" },
      { value: "9th", label: "9th" },
    ] }], settings.chordExtension, (value) => {
      settings.chordExtension = value as typeof settings.chordExtension;
      this.render();
      this.onStateChange();
    });
  }

  private openChordPicker() {
    const settings = this.targetTrack!.settings;
    this.openPicker("Chord quality", [{
      options: CHORDS.map((chord) => ({ value: chord.id, label: chord.name })),
    }], settings.chordQuality, (value) => {
      settings.chordQuality = getChord(value).id as typeof settings.chordQuality;
      this.render();
      this.onStateChange();
    });
  }

  private openPicker(
    title: string,
    groups: PickerGroup[],
    selected: string,
    choose: (value: string) => void,
  ) {
    this.closePicker();
    const backdrop = el("div", { class: "picker-backdrop" });
    const sheet = el("div", {
      class: "picker-sheet",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": title,
    });
    const close = el("button", { class: "ctrl", "aria-label": "Close picker" }, ["✕"]) as HTMLButtonElement;
    close.addEventListener("click", () => this.closePicker());
    sheet.append(el("div", { class: "picker-head" }, [el("strong", {}, [title]), close]));

    const list = el("div", { class: "picker-list" });
    groups.forEach((group) => {
      if (group.label) list.append(el("h3", { class: "picker-group-title" }, [group.label]));
      const grid = el("div", { class: "picker-grid" });
      group.options.forEach((option) => {
        const button = el("button", {
          class: `ctrl picker-option${option.value === selected ? " active" : ""}`,
        }, [option.label]) as HTMLButtonElement;
        button.addEventListener("click", () => {
          this.closePicker();
          choose(option.value);
        });
        grid.append(button);
      });
      list.append(grid);
    });
    sheet.append(list);
    backdrop.append(sheet);
    backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === backdrop) this.closePicker();
    });
    document.body.append(backdrop);
    this.picker = backdrop;
    close.focus();
  }

  private closePicker() {
    this.picker?.remove();
    this.picker = null;
  }
}