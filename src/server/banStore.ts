/**
 * BanStore — persistent IP/name ban list backed by a JSON file.
 *
 * File location (in priority order):
 *   1. BAN_FILE env var
 *   2. ./bans.json next to the server
 *
 * The same file is read/written by the `admin` CLI (scripts/admin.ts), which
 * lets an operator ban or unban players on a running server: bans are polled
 * from disk every few seconds, so `node dist/admin.cjs ban <ip>` takes effect
 * within ~5s without restarting the server.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger';

const log = createLogger('bans');

export interface BanEntry {
  value: string;          // ip or name (lowercased for names)
  kind: 'ip' | 'name';
  reason: string;
  bannedAt: number;       // epoch ms
  expiresAt: number | null; // epoch ms or null = permanent
}

export class BanStore {
  private bans: Map<string, BanEntry> = new Map();
  private lastMtimeMs = 0;
  private lastLoadAt = 0;

  constructor(public readonly filePath: string) {}

  static default(): BanStore {
    const p = process.env.BAN_FILE || path.join(process.cwd(), 'bans.json');
    return new BanStore(p);
  }

  private key(kind: 'ip' | 'name', value: string): string {
    return `${kind}:${value.toLowerCase()}`;
  }

  loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.bans.clear();
        this.lastMtimeMs = 0;
        return;
      }
      const stat = fs.statSync(this.filePath);
      this.lastMtimeMs = stat.mtimeMs;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const entries: BanEntry[] = Array.isArray(raw) ? raw : (raw.bans ?? []);
      this.bans.clear();
      const now = Date.now();
      for (const e of entries) {
        if (!e || !e.value || !e.kind) continue;
        if (e.expiresAt !== null && e.expiresAt !== undefined && e.expiresAt < now) continue; // expired
        this.bans.set(this.key(e.kind, e.value), e);
      }
    } catch (err) {
      log.error(`Failed to load ban file ${this.filePath}: ${(err as Error).message}`);
    }
  }

  saveToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const entries = [...this.bans.values()];
      fs.writeFileSync(this.filePath, JSON.stringify({ bans: entries }, null, 2));
      this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch (err) {
      log.error(`Failed to save ban file: ${(err as Error).message}`);
    }
  }

  /** Re-read from disk if the file changed (external CLI edits). Cheap mtime check, throttled. */
  reloadIfChanged(): void {
    const now = Date.now();
    if (now - this.lastLoadAt < 2000) return; // poll at most every 2s
    this.lastLoadAt = now;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const mtime = fs.statSync(this.filePath).mtimeMs;
      if (mtime !== this.lastMtimeMs) {
        log.info('Ban file changed on disk, reloading');
        this.loadFromDisk();
      }
    } catch {
      /* ignore transient fs errors */
    }
  }

  add(kind: 'ip' | 'name', value: string, reason = 'no reason given', durationMin: number | null = null): BanEntry {
    const entry: BanEntry = {
      value: kind === 'name' ? value.toLowerCase() : value,
      kind,
      reason,
      bannedAt: Date.now(),
      expiresAt: durationMin === null ? null : Date.now() + durationMin * 60_000,
    };
    this.bans.set(this.key(kind, value), entry);
    this.saveToDisk();
    return entry;
  }

  remove(kind: 'ip' | 'name', value: string): boolean {
    const existed = this.bans.delete(this.key(kind, value));
    if (existed) this.saveToDisk();
    return existed;
  }

  isIpBanned(ip: string): BanEntry | null {
    this.reloadIfChanged();
    const entry = this.bans.get(this.key('ip', normalizeIp(ip)));
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.bans.delete(this.key('ip', normalizeIp(ip)));
      return null;
    }
    return entry;
  }

  list(): BanEntry[] {
    this.reloadIfChanged();
    const now = Date.now();
    // prune expired
    for (const [k, e] of this.bans) {
      if (e.expiresAt !== null && e.expiresAt < now) this.bans.delete(k);
    }
    return [...this.bans.values()];
  }
}

/** Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) and localhost forms. */
export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  let out = ip.trim();
  const mapped = out.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) out = mapped[1];
  if (out === '::1') out = '127.0.0.1';
  return out;
}
