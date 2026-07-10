import { el } from "./dom.ts";

/**
 * Waveform display with a draggable start/end selection so you can grab a
 * specific moment out of a recording. Selection is stored as 0..1 fractions of
 * the buffer and exposed in seconds via getRegion().
 */
export class WaveformEditor {
  readonly root: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private selEl: HTMLElement;
  private startHandle: HTMLElement;
  private endHandle: HTMLElement;

  private buffer: AudioBuffer | null = null;
  private peaks: { min: number; max: number }[] = [];

  // Selection as fractions 0..1.
  private startFrac = 0;
  private endFrac = 1;

  private dragging: "start" | "end" | "new" | null = null;
  private anchorFrac = 0;

  /** Fired when the selection changes, with seconds. */
  onChange: (start: number, end: number) => void = () => {};

  constructor() {
    this.canvas = el("canvas", { class: "wave-canvas" }) as HTMLCanvasElement;
    this.ctx2d = this.canvas.getContext("2d")!;
    this.selEl = el("div", { class: "wave-sel" });
    this.startHandle = el("div", { class: "wave-handle" });
    this.endHandle = el("div", { class: "wave-handle" });
    this.root = el("div", { class: "wave" }, [
      this.canvas,
      this.selEl,
      this.startHandle,
      this.endHandle,
    ]);

    this.attachPointerEvents();
    window.addEventListener("resize", () => this.redraw());
  }

  hasBuffer(): boolean {
    return this.buffer !== null;
  }

  setBuffer(buffer: AudioBuffer) {
    this.buffer = buffer;
    this.startFrac = 0;
    this.endFrac = 1;
    this.computePeaks();
    this.redraw();
    this.updateOverlay();
    this.emit();
  }

  /** Current selection in seconds. */
  getRegion(): [number, number] {
    const dur = this.buffer?.duration ?? 0;
    return [this.startFrac * dur, this.endFrac * dur];
  }

  // ---- Peak analysis ------------------------------------------------------

  private computePeaks() {
    this.peaks = [];
    if (!this.buffer) return;
    const data = this.buffer.getChannelData(0);
    const width = Math.max(1, this.canvasWidth());
    const per = Math.floor(data.length / width) || 1;
    for (let x = 0; x < width; x++) {
      let min = 1;
      let max = -1;
      const start = x * per;
      const end = Math.min(data.length, start + per);
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      this.peaks.push({ min, max });
    }
  }

  private canvasWidth(): number {
    return Math.floor(this.root.clientWidth || 320);
  }

  // ---- Drawing ------------------------------------------------------------

  redraw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvasWidth();
    const h = 120;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = "100%";
    this.canvas.style.height = `${h}px`;

    const ctx = this.ctx2d;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Background.
    ctx.fillStyle = "#14141c";
    ctx.fillRect(0, 0, w, h);

    if (!this.buffer) {
      ctx.fillStyle = "#8a8a9a";
      ctx.font = "12px sans-serif";
      ctx.fillText("record or open a file to edit", 12, h / 2);
      return;
    }

    // Recompute peaks if the width changed.
    if (this.peaks.length !== w) this.computePeaks();

    // Waveform.
    const mid = h / 2;
    ctx.strokeStyle = "#39c0ff";
    ctx.beginPath();
    for (let x = 0; x < this.peaks.length; x++) {
      const p = this.peaks[x];
      ctx.moveTo(x + 0.5, mid - p.max * mid);
      ctx.lineTo(x + 0.5, mid - p.min * mid);
    }
    ctx.stroke();

    // Zero line.
    ctx.strokeStyle = "#2a2a38";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }

  private updateOverlay() {
    const left = this.startFrac * 100;
    const width = (this.endFrac - this.startFrac) * 100;
    this.selEl.style.left = `${left}%`;
    this.selEl.style.width = `${width}%`;
    this.startHandle.style.left = `${left}%`;
    this.endHandle.style.left = `${this.endFrac * 100}%`;
  }

  private emit() {
    const [s, e] = this.getRegion();
    this.onChange(s, e);
  }

  // ---- Pointer interaction ------------------------------------------------

  private fracFromEvent(e: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    return Math.min(1, Math.max(0, x));
  }

  private attachPointerEvents() {
    const onStartHandle = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragging = "start";
    };
    const onEndHandle = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragging = "end";
    };
    this.startHandle.addEventListener("pointerdown", onStartHandle);
    this.endHandle.addEventListener("pointerdown", onEndHandle);

    // Drag anywhere on the waveform to draw a fresh selection.
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.buffer) return;
      e.preventDefault();
      this.anchorFrac = this.fracFromEvent(e);
      this.startFrac = this.anchorFrac;
      this.endFrac = this.anchorFrac;
      this.dragging = "new";
      this.updateOverlay();
    });

    window.addEventListener("pointermove", (e) => {
      if (!this.dragging || !this.buffer) return;
      const f = this.fracFromEvent(e);
      if (this.dragging === "start") {
        this.startFrac = Math.min(f, this.endFrac - 0.002);
      } else if (this.dragging === "end") {
        this.endFrac = Math.max(f, this.startFrac + 0.002);
      } else {
        // "new" drag-select from the anchor point.
        this.startFrac = Math.min(this.anchorFrac, f);
        this.endFrac = Math.max(this.anchorFrac, f);
      }
      this.updateOverlay();
    });

    window.addEventListener("pointerup", () => {
      if (this.dragging) {
        this.dragging = null;
        this.emit();
      }
    });
  }
}
