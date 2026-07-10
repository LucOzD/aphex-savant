// Bitcrusher + sample-rate reducer AudioWorklet processor.
// Quantizes sample amplitude (bit depth) and holds samples (rate reduction)
// for that classic lo-fi / pocket-operator grit.
class BitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Effective bit depth. 16 = basically clean, ~4 = crunchy.
      { name: "bits", defaultValue: 16, minValue: 1, maxValue: 16, automationRate: "k-rate" },
      // Sample-rate reduction factor. 1 = full rate, higher = more reduction.
      { name: "reduction", defaultValue: 1, minValue: 1, maxValue: 50, automationRate: "k-rate" },
      // Dry/wet mix, 0..1.
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    // Per-channel sample-and-hold state.
    this._hold = [];
    this._phase = [];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const bits = parameters.bits[0];
    const reduction = Math.max(1, Math.floor(parameters.reduction[0]));
    const mix = parameters.mix[0];
    const step = Math.pow(0.5, bits); // quantization step size
    const invStep = 1 / step;

    for (let ch = 0; ch < input.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (this._hold[ch] === undefined) {
        this._hold[ch] = 0;
        this._phase[ch] = 0;
      }
      for (let i = 0; i < inCh.length; i++) {
        if (this._phase[ch] % reduction === 0) {
          // Quantize amplitude to the reduced bit depth.
          this._hold[ch] = Math.round(inCh[i] * invStep) * step;
        }
        this._phase[ch]++;
        outCh[i] = inCh[i] * (1 - mix) + this._hold[ch] * mix;
      }
    }
    return true;
  }
}

registerProcessor("bitcrusher", BitcrusherProcessor);
