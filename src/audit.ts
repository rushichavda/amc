import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config.js";
import { nowMs } from "./util.js";

export interface AuditEntry {
  ts: number;
  dir: "in" | "out";
  typ: string; // hello | ping | ask | ...
  peerFp: string;
  peerName: string;
  status: string; // ok | denied | pending | rate_limited | filtered | busy | error | timeout
  question?: string;
  answer?: string;
  detail?: string;
  durationMs?: number;
  numTurns?: number;
  costUsd?: number;
  grantsUsed?: { projects: string[]; mcp: string[] };
  filterHits?: string[];
}

export function appendAudit(entry: Omit<AuditEntry, "ts"> & { ts?: number }): void {
  const path = paths().audit;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ts: nowMs(), ...entry }) + "\n";
  appendFileSync(path, line, { mode: 0o600 });
}

export function readAudit(opts: {
  peerFp?: string;
  sinceMs?: number;
  limit?: number;
}): AuditEntry[] {
  const path = paths().audit;
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* skip corrupt lines */
    }
  }
  let out = entries;
  if (opts.peerFp) out = out.filter((e) => e.peerFp === opts.peerFp);
  if (opts.sinceMs) out = out.filter((e) => e.ts >= opts.sinceMs!);
  if (opts.limit && out.length > opts.limit) out = out.slice(-opts.limit);
  return out;
}
