import { paths } from "../config.js";
import { atomicWriteJson, readJson, nowMs } from "../util.js";

interface Window {
  start: number;
  count: number;
}

type UsageFile = Record<string, { h: Window; d: Window }>; // keyed by peer fingerprint

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Fixed-window rate limiting per peer. Returns whether the query may proceed
 * and increments counters when it does.
 */
export function checkAndIncrement(
  fp: string,
  limits: { perHour: number; perDay: number }
): { ok: boolean; reason?: string } {
  const usage = readJson<UsageFile>(paths().usage, {});
  const now = nowMs();
  const entry = usage[fp] ?? { h: { start: now, count: 0 }, d: { start: now, count: 0 } };

  if (now - entry.h.start >= HOUR) entry.h = { start: now, count: 0 };
  if (now - entry.d.start >= DAY) entry.d = { start: now, count: 0 };

  if (entry.h.count >= limits.perHour) {
    return { ok: false, reason: `hourly limit reached (${limits.perHour}/hour)` };
  }
  if (entry.d.count >= limits.perDay) {
    return { ok: false, reason: `daily limit reached (${limits.perDay}/day)` };
  }

  entry.h.count += 1;
  entry.d.count += 1;
  usage[fp] = entry;
  atomicWriteJson(paths().usage, usage);
  return { ok: true };
}
