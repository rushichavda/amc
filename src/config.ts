import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { atomicWriteJson, readJson } from "./util.js";

/** Resolve the amc home directory. Overridable for tests / multi-instance via AMC_HOME. */
export function amcHome(): string {
  return process.env.AMC_HOME || join(homedir(), ".amc");
}

export function paths() {
  const home = amcHome();
  return {
    home,
    config: join(home, "config.json"),
    identity: join(home, "identity.json"),
    peers: join(home, "peers.json"),
    shares: join(home, "shares.json"),
    invites: join(home, "invites.json"),
    requests: join(home, "requests.json"),
    usage: join(home, "usage.json"),
    audit: join(home, "audit.log"),
    pid: join(home, "daemon.pid"),
    daemonLog: join(home, "daemon.log"),
    tmp: join(home, "tmp"),
  };
}

export interface SandboxConfig {
  /** Model for sandboxed peer-query sessions. Keep it fast/cheap; quality is plenty for Q&A. */
  model: string;
  /** Hard wall-clock limit for one sandbox run. */
  timeoutMs: number;
  /** Max concurrent sandbox runs; extra inbound queries are rejected as busy. */
  maxConcurrent: number;
  /** Cap on answer size returned to a peer. */
  maxAnswerChars: number;
  /** Cap on inbound question size. */
  maxQuestionChars: number;
  /** Optional per-query API budget cap, passed as --max-budget-usd (API-key users). 0 disables. */
  maxBudgetUsd: number;
  /** Effort level for sandbox runs (low|medium|high). */
  effort: string;
  /** Extra raw CLI args appended to the claude invocation (escape hatch). */
  extraArgs: string[];
  /** Disable --safe-mode if the installed claude version misbehaves with it. */
  safeMode: boolean;
  /** Keep sandbox workspaces on disk for debugging. */
  keepWorkspaces: boolean;
}

export interface Config {
  name: string;
  port: number;
  bind: string;
  /** Host to advertise in invites (e.g. Tailscale DNS name). Empty = auto-detect LAN IPv4. */
  advertiseHost: string;
  claudeBin: string;
  paused: boolean;
  notify: boolean;
  sandbox: SandboxConfig;
  limitsDefault: { perHour: number; perDay: number };
  filter: { enabled: boolean; extraPatterns: string[] };
}

export const DEFAULT_CONFIG: Config = {
  name: "",
  port: 4711,
  bind: "0.0.0.0",
  advertiseHost: "",
  claudeBin: "claude",
  paused: false,
  notify: true,
  sandbox: {
    model: "sonnet",
    timeoutMs: 180_000,
    maxConcurrent: 2,
    maxAnswerChars: 32_000,
    maxQuestionChars: 8_000,
    maxBudgetUsd: 0,
    effort: "medium",
    extraArgs: [],
    safeMode: true,
    keepWorkspaces: false,
  },
  limitsDefault: { perHour: 10, perDay: 40 },
  filter: { enabled: true, extraPatterns: [] },
};

export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(paths().config, {});
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    sandbox: { ...DEFAULT_CONFIG.sandbox, ...(raw.sandbox ?? {}) },
    limitsDefault: { ...DEFAULT_CONFIG.limitsDefault, ...(raw.limitsDefault ?? {}) },
    filter: { ...DEFAULT_CONFIG.filter, ...(raw.filter ?? {}) },
  };
}

export function saveConfig(config: Config): void {
  atomicWriteJson(paths().config, config);
}

export function ensureHome(): void {
  mkdirSync(paths().tmp, { recursive: true, mode: 0o700 });
}
