import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { loadConfig, saveConfig, ensureHome, paths } from "../config.js";
import { createIdentity, loadIdentity, fingerprint } from "../crypto/identity.js";
import { loadShares } from "../state/shares.js";
import { loadRequests } from "../state/requests.js";

const execFileAsync = promisify(execFile);

function cliPath(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

export async function cmdInit(flags: { name?: string; "skip-claude"?: boolean }): Promise<void> {
  ensureHome();
  let identity = loadIdentity();
  if (identity) {
    console.log(`identity already exists: ${identity.name} (${fingerprint(identity.ik)})`);
  } else {
    const name = flags.name || process.env.USER || hostname().split(".")[0] || "me";
    identity = createIdentity(name);
    console.log(`created identity "${name}" (${fingerprint(identity.ik)})`);
  }
  const config = loadConfig();
  if (!config.name) {
    config.name = identity.name;
    saveConfig(config);
  }

  if (!flags["skip-claude"]) {
    const ok = await registerWithClaude();
    if (!ok) {
      console.log("could not auto-register with Claude Code — run `amc setup-claude` later.");
    }
  }

  console.log(`
next steps:
  1. share something:        amc share project myproj ~/code/myproj --description "What it is"
  2. start your daemon:      amc daemon start
  3. invite a teammate:      amc invite            (send them the code)
     they run:               amc connect <code>
  4. approve them:           amc accept <their-name>
  5. grant them scope:       amc grant <their-name> project myproj
their Claude can then call ask_peer("${identity.name}", "...") — answered by a fresh
sandboxed session limited to what you granted. Watch everything: amc audit
`);
}

export async function registerWithClaude(): Promise<boolean> {
  const serverDef = JSON.stringify({
    type: "stdio",
    command: process.execPath,
    args: [cliPath(), "mcp-serve"],
  });
  try {
    // Replace any stale registration first (path may have changed).
    await execFileAsync("claude", ["mcp", "remove", "--scope", "user", "amc"]).catch(() => null);
    await execFileAsync("claude", ["mcp", "add-json", "--scope", "user", "amc", serverDef]);
    console.log("registered `amc` MCP server with Claude Code (user scope) — tools: ask_peer, list_peers");
    return true;
  } catch {
    return false;
  }
}

export async function cmdSetupClaude(flags: { remove?: boolean }): Promise<void> {
  if (flags.remove) {
    try {
      await execFileAsync("claude", ["mcp", "remove", "--scope", "user", "amc"]);
      console.log("removed amc MCP server from Claude Code");
    } catch (err) {
      console.error(`failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }
  const ok = await registerWithClaude();
  if (!ok) {
    console.error(`auto-registration failed. Register manually:
  claude mcp add-json --scope user amc '{"type":"stdio","command":"${process.execPath}","args":["${cliPath()}","mcp-serve"]}'`);
    process.exitCode = 1;
  }
}

export async function cmdWhoami(flags: { json?: boolean }): Promise<void> {
  const identity = loadIdentity();
  if (!identity) {
    console.error("no identity — run `amc init`");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const daemonUp = await healthCheck(config.port);
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          name: identity.name,
          fingerprint: fingerprint(identity.ik),
          ik: identity.ik,
          port: config.port,
          daemon: daemonUp ? "running" : "stopped",
          paused: config.paused,
        },
        null,
        2
      )
    );
    return;
  }
  console.log(`name:        ${identity.name}`);
  console.log(`fingerprint: ${fingerprint(identity.ik)}`);
  console.log(`port:        ${config.port}`);
  console.log(`daemon:      ${daemonUp ? "running" : "stopped"}${config.paused ? " (paused)" : ""}`);
}

export async function healthCheck(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/v1/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await res.json()) as { amc?: boolean };
    return body.amc === true;
  } catch {
    return false;
  }
}

export async function cmdDoctor(): Promise<void> {
  const report: Array<[string, boolean, string]> = [];
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
  report.push(["node >= 20", nodeOk, process.versions.node]);

  const identity = loadIdentity();
  report.push(["identity", !!identity, identity ? `${identity.name} (${fingerprint(identity.ik)})` : "run `amc init`"]);

  const config = loadConfig();
  let claudeVersion = "";
  try {
    const { stdout } = await execFileAsync(config.claudeBin, ["--version"]);
    claudeVersion = stdout.trim();
  } catch {
    /* missing */
  }
  report.push(["claude CLI", !!claudeVersion, claudeVersion || `'${config.claudeBin}' not found on PATH`]);

  const daemonUp = await healthCheck(config.port);
  report.push(["daemon", daemonUp, daemonUp ? `listening on :${config.port}` : "run `amc daemon start`"]);

  let mcpRegistered = false;
  try {
    const { stdout } = await execFileAsync("claude", ["mcp", "list"]);
    mcpRegistered = /\bamc\b/.test(stdout);
  } catch {
    /* claude missing */
  }
  report.push(["MCP registration", mcpRegistered, mcpRegistered ? "amc registered in Claude Code" : "run `amc setup-claude`"]);

  const shares = loadShares();
  for (const [name, share] of Object.entries(shares.projects)) {
    report.push([`share:${name}`, existsSync(share.path), share.path]);
  }

  const pending = Object.keys(loadRequests()).length;
  if (pending > 0) report.push(["pending requests", true, `${pending} waiting — see \`amc requests\``]);

  let allOk = true;
  for (const [name, ok, detail] of report) {
    console.log(`${ok ? "✓" : "✗"} ${name.padEnd(18)} ${detail}`);
    if (!ok) allOk = false;
  }
  if (!allOk) process.exitCode = 1;
  console.log(`\namc home: ${paths().home}`);
}
