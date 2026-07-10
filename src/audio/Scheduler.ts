/**
 * Lookahead scheduler ("A Tale of Two Clocks"). A timer wakes frequently and
 * schedules any steps due within the lookahead window using the precise audio
 * clock, so timing stays tight even when the main thread is busy.
 */
export class Scheduler {
  /** How often the timer fires, ms. */
  private readonly interval = 25;
  /** How far ahead we schedule, seconds. */
  private readonly lookahead = 0.1;

  private ctx: AudioContext;
  private timer: number | null = null;
  private nextNoteTime = 0;
  private step = 0;

  /** Called for each step: (stepIndex, audioTime). */
  onStep: (step: number, time: number) => void = () => {};
  /** Total steps in a bar. */
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
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.tick(), this.interval);
  }

  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private secondsPerStep(): number {
    // 16 steps per bar => a step is a 16th note (quarter / 4).
    return 60 / this.bpm / 4;
  }

  private tick() {
    while (this.nextNoteTime < this.ctx.currentTime + this.lookahead) {
      let time = this.nextNoteTime;
      // Apply swing to odd (off-beat) 16ths.
      if (this.step % 2 === 1) {
        time += this.secondsPerStep() * this.swing * 0.5;
      }
      this.onStep(this.step, time);
      this.nextNoteTime += this.secondsPerStep();
      this.step = (this.step + 1) % this.totalSteps;
    }
  }
}
