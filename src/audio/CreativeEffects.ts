import { makeDriveCurve, makeReverbIR } from "./dsp.ts";

export type CreativeEffectType =
  | "grain"
  | "resonate"
  | "tape"
  | "repeater"
  | "space"
  | "fold"
  | "dub"
  | "formant"
  | "motion"
  | "transient";

/** Numeric controls shared with the rack's serializable slot object. */
export interface CreativeEffectSettings {
  mix: number;
  position: number;
  grainSize: number;
  spray: number;
  tune: number;
  decay: number;
  color: number;
  age: number;
  wobble: number;
  dropout: number;
  drive: number;
  division: number;
  jitter: number;
  reverse: number;
  size: number;
  shimmer: number;
  fold: number;
  bias: number;
  tone: number;
  time: number;
  feedback: number;
  vowel: number;
  shift: number;
  resonance: number;
  rate: number;
  depth: number;
  shape: number;
  attack: number;
  body: number;
  punch: number;
  dirt: number;
}

export interface CreativeEffectUnit {
  input: GainNode;
  output: GainNode;
  apply(settings: CreativeEffectSettings, bpm: number): void;
  dispose(): void;
}

export type CreativeNodeFactory = () => AudioWorkletNode | null;

const CREATIVE_TYPES: readonly CreativeEffectType[] = [
  "grain", "resonate", "tape", "repeater", "space",
  "fold", "dub", "formant", "motion", "transient",
];

export function isCreativeEffect(type: string): type is CreativeEffectType {
  return CREATIVE_TYPES.includes(type as CreativeEffectType);
}

export function createCreativeEffect(
  ctx: BaseAudioContext,
  type: CreativeEffectType,
  makeWorklet: CreativeNodeFactory,
): CreativeEffectUnit {
  if (
    type === "grain" || type === "tape" || type === "repeater" ||
    type === "space" || type === "transient"
  ) {
    const node = makeWorklet();
    if (node) return createWorkletUnit(ctx, type, node);
  }

  switch (type) {
    case "resonate": return createResonate(ctx);
    case "fold": return createFold(ctx);
    case "dub": return createDub(ctx);
    case "formant": return createFormant(ctx);
    case "motion": return createMotion(ctx);
    case "grain": return createGrainFallback(ctx);
    case "tape": return createTapeFallback(ctx);
    case "repeater": return createRepeaterFallback(ctx);
    case "space": return createSpaceFallback(ctx);
    case "transient": return createTransientFallback(ctx);
  }
}

interface WetDryShell {
  input: GainNode;
  output: GainNode;
  wet: GainNode;
  dry: GainNode;
}

function wetDry(ctx: BaseAudioContext): WetDryShell {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  return { input, output, wet, dry };
}

function setMix(ctx: BaseAudioContext, shell: WetDryShell, mix: number) {
  const m = clamp(mix, 0, 1);
  shell.wet.gain.setTargetAtTime(m, ctx.currentTime, 0.02);
  shell.dry.gain.setTargetAtTime(1 - m, ctx.currentTime, 0.02);
}

function disposeShell(shell: WetDryShell, extra: AudioNode[] = []) {
  try { shell.input.disconnect(); } catch { /* disconnected */ }
  try { shell.output.disconnect(); } catch { /* disconnected */ }
  for (const node of extra) {
    try { node.disconnect(); } catch { /* disconnected */ }
  }
}

const WORKLET_MODE: Record<"grain" | "tape" | "repeater" | "space" | "transient", number> = {
  grain: 0,
  tape: 1,
  repeater: 2,
  space: 3,
  transient: 4,
};

function createWorkletUnit(
  ctx: BaseAudioContext,
  type: keyof typeof WORKLET_MODE,
  node: AudioWorkletNode,
): CreativeEffectUnit {
  const shell = wetDry(ctx);
  shell.input.connect(node);
  node.connect(shell.wet);
  node.parameters.get("mode")?.setValueAtTime(WORKLET_MODE[type], ctx.currentTime);

  return {
    input: shell.input,
    output: shell.output,
    apply(s, bpm) {
      setMix(ctx, shell, s.mix);
      const values: Record<string, number> = {
        tempo: bpm,
        position: s.position,
        grainSize: s.grainSize,
        spray: s.spray,
        age: s.age,
        wobble: s.wobble,
        dropout: s.dropout,
        drive: s.drive,
        division: s.division,
        jitter: s.jitter,
        reverse: s.reverse,
        size: s.size,
        color: s.color,
        shimmer: s.shimmer,
        attack: s.attack,
        body: s.body,
        punch: s.punch,
        dirt: s.dirt,
      };
      for (const [name, value] of Object.entries(values)) {
        node.parameters.get(name)?.setTargetAtTime(value, ctx.currentTime, 0.02);
      }
    },
    dispose() {
      node.port.close();
      disposeShell(shell, [node]);
    },
  };
}

