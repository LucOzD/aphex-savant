// Shared audio + sequencer types.

import type { ChordExtension, ChordQualityId, ChordVoicing, ScaleId } from "./musicTheory.ts";

export type FilterType = "lowpass" | "highpass" | "bandpass";
export type PlayingLayout = "keys" | "scale" | "chords";
export type ChordSubmode = "diatonic" | "free";

export interface MelodicLoopEvent {
  midi: number;
  /** Start and duration measured in sequencer sixteenth-note steps. */
  startStep: number;
  durationSteps: number;
  velocity: number;
}

/** Persisted performance state for one sample instrument/pad. */
export interface MelodicPerformanceSettings {
  /** MIDI note at which the sample plays at its original speed. */
  sampleRootMidi: number;
  playLayout: PlayingLayout;
  scaleRoot: number;
  scaleId: ScaleId;
  performanceOctave: number;
  chordSubmode: ChordSubmode;
  chordExtension: ChordExtension;
  chordQuality: ChordQualityId;
  chordInversion: number;
  chordVoicing: ChordVoicing;
  chordStrumMs: number;
  polyphony: number;
  melodicLoopBars: number;
  melodicLoopEnabled: boolean;
}

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
export interface TrackSettings extends MelodicPerformanceSettings {
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
  /** Amplitude envelope (seconds). */
  attack: number;
  release: number;
  /** Choke group id; tracks sharing a group cut each other off (0 = none). */
  chokeGroup: number;
  /** When true, retriggering this pad cuts off the previous sound (self-choke). */
  mono: boolean;
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
    sampleRootMidi: 60,
    playLayout: "scale",
    scaleRoot: 0,
    scaleId: "major",
    performanceOctave: 4,
    chordSubmode: "diatonic",
    chordExtension: "triad",
    chordQuality: "major",
    chordInversion: 0,
    chordVoicing: "close",
    chordStrumMs: 0,
    polyphony: 8,
    melodicLoopBars: 2,
    melodicLoopEnabled: false,
    attack: 0.001,
    release: 0.25,
    chokeGroup: 0,
    mono: false,
  };
}

export function defaultStep(): Step {
  return { on: false, pitch: 0, probability: 1, velocity: 1 };
}
