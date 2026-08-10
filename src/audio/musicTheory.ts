export type NoteSpelling = "sharps" | "flats";

export interface ScaleDefinition {
  id: string;
  name: string;
  category: "Common" | "Modes" | "Symmetric" | "World";
  intervals: readonly number[];
}

export interface ChordDefinition {
  id: string;
  name: string;
  symbol: string;
  intervals: readonly number[];
}

export type ChordExtension = "triad" | "7th" | "9th";
export type ChordVoicing = "close" | "open";

export const SCALES = [
  { id: "chromatic", name: "Chromatic", category: "Common", intervals: [0,1,2,3,4,5,6,7,8,9,10,11] },
  { id: "major", name: "Major / Ionian", category: "Common", intervals: [0,2,4,5,7,9,11] },
  { id: "natural-minor", name: "Natural Minor / Aeolian", category: "Common", intervals: [0,2,3,5,7,8,10] },
  { id: "harmonic-minor", name: "Harmonic Minor", category: "Common", intervals: [0,2,3,5,7,8,11] },
  { id: "melodic-minor", name: "Melodic Minor", category: "Common", intervals: [0,2,3,5,7,9,11] },
  { id: "major-pentatonic", name: "Major Pentatonic", category: "Common", intervals: [0,2,4,7,9] },
  { id: "minor-pentatonic", name: "Minor Pentatonic", category: "Common", intervals: [0,3,5,7,10] },
  { id: "blues", name: "Blues", category: "Common", intervals: [0,3,5,6,7,10] },
  { id: "dorian", name: "Dorian", category: "Modes", intervals: [0,2,3,5,7,9,10] },
  { id: "phrygian", name: "Phrygian", category: "Modes", intervals: [0,1,3,5,7,8,10] },
  { id: "lydian", name: "Lydian", category: "Modes", intervals: [0,2,4,6,7,9,11] },
  { id: "mixolydian", name: "Mixolydian", category: "Modes", intervals: [0,2,4,5,7,9,10] },
  { id: "locrian", name: "Locrian", category: "Modes", intervals: [0,1,3,5,6,8,10] },
  { id: "phrygian-dominant", name: "Phrygian Dominant", category: "Modes", intervals: [0,1,4,5,7,8,10] },
  { id: "whole-tone", name: "Whole Tone", category: "Symmetric", intervals: [0,2,4,6,8,10] },
  { id: "diminished-half-whole", name: "Diminished Half-Whole", category: "Symmetric", intervals: [0,1,3,4,6,7,9,10] },
  { id: "diminished-whole-half", name: "Diminished Whole-Half", category: "Symmetric", intervals: [0,2,3,5,6,8,9,11] },
  { id: "hungarian-minor", name: "Hungarian Minor", category: "World", intervals: [0,2,3,6,7,8,11] },
  { id: "hirajoshi", name: "Hirajoshi", category: "World", intervals: [0,2,3,7,8] },
  { id: "in-sen", name: "In Sen", category: "World", intervals: [0,1,5,7,10] },
] as const satisfies readonly ScaleDefinition[];

export type ScaleId = (typeof SCALES)[number]["id"];

export const CHORDS = [
  { id: "major", name: "Major", symbol: "", intervals: [0,4,7] },
  { id: "minor", name: "Minor", symbol: "m", intervals: [0,3,7] },
  { id: "diminished", name: "Diminished", symbol: "dim", intervals: [0,3,6] },
  { id: "augmented", name: "Augmented", symbol: "+", intervals: [0,4,8] },
  { id: "sus2", name: "Sus2", symbol: "sus2", intervals: [0,2,7] },
  { id: "sus4", name: "Sus4", symbol: "sus4", intervals: [0,5,7] },
  { id: "power", name: "Power / fifth", symbol: "5", intervals: [0,7] },
  { id: "major-6", name: "Major 6", symbol: "6", intervals: [0,4,7,9] },
  { id: "minor-6", name: "Minor 6", symbol: "m6", intervals: [0,3,7,9] },
  { id: "dominant-7", name: "Dominant 7", symbol: "7", intervals: [0,4,7,10] },
  { id: "major-7", name: "Major 7", symbol: "maj7", intervals: [0,4,7,11] },
  { id: "minor-7", name: "Minor 7", symbol: "m7", intervals: [0,3,7,10] },
  { id: "minor-major-7", name: "Minor-major 7", symbol: "m(maj7)", intervals: [0,3,7,11] },
  { id: "half-diminished-7", name: "Half-diminished 7", symbol: "m7♭5", intervals: [0,3,6,10] },
  { id: "diminished-7", name: "Diminished 7", symbol: "dim7", intervals: [0,3,6,9] },
  { id: "add9", name: "Add9", symbol: "add9", intervals: [0,4,7,14] },
  { id: "minor-add9", name: "Minor add9", symbol: "m(add9)", intervals: [0,3,7,14] },
  { id: "major-9", name: "Major 9", symbol: "maj9", intervals: [0,4,7,11,14] },
  { id: "minor-9", name: "Minor 9", symbol: "m9", intervals: [0,3,7,10,14] },
  { id: "dominant-9", name: "Dominant 9", symbol: "9", intervals: [0,4,7,10,14] },
] as const satisfies readonly ChordDefinition[];

