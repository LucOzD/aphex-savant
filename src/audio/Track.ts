import type { MasterChain } from "./MasterChain.ts";
import { semitonesToRate } from "./dsp.ts";
import { defaultTrackSettings, type Note, type Step, type TrackSettings } from "./types.ts";
import { defaultStep } from "./types.ts";

/**
 * One track = one pad = one sound + a 16-step sequence.
 *
 * Persistent per-track chain:
 *   [per-hit source → hitGain(env)] → filter → panner → gain → master.input
 *                                                          ├→ delaySend → delayBus
 *                                                          └→ reverbSend → reverbBus
 */
export class Track {
  readonly settings: TrackSettings;

  /** Drum-machine sequence (used when !melodic). */
  steps: Step[];

  /** Piano-roll notes (used when melodic). */
  notes: Note[] = [];

  /**
   * When true, this track is a melodic/piano-roll instrument: it plays `notes`
   * (pitch + start + length) instead of the on/off `steps` grid.
   */
  melodic = false;

  /** Loop length in steps. Drums default to the bar length; melodic can be longer. */
  length: number;

  private readonly ctx: AudioContext;

  private readonly filter: BiquadFilterNode;
  private readonly panner: StereoPannerNode;
  private readonly gain: GainNode;
  private readonly delaySend: GainNode;
  private readonly reverbSend: GainNode;

  /** Currently-sounding voices, tracked so choke groups can cut them off. */
  private active: AudioBufferSourceNode[] = [];

  buffer: AudioBuffer | null = null;
  /** Optional [start,end] sample offsets in seconds for a sliced region. */
  region: [number, number] | null = null;

  constructor(
    ctx: AudioContext,
    master: MasterChain,
    steps: number,
    settings?: Partial<TrackSettings>,
  ) {
    this.ctx = ctx;
    this.settings = { ...defaultTrackSettings("pad"), ...settings };
    this.steps = Array.from({ length: steps }, () => defaultStep());
    this.length = steps;

    this.filter = ctx.createBiquadFilter();
    this.panner = ctx.createStereoPanner();
    this.gain = ctx.createGain();
    this.delaySend = ctx.createGain();
    this.reverbSend = ctx.createGain();

    this.filter.connect(this.panner);
    this.panner.connect(this.gain);
    this.gain.connect(master.input); // dry
    this.gain.connect(this.delaySend);
    this.gain.connect(this.reverbSend);
    this.delaySend.connect(master.delayBus);
    this.reverbSend.connect(master.reverbBus);

    this.applySettings();
  }

  /** Push the current settings object into the audio nodes. */
  applySettings() {
    const s = this.settings;
    this.filter.type = s.filterType;
    this.filter.frequency.value = s.cutoff;
    this.filter.Q.value = s.resonance;
    this.panner.pan.value = s.pan;
    this.gain.gain.value = s.gain;
    this.delaySend.gain.value = s.delaySend;
    this.reverbSend.gain.value = s.reverbSend;
  }

  setBuffer(buffer: AudioBuffer | null, region: [number, number] | null = null) {
    this.buffer = buffer;
    this.region = region;
  }

  /**
   * Trigger the sound.
   * @param when   AudioContext time to start.
   * @param semis  Extra pitch offset in semitones (from a step or note).
   * @param velocity 0..1 level.
   * @param gateSeconds  Optional note length in real seconds. If given, the
   *   sample is cut off (and released) after this long — this is what makes the
   *   piano roll's note lengths behave like a DAW.
   */
  trigger(when: number, semis = 0, velocity = 1, gateSeconds?: number) {
    if (!this.buffer) return;
    const s = this.settings;

    if (s.chokeGroup !== 0) this.chokeActive(when);

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const rate = s.playbackRate * semitonesToRate(semis);
    src.playbackRate.value = rate;

    const hitGain = this.ctx.createGain();
    // Amplitude envelope: quick attack to `velocity`, then release.
    const peak = Math.max(0.0001, velocity);
    hitGain.gain.setValueAtTime(0.0001, when);
    hitGain.gain.linearRampToValueAtTime(peak, when + s.attack);

    src.connect(hitGain);
    hitGain.connect(this.filter);

    let offset = 0;
    let regionDur: number | undefined; // source-domain seconds
    if (this.region) {
      offset = this.region[0];
      regionDur = Math.max(0.01, this.region[1] - this.region[0]);
    }

    // Real playback time to sound the whole sample/region at this rate.
    const naturalReal = (regionDur ?? this.buffer.duration) / rate;
    // Gate to the note length if one was supplied.
    const soundReal = gateSeconds != null ? Math.min(naturalReal, gateSeconds) : naturalReal;

    hitGain.gain.setTargetAtTime(0.0001, when + soundReal, s.release / 3 + 0.01);
    const stopAt = when + soundReal + s.release;

    if (regionDur !== undefined) src.start(when, offset, regionDur);
    else src.start(when, offset);
    src.stop(stopAt);

    this.active.push(src);
    src.onended = () => {
      this.active = this.active.filter((a) => a !== src);
      try {
        hitGain.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  private chokeActive(when: number) {
    for (const src of this.active) {
      try {
        src.stop(when + 0.005);
      } catch {
        /* ignore */
      }
    }
  }
}
