import { makeDriveCurve, makeReverbIR } from "./dsp.ts";
import {
  createCreativeEffect,
  isCreativeEffect,
  type CreativeEffectSettings,
  type CreativeEffectType,
  type CreativeEffectUnit,
  type CreativeNodeFactory,
} from "./CreativeEffects.ts";

export type EffectType =
  | "none" | "filter" | "drive" | "crusher" | "phaser" | "chorus"
  | CreativeEffectType;

/** Settings carried by one user-assignable insert slot. */
export interface EffectSlotSettings extends CreativeEffectSettings {
  type: EffectType;
  filterType: BiquadFilterType;
  frequency: number;
  q: number;
  bits: number;
  reduction: number;
}

export interface FxSettings {
  /** Three ordered insert slots. */
  slots: EffectSlotSettings[];
}

export function defaultEffectSlot(): EffectSlotSettings {
  return {
    type: "none",
    mix: 0.5,
    filterType: "lowpass",
    frequency: 8000,
    q: 0.7,
    drive: 0.35,
    bits: 8,
    reduction: 4,
    rate: 0.5,
    depth: 0.5,
    position: 0.5,
    grainSize: 0.12,
    spray: 0.15,
    tune: 48,
    decay: 0.65,
    color: 0.65,
    age: 0.35,
    wobble: 0.25,
    dropout: 0.08,
    division: 16,
    jitter: 0.08,
    reverse: 0,
    size: 0.75,
    shimmer: 0.35,
    fold: 0.45,
    bias: 0,
    tone: 0.65,
    time: 8,
    feedback: 0.55,
    vowel: 0,
    shift: 0,
    resonance: 0.65,
    shape: 0,
    attack: 0.6,
    body: 0.5,
    punch: 0.6,
    dirt: 0.15,
  };
}

export function defaultFxSettings(): FxSettings {
  return { slots: Array.from({ length: 3 }, () => defaultEffectSlot()) };
}

interface EffectUnit {
  input: GainNode;
  output: GainNode;
}

/**
 * Three-slot insert rack owned by one bank (scene). Slots are routed in their
 * displayed order. Effect types are unique per rack because each unit is built
 * once; assigning an effect to a new slot clears it from its previous slot.
 *
 * Per-pad delay and reverb sends remain independent and return before the rack:
 *   tracks + send returns → input → slot 1 → slot 2 → slot 3 → output
 */
export class FxChain {
  readonly ctx: BaseAudioContext;
  readonly input: GainNode;
  readonly delayBus: GainNode;
  readonly reverbBus: GainNode;
  settings: FxSettings = defaultFxSettings();

  private readonly destination: AudioNode;
  private readonly units = new Map<Exclude<EffectType, "none">, EffectUnit>();
  private readonly creativeUnits = new Map<CreativeEffectType, CreativeEffectUnit>();
  private readonly makeCreativeNode: CreativeNodeFactory;
  private tempo = 120;
  private routingSignature = "";

  private readonly filter: BiquadFilterNode;
  private readonly driveShape: WaveShaperNode;
  private readonly driveWet: GainNode;
  private readonly driveDry: GainNode;

  private readonly crusher: AudioWorkletNode | null;
  private readonly crusherWet: GainNode;
  private readonly crusherDry: GainNode;

  private readonly phaserLfo: OscillatorNode;
  private readonly phaserDepth: GainNode;
  private readonly phaserWet: GainNode;
  private readonly phaserDry: GainNode;

  private readonly chorusDelay: DelayNode;
  private readonly chorusLfo: OscillatorNode;
  private readonly chorusDepth: GainNode;
  private readonly chorusWet: GainNode;
  private readonly chorusDry: GainNode;

  private readonly delay: DelayNode;
  private readonly delayFeedback: GainNode;

  private filterOverride: { freq: number; q: number } | null = null;
  private crushOverride: { bits: number; reduction: number; mix: number } | null = null;

