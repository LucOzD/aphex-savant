// Shared audio + sequencer types.

export type FilterType = "lowpass" | "highpass" | "bandpass";

/** A step in a track's sequence. */
export interface Step {
  on: boolean;
  /** Pitch offset in semitones applied to the sample/synth for this step. */
  pitch: number;
  /** 0..1 probability the step actually fires on a given pass. */
  probability: number;
  /** 0..1 velocity/level for this step. */
  velocity: number;
}

/** Per-track sound + routing settings. */
export interface TrackSettings {
  name: string;
  /** 0..1 track volume. */
  gain: number;
  /** -1..1 stereo pan. */
  pan: number;
  filterType: FilterType;
  /** Filter cutoff in Hz. */
  cutoff: number;
  /** Filter resonance (Q). */
  resonance: number;
  /** 0..1 send amount to the delay bus. */
  delaySend: number;
  /** 0..1 send amount to the reverb bus. */
  reverbSend: number;
  /** Base playback rate multiplier (before per-step pitch). */
  playbackRate: number;
  /**
   * MIDI note that plays the sample at its recorded pitch. Notes above/below
   * this repitch the sample chromatically. Used by the melodic keyboard.
   */
  rootNote: number;
  /** Amplitude envelope (seconds). */
  attack: number;
  release: number;
  /** Choke group id; tracks sharing a group cut each other off (0 = none). */
  chokeGroup: number;
}

export function defaultTrackSettings(name: string): TrackSettings {
  return {
    name,
    gain: 0.8,
    pan: 0,
    filterType: "lowpass",
    cutoff: 18000,
    resonance: 0.7,
    delaySend: 0,
    reverbSend: 0,
    playbackRate: 1,
    rootNote: 60, // C4
    attack: 0.001,
    release: 0.25,
    chokeGroup: 0,
  };
}

export function defaultStep(): Step {
  return { on: false, pitch: 0, probability: 1, velocity: 1 };
}
