import { makeDriveCurve, makeReverbIR } from "./dsp.ts";

/**
 * The master signal path plus shared send buses.
 *
 *   tracks (dry) ─┐
 *   delay return ─┤
 *   reverb return─┴→ input → bitcrush → filter → drive → limiter → destination
 *
 *   track delay send → delayBus  → (delay + feedback) → input
 *   track reverb send → reverbBus → (convolver)        → input
 */
export class MasterChain {
  readonly ctx: AudioContext;

  /** Sum point for all dry track signal + FX returns. */
  readonly input: GainNode;

  /** Send-bus entry points that tracks connect their send taps to. */
  readonly delayBus: GainNode;
  readonly reverbBus: GainNode;

  private readonly bitcrush: AudioWorkletNode | null;
  private readonly preCrushGain: GainNode; // used when worklet unavailable (bypass)
  private readonly filter: BiquadFilterNode;
  private readonly drive: WaveShaperNode;
  private readonly limiter: DynamicsCompressorNode;

  // Delay bus internals.
  private readonly delay: DelayNode;
  private readonly delayFeedback: GainNode;
  private readonly delayTone: BiquadFilterNode;

  // Phaser (chain of allpass filters modulated by an LFO).
  private readonly phaserStages: BiquadFilterNode[];
  private readonly phaserLfo: OscillatorNode;
  private readonly phaserDepth: GainNode;
  private readonly phaserWet: GainNode;
  private readonly phaserDry: GainNode;
  private readonly phaserMix: GainNode; // sum point

  // Chorus (short modulated delay for width/thickening).
  private readonly chorusDelay: DelayNode;
  private readonly chorusLfo: OscillatorNode;
  private readonly chorusDepth: GainNode;
  private readonly chorusWet: GainNode;
  private readonly chorusDry: GainNode;
  private readonly chorusMix: GainNode;

  constructor(ctx: AudioContext, bitcrush: AudioWorkletNode | null) {
    this.ctx = ctx;
    this.bitcrush = bitcrush;

    this.input = ctx.createGain();
    this.preCrushGain = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 20000;
    this.filter.Q.value = 0.7;

    this.drive = ctx.createWaveShaper();
    this.drive.curve = makeDriveCurve(0); // start clean
    this.drive.oversample = "2x";

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;

    // Master chain wiring:
    // input → bitcrush → filter → drive → phaser → chorus → limiter → output
    if (this.bitcrush) {
      this.input.connect(this.bitcrush);
      this.bitcrush.connect(this.filter);
    } else {
      this.input.connect(this.preCrushGain);
      this.preCrushGain.connect(this.filter);
    }
    this.filter.connect(this.drive);

    // Phaser: 4 cascaded allpass stages with LFO-modulated frequency.
    this.phaserStages = [];
    this.phaserLfo = ctx.createOscillator();
    this.phaserDepth = ctx.createGain();
    this.phaserWet = ctx.createGain();
    this.phaserDry = ctx.createGain();
    this.phaserMix = ctx.createGain();
    this.phaserLfo.type = "sine";
    this.phaserLfo.frequency.value = 0.4;
    this.phaserDepth.gain.value = 800;
    this.phaserWet.gain.value = 0; // phaser off by default
    this.phaserDry.gain.value = 1;
    this.phaserLfo.connect(this.phaserDepth);
    this.phaserLfo.start();

    let prevNode: AudioNode = this.drive;
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = 1000;
      this.phaserDepth.connect(ap.frequency);
      this.phaserStages.push(ap);
      if (i === 0) this.drive.connect(ap);
      else (prevNode as BiquadFilterNode).connect(ap);
      prevNode = ap;
    }
    // Wet (phaser output) and dry (bypass) summed into phaserMix.
    (prevNode as BiquadFilterNode).connect(this.phaserWet);
    this.drive.connect(this.phaserDry);
    this.phaserWet.connect(this.phaserMix);
    this.phaserDry.connect(this.phaserMix);

