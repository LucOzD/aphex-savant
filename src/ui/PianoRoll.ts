import type { Track } from "../audio/Track.ts";
import { isBlackKey, midiToName } from "../audio/music.ts";
import { el } from "./dom.ts";

/**
 * DAW-style piano roll for a melodic track. Rows are pitches (high at the top),
 * columns are steps along the timeline. Tap an empty cell to place a note of the
 * current length; tap an existing note to remove it. Notes carry pitch, start,
 * and length, so the track plays like a melodic instrument rather than a drum
 * grid.
 */
export class PianoRoll {
  readonly root: HTMLElement;

  private lengthRow: HTMLElement;
  private gridWrap: HTMLElement;
  private grid: HTMLElement;

  private track: Track | null = null;
  private low: number;
  private high: number;
  private cols = 16;

  /** Length (in steps) of a newly-placed note. */
  private noteLen = 2;
  private lengthBtns: { len: number; el: HTMLButtonElement }[] = [];

  /** cells[rowIndex][col] — rowIndex 0 = highest pitch. */
  private cells: HTMLButtonElement[][] = [];
  private lastPlayCol = -1;

  /** Called to audition a pitch when a note is placed or a key label tapped. */
  onAudition: (pitch: number) => void = () => {};

  constructor(low: number, high: number) {
    this.low = low;
    this.high = high;

    this.lengthRow = el("div", { class: "row" });
    this.grid = el("div", { class: "roll-grid" });
    this.gridWrap = el("div", { class: "roll-wrap" }, [this.grid]);

    this.buildLengthSelector();
    this.root = el("div", { class: "panel" }, [this.lengthRow, this.gridWrap]);
  }

  private buildLengthSelector() {
    this.lengthRow.append(el("span", { class: "hint" }, ["note length:"]));
    for (const len of [1, 2, 4, 8]) {
      const label = len === 1 ? "1/16" : len === 2 ? "1/8" : len === 4 ? "1/4" : "1/2";
      const btn = el("button", { class: "ctrl" }, [label]) as HTMLButtonElement;
      btn.addEventListener("click", () => {
        this.noteLen = len;
        this.refreshLengthButtons();
      });
      this.lengthBtns.push({ len, el: btn });
      this.lengthRow.append(btn);
    }
    this.refreshLengthButtons();
  }

  private refreshLengthButtons() {
    this.lengthBtns.forEach(({ len, el: b }) => b.classList.toggle("active", len === this.noteLen));
  }

  setTrack(track: Track) {
    this.track = track;
    this.cols = track.length;
    this.render();
  }

  private render() {
    this.grid.innerHTML = "";
    this.cells = [];
    if (!this.track) return;

    const rows = this.high - this.low + 1;
    // 1 label column + one column per step.
    this.grid.style.gridTemplateColumns = `44px repeat(${this.cols}, 22px)`;

    for (let r = 0; r < rows; r++) {
      const pitch = this.high - r;
      const rowCells: HTMLButtonElement[] = [];

      // Pitch label (also auditions the note).
      const label = el(
        "button",
        { class: `roll-label ${isBlackKey(pitch) ? "black" : "white"}` },
        [midiToName(pitch)],
      ) as HTMLButtonElement;
      label.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.onAudition(pitch);
      });
      this.grid.append(label);

      for (let c = 0; c < this.cols; c++) {
        const cell = el("button", {
          class: `roll-cell${c % 4 === 0 ? " bar" : ""}${isBlackKey(pitch) ? " blackrow" : ""}`,
        }) as HTMLButtonElement;
        cell.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          this.toggleNoteAt(pitch, c);
        });
        rowCells.push(cell);
        this.grid.append(cell);
      }
      this.cells.push(rowCells);
    }
    this.paintNotes();
  }

  private toggleNoteAt(pitch: number, col: number) {
    const track = this.track;
    if (!track) return;
    const notes = track.notes;

    // Existing note in this row covering the column? Remove it.
    const idx = notes.findIndex(
      (n) => n.pitch === pitch && col >= n.start && col < n.start + n.length,
    );
    if (idx >= 0) {
      notes.splice(idx, 1);
    } else {
      const length = Math.max(1, Math.min(this.noteLen, this.cols - col));
      // Clear anything overlapping in this row before adding.
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (n.pitch === pitch && n.start < col + length && n.start + n.length > col) {
          notes.splice(i, 1);
        }
      }
      notes.push({ pitch, start: col, length, velocity: 1 });
      this.onAudition(pitch);
    }
    this.paintNotes();
  }

  private paintNotes() {
    if (!this.track) return;
    // Clear.
    for (const row of this.cells) {
      for (const cell of row) cell.classList.remove("note", "note-start");
    }
    // Paint.
    for (const note of this.track.notes) {
      const r = this.high - note.pitch;
      if (r < 0 || r >= this.cells.length) continue;
      for (let c = note.start; c < note.start + note.length && c < this.cols; c++) {
        const cell = this.cells[r]?.[c];
        if (!cell) continue;
        cell.classList.add("note");
        if (c === note.start) cell.classList.add("note-start");
      }
    }
  }

  /** Highlight the currently-playing column. */
  setPlayhead(col: number) {
    if (this.lastPlayCol === col) return;
    if (this.lastPlayCol >= 0) {
      for (const row of this.cells) row[this.lastPlayCol]?.classList.remove("playing");
    }
    if (col >= 0) {
      for (const row of this.cells) row[col]?.classList.add("playing");
    }
    this.lastPlayCol = col;
  }
}