function createResonate(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const delay = ctx.createDelay(0.1);
  const color = ctx.createBiquadFilter();
  const feedback = ctx.createGain();
  color.type = "lowpass";
  shell.input.connect(delay);
  delay.connect(color);
  color.connect(shell.wet);
  color.connect(feedback);
  feedback.connect(delay);

  return {
    input: shell.input,
    output: shell.output,
    apply(s) {
      setMix(ctx, shell, s.mix);
      const hz = 440 * 2 ** ((clamp(s.tune, 24, 96) - 69) / 12);
      delay.delayTime.setTargetAtTime(1 / hz, ctx.currentTime, 0.01);
      feedback.gain.setTargetAtTime(0.2 + clamp(s.decay, 0, 1) * 0.76, ctx.currentTime, 0.02);
      color.frequency.setTargetAtTime(500 + clamp(s.color, 0, 1) * 11500, ctx.currentTime, 0.02);
    },
    dispose: () => disposeShell(shell, [delay, color, feedback]),
  };
}

function createFold(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  shell.input.connect(pre);
  pre.connect(shaper);
  shaper.connect(tone);
  tone.connect(shell.wet);

  return {
    input: shell.input,
    output: shell.output,
    apply(s) {
      setMix(ctx, shell, s.mix);
      const amount = clamp(s.fold, 0, 1);
      pre.gain.setTargetAtTime(1 + amount * 8, ctx.currentTime, 0.02);
      shaper.curve = makeFoldCurve(amount, clamp(s.bias, -1, 1));
      shaper.oversample = "2x";
      tone.frequency.setTargetAtTime(500 + clamp(s.tone, 0, 1) * 15500, ctx.currentTime, 0.02);
    },
    dispose: () => disposeShell(shell, [pre, shaper, tone]),
  };
}

function createDub(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const delay = ctx.createDelay(4);
  const tone = ctx.createBiquadFilter();
  const feedback = ctx.createGain();
  const lfo = ctx.createOscillator();
  const wobble = ctx.createGain();
  tone.type = "lowpass";
  shell.input.connect(delay);
  delay.connect(tone);
  tone.connect(shell.wet);
  tone.connect(feedback);
  feedback.connect(delay);
  lfo.connect(wobble);
  wobble.connect(delay.delayTime);
  lfo.start();

  return {
    input: shell.input,
    output: shell.output,
    apply(s, bpm) {
      setMix(ctx, shell, s.mix);
      const seconds = divisionSeconds(bpm, s.time);
      delay.delayTime.setTargetAtTime(seconds, ctx.currentTime, 0.03);
      feedback.gain.setTargetAtTime(clamp(s.feedback, 0, 0.88), ctx.currentTime, 0.02);
      tone.frequency.setTargetAtTime(350 + clamp(s.tone, 0, 1) * 9000, ctx.currentTime, 0.02);
      lfo.frequency.setTargetAtTime(0.08 + clamp(s.wobble, 0, 1) * 1.8, ctx.currentTime, 0.03);
      wobble.gain.setTargetAtTime(seconds * clamp(s.wobble, 0, 1) * 0.035, ctx.currentTime, 0.03);
    },
    dispose() {
      try { lfo.stop(); } catch { /* stopped */ }
      disposeShell(shell, [delay, tone, feedback, lfo, wobble]);
    },
  };
}

function createFormant(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const filters = Array.from({ length: 3 }, () => ctx.createBiquadFilter());
  const gains = filters.map(() => ctx.createGain());
  filters.forEach((filter, index) => {
    filter.type = "bandpass";
    shell.input.connect(filter);
    filter.connect(gains[index]);
    gains[index].connect(shell.wet);
    gains[index].gain.value = 0.45;
  });
  const vowels = [
    [800, 1150, 2900], [400, 1600, 2700], [350, 1700, 2700],
    [450, 800, 2830], [325, 700, 2530],
  ];

  return {
    input: shell.input,
    output: shell.output,
    apply(s) {
      setMix(ctx, shell, s.mix);
      const vowel = clamp(s.vowel, 0, 4);
      const lo = Math.floor(vowel);
      const hi = Math.min(4, lo + 1);
      const morph = vowel - lo;
      const shift = 2 ** (clamp(s.shift, -24, 24) / 12);
      filters.forEach((filter, index) => {
        const hz = (vowels[lo][index] * (1 - morph) + vowels[hi][index] * morph) * shift;
        filter.frequency.setTargetAtTime(clamp(hz, 80, 18000), ctx.currentTime, 0.02);
        filter.Q.setTargetAtTime(2 + clamp(s.resonance, 0, 1) * 18, ctx.currentTime, 0.02);
      });
    },
    dispose: () => disposeShell(shell, [...filters, ...gains]),
  };
}

