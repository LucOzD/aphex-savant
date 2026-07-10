// Small DSP helpers.

/** Build a waveshaper curve for soft-clipping drive/saturation. `amount` 0..1. */
export function makeDriveCurve(amount: number, samples = 1024): Float32Array<ArrayBuffer> {
  const k = amount * 100;
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/**
 * Generate a synthetic reverb impulse response (exponentially decaying noise)
 * so we don't have to ship an audio file. Returns a stereo AudioBuffer.
 */
export function makeReverbIR(
  ctx: BaseAudioContext,
  seconds = 2.2,
  decay = 3.0,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * rate));
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Random noise shaped by an exponential decay envelope.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return ir;
}

/** Convert a MIDI-style semitone offset to a playback-rate multiplier. */
export function semitonesToRate(semitones: number): number {
  return Math.pow(2, semitones / 12);
}
