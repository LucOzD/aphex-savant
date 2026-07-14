import { MasterChain } from "./MasterChain.ts";
import { Scheduler } from "./Scheduler.ts";
import { Track } from "./Track.ts";
import { generateDrumKit, drumName } from "./synthDrums.ts";
import { decodeAudio, sliceByTransients } from "./sampleUtils.ts";
import { Recorder } from "./Recorder.ts";

export type BankKind = "synth" | "sample";

export interface BankConfig {
  name: string;
  pads: number;
  kind: BankKind;
}

export interface EngineConfig {
  steps: number;
  banks: BankConfig[];
}

/** A group of pads/tracks shown together (e.g. DRUMS vs SAMPLES). */
export interface Bank {
  name: string;
  kind: BankKind;
  tracks: Track[];
}

const DEFAULT_CONFIG: EngineConfig = {
  steps: 16,
  banks: [
    { name: "DRUMS", pads: 16, kind: "synth" },
    { name: "SAMPLES", pads: 16, kind: "sample" },
  ],
};

/** Top-level audio engine: owns the context, master chain, banks, transport. */
export class AudioEngine {
  readonly ctx: AudioContext;
  master!: MasterChain;
  readonly banks: Bank[] = [];
  readonly scheduler: Scheduler;
  readonly config: EngineConfig;
  readonly recorder = new Recorder();

  /** The most recent mic recording, kept so it can be chopped or reassigned. */
  lastRecording: AudioBuffer | null = null;

  private started = false;

  /** UI hook: fired (on the main thread) when the playhead reaches a step. */
  onVisualStep: (step: number) => void = () => {};

  constructor(config: EngineConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.scheduler = new Scheduler(this.ctx);
    this.scheduler.totalSteps = config.steps;
    this.scheduler.onStep = (step, time) => this.handleStep(step, time);
  }

  /** Must be called from a user gesture (tap). Sets up worklet + voices. */
  async init(): Promise<void> {
    if (this.started) {
      await this.ctx.resume();
      return;
    }
    await this.ctx.resume();

    // Load the bitcrusher worklet; degrade gracefully if it fails.
    let crushNode: AudioWorkletNode | null = null;
    try {
      const url = new URL("worklets/bitcrusher.js", document.baseURI).href;
      await this.ctx.audioWorklet.addModule(url);
      crushNode = new AudioWorkletNode(this.ctx, "bitcrusher");
    } catch (err) {
      console.warn("Bitcrusher worklet unavailable, continuing without it.", err);
    }

    this.master = new MasterChain(this.ctx, crushNode);
    this.updateDelayTime();

    for (const bankCfg of this.config.banks) {
      const bank: Bank = { name: bankCfg.name, kind: bankCfg.kind, tracks: [] };
      const kit = bankCfg.kind === "synth" ? generateDrumKit(this.ctx, bankCfg.pads) : null;
      for (let i = 0; i < bankCfg.pads; i++) {
        const track = new Track(this.ctx, this.master, this.config.steps, {
          name: kit ? drumName(i) : "empty",
          // Synth hats choke each other by default; sample pads don't choke.
          chokeGroup: kit && i % 8 === 2 ? 1 : 0,
        });
        if (kit) track.setBuffer(kit[i]);
        bank.tracks.push(track);
      }
      this.banks.push(bank);
    }

    this.started = true;
  }

  get isReady(): boolean {
    return this.started;
  }

  /** Every track across all banks (for scheduling). */
  get allTracks(): Track[] {
    return this.banks.flatMap((b) => b.tracks);
  }

  /** Index of the first sample bank (where recordings/loads go). */
  get sampleBankIndex(): number {
    const idx = this.banks.findIndex((b) => b.kind === "sample");
    return idx >= 0 ? idx : this.banks.length - 1;
  }

  get steps(): number {
    return this.config.steps;
  }

  // ---- Transport ----------------------------------------------------------

  play() {
    if (!this.started) return;
    this.scheduler.start();
  }

  stop() {
    this.scheduler.stop();
    this.onVisualStep(-1);
  }

  get isPlaying(): boolean {
    return this.scheduler.isRunning;
  }

  set bpm(value: number) {
    this.scheduler.bpm = value;
    this.updateDelayTime();
  }
  get bpm(): number {
    return this.scheduler.bpm;
  }

  set swing(value: number) {
    this.scheduler.swing = value;
  }
  get swing(): number {
    return this.scheduler.swing;
  }

  /** Sync the delay bus to a dotted-eighth of the current tempo. */
  private updateDelayTime() {
    if (!this.master) return;
    const dottedEighth = (60 / this.scheduler.bpm) * 0.75;
    this.master.setDelayTime(dottedEighth);
  }