    // Chorus: short modulated delay mixed with dry.
    this.chorusDelay = ctx.createDelay(0.05);
    this.chorusDelay.delayTime.value = 0.012;
    this.chorusLfo = ctx.createOscillator();
    this.chorusLfo.type = "sine";
    this.chorusLfo.frequency.value = 1.5;
    this.chorusDepth = ctx.createGain();
    this.chorusDepth.gain.value = 0.004;
    this.chorusLfo.connect(this.chorusDepth);
    this.chorusDepth.connect(this.chorusDelay.delayTime);
    this.chorusLfo.start();
    this.chorusWet = ctx.createGain();
    this.chorusWet.gain.value = 0; // chorus off by default
    this.chorusDry = ctx.createGain();
    this.chorusDry.gain.value = 1;
    this.chorusMix = ctx.createGain();

    this.phaserMix.connect(this.chorusDelay);
    this.chorusDelay.connect(this.chorusWet);
    this.phaserMix.connect(this.chorusDry);
    this.chorusWet.connect(this.chorusMix);
    this.chorusDry.connect(this.chorusMix);

    this.chorusMix.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // Delay send bus (tempo-set later via setDelayTime).
    this.delayBus = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.375;
    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0.35;
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = "lowpass";
    this.delayTone.frequency.value = 3000;

    this.delayBus.connect(this.delay);
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay); // feedback loop
    this.delayTone.connect(this.input); // return to master

    // Reverb send bus.
    this.reverbBus = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = makeReverbIR(ctx);
    this.reverbBus.connect(convolver);
    convolver.connect(this.input);
  }

  // ---- Master FX controls -------------------------------------------------

  setCrush(bits: number, reduction: number, mix: number) {
    if (!this.bitcrush) return;
    const t = this.ctx.currentTime;
    this.bitcrush.parameters.get("bits")?.setValueAtTime(bits, t);
    this.bitcrush.parameters.get("reduction")?.setValueAtTime(reduction, t);
    this.bitcrush.parameters.get("mix")?.setValueAtTime(mix, t);
  }

  setFilter(cutoffHz: number, q = 0.7) {
    const t = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(cutoffHz, t, 0.02);
    this.filter.Q.setValueAtTime(q, t);
  }

  setFilterType(type: BiquadFilterType) {
    this.filter.type = type;
  }

  setDrive(amount: number) {
    this.drive.curve = makeDriveCurve(Math.max(0, Math.min(1, amount)));
  }

  /** Set delay time in seconds (e.g. derived from tempo). */
  setDelayTime(seconds: number) {
    this.delay.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.05);
  }

  setDelayFeedback(amount: number) {
    this.delayFeedback.gain.setTargetAtTime(
      Math.max(0, Math.min(0.95, amount)),
      this.ctx.currentTime,
      0.02,
    );
  }

  // ---- Phaser controls ----------------------------------------------------

  /** 0..1 mix (0 = off, 1 = full wet). */
  setPhaserMix(mix: number) {
    const t = this.ctx.currentTime;
    this.phaserWet.gain.setTargetAtTime(Math.min(1, Math.max(0, mix)), t, 0.02);
    this.phaserDry.gain.setTargetAtTime(1 - Math.min(1, Math.max(0, mix)), t, 0.02);
  }

  /** LFO rate in Hz. */
  setPhaserRate(hz: number) {
    this.phaserLfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  /** LFO sweep depth (higher = wider sweep). */
  setPhaserDepth(depth: number) {
    this.phaserDepth.gain.setTargetAtTime(depth, this.ctx.currentTime, 0.02);
  }

  // ---- Chorus controls ----------------------------------------------------

  /** 0..1 mix (0 = off, 1 = full wet). */
  setChorusMix(mix: number) {
    const t = this.ctx.currentTime;
    this.chorusWet.gain.setTargetAtTime(Math.min(1, Math.max(0, mix)), t, 0.02);
    this.chorusDry.gain.setTargetAtTime(1 - Math.min(1, Math.max(0, mix)), t, 0.02);
  }

  /** LFO rate in Hz. */
  setChorusRate(hz: number) {
    this.chorusLfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  /** Modulation depth (controls detune amount). */
  setChorusDepth(depth: number) {
    this.chorusDepth.gain.setTargetAtTime(depth, this.ctx.currentTime, 0.02);
  }
}
