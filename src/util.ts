import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

/** Deterministic JSON serialization (sorted object keys, recursively). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function b64u(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function randomId(bytes = 16): string {
  return b64u(randomBytes(bytes));
}

export function nowMs(): number {
  return Date.now();
}

/** Atomically write JSON to a file (tmp + rename), creating parent dirs, mode 0600. */
export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${Date.now()}-${randomId(6)}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Parse durations like "30s", "5m", "2h", "7d" into milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${s} (use e.g. 30s, 5m, 2h, 7d)`);
  const n = parseFloat(m[1]);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"];
  return Math.round(n * mult);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[... truncated at ${max} characters by amc]`;
}

export function shortTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function osTmpDir(): string {
  return tmpdir();
}

/** Best-effort first non-internal IPv4 address for invite hints. */
export async function guessLanAddress(): Promise<string | null> {
  const { networkInterfaces } = await import("node:os");
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return null;
}
