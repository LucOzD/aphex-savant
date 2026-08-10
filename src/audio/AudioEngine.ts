import { FxChain, defaultFxSettings, type FxSettings } from "./FxChain.ts";
import { Scheduler } from "./Scheduler.ts";
import { Track, type VoiceId } from "./Track.ts";
import { generateDrumKit, drumName } from "./synthDrums.ts";
import { decodeAudio, sliceByTransients } from "./sampleUtils.ts";
import { audioBufferToWav } from "./wavEncode.ts";
import { Recorder } from "./Recorder.ts";
import { SampleLibrary, type SampleEntry } from "./SampleLibrary.ts";
import type { Step, TrackSettings } from "./types.ts";

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

export interface NoteHandle {
  /** Stable track reference keeps releases safe if bank indexes later move. */
  track: Track;
  voiceId: VoiceId;
}

/** A point-in-time copy of all editable state, for undo/redo. */
export interface EngineSnapshot {
  bpm: number;
  swing: number;
  banks: {
    name: string;
    kind: BankKind;
    muted: boolean;
    fx: FxSettings;
    tracks: {
      settings: TrackSettings;
      steps: Step[];
      length: number;
      /** Shared by reference — snapshots never copy audio data. */
      buffer: AudioBuffer | null;
      region: [number, number] | null;
    }[];
  }[];
}

/** A group of pads/tracks shown together (e.g. DRUMS vs SAMPLES). */
export interface Bank {
  name: string;
  kind: BankKind;
  tracks: Track[];
  muted: boolean;
  /** This bank's own FX chain, so FX only affect this scene. */
  chain: FxChain;
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
  /** Shared bus all bank chains sum into, before the one global limiter. */
  private outputBus!: GainNode;
  readonly banks: Bank[] = [];
  readonly scheduler: Scheduler;
  readonly config: EngineConfig;
  readonly recorder = new Recorder();
  readonly library = new SampleLibrary();

  /** The most recent mic recording, kept so it can be chopped or reassigned. */
  lastRecording: AudioBuffer | null = null;

  private started = false;
  private crushReady = false;
  private creativeReady = false;

  /** UI hook: fired when the playhead reaches a step (driven by the UI's rAF loop). */
  onVisualStep: (step: number) => void = () => {};

  /**
   * Steps that have been scheduled but not yet reached by the audio clock.
   * The UI drains this in a requestAnimationFrame loop so the on-screen
   * playhead lines up with what you actually hear. Using the audio clock here
   * (rather than setTimeout) is what keeps the highlight from drifting.
   */
  private visualQueue: { step: number; time: number }[] = [];

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

    // Load worklets once; every bank creates only the nodes it actually uses.
    try {
      const url = new URL("worklets/bitcrusher.js", document.baseURI).href;
      await this.ctx.audioWorklet.addModule(url);
      this.crushReady = true;
    } catch (err) {
      console.warn("Bitcrusher worklet unavailable, continuing without it.", err);
    }
    try {
      const url = new URL("worklets/creative-fx.js", document.baseURI).href;
      await this.ctx.audioWorklet.addModule(url);
      this.creativeReady = true;
    } catch (err) {
      console.warn("Creative FX worklet unavailable, using native fallbacks.", err);
    }

    // All bank chains sum here, then through a single global limiter so the
    // combined mix can't clip on phone speakers.
    this.outputBus = this.ctx.createGain();
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    this.outputBus.connect(limiter);
    limiter.connect(this.ctx.destination);

    await this.library.init();

    for (const bankCfg of this.config.banks) {
      this.banks.push(this.buildBank(bankCfg));
    }

