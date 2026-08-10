// Allocation-free creative insert effects for live playback.
// Modes: 0 grain, 1 tape, 2 repeater, 3 shimmer space, 4 transient.
class CreativeFxProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, defaultValue, minValue, maxValue) => ({
      name, defaultValue, minValue, maxValue, automationRate: "k-rate",
    });
    return [
      k("mode", 0, 0, 4),
      k("tempo", 120, 30, 300),
      k("position", 0.5, 0, 1),
      k("grainSize", 0.12, 0.02, 0.5),
      k("spray", 0.15, 0, 1),
      k("age", 0.35, 0, 1),
      k("wobble", 0.25, 0, 1),
      k("dropout", 0.08, 0, 1),
      k("drive", 0.25, 0, 1),
      k("division", 16, 2, 32),
      k("jitter", 0.08, 0, 1),
      k("reverse", 0, 0, 1),
      k("size", 0.75, 0, 1),
      k("color", 0.65, 0, 1),
      k("shimmer", 0.35, 0, 1),
      k("attack", 0.6, 0, 1),
      k("body", 0.5, 0, 1),
      k("punch", 0.6, 0, 1),
      k("dirt", 0.15, 0, 1),
    ];
  }

  constructor() {
    super();
    this.buffers = [];
    this.write = 0;
    this.frame = 0;
    this.anchors = [];
    this.fastEnv = [];
    this.slowEnv = [];
    this.toneState = [];
    this.feedbackState = [];
    this.bufferLength = Math.ceil(sampleRate * 4);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;
    const mode = Math.round(parameters.mode[0]);
    this.ensureChannels(output.length, mode !== 4);

    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < output.length; ch++) {
        const source = input[Math.min(ch, input.length - 1)];
        const x = source ? source[i] || 0 : 0;
        let y = x;
        if (mode === 0) y = this.grain(x, ch, parameters);
        else if (mode === 1) y = this.tape(x, ch, parameters);
        else if (mode === 2) y = this.repeater(x, ch, parameters);
        else if (mode === 3) y = this.space(x, ch, parameters);
        else if (mode === 4) y = this.transient(x, ch, parameters);
        output[ch][i] = Number.isFinite(y) ? Math.max(-2, Math.min(2, y)) : 0;
      }
      this.write = (this.write + 1) % this.bufferLength;
      this.frame++;
    }
    return true;
  }

  ensureChannels(count, needsBuffer) {
    while (this.buffers.length < count) {
      // Transient mode needs only envelope state, not a multi-second ring buffer.
      this.buffers.push(needsBuffer ? new Float32Array(this.bufferLength) : null);
      this.anchors.push(0);
      this.fastEnv.push(0);
      this.slowEnv.push(0);
      this.toneState.push(0);
      this.feedbackState.push(0);
    }
  }

  read(buffer, index) {
    let wrapped = index % this.bufferLength;
    if (wrapped < 0) wrapped += this.bufferLength;
    const a = Math.floor(wrapped);
    const b = (a + 1) % this.bufferLength;
    const frac = wrapped - a;
    return buffer[a] * (1 - frac) + buffer[b] * frac;
  }

  grain(x, ch, p) {
    const buffer = this.buffers[ch];
    buffer[this.write] = x;
    const grainFrames = Math.max(32, Math.floor(p.grainSize[0] * sampleRate));
    const phase = this.frame % grainFrames;
    if (phase === 0) {
      const history = (0.03 + p.position[0] * 1.8) * sampleRate;
      const random = this.noise(this.frame + ch * 97) * p.spray[0] * sampleRate * 0.3;
      this.anchors[ch] = this.write - history + random;
    }
    const aPhase = phase / grainFrames;
    const bPhase = (aPhase + 0.5) % 1;
    const a = this.read(buffer, this.anchors[ch] + phase);
    const b = this.read(buffer, this.anchors[ch] - grainFrames * 0.5 + bPhase * grainFrames);
    const wa = Math.sin(Math.PI * aPhase);
    const wb = Math.sin(Math.PI * bPhase);
    return (a * wa + b * wb) / Math.max(0.7, wa + wb);
  }

  tape(x, ch, p) {
    const buffer = this.buffers[ch];
    const age = p.age[0];
    const wobble = p.wobble[0];
    const phase = this.frame / sampleRate;
    const wow = Math.sin(phase * Math.PI * (0.35 + wobble * 0.8));
    const flutter = Math.sin(phase * Math.PI * 2 * (4.7 + wobble * 3.1));
    const delay = sampleRate * (0.012 + (wow * 0.004 + flutter * 0.0015) * wobble);
    buffer[this.write] = x;
    let y = this.read(buffer, this.write - Math.max(1, delay));
    const cutoff = 0.04 + (1 - age) * 0.35;
    this.toneState[ch] += cutoff * (y - this.toneState[ch]);
    y = this.toneState[ch];
    const dropoutWave = this.noise(Math.floor(this.frame / 256) + ch * 31);
    const dropout = dropoutWave > 1 - p.dropout[0] * 0.35 ? 0.08 : 1;
    const gain = 1 + p.drive[0] * 7;
    return Math.tanh(y * gain) / Math.tanh(gain) * dropout;
  }

  repeater(x, ch, p) {
    const buffer = this.buffers[ch];
    buffer[this.write] = x;
    const division = this.nearestDivision(p.division[0]);
    const sliceFrames = Math.max(64, Math.floor((60 / p.tempo[0]) * 4 / division * sampleRate));
    const phase = this.frame % sliceFrames;
    const cycle = Math.floor(this.frame / sliceFrames);
    if (phase === 0 && cycle % 4 === 0) {
      const jitter = this.noise(cycle + ch * 53) * p.jitter[0] * sliceFrames * 0.45;
      this.anchors[ch] = this.write - sliceFrames + jitter;
    }
    const offset = p.reverse[0] >= 0.5 ? sliceFrames - 1 - phase : phase;
    return this.read(buffer, this.anchors[ch] + offset);
  }

  space(x, ch, p) {
    const buffer = this.buffers[ch];
    const size = p.size[0];
    const baseDelay = sampleRate * (0.08 + size * 0.9);
    const normal = this.read(buffer, this.write - baseDelay);
    const window = Math.max(128, Math.floor(sampleRate * (0.04 + size * 0.09)));
    const phase = this.frame % window;
    const shiftedA = this.read(buffer, this.write - baseDelay - phase);
    const phaseB = (phase + window / 2) % window;
    const shiftedB = this.read(buffer, this.write - baseDelay - phaseB);
    const cross = 0.5 - 0.5 * Math.cos((phase / window) * Math.PI * 2);
    const shifted = shiftedA * (1 - cross) + shiftedB * cross;
    const shimmer = p.shimmer[0];
    const feedback = normal * (1 - shimmer) + shifted * shimmer;
    const tone = 0.03 + p.color[0] * 0.3;
    this.toneState[ch] += tone * (feedback - this.toneState[ch]);
    buffer[this.write] = x + this.toneState[ch] * (0.45 + size * 0.42);
    return normal * (1 - shimmer * 0.35) + shifted * shimmer * 0.75;
  }

  transient(x, ch, p) {
    const level = Math.abs(x);
    this.fastEnv[ch] += (level - this.fastEnv[ch]) * (level > this.fastEnv[ch] ? 0.35 : 0.08);
    this.slowEnv[ch] += (level - this.slowEnv[ch]) * 0.004;
    const transient = Math.max(0, this.fastEnv[ch] - this.slowEnv[ch]);
    const attackGain = 0.25 + p.attack[0] * 2.5;
    const bodyGain = 0.3 + p.body[0] * 1.4;
    const punch = 1 + transient * p.punch[0] * 14;
    const shaped = x * bodyGain * punch + Math.sign(x) * transient * attackGain;
    const drive = 1 + p.dirt[0] * 8;
    return Math.tanh(shaped * drive) / Math.tanh(drive);
  }

  nearestDivision(value) {
    const divisions = [2, 4, 8, 16, 32];
    let best = divisions[0];
    for (let i = 1; i < divisions.length; i++) {
      if (Math.abs(divisions[i] - value) < Math.abs(best - value)) best = divisions[i];
    }
    return best;
  }

  noise(seed) {
    const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
  }
}

registerProcessor("creative-fx", CreativeFxProcessor);