  constructor(
    ctx: BaseAudioContext,
    crusher: AudioWorkletNode | null,
    output: AudioNode,
    makeCreativeNode: CreativeNodeFactory = () => null,
  ) {
    this.ctx = ctx;
    this.destination = output;
    this.crusher = crusher;
    this.makeCreativeNode = makeCreativeNode;
    this.input = ctx.createGain();

    // Filter unit.
    const filterIn = ctx.createGain();
    const filterOut = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    filterIn.connect(this.filter);
    this.filter.connect(filterOut);
    this.units.set("filter", { input: filterIn, output: filterOut });

    // Drive unit with wet/dry mix.
    const driveIn = ctx.createGain();
    const driveOut = ctx.createGain();
    this.driveShape = ctx.createWaveShaper();
    this.driveShape.oversample = "2x";
    this.driveWet = ctx.createGain();
    this.driveDry = ctx.createGain();
    driveIn.connect(this.driveShape);
    this.driveShape.connect(this.driveWet);
    driveIn.connect(this.driveDry);
    this.driveWet.connect(driveOut);
    this.driveDry.connect(driveOut);
    this.units.set("drive", { input: driveIn, output: driveOut });

    // Crusher unit. If the worklet failed, its wet path is a clean fallback.
    const crushIn = ctx.createGain();
    const crushOut = ctx.createGain();
    this.crusherWet = ctx.createGain();
    this.crusherDry = ctx.createGain();
    if (crusher) {
      crushIn.connect(crusher);
      crusher.connect(this.crusherWet);
    } else {
      crushIn.connect(this.crusherWet);
    }
    crushIn.connect(this.crusherDry);
    this.crusherWet.connect(crushOut);
    this.crusherDry.connect(crushOut);
    this.units.set("crusher", { input: crushIn, output: crushOut });

    // Phaser unit: four cascaded allpass filters swept by an LFO.
    const phaserIn = ctx.createGain();
    const phaserOut = ctx.createGain();
    this.phaserLfo = ctx.createOscillator();
    this.phaserLfo.type = "sine";
    this.phaserDepth = ctx.createGain();
    this.phaserWet = ctx.createGain();
    this.phaserDry = ctx.createGain();
    this.phaserLfo.connect(this.phaserDepth);
    this.phaserLfo.start();
    let phaserNode: AudioNode = phaserIn;
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = 1000;
      this.phaserDepth.connect(ap.frequency);
      phaserNode.connect(ap);
      phaserNode = ap;
    }
    phaserNode.connect(this.phaserWet);
    phaserIn.connect(this.phaserDry);
    this.phaserWet.connect(phaserOut);
    this.phaserDry.connect(phaserOut);
    this.units.set("phaser", { input: phaserIn, output: phaserOut });

    // Chorus unit: short LFO-modulated delay mixed against dry.
    const chorusIn = ctx.createGain();
    const chorusOut = ctx.createGain();
    this.chorusDelay = ctx.createDelay(0.05);
    this.chorusDelay.delayTime.value = 0.012;
    this.chorusLfo = ctx.createOscillator();
    this.chorusLfo.type = "sine";
    this.chorusDepth = ctx.createGain();
    this.chorusWet = ctx.createGain();
    this.chorusDry = ctx.createGain();
    this.chorusLfo.connect(this.chorusDepth);
    this.chorusDepth.connect(this.chorusDelay.delayTime);
    this.chorusLfo.start();
    chorusIn.connect(this.chorusDelay);
    this.chorusDelay.connect(this.chorusWet);
    chorusIn.connect(this.chorusDry);
    this.chorusWet.connect(chorusOut);
    this.chorusDry.connect(chorusOut);
    this.units.set("chorus", { input: chorusIn, output: chorusOut });

    // Per-pad delay send bus (kept separate from insert slots).
    this.delayBus = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.375;
    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0.35;
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = "lowpass";
    delayTone.frequency.value = 3000;
    this.delayBus.connect(this.delay);
    this.delay.connect(delayTone);
    delayTone.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    delayTone.connect(this.input);

