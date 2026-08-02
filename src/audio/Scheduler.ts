/**
 * Lookahead scheduler ("A Tale of Two Clocks"). A timer wakes frequently and
 * schedules any steps due within the lookahead window using the precise audio
 * clock, so timing stays tight even when the main thread is busy.
 */
export class Scheduler {
  /**
   * How often the timer fires, ms. Kept short so edits you make while playing
   * (toggling a step, changing a knob) get picked up quickly.
   */
  private readonly interval = 10;
  /**
   * How far ahead we schedule, seconds. This is the tradeoff: a wider window is
   * more robust against main-thread stalls, but it also means a step you toggle
   * may already have been scheduled, which feels unresponsive. 40ms is enough
   * headroom to survive a dropped frame while still reacting quickly.
   */
  private readonly lookahead = 0.04;

  private ctx: AudioContext;
  private timer: number | null = null;
  private nextNoteTime = 0;
  private step = 0;

  /**
   * Called for each step: (absoluteStep, audioTime). The step counter is
   * monotonic (never wraps); each track applies its own loop length via modulo,
   * which allows tracks of different lengths to play together.
   */
  onStep: (step: number, time: number) => void = () => {};
  /** Reference bar length in steps (used by consumers, not for wrapping). */
  totalSteps = 16;
  /** Beats per minute. */
  bpm = 120;
  /** Swing amount 0..1 (delays every other 16th). */
  swing = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start() {
    if (this.timer !== null) return;
    this.step = 0;
    // Small offset so the first step isn't scheduled in the past.
    this.nextNoteTime = this.ctx.currentTime + 0.015;
    this.tick(); // schedule immediately rather than waiting for the first timer
    this.timer = window.setInterval(() => this.tick(), this.interval);
  }

  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Duration of one step (a 16th note) in seconds. */
  get stepDuration(): number {
    return 60 / this.bpm / 4;
  }

  private tick() {
    while (this.nextNoteTime < this.ctx.currentTime + this.lookahead) {
      let time = this.nextNoteTime;
      // Apply swing to odd (off-beat) 16ths.
      if (this.step % 2 === 1) {
        time += this.stepDuration * this.swing * 0.5;
      }
      this.onStep(this.step, time);
      this.nextNoteTime += this.stepDuration;
      this.step += 1; // monotonic; tracks wrap via their own length
    }
  }
}
