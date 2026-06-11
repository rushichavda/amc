import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { loadConfig, saveConfig, ensureHome, paths } from "../config.js";
import { createIdentity, loadIdentity, fingerprint, type Identity } from "../crypto/identity.js";
import { loadShares, addProjectShare } from "../state/shares.js";
import { loadRequests } from "../state/requests.js";
import { healthCheck, expandTilde, guessLanAddress } from "../util.js";
import { isInteractive, ask, confirm, c } from "../tui.js";
import { startDaemonDetached } from "./ops.js";
import { buildInvite } from "./network.js";

const execFileAsync = promisify(execFile);

function cliPath(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

export async function cmdInit(flags: { name?: string; "skip-claude"?: boolean }): Promise<void> {
  ensureHome();
  // Quick path: flags given or no TTY (scripts, tests).
  if (flags.name || flags["skip-claude"] || !isInteractive()) {
    quickInit(flags);
    if (!flags["skip-claude"]) {
      const ok = await registerWithClaude();
      if (!ok) console.log("could not auto-register with Claude Code — run `amc setup-claude` later.");
    }
    printNextSteps(loadIdentity()!.name);
    return;
  }
  await initWizard();
}

function quickInit(flags: { name?: string }): Identity {
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
  return identity;
}

function printNextSteps(name: string): void {
  console.log(`
next steps:
  1. share something:        amc share project myproj ~/code/myproj --description "What it is"
  2. start your daemon:      amc daemon start
  3. invite a teammate:      amc invite            (send them the code)
     they run:               amc connect <code>
  4. approve them:           amc requests          (interactive — enter approves)
  5. grant them scope:       amc grant <their-name>
their Claude can then call ask_peer("${name}", "...") — answered by a fresh
sandboxed session limited to what you granted. Watch everything: amc audit
`);
}

/** Interactive first-run questionnaire: identity → Claude Code → shares → daemon → invite. */
async function initWizard(): Promise<void> {
  console.log(c.bold("\namc setup — peer-to-peer scoped queries between teammates' Claudes\n"));

  // 1. Identity
  let identity = loadIdentity();
  if (identity) {
    console.log(`${c.green("✓")} identity exists: ${identity.name} (${fingerprint(identity.ik)})`);
  } else {
    const name = await ask("your name — peers will see this", process.env.USER || hostname().split(".")[0] || "me");
    identity = createIdentity(name);
    console.log(`${c.green("✓")} created identity "${name}" (${fingerprint(identity.ik)})`);
  }
  const config = loadConfig();
  if (!config.name) {
    config.name = identity.name;
    saveConfig(config);
  }

  // 2. Claude Code integration
  if (await confirm("register the ask_peer tools with Claude Code?")) {
    const ok = await registerWithClaude();
    if (!ok) console.log(`${c.red("✗")} auto-registration failed — run \`amc setup-claude\` later`);
  }

  // 3. Shares
  console.log("");
  const existingShares = loadShares();
  const shareCount = Object.keys(existingShares.projects).length + Object.keys(existingShares.mcp).length;
  if (shareCount > 0) {
    console.log(`${c.green("✓")} already sharing ${shareCount} item(s) — \`amc share list\``);
  }
  console.log(c.dim("shares are what peers CAN be granted. Nothing is visible until you grant it per peer."));
  let first = shareCount === 0;
  while (await confirm(first ? "share a project directory now?" : "share another project?", first)) {
    first = false;
    const path = await ask("project path (e.g. ~/code/myproj)");
    if (!path) break;
    try {
      const defaultName = basename(resolve(expandTilde(path)))
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .slice(0, 32) || "project";
      const name = await ask("share name", defaultName);
      const description = await ask("one-line description — helps peers' Claudes route questions here");
      addProjectShare(name, path, description);
      console.log(`${c.green("✓")} sharing "${name}" (read-only)`);
    } catch (err) {
      console.log(`${c.red("✗")} ${(err as Error).message}`);
    }
  }

  // 4. Daemon
  console.log("");
  if (await healthCheck(config.port)) {
    console.log(`${c.green("✓")} daemon already running on :${config.port}`);
  } else if (await confirm("start your daemon now? (required for peers to reach you)")) {
    const ok = await startDaemonDetached();
    console.log(ok ? `${c.green("✓")} daemon running on :${config.port}` : `${c.red("✗")} daemon failed — check \`amc daemon logs\``);
  }

  // 5. Invite
  console.log("");
  if (await confirm("create an invite code for a teammate?")) {
    const guessed = config.advertiseHost || (await guessLanAddress()) || "";
    const host = await ask("address teammates can reach you at (LAN IP or Tailscale name)", guessed);
    if (host) {
      if (host !== config.advertiseHost) {
        config.advertiseHost = host;
        saveConfig(config);
      }
      const { code } = buildInvite(host, "7d", false, "init-wizard");
      console.log(`\nsend this to your teammate (valid 7 days, single use):\n\n  ${c.cyan(code)}\n`);
      console.log(`they run:   ${c.bold(`amc connect ${code.slice(0, 18)}…`)}`);
      console.log(`then you:   ${c.bold("amc requests")}   ${c.dim("(interactive — enter approves, then pick grants)")}`);
    }
  }

  console.log(c.dim("\nall set. Useful commands: amc requests · amc peers --ping · amc audit · amc pause"));
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
