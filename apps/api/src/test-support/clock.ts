/**
 * Controllable clock for tests. Every time-dependent code path in the API takes its time from
 * the injected `Clock`, so tests never sleep and never depend on the wall clock.
 */
import type { Clock } from '../clock';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Lets pending promise chains (including database round trips) settle. */
export async function flushAsync(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Waits (in real time) until `predicate` holds. Used for work that a fake timer kicked off. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, options: { timeoutMs?: number; label?: string } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${options.label ?? 'condition'}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const TEST_EPOCH = '2025-03-01T12:00:00.000Z';

export class TestClock implements Clock {
  #now: number;
  #timers = new Map<number, Timer>();
  #nextId = 1;

  constructor(start: Date | string | number = TEST_EPOCH) {
    this.#now = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  get epochMs(): number {
    return this.#now;
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  setTimer(ms: number, fn: () => void): () => void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, { id, at: this.#now + Math.max(0, ms), fn });
    return () => {
      this.#timers.delete(id);
    };
  }

  /** Advances the clock, firing each due timer at its own scheduled instant. */
  async advance(ms: number, options: { flushRounds?: number } = {}): Promise<void> {
    if (ms < 0) throw new RangeError('TestClock.advance: ms must not be negative');
    const target = this.#now + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.#timers.values()) {
        if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) next = timer;
      }
      if (!next) break;
      this.#now = Math.max(this.#now, next.at);
      this.#timers.delete(next.id);
      next.fn();
      await flushAsync(options.flushRounds);
    }
    this.#now = target;
    await flushAsync(options.flushRounds);
  }

  async advanceTo(when: Date | string | number, options: { flushRounds?: number } = {}): Promise<void> {
    await this.advance(new Date(when).getTime() - this.#now, options);
  }

  /** Moves time forward WITHOUT firing timers: models a suspended or throttled process. */
  jump(ms: number): void {
    this.#now += ms;
  }
}
