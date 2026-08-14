import type { FxChain } from "./FxChain.ts";
import { semitonesToRate } from "./dsp.ts";
import { defaultTrackSettings, type MelodicLoopEvent, type Step, type TrackSettings } from "./types.ts";
import { defaultStep } from "./types.ts";

export type VoiceId = number;

interface Voice {
  id: VoiceId;
  source: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
  released: boolean;
}

/**
 * One track = one pad = one sound + a 16-step sequence.
 *
 * Persistent per-track chain, feeding its own bank's FX chain:
 *   [per-hit source → hitGain(env)] → filter → panner → gain → chain.input
 *                                                          ├→ delaySend → delayBus
 *                                                          └→ reverbSend → reverbBus
 */
export class Track {
  readonly settings: TrackSettings;

  /** Step sequence. */
  steps: Step[];

  /** Loop length in steps. */
  length: number;

  /** Live-recorded melodic notes, measured in sixteenth-note steps. */
  melodicLoopEvents: MelodicLoopEvent[] = [];
  /** Runtime phase offset used when recording starts mid-transport. */
  melodicLoopPhaseOffset = 0;

  private readonly ctx: BaseAudioContext;

  private readonly filter: BiquadFilterNode;
  private readonly panner: StereoPannerNode;
  private readonly gain: GainNode;
  private readonly delaySend: GainNode;
  private readonly reverbSend: GainNode;

  /** Active and future-scheduled voices for note-off and oldest-voice stealing. */
  private active: Voice[] = [];
  private nextVoiceId = 1;

  buffer: AudioBuffer | null = null;
  /** Optional [start,end] sample offsets in seconds for a sliced region. */
  region: [number, number] | null = null;

  constructor(
    ctx: BaseAudioContext,
    chain: FxChain,
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
    this.gain.connect(chain.input); // dry
    this.gain.connect(this.delaySend);
    this.gain.connect(this.reverbSend);
    this.delaySend.connect(chain.delayBus);
    this.reverbSend.connect(chain.reverbBus);

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
   * Set the loop length in steps. Grows the step array as needed (never shrinks
   * the stored data, so shortening then re-lengthening keeps your hits). Enables
   * per-track polymeter / polyrhythms.
   */
  setLength(steps: number) {
    this.length = Math.max(1, Math.round(steps));
    while (this.steps.length < this.length) this.steps.push(defaultStep());
  }

  /** One-shot sequencer/drum compatibility path using a semitone offset. */
  trigger(when: number, semis = 0, velocity = 1): VoiceId | null {
    return this.startVoice(when, semis, velocity, false);
  }

  /** Held melodic-note path. MIDI-to-pitch conversion is isolated for future DSP replacement. */
  noteOnMidi(when: number, midi: number, velocity = 1): VoiceId | null {
    const semitones = Math.round(midi) - this.settings.sampleRootMidi;
    return this.startVoice(when, semitones, velocity, true);
  }

  noteOff(id: VoiceId, when = this.ctx.currentTime) {
    const voice = this.active.find((item) => item.id === id);
    if (!voice || voice.released) return;
    this.releaseVoice(voice, when, false);
  }

  allNotesOff(when = this.ctx.currentTime, fast = false) {
    for (const voice of [...this.active]) this.releaseVoice(voice, when, fast);
  }

  dispose() {
    this.allNotesOff(this.ctx.currentTime, true);
    try { this.filter.disconnect(); } catch { /* disconnected */ }
    try { this.panner.disconnect(); } catch { /* disconnected */ }
    try { this.gain.disconnect(); } catch { /* disconnected */ }
    try { this.delaySend.disconnect(); } catch { /* disconnected */ }
    try { this.reverbSend.disconnect(); } catch { /* disconnected */ }
  }

  private startVoice(
    when: number,
    semis: number,
    velocity: number,
    enforcePolyphony: boolean,
  ): VoiceId | null {
    if (!this.buffer) return null;
    const s = this.settings;
    const startAt = Math.max(when, this.ctx.currentTime);

    if (s.mono || s.chokeGroup !== 0) {
      this.allNotesOff(startAt, true);
      this.active = this.active.filter((voice) => !voice.released);
    }
    const limit = enforcePolyphony ? Math.max(1, Math.round(s.polyphony || 8)) : Infinity;
    while (this.active.length >= limit) {
      const oldest = this.active.reduce((a, b) => a.startedAt <= b.startedAt ? a : b);
      this.releaseVoice(oldest, startAt, true);
      // The voice remains registered until onended, so remove it from the
      // polyphony count immediately after scheduling its short steal fade.
      this.active = this.active.filter((voice) => voice !== oldest);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    const rate = Math.max(0.001, s.playbackRate * semitonesToRate(semis));
    source.playbackRate.value = rate;

    const hitGain = this.ctx.createGain();
    const peak = Math.max(0.0001, Math.min(1, velocity));
    hitGain.gain.setValueAtTime(0.0001, startAt);
    hitGain.gain.linearRampToValueAtTime(peak, startAt + Math.max(0, s.attack));
    source.connect(hitGain);
    hitGain.connect(this.filter);

    let offset = 0;
    let regionDuration: number | undefined;
    if (this.region) {
      offset = this.region[0];
      regionDuration = Math.max(0.01, this.region[1] - this.region[0]);
    }
    const sourceDuration = (regionDuration ?? this.buffer.duration) / rate;
    const naturalEnd = startAt + sourceDuration;
    hitGain.gain.setTargetAtTime(0.0001, naturalEnd, s.release / 3 + 0.01);

    const voice: Voice = {
      id: this.nextVoiceId++,
      source,
      gain: hitGain,
      startedAt: startAt,
      released: false,
    };
    this.active.push(voice);
    source.onended = () => this.removeVoice(voice);

    if (regionDuration !== undefined) source.start(startAt, offset, regionDuration);
    else source.start(startAt, offset);
    source.stop(naturalEnd + Math.max(0.02, s.release));
    return voice.id;
  }

  private releaseVoice(voice: Voice, when: number, fast: boolean) {
    if (voice.released) return;
    voice.released = true;
    const now = this.ctx.currentTime;

    // A strummed voice released before its scheduled start must never sound.
    if (when < voice.startedAt - 0.001) {
      try { voice.source.stop(Math.max(now, when) + 0.001); } catch { /* ended */ }
      return;
    }

    const releaseAt = Math.max(now, when, voice.startedAt);
    const release = fast ? 0.012 : Math.max(0.015, this.settings.release);
    const param = voice.gain.gain as AudioParam & {
      cancelAndHoldAtTime?: (time: number) => AudioParam;
    };
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(releaseAt);
    } else {
      param.cancelScheduledValues(releaseAt);
      param.setValueAtTime(Math.max(0.0001, param.value), releaseAt);
    }
    param.linearRampToValueAtTime(0.0001, releaseAt + release);
    try { voice.source.stop(releaseAt + release + 0.01); } catch { /* ended */ }
  }

  private removeVoice(voice: Voice) {
    this.active = this.active.filter((item) => item !== voice);
    try { voice.source.disconnect(); } catch { /* disconnected */ }
    try { voice.gain.disconnect(); } catch { /* disconnected */ }
  }
}