function createMotion(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const delay = ctx.createDelay(0.05);
  const allpass = ctx.createBiquadFilter();
  const panner = ctx.createStereoPanner();
  const lfo = ctx.createOscillator();
  const delayDepth = ctx.createGain();
  const filterDepth = ctx.createGain();
  const panDepth = ctx.createGain();
  delay.delayTime.value = 0.012;
  allpass.type = "allpass";
  allpass.frequency.value = 1000;
  shell.input.connect(delay);
  delay.connect(allpass);
  allpass.connect(panner);
  panner.connect(shell.wet);
  lfo.connect(delayDepth);
  lfo.connect(filterDepth);
  lfo.connect(panDepth);
  delayDepth.connect(delay.delayTime);
  filterDepth.connect(allpass.frequency);
  panDepth.connect(panner.pan);
  lfo.start();

  return {
    input: shell.input,
    output: shell.output,
    apply(s) {
      setMix(ctx, shell, s.mix);
      lfo.type = (["sine", "triangle", "square"] as OscillatorType[])[Math.round(clamp(s.shape, 0, 2))];
      lfo.frequency.setTargetAtTime(clamp(s.rate, 0.03, 12), ctx.currentTime, 0.02);
      const depth = clamp(s.depth, 0, 1);
      delayDepth.gain.setTargetAtTime(depth * 0.008, ctx.currentTime, 0.02);
      filterDepth.gain.setTargetAtTime(depth * 1400, ctx.currentTime, 0.02);
      panDepth.gain.setTargetAtTime(depth, ctx.currentTime, 0.02);
    },
    dispose() {
      try { lfo.stop(); } catch { /* stopped */ }
      disposeShell(shell, [delay, allpass, panner, lfo, delayDepth, filterDepth, panDepth]);
    },
  };
}

function createGrainFallback(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const delay = ctx.createDelay(2);
  const feedback = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  tone.type = "lowpass";
  shell.input.connect(delay);
  delay.connect(tone);
  tone.connect(shell.wet);
  tone.connect(feedback);
  feedback.connect(delay);
  lfo.connect(depth);
  depth.connect(delay.delayTime);
  lfo.start();
  return {
    input: shell.input, output: shell.output,
    apply(s) {
      setMix(ctx, shell, s.mix);
      delay.delayTime.setTargetAtTime(0.03 + s.position * 1.2, ctx.currentTime, 0.03);
      feedback.gain.setTargetAtTime(0.25 + s.spray * 0.6, ctx.currentTime, 0.03);
      lfo.frequency.setTargetAtTime(1 / clamp(s.grainSize, 0.02, 0.5), ctx.currentTime, 0.03);
      depth.gain.setTargetAtTime(s.spray * s.grainSize * 0.4, ctx.currentTime, 0.03);
      tone.frequency.setTargetAtTime(1200 + (1 - s.spray) * 9000, ctx.currentTime, 0.03);
    },
    dispose() {
      try { lfo.stop(); } catch { /* stopped */ }
      disposeShell(shell, [delay, feedback, tone, lfo, depth]);
    },
  };
}

function createTapeFallback(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const delay = ctx.createDelay(0.08);
  const tone = ctx.createBiquadFilter();
  const shaper = ctx.createWaveShaper();
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  tone.type = "lowpass";
  shell.input.connect(delay);
  delay.connect(tone);
  tone.connect(shaper);
  shaper.connect(shell.wet);
  lfo.connect(depth);
  depth.connect(delay.delayTime);
  lfo.start();
  return {
    input: shell.input, output: shell.output,
    apply(s) {
      setMix(ctx, shell, s.mix);
      delay.delayTime.setTargetAtTime(0.012 + s.age * 0.012, ctx.currentTime, 0.02);
      lfo.frequency.setTargetAtTime(0.15 + s.wobble * 3, ctx.currentTime, 0.02);
      depth.gain.setTargetAtTime(0.0005 + s.wobble * 0.006, ctx.currentTime, 0.02);
      tone.frequency.setTargetAtTime(14000 - s.age * 10500 - s.dropout * 1500, ctx.currentTime, 0.02);
      shaper.curve = makeDriveCurve(clamp(s.drive, 0, 1));
      shaper.oversample = "2x";
    },
    dispose() {
      try { lfo.stop(); } catch { /* stopped */ }
      disposeShell(shell, [delay, tone, shaper, lfo, depth]);
    },
  };
}

