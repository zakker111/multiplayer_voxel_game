/**
 * Transport limits shared by the game server.
 *
 * Kept in their own module so they can be tested without booting the HTTP
 * server (server.ts pulls in Vite and binds a port).
 */

/**
 * Token bucket: `burst` operations immediately, then `ratePerSecond` sustained.
 *
 * Used per WebSocket so a client that spams frames is throttled to a humanly
 * achievable rate instead of feeding every frame to the 20Hz game loop.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    nowMs: number = Date.now(),
  ) {
    this.tokens = burst;
    this.lastRefillMs = nowMs;
  }

  /** Spend one token if one is available. Never goes below zero. */
  tryConsume(nowMs: number = Date.now()): boolean {
    const elapsedSeconds = Math.max(nowMs - this.lastRefillMs, 0) / 1000;
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Counts live connections per key (client IP) with a global ceiling as well, so
 * one client cannot open thousands of sockets and starve everyone else.
 *
 * `canAccept` is a pure check; `add` is called once the socket really exists, so
 * a rejected upgrade can never leak a slot.
 */
export class ConnectionLimiter {
  private readonly counts = new Map<string, number>();
  private totalCount = 0;

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerKey: number,
  ) {}

  canAccept(key: string): boolean {
    if (this.totalCount >= this.maxTotal) return false;
    return (this.counts.get(key) ?? 0) < this.maxPerKey;
  }

  add(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.totalCount++;
  }

  /** Removing a key that was never added is a no-op (close and error can both fire). */
  remove(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 0) return;
    if (current === 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
    this.totalCount--;
  }

  get total(): number {
    return this.totalCount;
  }

  countFor(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
