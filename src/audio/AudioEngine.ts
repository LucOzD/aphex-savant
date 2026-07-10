import { MasterChain } from "./MasterChain.ts";
import { Scheduler } from "./Scheduler.ts";
import { Track } from "./Track.ts";
import { generateDrumKit, drumName } from "./synthDrums.ts";
import { decodeAudio, sliceByTransients } from "./sampleUtils.ts";
import { Recorder } from "./Recorder.ts";

export interface EngineConfig {
  trackCount: number;
  steps: number;
}

/** Top-level audio engine: owns the context, master chain, tracks, transport. */
export class AudioEngine {
  readonly ctx: AudioContext;
  master!: MasterChain;
  readonly tracks: Track[] = [];
  readonly scheduler: Scheduler;
  readonly config: EngineConfig;
  readonly recorder = new Recorder();

  /** The most recent mic recording, kept so it can be chopped or reassigned. */
  lastRecording: AudioBuffer | null = null;

  private started = false;

  /** UI hook: fired (on the main thread) when the playhead reaches a step. */
  onVisualStep: (step: number) => void = () => {};

  constructor(config: EngineConfig = { trackCount: 16, steps: 16 }) {
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

    // Build tracks and load them with the default synth kit.
    const kit = generateDrumKit(this.ctx, this.config.trackCount);
    for (let i = 0; i < this.config.trackCount; i++) {
      const track = new Track(this.ctx, this.master, this.config.steps, {
        name: drumName(i),
        chokeGroup: i % 8 === 2 ? 1 : 0, // hats choke each other by default
      });
      track.setBuffer(kit[i]);
      this.tracks.push(track);
    }

    this.started = true;
  }

  get isReady(): boolean {
    return this.started;
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
  padHit(trackIndex: number, velocity = 1) {
    const track = this.tracks[trackIndex];
    if (!track) return;
    track.trigger(this.ctx.currentTime + 0.005, 0, velocity);
  }

  private handleStep(step: number, time: number) {
    for (const track of this.tracks) {
      const s = track.steps[step];
      if (!s || !s.on) continue;
      if (s.probability < 1 && Math.random() > s.probability) continue;
      track.trigger(time, s.pitch, s.velocity);
    }
    // Schedule the UI highlight to line up with the audio.
    const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
    window.setTimeout(() => this.onVisualStep(step), delayMs);
  }

  // ---- Sample loading -----------------------------------------------------

  /** Decode a user file and slice it across the pads by transients. */
  async loadAndSlice(file: File): Promise<number> {
    const buffer = await this.decodeFile(file);
    return this.sliceBufferAcrossPads(buffer);
  }

  /** Load a single file onto one pad (whole sample, no slicing). */
  async loadOntoPad(trackIndex: number, file: File): Promise<void> {
    const buffer = await this.decodeFile(file);
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 12);
    this.loadBufferOntoPad(trackIndex, buffer, name);
  }

  private async decodeFile(file: File): Promise<AudioBuffer> {
    return decodeAudio(this.ctx, await file.arrayBuffer());
  }

  /** Auto-slice a decoded buffer by transients and spread it over the pads. */
  sliceBufferAcrossPads(buffer: AudioBuffer): number {
    const slices = sliceByTransients(buffer, this.config.trackCount);
    slices.forEach((region, i) => {
      if (this.tracks[i]) {
        this.tracks[i].setBuffer(buffer, region);
        this.tracks[i].settings.name = `slice ${i + 1}`;
      }
    });
    return slices.length;
  }

  /** Put a whole decoded buffer onto one pad. */
  loadBufferOntoPad(trackIndex: number, buffer: AudioBuffer, name = "sample") {
    const track = this.tracks[trackIndex];
    if (track) {
      track.setBuffer(buffer, null);
      track.settings.name = name;
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
