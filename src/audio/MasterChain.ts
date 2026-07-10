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

    // Master chain wiring.
    if (this.bitcrush) {
      this.input.connect(this.bitcrush);
      this.bitcrush.connect(this.filter);
    } else {
      this.input.connect(this.preCrushGain);
      this.preCrushGain.connect(this.filter);
    }
    this.filter.connect(this.drive);
    this.drive.connect(this.limiter);
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
}