function createRepeaterFallback(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const delay = ctx.createDelay(4);
  const feedback = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  shell.input.connect(delay);
  delay.connect(tone);
  tone.connect(shell.wet);
  tone.connect(feedback);
  feedback.connect(delay);
  return {
    input: shell.input, output: shell.output,
    apply(s, bpm) {
      setMix(ctx, shell, s.mix);
      delay.delayTime.setTargetAtTime(divisionSeconds(bpm, s.division), ctx.currentTime, 0.01);
      feedback.gain.setTargetAtTime(0.45 + s.jitter * 0.42, ctx.currentTime, 0.02);
      tone.frequency.setTargetAtTime(s.reverse >= 0.5 ? 3200 : 9000, ctx.currentTime, 0.02);
    },
    dispose: () => disposeShell(shell, [delay, feedback, tone]),
  };
}

function createSpaceFallback(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const convolver = ctx.createConvolver();
  const color = ctx.createBiquadFilter();
  const shimmer = ctx.createBiquadFilter();
  color.type = "lowpass";
  shimmer.type = "highshelf";
  shell.input.connect(convolver);
  convolver.connect(color);
  color.connect(shimmer);
  shimmer.connect(shell.wet);
  return {
    input: shell.input, output: shell.output,
    apply(s) {
      setMix(ctx, shell, s.mix);
      // Replacing the IR only while settings move noticeably avoids per-frame work.
      const seconds = 1.2 + clamp(s.size, 0, 1) * 3.8;
      if (!convolver.buffer || Math.abs(convolver.buffer.duration - seconds) > 0.2) {
        convolver.buffer = makeReverbIR(ctx, seconds);
      }
      color.frequency.setTargetAtTime(1200 + s.color * 12000, ctx.currentTime, 0.03);
      shimmer.frequency.setTargetAtTime(2800, ctx.currentTime, 0.03);
      shimmer.gain.setTargetAtTime(s.shimmer * 12, ctx.currentTime, 0.03);
    },
    dispose: () => disposeShell(shell, [convolver, color, shimmer]),
  };
}

function createTransientFallback(ctx: BaseAudioContext): CreativeEffectUnit {
  const shell = wetDry(ctx);
  const compressor = ctx.createDynamicsCompressor();
  const body = ctx.createBiquadFilter();
  const shaper = ctx.createWaveShaper();
  body.type = "peaking";
  body.frequency.value = 140;
  shell.input.connect(compressor);
  compressor.connect(body);
  body.connect(shaper);
  shaper.connect(shell.wet);
  return {
    input: shell.input, output: shell.output,
    apply(s) {
      setMix(ctx, shell, s.mix);
      compressor.attack.setTargetAtTime(0.001 + (1 - s.attack) * 0.08, ctx.currentTime, 0.02);
      compressor.release.setTargetAtTime(0.03 + s.body * 0.35, ctx.currentTime, 0.02);
      compressor.threshold.setTargetAtTime(-8 - s.punch * 28, ctx.currentTime, 0.02);
      compressor.ratio.setTargetAtTime(1 + s.punch * 10, ctx.currentTime, 0.02);
      body.gain.setTargetAtTime((s.body - 0.5) * 16, ctx.currentTime, 0.02);
      shaper.curve = makeDriveCurve(clamp(s.dirt, 0, 1));
    },
    dispose: () => disposeShell(shell, [compressor, body, shaper]),
  };
}

function makeFoldCurve(amount: number, bias: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(2048);
  const folds = 1 + amount * 7;
  for (let i = 0; i < curve.length; i++) {
    const x = ((i / (curve.length - 1)) * 2 - 1 + bias * 0.6) * folds;
    curve[i] = (2 / Math.PI) * Math.asin(Math.sin(x));
  }
  return curve;
}

function divisionSeconds(bpm: number, denominator: number): number {
  const beat = 60 / clamp(bpm, 30, 300);
  return clamp(beat * 4 / nearestDivision(denominator), 0.01, 3.9);
}

function nearestDivision(value: number): number {
  const divisions = [2, 4, 8, 16, 32];
  return divisions.reduce((best, item) =>
    Math.abs(item - value) < Math.abs(best - value) ? item : best, divisions[0]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}