export type ChordQualityId = (typeof CHORDS)[number]["id"];

const NOTE_NAMES: Record<NoteSpelling, readonly string[]> = {
  sharps: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"],
  flats: ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"],
};

export function pitchClassName(pitchClass: number, spelling: NoteSpelling = "sharps"): string {
  return NOTE_NAMES[spelling][mod(pitchClass, 12)];
}

export function noteName(midi: number, spelling: NoteSpelling = "sharps"): string {
  const note = Math.round(midi);
  return `${pitchClassName(note, spelling)}${Math.floor(note / 12) - 1}`;
}

export function midiForPitchClass(pitchClass: number, octave: number): number {
  return clampMidi((Math.round(octave) + 1) * 12 + mod(pitchClass, 12));
}

export function getScale(id: string): ScaleDefinition {
  return SCALES.find((scale) => scale.id === id) ?? SCALES[1];
}

export function getChord(id: string): ChordDefinition {
  return CHORDS.find((chord) => chord.id === id) ?? CHORDS[0];
}

export interface ScalePadNote {
  midi: number;
  degree: number;
  isRoot: boolean;
}

export function scalePadNotes(
  rootPitchClass: number,
  scale: ScaleDefinition,
  octave: number,
  count = 16,
): ScalePadNote[] {
  const base = midiForPitchClass(rootPitchClass, octave);
  return Array.from({ length: count }, (_, index) => {
    const degree = index % scale.intervals.length;
    const scaleOctave = Math.floor(index / scale.intervals.length);
    return {
      midi: clampMidi(base + scale.intervals[degree] + scaleOctave * 12),
      degree: degree + 1,
      isRoot: degree === 0,
    };
  });
}

export function buildDiatonicChord(
  rootPitchClass: number,
  scale: ScaleDefinition,
  octave: number,
  degree: number,
  extension: ChordExtension,
): number[] {
  const noteCount = extension === "triad" ? 3 : extension === "7th" ? 4 : 5;
  const intervals = scale.intervals;
  const base = midiForPitchClass(rootPitchClass, octave);
  const result: number[] = [];
  for (let index = 0; index < noteCount; index++) {
    const scaleIndex = degree + index * 2;
    const interval = intervals[scaleIndex % intervals.length]
      + Math.floor(scaleIndex / intervals.length) * 12;
    result.push(base + interval);
  }
  return fitMidiRange(ascending(result));
}

export function voiceChord(
  rootMidi: number,
  intervals: readonly number[],
  inversion: number,
  voicing: ChordVoicing,
): number[] {
  const notes = ascending(intervals.map((interval) => Math.round(rootMidi + interval)));
  const turns = Math.max(0, Math.round(inversion));
  for (let index = 0; index < turns && notes.length > 1; index++) {
    notes.push(notes.shift()! + 12);
    notes.sort((a, b) => a - b);
  }
  if (voicing === "open" && notes.length >= 3) {
    for (let index = 1; index < notes.length; index += 2) notes[index] += 12;
    notes.sort((a, b) => a - b);
  }
  return fitMidiRange(ascending(notes));
}

export function chordName(notes: readonly number[], spelling: NoteSpelling = "sharps"): string {
  if (notes.length === 0) return "—";
  const root = notes[0];
  const intervals = notes.map((note) => note - root);
  const match = CHORDS.find((chord) => sameIntervals(chord.intervals, intervals));
  const rootName = pitchClassName(root, spelling);
  if (match) return `${rootName}${match.symbol}`;
  return `${rootName} (${notes.map((note) => noteName(note, spelling)).join(" · ")})`;
}

export function degreeLabel(degree: number): string {
  const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
  return roman[degree] ?? String(degree + 1);
}

function sameIntervals(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function ascending(notes: number[]): number[] {
  for (let index = 1; index < notes.length; index++) {
    while (notes[index] <= notes[index - 1]) notes[index] += 12;
  }
  return notes;
}

function fitMidiRange(notes: number[]): number[] {
  if (notes.length === 0) return notes;
  while (notes[notes.length - 1] > 127) notes = notes.map((note) => note - 12);
  while (notes[0] < 0) notes = notes.map((note) => note + 12);
  return notes.map((note) => Math.round(note));
}

function clampMidi(value: number): number {
  return Math.max(0, Math.min(127, Math.round(value)));
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}