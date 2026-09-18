/** Time source. Production uses the system clock; tests inject a controllable clock. */
export interface Clock {
  now(): Date;
  /** Schedules `fn` after `ms` milliseconds of clock time. Returns a cancel function. */
  setTimer(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimer(ms, fn) {
    // Node timers overflow above 2^31-1 ms; long timers are never needed here.
    const handle = setTimeout(fn, Math.max(0, Math.min(ms, 2_147_483_647)));
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