    this.started = true;
  }

  /** Create a bitcrusher node for a chain, if the worklet loaded. */
  private makeCrushNode(): AudioWorkletNode | null {
    if (!this.crushReady) return null;
    try {
      return new AudioWorkletNode(this.ctx, "bitcrusher");
    } catch {
      return null;
    }
  }

  /** Create a creative processor lazily when a rack slot needs one. */
  private makeCreativeNode(): AudioWorkletNode | null {
    if (!this.creativeReady) return null;
    try {
      return new AudioWorkletNode(this.ctx, "creative-fx");
    } catch {
      return null;
    }
  }

  private makeLiveChain(): FxChain {
    return new FxChain(
      this.ctx,
      this.makeCrushNode(),
      this.outputBus,
      () => this.makeCreativeNode(),
    );
  }

  /** Construct a bank of pads/tracks from a config (used at init + when adding). */
  private buildBank(bankCfg: BankConfig): Bank {
    const chain = this.makeLiveChain();
    chain.setTempo(this.scheduler.bpm);
    chain.setDelayTime((60 / this.scheduler.bpm) * 0.75);
    const bank: Bank = {
      name: bankCfg.name,
      kind: bankCfg.kind,
      tracks: [],
      muted: false,
      chain,
    };
    const kit = bankCfg.kind === "synth" ? generateDrumKit(this.ctx, bankCfg.pads) : null;
    for (let i = 0; i < bankCfg.pads; i++) {
      const track = new Track(this.ctx, chain, this.config.steps, {
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

  /** Delete a bank by index. Returns true if deleted. Won't delete the last bank. */
  deleteBank(index: number): boolean {
    if (this.banks.length <= 1) return false;
    if (index < 0 || index >= this.banks.length) return false;
    const [removed] = this.banks.splice(index, 1);
    removed.tracks.forEach((track) => track.dispose());
    return true;
  }

  get isReady(): boolean {
    return this.started;
  }

  /** Every track across all banks (for scheduling). */
  get allTracks(): Track[] {
    return this.banks.flatMap((b) => b.tracks);
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
    this.visualQueue.length = 0;
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

  /** Sync every bank's send delay and tempo-aware inserts. */
  private updateDelayTime() {
    const bpm = this.scheduler.bpm;
    const dottedEighth = (60 / bpm) * 0.75;
    for (const bank of this.banks) {
      bank.chain.setTempo(bpm);
      bank.chain.setDelayTime(dottedEighth);
    }
  }

  /** The FX chain for a given bank (scene). */
  chainFor(bankIndex: number): FxChain | undefined {
    return this.banks[bankIndex]?.chain;
  }

  // ---- Playback -----------------------------------------------------------

  /** Live-play a pad immediately (finger drumming). */
  padHit(bankIndex: number, padIndex: number, velocity = 1) {
    const track = this.banks[bankIndex]?.tracks[padIndex];
    if (!track) return;
    // Schedule at the current audio time for the lowest possible latency.
    track.trigger(this.ctx.currentTime, 0, velocity);
  }

  /** Start an ordinary MIDI note on a selected sample track. */
  noteOn(
    bankIndex: number,
    padIndex: number,
    midi: number,
    velocity = 1,
    delaySeconds = 0,
  ): NoteHandle | null {
    const bank = this.banks[bankIndex];
    const track = bank?.tracks[padIndex];
    if (!track || bank.muted) return null;
    const voiceId = track.noteOnMidi(
      this.ctx.currentTime + Math.max(0, delaySeconds),
      Math.max(0, Math.min(127, Math.round(midi))),
      velocity,
    );
    return voiceId === null ? null : { track, voiceId };
  }

  noteOff(handle: NoteHandle, when = this.ctx.currentTime) {
    handle.track.noteOff(handle.voiceId, when);
  }

  allNotesOff(bankIndex?: number, padIndex?: number) {
    const banks = bankIndex === undefined ? this.banks : this.banks.slice(bankIndex, bankIndex + 1);
    for (const bank of banks) {
      const tracks = padIndex === undefined ? bank.tracks : bank.tracks.slice(padIndex, padIndex + 1);
      tracks.forEach((track) => track.allNotesOff(this.ctx.currentTime, true));
    }
  }

  private handleStep(absStep: number, time: number) {
    for (const bank of this.banks) {
      if (bank.muted) continue;
      for (const track of bank.tracks) {
        const len = track.length;
        const local = ((absStep % len) + len) % len;
        const s = track.steps[local];
        if (!s || !s.on) continue;
        if (s.probability < 1 && Math.random() > s.probability) continue;
        track.trigger(time, s.pitch, s.velocity);
      }
    }
    // Queue the highlight; the UI drains it against the audio clock.
    this.visualQueue.push({ step: absStep, time });
  }

  /**
   * Return the step the audio clock has actually reached, or null if it hasn't
   * advanced since the last call. Called from the UI's animation loop.
   */
  drainVisualStep(): number | null {
    const now = this.ctx.currentTime;
    let latest: number | null = null;
    while (this.visualQueue.length > 0 && this.visualQueue[0].time <= now) {
      latest = this.visualQueue.shift()!.step;
    }
    return latest;
  }

  // ---- Sample loading (always targets the SAMPLES bank) -------------------

  /** Decode a user file and slice it across the given bank's pads. */
  async loadAndSlice(file: File, bankIndex: number): Promise<number> {
    const raw = await file.arrayBuffer();
    const buffer = await decodeAudio(this.ctx, raw);
    await this.library.add(file.name, raw);
    return this.sliceBufferAcrossPads(buffer, bankIndex);
  }

  /** Load a single file onto one pad (whole sample, no slicing). */
  async loadOntoPad(bankIndex: number, padIndex: number, file: File): Promise<void> {
    const raw = await file.arrayBuffer();
    const buffer = await decodeAudio(this.ctx, raw);
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 12);
    await this.library.add(file.name, raw);
    this.loadBufferOntoPad(bankIndex, padIndex, buffer, name);
  }

  private async decodeFile(file: File): Promise<AudioBuffer> {
    return decodeAudio(this.ctx, await file.arrayBuffer());
  }

  /** Decode a file into an AudioBuffer without assigning it anywhere. */
  async decodeToBuffer(file: File): Promise<AudioBuffer> {
    return this.decodeFile(file);
  }

  /** Auto-slice a decoded buffer by transients across one bank's pads. */
  sliceBufferAcrossPads(buffer: AudioBuffer, bankIndex: number): number {
    const tracks = this.banks[bankIndex]?.tracks;
    if (!tracks) return 0;
    const slices = sliceByTransients(buffer, tracks.length);
    slices.forEach((region, i) => {
      if (tracks[i]) {
        tracks[i].setBuffer(buffer, region);
        tracks[i].settings.name = `slice ${i + 1}`;
      }
    });
    return slices.length;
  }

  /** Put a whole decoded buffer onto one pad. */
  loadBufferOntoPad(bankIndex: number, padIndex: number, buffer: AudioBuffer, name = "sample") {
    const track = this.banks[bankIndex]?.tracks[padIndex];
    if (track) {
      track.setBuffer(buffer, null);
      track.settings.name = name;
    }
  }

  /** Assign a manually-selected [start,end] region of a buffer to a pad. */
  assignRegionToPad(
    bankIndex: number,
    padIndex: number,
    buffer: AudioBuffer,
    start: number,
    end: number,
    name = "slice",
  ) {
    const track = this.banks[bankIndex]?.tracks[padIndex];
    if (track) {
      track.setBuffer(buffer, [start, end]);
      track.settings.name = name;
    }
  }

  // ---- Region preview (for the sample editor) -----------------------------

  private previewSource: AudioBufferSourceNode | null = null;

  /** Audition a region of a buffer, dry, straight to the output bus. */
  previewRegion(buffer: AudioBuffer, start: number, end: number) {
    this.stopPreview();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outputBus);
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

    // Mirror the live graph: shared output bus + global limiter.
    const offBus = offline.createGain();
    const offLimiter = offline.createDynamicsCompressor();
    offLimiter.threshold.value = -3;
    offLimiter.knee.value = 3;
    offLimiter.ratio.value = 20;
    offLimiter.attack.value = 0.002;
    offLimiter.release.value = 0.15;
    offBus.connect(offLimiter);
    offLimiter.connect(offline.destination);

    // One FX chain per bank, matching that bank's settings. The bitcrusher is
    // a worklet we don't load offline, so crush is omitted from the bounce.
    for (const bank of this.banks) {
      if (bank.muted) continue;
      const offChain = new FxChain(offline, null, offBus);
      offChain.settings = {
        slots: bank.chain.settings.slots.map((slot) => ({ ...slot })),
      };
      offChain.applySettings();
      offChain.setTempo(this.scheduler.bpm);
      offChain.setDelayTime((60 / this.scheduler.bpm) * 0.75);

      for (const srcTrack of bank.tracks) {
        if (!srcTrack.buffer) continue;
        const t = new Track(offline, offChain, srcTrack.length, srcTrack.settings);
        t.setBuffer(srcTrack.buffer, srcTrack.region);
        t.steps = srcTrack.steps;
        t.setLength(srcTrack.length);
        for (let step = 0; step < totalSteps; step++) {
          const local = step % t.length;
          const s = t.steps[local];
          if (!s || !s.on) continue;
          if (s.probability < 1 && Math.random() > s.probability) continue;
          t.trigger(step * stepDur + 0.01, s.pitch, s.velocity);
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
        muted: bank.muted,
        fx: bank.chain.settings,
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
    for (const bank of this.banks) bank.tracks.forEach((track) => track.dispose());
    this.banks.length = 0;
    for (const bankData of project.banks) {
      const chain = this.makeLiveChain();
      const importedSlots = Array.isArray(bankData.fx?.slots) ? bankData.fx.slots : [];
      chain.settings = {
        // Projects from the old fixed panel had no slots; they open with an
        // empty rack instead of leaking obsolete flat settings into the graph.
        slots: defaultFxSettings().slots.map((fallback, index) => ({
          ...fallback,
          ...(importedSlots[index] ?? {}),
        })),
      };
      chain.applySettings();
      const bank: Bank = {
        name: bankData.name,
        kind: bankData.kind,
        tracks: [],
        muted: bankData.muted ?? false,
        chain,
      };
      for (const td of bankData.tracks) {
        const track = new Track(this.ctx, chain, td.length, td.settings);
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
    this.updateDelayTime();
  }

  // ---- Undo / redo snapshots ----------------------------------------------

  /**
   * Capture the full editable state. AudioBuffers are shared by reference (not
   * copied), so snapshots stay cheap even with lots of samples loaded.
   */
  snapshot(): EngineSnapshot {
    return {
      bpm: this.bpm,
      swing: this.swing,
      banks: this.banks.map((bank) => ({
        name: bank.name,
        kind: bank.kind,
        muted: bank.muted,
        fx: {
          slots: bank.chain.settings.slots.map((slot) => ({ ...slot })),
        },
        tracks: bank.tracks.map((t) => ({
          settings: { ...t.settings },
          steps: t.steps.map((s) => ({ ...s })),
          length: t.length,
          buffer: t.buffer,
          region: t.region ? ([...t.region] as [number, number]) : null,
        })),
      })),
    };
  }

  /** Rebuild engine state from a snapshot (used by undo/redo). */
  restore(snap: EngineSnapshot) {
    this.bpm = snap.bpm;
    this.swing = snap.swing;

    // Tear down existing voices/chains so undo never leaves hanging notes.
    for (const bank of this.banks) {
      bank.tracks.forEach((track) => track.dispose());
      try {
        bank.chain.input.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.banks.length = 0;

    for (const bs of snap.banks) {
      const chain = this.makeLiveChain();
      chain.settings = {
        slots: bs.fx.slots.map((slot) => ({ ...slot })),
      };
      chain.applySettings();
      const bank: Bank = {
        name: bs.name,
        kind: bs.kind,
        tracks: [],
        muted: bs.muted,
        chain,
      };
      for (const ts of bs.tracks) {
        const track = new Track(this.ctx, chain, ts.length, ts.settings);
        track.steps = ts.steps.map((s) => ({ ...s }));
        track.setLength(ts.length);
        track.setBuffer(ts.buffer, ts.region);
        bank.tracks.push(track);
      }
      this.banks.push(bank);
    }
    this.updateDelayTime();
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