    // Per-pad reverb send bus.
    this.reverbBus = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = makeReverbIR(ctx, 1.6);
    this.reverbBus.connect(convolver);
    convolver.connect(this.input);

    this.applySettings();
  }

  /** Assign a type to a slot. Existing effects move with their tweaked settings. */
  setSlotType(index: number, type: EffectType) {
    const current = this.settings.slots[index];
    if (!current || current.type === type) return;

    if (type === "none") {
      this.settings.slots[index] = defaultEffectSlot();
    } else {
      const existingIndex = this.settings.slots.findIndex((slot) => slot.type === type);
      if (existingIndex >= 0) {
        const moved = { ...this.settings.slots[existingIndex], type };
        this.settings.slots[existingIndex] = defaultEffectSlot();
        this.settings.slots[index] = moved;
      } else {
        this.settings.slots[index] = this.defaultSlotFor(type);
      }
    }
    this.applySettings();
  }

  /** Safe starting values for effect-specific ranges. */
  private defaultSlotFor(type: Exclude<EffectType, "none">): EffectSlotSettings {
    const slot = { ...defaultEffectSlot(), type };
    if (type === "phaser") {
      slot.rate = 0.5;
      slot.depth = 800;
    } else if (type === "chorus") {
      slot.mix = 0.35;
      slot.rate = 1.2;
      slot.depth = 0.006;
    } else if (type === "grain") {
      slot.mix = 0.65;
    } else if (type === "resonate") {
      slot.mix = 0.55;
      slot.tune = 48;
      slot.decay = 0.65;
    } else if (type === "tape") {
      slot.mix = 0.7;
      slot.drive = 0.25;
    } else if (type === "repeater") {
      slot.mix = 0.75;
      slot.division = 16;
    } else if (type === "space") {
      slot.mix = 0.45;
    } else if (type === "fold") {
      slot.mix = 0.55;
    } else if (type === "dub") {
      slot.mix = 0.45;
      slot.time = 8;
    } else if (type === "formant") {
      slot.mix = 0.65;
    } else if (type === "motion") {
      slot.mix = 0.5;
      slot.rate = 0.4;
      slot.depth = 0.65;
    } else if (type === "transient") {
      slot.mix = 0.7;
    }
    return slot;
  }

  /** Push settings into DSP; routing only rebuilds when the slot order changes. */
  applySettings() {
    this.ensureThreeSlots();
    const activeCreative = this.settings.slots
      .map((slot) => slot.type)
      .filter(isCreativeEffect);
    activeCreative.forEach((type) => this.ensureCreativeUnit(type));

    this.applyFilter();
    this.applyDrive();
    this.applyCrusher();
    this.applyPhaser();
    this.applyChorus();
    for (const type of activeCreative) {
      this.creativeUnits.get(type)?.apply(this.slotFor(type), this.tempo);
    }
    this.pruneCreativeUnits(new Set(activeCreative));

    const signature = this.settings.slots.map((slot) => slot.type).join("|");
    if (signature !== this.routingSignature) {
      this.rebuildRouting();
      this.routingSignature = signature;
    }
  }

  setTempo(bpm: number) {
    this.tempo = clamp(bpm, 30, 300);
    for (const [type, unit] of this.creativeUnits) {
      unit.apply(this.slotFor(type), this.tempo);
    }
  }

  setDelayTime(seconds: number) {
    this.delay.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.05);
  }

  /** Momentary filter slam. It is audible only when a filter slot is assigned. */
  setFilterOverride(freq: number, q: number) {
    this.filterOverride = { freq, q };
    const t = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(freq, t, 0.02);
    this.filter.Q.setTargetAtTime(q, t, 0.02);
  }

  /** Momentary crush slam. It is audible only when a crusher slot is assigned. */
  setCrushOverride(bits: number, reduction: number, mix: number) {
    this.crushOverride = { bits, reduction, mix };
    this.writeCrush(bits, reduction, mix);
  }

  clearOverrides() {
    this.filterOverride = null;
    this.crushOverride = null;
    this.applySettings();
  }

  private ensureThreeSlots() {
    if (!Array.isArray(this.settings.slots)) this.settings.slots = [];
    while (this.settings.slots.length < 3) this.settings.slots.push(defaultEffectSlot());
    this.settings.slots = this.settings.slots.slice(0, 3).map((slot) => ({
      ...defaultEffectSlot(),
      ...slot,
    }));

    // Older/corrupt projects may contain duplicates. Keep the first one.
    const seen = new Set<EffectType>();
    for (const slot of this.settings.slots) {
      if (slot.type !== "none" && seen.has(slot.type)) slot.type = "none";
      if (slot.type !== "none") seen.add(slot.type);
    }
  }

  private ensureCreativeUnit(type: CreativeEffectType) {
    if (this.creativeUnits.has(type)) return;
    const creative = createCreativeEffect(this.ctx, type, this.makeCreativeNode);
    this.creativeUnits.set(type, creative);
    this.units.set(type, { input: creative.input, output: creative.output });
    this.routingSignature = "";
  }

  /** Stop and release lazy effects as soon as they leave the rack. */
  private pruneCreativeUnits(active: Set<CreativeEffectType>) {
    for (const [type, unit] of this.creativeUnits) {
      if (active.has(type)) continue;
      unit.dispose();
      this.creativeUnits.delete(type);
      this.units.delete(type);
      this.routingSignature = "";
    }
  }

  /** Reconnect only the external unit links; internal unit wiring stays intact. */
  private rebuildRouting() {
    this.input.disconnect();
    for (const unit of this.units.values()) unit.output.disconnect();

    let previous: AudioNode = this.input;
    for (const slot of this.settings.slots) {
      if (slot.type === "none") continue;
      const unit = this.units.get(slot.type);
      if (!unit) continue;
      previous.connect(unit.input);
      previous = unit.output;
    }
    previous.connect(this.destination);
  }

  private slotFor(type: EffectType): EffectSlotSettings {
    return this.settings.slots.find((s) => s.type === type) ?? defaultEffectSlot();
  }

  private applyFilter() {
    if (this.filterOverride) return;
    const s = this.slotFor("filter");
    const t = this.ctx.currentTime;
    this.filter.type = s.filterType;
    this.filter.frequency.setTargetAtTime(s.frequency, t, 0.02);
    this.filter.Q.setTargetAtTime(s.q, t, 0.02);
  }

  private applyDrive() {
    const s = this.slotFor("drive");
    this.driveShape.curve = makeDriveCurve(clamp(s.drive, 0, 1));
    this.writeMix(this.driveWet, this.driveDry, s.mix);
  }

  private applyCrusher() {
    if (this.crushOverride) return;
    const s = this.slotFor("crusher");
    this.writeCrush(s.bits, s.reduction, s.mix);
  }

  private applyPhaser() {
    const s = this.slotFor("phaser");
    const t = this.ctx.currentTime;
    this.writeMix(this.phaserWet, this.phaserDry, s.mix);
    this.phaserLfo.frequency.setTargetAtTime(s.rate, t, 0.02);
    this.phaserDepth.gain.setTargetAtTime(s.depth, t, 0.02);
  }

  private applyChorus() {
    const s = this.slotFor("chorus");
    const t = this.ctx.currentTime;
    this.writeMix(this.chorusWet, this.chorusDry, s.mix);
    this.chorusLfo.frequency.setTargetAtTime(s.rate, t, 0.02);
    this.chorusDepth.gain.setTargetAtTime(s.depth, t, 0.02);
  }

  private writeCrush(bits: number, reduction: number, mix: number) {
    const t = this.ctx.currentTime;
    this.crusher?.parameters.get("bits")?.setValueAtTime(bits, t);
    this.crusher?.parameters.get("reduction")?.setValueAtTime(reduction, t);
    this.writeMix(this.crusherWet, this.crusherDry, mix);
  }

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
