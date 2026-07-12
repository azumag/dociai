// Progress/speed/ETA computation for the download service (#76). Deliberately pure and
// clock-injectable so it is unit-testable without real timers or a real network transfer.

export type ProgressSnapshot = {
  bytesDownloaded: number;
  totalBytes?: number;
  bytesPerSecond: number;
  etaSeconds?: number;
  percent?: number;
};

/** Tracks a rolling window of (time, bytesDownloaded) samples and derives an instantaneous
 * transfer rate from the oldest sample still inside the window, rather than from the single most
 * recent delta — a single delta is noisy (one big/small chunk skews it wildly), while a rolling
 * window smooths that out into a rate a human reading a progress bar finds stable. */
export class ProgressTracker {
  #samples: Array<{ at: number; bytes: number }> = [];

  constructor(private readonly windowMs = 5000, private readonly now: () => number = Date.now) {}

  snapshot(bytesDownloaded: number, totalBytes?: number): ProgressSnapshot {
    const at = this.now();
    this.#samples.push({ at, bytes: bytesDownloaded });
    while (this.#samples.length > 1 && at - this.#samples[0].at > this.windowMs) this.#samples.shift();

    const oldest = this.#samples[0];
    const elapsedSeconds = (at - oldest.at) / 1000;
    const bytesPerSecond = elapsedSeconds > 0 ? Math.max(0, (bytesDownloaded - oldest.bytes) / elapsedSeconds) : 0;
    const remaining = totalBytes !== undefined ? Math.max(0, totalBytes - bytesDownloaded) : undefined;
    const etaSeconds = remaining !== undefined && bytesPerSecond > 0 ? remaining / bytesPerSecond : undefined;
    const percent = totalBytes !== undefined && totalBytes > 0 ? Math.min(100, (bytesDownloaded / totalBytes) * 100) : undefined;
    return { bytesDownloaded, totalBytes, bytesPerSecond, etaSeconds, percent };
  }

  reset(): void {
    this.#samples = [];
  }
}

/** Wraps `emit` so it fires at most once per `intervalMs`, plus always on `force` (used for the
 * first sample of a job and the final terminal sample, both of which the UI must never miss even
 * if they land inside the throttle window). */
export function createThrottledEmitter<T>(intervalMs: number, emit: (value: T) => void, now: () => number = Date.now): (value: T, force?: boolean) => void {
  let last = -Infinity;
  return (value: T, force = false) => {
    const at = now();
    if (!force && at - last < intervalMs) return;
    last = at;
    emit(value);
  };
}