  // ---- Playback -----------------------------------------------------------

  /** Live-play a pad immediately (finger drumming). */
  padHit(bankIndex: number, padIndex: number, velocity = 1) {
    const track = this.banks[bankIndex]?.tracks[padIndex];
    if (!track) return;
    track.trigger(this.ctx.currentTime + 0.005, 0, velocity);
  }

  /** Live-play a pad chromatically at a MIDI note, relative to its root. */
  playNote(bankIndex: number, padIndex: number, midiNote: number, velocity = 1) {
    const track = this.banks[bankIndex]?.tracks[padIndex];
    if (!track) return;
    const semis = midiNote - track.settings.rootNote;
    track.trigger(this.ctx.currentTime + 0.005, semis, velocity);
  }

  private handleStep(step: number, time: number) {
    for (const track of this.allTracks) {
      const s = track.steps[step];
      if (!s || !s.on) continue;
      if (s.probability < 1 && Math.random() > s.probability) continue;
      track.trigger(time, s.pitch, s.velocity);
    }
    // Schedule the UI highlight to line up with the audio.
    const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
    window.setTimeout(() => this.onVisualStep(step), delayMs);
  }

  // ---- Sample loading (always targets the SAMPLES bank) -------------------

  /** Decode a user file and slice it across the sample pads by transients. */
  async loadAndSlice(file: File): Promise<number> {
    const buffer = await this.decodeFile(file);
    return this.sliceBufferAcrossPads(buffer);
  }

  /** Load a single file onto one sample pad (whole sample, no slicing). */
  async loadOntoPad(padIndex: number, file: File): Promise<void> {
    const buffer = await this.decodeFile(file);
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 12);
    this.loadBufferOntoPad(padIndex, buffer, name);
  }

  private async decodeFile(file: File): Promise<AudioBuffer> {
    return decodeAudio(this.ctx, await file.arrayBuffer());
  }

  /** Decode a file into an AudioBuffer without assigning it anywhere. */
  async decodeToBuffer(file: File): Promise<AudioBuffer> {
    return this.decodeFile(file);
  }

  /** Auto-slice a decoded buffer by transients and spread over the sample pads. */
  sliceBufferAcrossPads(buffer: AudioBuffer): number {
    const tracks = this.banks[this.sampleBankIndex].tracks;
    const slices = sliceByTransients(buffer, tracks.length);
    slices.forEach((region, i) => {
      if (tracks[i]) {
        tracks[i].setBuffer(buffer, region);
        tracks[i].settings.name = `slice ${i + 1}`;
      }
    });
    return slices.length;
  }

  /** Put a whole decoded buffer onto one sample pad. */
  loadBufferOntoPad(padIndex: number, buffer: AudioBuffer, name = "sample") {
    const track = this.banks[this.sampleBankIndex].tracks[padIndex];
    if (track) {
      track.setBuffer(buffer, null);
      track.settings.name = name;
    }
  }

  /** Assign a manually-selected [start,end] region of a buffer to a sample pad. */
  assignRegionToPad(
    padIndex: number,
    buffer: AudioBuffer,
    start: number,
    end: number,
    name = "slice",
  ) {
    const track = this.banks[this.sampleBankIndex].tracks[padIndex];
    if (track) {
      track.setBuffer(buffer, [start, end]);
      track.settings.name = name;
    }
  }

  // ---- Region preview (for the sample editor) -----------------------------

  private previewSource: AudioBufferSourceNode | null = null;

  /** Audition a region of a buffer through the master chain. */
  previewRegion(buffer: AudioBuffer, start: number, end: number) {
    this.stopPreview();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.master.input);
    const duration = Math.max(0.02, end - start);
    src.start(this.ctx.currentTime + 0.005, start, duration);
    this.previewSource = src;
    src.onended = () => {
      if (this.previewSource === src) this.previewSource = null;
    };
  }

  stopPreview() {
    if (this.previewSource) {
      try {
        this.previewSource.stop();
      } catch {
        /* already stopped */
      }
      this.previewSource = null;
    }
  }

  // ---- Mic recording ------------------------------------------------------

  get isRecording(): boolean {
    return this.recorder.recording;
  }

  /** Begin capturing from the microphone. Throws if permission is denied. */
  async startRecording(): Promise<void> {
    await this.ctx.resume();
    await this.recorder.start();
  }

  /** Stop capturing, decode the take, store it, and return the AudioBuffer. */
  async stopRecording(): Promise<AudioBuffer> {
    const blob = await this.recorder.stop();
    const buffer = await decodeAudio(this.ctx, await blob.arrayBuffer());
    this.lastRecording = buffer;
    return buffer;
  }
}
