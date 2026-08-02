import { makeDriveCurve, makeReverbIR } from "./dsp.ts";

/**
 * User-facing FX settings for one chain. Stored as plain data so it can be
 * shown per bank in the UI, snapshotted for undo, and saved in a project.
 */
export interface FxSettings {
  crushBits: number; // 1..16
  crushReduction: number; // 1..40
  crushMix: number; // 0..1
  filterType: BiquadFilterType;
  filterFreq: number; // Hz
  filterQ: number;
  drive: number; // 0..1
  delayFeedback: number; // 0..0.95
  phaserMix: number; // 0..1
  phaserRate: number; // Hz
  phaserDepth: number;
  chorusMix: number; // 0..1
  chorusRate: number; // Hz
  chorusDepth: number; // seconds of modulation
}

export function defaultFxSettings(): FxSettings {
  return {
    crushBits: 16,
    crushReduction: 1,
    crushMix: 1,
    filterType: "lowpass",
    filterFreq: 20000,
    filterQ: 0.7,
    drive: 0,
    delayFeedback: 0.35,
    phaserMix: 0,
    phaserRate: 0.4,
    phaserDepth: 800,
    chorusMix: 0,
    chorusRate: 1.5,
    chorusDepth: 0.004,
  };
}

/**
 * One FX chain, owned by a single bank (scene) so each bank can be processed
 * independently. Chains sum into a shared output bus, which the engine runs
 * through one global limiter.
 *
 *   tracks (dry) ─┐
 *   delay return ─┤
 *   reverb return─┴→ input → bitcrush → filter → drive → phaser → chorus → output
 *
 *   track delaySend  → delayBus  → (delay + filtered feedback) → input
 *   track reverbSend → reverbBus → (convolver)                 → input
 */
export class FxChain {
  readonly ctx: BaseAudioContext;

  /** Sum point for this bank's dry track signal + its FX returns. */
  readonly input: GainNode;

  /** Send-bus entry points that tracks connect their send taps to. */
  readonly delayBus: GainNode;
  readonly reverbBus: GainNode;

  /** Current settings. Mutate then call applySettings(). */
  settings: FxSettings = defaultFxSettings();

  private readonly bitcrush: AudioWorkletNode | null;
  private readonly filter: BiquadFilterNode;
  private readonly drive: WaveShaperNode;

  private readonly delay: DelayNode;
  private readonly delayFeedback: GainNode;

  private readonly phaserLfo: OscillatorNode;
  private readonly phaserDepth: GainNode;
  private readonly phaserWet: GainNode;
  private readonly phaserDry: GainNode;
  private readonly phaserMix: GainNode;

  private readonly chorusDelay: DelayNode;
  private readonly chorusLfo: OscillatorNode;
  private readonly chorusDepth: GainNode;
  private readonly chorusWet: GainNode;
  private readonly chorusDry: GainNode;
  private readonly chorusMix: GainNode;

  /** Momentary performance overrides, restored from settings when released. */
  private filterOverride: { freq: number; q: number } | null = null;
  private crushOverride: { bits: number; reduction: number; mix: number } | null = null;

  constructor(ctx: BaseAudioContext, bitcrush: AudioWorkletNode | null, output: AudioNode) {
    this.ctx = ctx;
    this.bitcrush = bitcrush;

    this.input = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.drive = ctx.createWaveShaper();
    this.drive.oversample = "2x";

    // input → [bitcrush] → filter → drive
    if (bitcrush) {
      this.input.connect(bitcrush);
      bitcrush.connect(this.filter);
    } else {
      this.input.connect(this.filter);
    }
    this.filter.connect(this.drive);

    // Phaser: 4 cascaded allpass stages swept by an LFO, mixed against dry.
    this.phaserLfo = ctx.createOscillator();
    this.phaserLfo.type = "sine";
    this.phaserDepth = ctx.createGain();
    this.phaserWet = ctx.createGain();
    this.phaserDry = ctx.createGain();
    this.phaserMix = ctx.createGain();
    this.phaserLfo.connect(this.phaserDepth);
    this.phaserLfo.start();

    let node: AudioNode = this.drive;
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = 1000;
      this.phaserDepth.connect(ap.frequency);
      node.connect(ap);
      node = ap;
    }
    node.connect(this.phaserWet);
    this.drive.connect(this.phaserDry);
    this.phaserWet.connect(this.phaserMix);
    this.phaserDry.connect(this.phaserMix);

