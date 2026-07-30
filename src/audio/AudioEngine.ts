import { MasterChain } from "./MasterChain.ts";
import { Scheduler } from "./Scheduler.ts";
import { Track } from "./Track.ts";
import { generateDrumKit, drumName } from "./synthDrums.ts";
import { decodeAudio, sliceByTransients } from "./sampleUtils.ts";
import { audioBufferToWav } from "./wavEncode.ts";
import { Recorder } from "./Recorder.ts";
import { SampleLibrary, type SampleEntry } from "./SampleLibrary.ts";

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
    { name: "DRUMS 1", pads: 16, kind: "synth" },
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
  readonly library = new SampleLibrary();

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

    await this.library.init();

    for (const bankCfg of this.config.banks) {
      this.banks.push(this.buildBank(bankCfg));
    }

    this.started = true;
  }

  /** Construct a bank of pads/tracks from a config (used at init + when adding). */
  private buildBank(bankCfg: BankConfig): Bank {
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
    return bank;
  }

  /** Add a fresh drum machine (synth bank). Returns its bank index. */
  addDrumBank(pads = 16): number {
    if (!this.started) return -1;
    const count = this.banks.filter((b) => b.kind === "synth").length + 1;
    this.banks.push(this.buildBank({ name: `DRUMS ${count}`, pads, kind: "synth" }));
    return this.banks.length - 1;
  }

  /** Add a fresh sample bank. Returns its bank index. */
  addSampleBank(pads = 16): number {
    if (!this.started) return -1;
    const count = this.banks.filter((b) => b.kind === "sample").length + 1;
    this.banks.push(this.buildBank({ name: `SAMPLES ${count}`, pads, kind: "sample" }));
    return this.banks.length - 1;
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

  private handleStep(absStep: number, time: number) {
    for (const track of this.allTracks) {
      const len = track.length;
      const local = ((absStep % len) + len) % len;
      const s = track.steps[local];
      if (!s || !s.on) continue;
      if (s.probability < 1 && Math.random() > s.probability) continue;
      track.trigger(time, s.pitch, s.velocity);
    }
    // Schedule the UI highlight to line up with the audio.
    const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
    window.setTimeout(() => this.onVisualStep(absStep), delayMs);
  }

  // ---- Sample loading (always targets the SAMPLES bank) -------------------

  /** Decode a user file and slice it across the sample pads by transients. */
  async loadAndSlice(file: File): Promise<number> {
    const raw = await file.arrayBuffer();
    const buffer = await decodeAudio(this.ctx, raw);
    await this.library.add(file.name, raw);
    return this.sliceBufferAcrossPads(buffer);
  }

  /** Load a single file onto one sample pad (whole sample, no slicing). */
  async loadOntoPad(padIndex: number, file: File): Promise<void> {
    const raw = await file.arrayBuffer();
    const buffer = await decodeAudio(this.ctx, raw);
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 12);
    await this.library.add(file.name, raw);
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
    await this.recorder.start(this.ctx);
  }

  /** Stop capturing, store in library, and return the AudioBuffer. */
  async stopRecording(): Promise<AudioBuffer> {
    const buffer = this.recorder.stop();
    this.lastRecording = buffer;

    // Store as WAV in the library for persistence.
    const wav = audioBufferToWav(buffer);
    await this.library.add("recording", wav);
    return buffer;
  }

  /** Load a sample from the library onto a pad in the samples bank. */
  async loadLibraryEntry(entry: SampleEntry, padIndex: number): Promise<void> {
    const buffer = await decodeAudio(this.ctx, entry.data);
    this.loadBufferOntoPad(padIndex, buffer, entry.name.replace(/\.[^.]+$/, "").slice(0, 12));
  }

  /** Decode a library entry into an AudioBuffer (for the editor, without assigning to a pad). */
  async loadLibraryEntryToBuffer(entry: SampleEntry): Promise<AudioBuffer> {
    return decodeAudio(this.ctx, entry.data);
  }

  /** List everything in the library (newest first). */
  listLibrary(): Promise<SampleEntry[]> {
    return this.library.list();
  }

  // ---- Export / project save-load -----------------------------------------

  /**
   * Offline-render the current sequence as a WAV file. Plays for `bars`
   * repetitions of the longest track length. Returns a Blob you can download.
   */
  async exportWav(bars = 4): Promise<Blob> {
    // Find longest loop across all tracks to know one "cycle".
    const maxLen = Math.max(...this.allTracks.map((t) => t.length));
    const totalSteps = maxLen * bars;
    const stepDur = 60 / this.scheduler.bpm / 4;
    const totalSeconds = totalSteps * stepDur + 2; // extra tail for reverb

    const offline = new OfflineAudioContext(2, Math.ceil(totalSeconds * this.ctx.sampleRate), this.ctx.sampleRate);

    // Build a temporary master chain in the offline context.
    const offMaster = new MasterChain(offline as unknown as AudioContext, null);

    // Build temporary tracks mirroring the current state.
    for (const bank of this.banks) {
      for (const srcTrack of bank.tracks) {
        if (!srcTrack.buffer) continue;
        const t = new Track(offline as unknown as AudioContext, offMaster, srcTrack.length, srcTrack.settings);
        t.setBuffer(srcTrack.buffer, srcTrack.region);
        t.steps = srcTrack.steps;
        t.setLength(srcTrack.length);
        // Schedule every step.
        for (let step = 0; step < totalSteps; step++) {
          const local = step % t.length;
          const s = t.steps[local];
          if (!s || !s.on) continue;
          if (s.probability < 1 && Math.random() > s.probability) continue;
          const when = step * stepDur + 0.01;
          t.trigger(when, s.pitch, s.velocity);
        }
      }
    }

    const rendered = await offline.startRendering();
    const wav = audioBufferToWav(rendered);
    return new Blob([wav], { type: "audio/wav" });
  }

  /**
   * Serialize the current project (patterns + track settings + sample data)
   * to a JSON blob that can be saved and re-opened.
   */
  async exportProject(): Promise<Blob> {
    const project: Record<string, unknown> = {
      version: 1,
      bpm: this.bpm,
      swing: this.swing,
      banks: this.banks.map((bank) => ({
        name: bank.name,
        kind: bank.kind,
        tracks: bank.tracks.map((t) => ({
          settings: t.settings,
          steps: t.steps.slice(0, t.length),
          length: t.length,
          // Encode sample data as base64 WAV if present.
          sampleData: t.buffer ? arrayBufferToBase64(audioBufferToWav(t.buffer)) : null,
          region: t.region,
        })),
      })),
    };
    const json = JSON.stringify(project);
    return new Blob([json], { type: "application/json" });
  }

  /** Load a project file exported by exportProject. */
  async importProject(file: File): Promise<void> {
    const text = await file.text();
    const project = JSON.parse(text);
    if (project.version !== 1) throw new Error("Unsupported project version");

    this.bpm = project.bpm ?? 120;
    this.swing = project.swing ?? 0;

    // Clear existing banks and rebuild from the project data.
    this.banks.length = 0;
    for (const bankData of project.banks) {
      const bank: Bank = { name: bankData.name, kind: bankData.kind, tracks: [] };
      for (const td of bankData.tracks) {
        const track = new Track(this.ctx, this.master, td.length, td.settings);
        track.steps = td.steps;
        track.setLength(td.length);
        if (td.sampleData) {
          const wav = base64ToArrayBuffer(td.sampleData);
          const buffer = await decodeAudio(this.ctx, wav);
          track.setBuffer(buffer, td.region ?? null);
        }
        bank.tracks.push(track);
      }
      this.banks.push(bank);
    }
  }
}

// ---- Helpers ----------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
