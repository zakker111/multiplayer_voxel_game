/**
 * Fixed-step clock for the 20Hz game loop.
 *
 * `setInterval` fires at most once per interval however long the callback took,
 * so a loop that advanced one step per fire lost every millisecond a tick
 * overran. On a CPU-thin host (shared vCPU, GC pause, a burst of bot
 * pathfinding) the whole simulation — round clock, bot timers, build cooldowns
 * — quietly ran in slow motion, and a match that builds a handful of structures
 * in five simulated minutes built next to nothing per wall-clock minute.
 *
 * This clock accumulates the wall time actually elapsed and returns every whole
 * step that is due, so catching up is automatic. The per-fire count is capped:
 * a host too slow to keep up gives up the oldest time (and can report it)
 * instead of bursting an unbounded catch-up into one callback. All arithmetic is
 * in whole milliseconds, so the step math is exact.
 */
export interface TickAdvance {
  /** Whole fixed steps to run for this fire (0 when the timer fired early). */
  steps: number;
  /** Simulation seconds skipped because the cap was hit (0 while keeping up). */
  droppedSeconds: number;
}

export class TickClock {
  private lastMs: number;
  private pendingMs = 0;

  constructor(
    private readonly stepMs: number,
    private readonly maxSteps: number,
    startMs: number = Date.now(),
  ) {
    this.lastMs = startMs;
  }

  advance(nowMs: number): TickAdvance {
    // A clock that jumps backwards (NTP correction) must not rewind the sim.
    this.pendingMs += Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;

    let steps = Math.floor(this.pendingMs / this.stepMs);
    let droppedSeconds = 0;
    if (steps > this.maxSteps) {
      droppedSeconds = ((steps - this.maxSteps) * this.stepMs) / 1000;
      steps = this.maxSteps;
      // Drop the backlog rather than carrying a debt the host cannot pay.
      this.pendingMs = 0;
    } else {
      this.pendingMs = Math.max(0, this.pendingMs - steps * this.stepMs);
    }
    return { steps, droppedSeconds };
  }
}