    // Chorus: short LFO-modulated delay mixed against dry.
    this.chorusDelay = ctx.createDelay(0.05);
    this.chorusDelay.delayTime.value = 0.012;
    this.chorusLfo = ctx.createOscillator();
    this.chorusLfo.type = "sine";
    this.chorusDepth = ctx.createGain();
    this.chorusLfo.connect(this.chorusDepth);
    this.chorusDepth.connect(this.chorusDelay.delayTime);
    this.chorusLfo.start();
    this.chorusWet = ctx.createGain();
    this.chorusDry = ctx.createGain();
    this.chorusMix = ctx.createGain();

    this.phaserMix.connect(this.chorusDelay);
    this.chorusDelay.connect(this.chorusWet);
    this.phaserMix.connect(this.chorusDry);
    this.chorusWet.connect(this.chorusMix);
    this.chorusDry.connect(this.chorusMix);

    // This chain's output feeds the shared bus (engine applies the limiter).
    this.chorusMix.connect(output);

    // Delay send bus. Tempo-synced via setDelayTime().
    this.delayBus = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.375;
    this.delayFeedback = ctx.createGain();
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = "lowpass";
    delayTone.frequency.value = 3000;

    this.delayBus.connect(this.delay);
    this.delay.connect(delayTone);
    delayTone.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay); // feedback loop
    delayTone.connect(this.input); // return into this bank's chain

    // Reverb send bus. Convolution cost scales with IR length and runs
    // constantly, so keep the tail modest for CPU headroom on phones.
    this.reverbBus = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = makeReverbIR(ctx, 1.6);
    this.reverbBus.connect(convolver);
    convolver.connect(this.input);

    this.applySettings();
  }

  /** Push the whole settings object into the audio nodes. */
  applySettings() {
    const s = this.settings;
    const t = this.ctx.currentTime;

    if (this.crushOverride === null) this.writeCrush(s.crushBits, s.crushReduction, s.crushMix);

    this.filter.type = s.filterType;
    if (this.filterOverride === null) {
      this.filter.frequency.setTargetAtTime(s.filterFreq, t, 0.02);
      this.filter.Q.setTargetAtTime(s.filterQ, t, 0.02);
    }

    this.drive.curve = makeDriveCurve(clamp(s.drive, 0, 1));
    this.delayFeedback.gain.setTargetAtTime(clamp(s.delayFeedback, 0, 0.95), t, 0.02);

    this.writeMix(this.phaserWet, this.phaserDry, s.phaserMix);
    this.phaserLfo.frequency.setTargetAtTime(s.phaserRate, t, 0.02);
    this.phaserDepth.gain.setTargetAtTime(s.phaserDepth, t, 0.02);

    this.writeMix(this.chorusWet, this.chorusDry, s.chorusMix);
    this.chorusLfo.frequency.setTargetAtTime(s.chorusRate, t, 0.02);
    this.chorusDepth.gain.setTargetAtTime(s.chorusDepth, t, 0.02);
  }

  /** Set delay time in seconds (derived from tempo, not a user setting). */
  setDelayTime(seconds: number) {
    this.delay.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.05);
  }

  // ---- Momentary performance overrides ------------------------------------

  /** Slam the filter while a performance button is held. */
  setFilterOverride(freq: number, q: number) {
    this.filterOverride = { freq, q };
    const t = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(freq, t, 0.02);
    this.filter.Q.setTargetAtTime(q, t, 0.02);
  }

  /** Slam the bitcrusher while a performance button is held. */
  setCrushOverride(bits: number, reduction: number, mix: number) {
    this.crushOverride = { bits, reduction, mix };
    this.writeCrush(bits, reduction, mix);
  }

  /** Release any momentary override and fall back to the stored settings. */
  clearOverrides() {
    this.filterOverride = null;
    this.crushOverride = null;
    this.applySettings();
  }

  // ---- Internals ----------------------------------------------------------

  private writeCrush(bits: number, reduction: number, mix: number) {
    if (!this.bitcrush) return;
    const t = this.ctx.currentTime;
    this.bitcrush.parameters.get("bits")?.setValueAtTime(bits, t);
    this.bitcrush.parameters.get("reduction")?.setValueAtTime(reduction, t);
    this.bitcrush.parameters.get("mix")?.setValueAtTime(mix, t);
  }

  /** Crossfade a wet/dry pair from a single 0..1 mix value. */
  private writeMix(wet: GainNode, dry: GainNode, mix: number) {
    const m = clamp(mix, 0, 1);
    const t = this.ctx.currentTime;
    wet.gain.setTargetAtTime(m, t, 0.02);
    dry.gain.setTargetAtTime(1 - m, t, 0.02);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
