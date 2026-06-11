import { spawn } from "node:child_process";
import { openSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paths, loadConfig, saveConfig, ensureHome } from "../config.js";
import { requireIdentity } from "../crypto/identity.js";
import { resolvePeer } from "../state/peers.js";
import { askPeer } from "../client.js";
import { readAudit } from "../audit.js";
import { runDaemon } from "../daemon/server.js";
import { healthCheck } from "./core.js";
import { parseDuration, shortTs } from "../util.js";
import { fingerprint } from "../crypto/identity.js";

function cliPath(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

export async function cmdDaemon(positional: string[], flags: { n?: string }): Promise<void> {
  const action = positional[0] ?? "status";
  const config = loadConfig();

  switch (action) {
    case "run":
      // Foreground mode (used by `daemon start` and by tests/systemd).
      await runDaemon();
      return;

    case "start": {
      requireIdentity();
      ensureHome();
      if (await healthCheck(config.port)) {
        console.log(`daemon already running on :${config.port}`);
        return;
      }
      const logFd = openSync(paths().daemonLog, "a");
      const child = spawn(process.execPath, [cliPath(), "daemon", "run"], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
      child.unref();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await healthCheck(config.port)) {
          console.log(`daemon started on ${config.bind}:${config.port} (log: ${paths().daemonLog})`);
          return;
        }
      }
      console.error(`daemon did not come up — check ${paths().daemonLog}`);
      process.exitCode = 1;
      return;
    }

    case "stop": {
      if (!existsSync(paths().pid)) {
        console.log("daemon not running (no pidfile)");
        return;
      }
      const pid = parseInt(readFileSync(paths().pid, "utf8").trim(), 10);
      try {
        process.kill(pid, "SIGTERM");
        console.log(`stopped daemon (pid ${pid})`);
      } catch {
        console.log("daemon process not found — cleaning up pidfile");
      }
      try {
        unlinkSync(paths().pid);
      } catch {
        /* gone */
      }
      return;
    }

    case "status": {
      const up = await healthCheck(config.port);
      console.log(up ? `daemon running on :${config.port}${config.paused ? " (paused)" : ""}` : "daemon stopped");
      if (!up) process.exitCode = 1;
      return;
    }

    case "logs": {
      if (!existsSync(paths().daemonLog)) {
        console.log("no daemon log yet");
        return;
      }
      const lines = readFileSync(paths().daemonLog, "utf8").split("\n");
      const n = flags.n ? parseInt(flags.n, 10) : 50;
      console.log(lines.slice(-n - 1).join("\n"));
      return;
    }

    default:
      throw new Error("usage: amc daemon <start|stop|status|run|logs>");
  }
}

export async function cmdAsk(
  positional: string[],
  flags: { context?: string; timeout?: string; json?: boolean }
): Promise<void> {
  const [peerName, ...questionParts] = positional;
  const question = questionParts.join(" ").trim();
  if (!peerName || !question) throw new Error('usage: amc ask <peer> "<question>"');
  const { peer } = resolvePeer(peerName);
  const timeoutMs = flags.timeout ? parseInt(flags.timeout, 10) * 1000 : 240_000;
  console.error(`asking ${peer.name}… (their sandbox may take a minute or two)`);
  const result = await askPeer(peer, question, flags.context, timeoutMs);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const status = String(result.status ?? "unknown");
  if (status === "ok") {
    console.log(String(result.answer ?? ""));
  } else {
    console.error(`no answer (${status}): ${String(result.message ?? "")}`);
    process.exitCode = 1;
  }
}

export async function cmdAudit(flags: {
  peer?: string;
  since?: string;
  n?: string;
  json?: boolean;
  dir?: string;
}): Promise<void> {
  let peerFp: string | undefined;
  if (flags.peer) peerFp = resolvePeer(flags.peer).fp;
  const sinceMs = flags.since ? Date.now() - parseDuration(flags.since) : undefined;
  let entries = readAudit({ peerFp, sinceMs, limit: flags.n ? parseInt(flags.n, 10) : 100 });
  if (flags.dir === "in" || flags.dir === "out") {
    entries = entries.filter((e) => e.dir === flags.dir);
  }
  if (flags.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("no audit entries");
    return;
  }
  for (const e of entries) {
    const arrow = e.dir === "in" ? "◀" : "▶";
    const head = `${shortTs(e.ts)} ${arrow} ${e.typ.padEnd(5)} ${e.peerName.padEnd(14)} ${e.status}`;
    const q = e.question ? `  q: ${e.question.slice(0, 90).replace(/\n/g, " ")}` : "";
    const extra = [
      e.durationMs ? `${Math.round(e.durationMs / 1000)}s` : "",
      e.numTurns ? `${e.numTurns} turns` : "",
      e.filterHits?.length ? `HITS:${e.filterHits.join(",")}` : "",
      e.detail ?? "",
    ]
      .filter(Boolean)
      .join("  ");
    console.log(head + q + (extra ? `  [${extra}]` : ""));
  }
}

export async function cmdPause(): Promise<void> {
  const config = loadConfig();
  config.paused = true;
  saveConfig(config);
  console.log("paused — inbound queries will be politely refused (daemon picks this up immediately)");
}

export async function cmdResume(): Promise<void> {
  const config = loadConfig();
  config.paused = false;
  saveConfig(config);
  console.log("resumed — inbound queries allowed again");
}

export async function cmdConfig(positional: string[]): Promise<void> {
  const [action, key, value] = positional;
  const config = loadConfig();
  if (!action || action === "show") {
    const identity = requireIdentity();
    console.log(JSON.stringify({ ...config, _fingerprint: fingerprint(identity.ik) }, null, 2));
    return;
  }
  if (action === "set" && key && value !== undefined) {
    // Dot-path setter for simple knobs, e.g. `amc config set sandbox.model haiku`
    const segments = key.split(".");
    let node: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (const segment of segments.slice(0, -1)) {
      if (typeof node[segment] !== "object" || node[segment] === null) {
        throw new Error(`unknown config section: ${segment}`);
      }
      node = node[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1];
    if (!(leaf in node)) throw new Error(`unknown config key: ${key}`);
    const current = node[leaf];
    let parsed: unknown = value;
    if (typeof current === "number") parsed = Number(value);
    else if (typeof current === "boolean") parsed = value === "true";
    else if (Array.isArray(current)) parsed = value.split(",").filter(Boolean);
    node[leaf] = parsed;
    saveConfig(config);
    console.log(`${key} = ${JSON.stringify(parsed)}`);
    return;
  }
  throw new Error("usage: amc config [show] | amc config set <key> <value>");
}
