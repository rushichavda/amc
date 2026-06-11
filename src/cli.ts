#!/usr/bin/env node
import { parseArgs } from "node:util";
import { cmdInit, cmdSetupClaude, cmdWhoami, cmdDoctor } from "./commands/core.js";
import {
  cmdInvite,
  cmdConnect,
  cmdRequests,
  cmdAccept,
  cmdReject,
  cmdPeers,
  cmdPeer,
} from "./commands/network.js";
import { cmdShare, cmdGrant, cmdRevokeGrant } from "./commands/sharing.js";
import { cmdDaemon, cmdAsk, cmdAudit, cmdPause, cmdResume, cmdConfig } from "./commands/ops.js";
import { runMcpServer } from "./mcp.js";

const HELP = `amc — ask my Claude. Peer-to-peer scoped queries between teammates' Claudes.

setup
  amc init                           interactive setup wizard (identity, shares,
                                     daemon, invite) — flags skip it: [--name <you>]
  amc setup-claude [--remove]        (re)register the ask_peer MCP tools
  amc doctor                         check everything is wired up
  amc whoami [--json]                show your identity

share what peers may use (default: nothing)
  amc share project <name> <path> [--description "..."]
  amc share mcp <name> --from-claude <server> --tools t1,t2 [--description "..."]
  amc share list | remove <project|mcp> <name> | claude-servers

connect with teammates
  amc invite [--host <ip|dns>] [--ttl 7d] [--multi] [--list] [--revoke <token>]
  amc connect <invite-code> [--name alias]
  amc requests                       browse pending requests (↑↓ + enter approves,
                                     r rejects, b blocks; then pick grants)
  amc accept <name> | reject <name> [--block]    (non-interactive forms)
  amc peers [--ping] [--json]
  amc peer <remove|set-host|limits|block|unblock> <peer> [...]

grant scope per peer (default: nothing)
  amc grant <peer>                   interactive checkbox picker (space toggles,
                                     enter saves; unchecking revokes)
  amc grant <peer> <project|mcp> <share-name>
  amc grant <peer> --list
  amc revoke <peer> <project|mcp> <share-name> | amc revoke <peer> --all

run
  amc daemon <start|stop|status|logs|run>
  amc ask <peer> "<question>" [--context "..."] [--timeout 240] [--json]
  amc audit [--peer p] [--since 2h] [--dir in|out] [-n 100] [--json]
  amc pause | resume                 kill-switch for inbound queries
  amc config [show] | config set <key> <value>

Peer queries run in a fresh sandboxed Claude session on the owner's machine —
no memory, no history, only the explicitly granted tools. Inference uses the
owner's existing Claude Code login; no API key needed. Everything is logged
to ~/.amc/audit.log.`;

const FLAG_SPEC: Record<string, Record<string, { type: "string" | "boolean"; multiple?: boolean }>> = {
  init: { name: { type: "string" }, "skip-claude": { type: "boolean" } },
  "setup-claude": { remove: { type: "boolean" } },
  whoami: { json: { type: "boolean" } },
  invite: {
    label: { type: "string" },
    ttl: { type: "string" },
    multi: { type: "boolean" },
    host: { type: "string" },
    list: { type: "boolean" },
    revoke: { type: "string" },
    json: { type: "boolean" },
  },
  connect: { name: { type: "string" }, json: { type: "boolean" } },
  requests: { json: { type: "boolean" } },
  reject: { block: { type: "boolean" } },
  peers: { json: { type: "boolean" }, ping: { type: "boolean" } },
  peer: { "per-hour": { type: "string" }, "per-day": { type: "string" } },
  share: {
    description: { type: "string" },
    tools: { type: "string" },
    "from-claude": { type: "string" },
    command: { type: "string" },
    args: { type: "string" },
    env: { type: "string", multiple: true },
    json: { type: "boolean" },
  },
  grant: { list: { type: "boolean" } },
  revoke: { all: { type: "boolean" } },
  daemon: { n: { type: "string" } },
  ask: { context: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" } },
  audit: {
    peer: { type: "string" },
    since: { type: "string" },
    n: { type: "string" },
    json: { type: "boolean" },
    dir: { type: "string" },
  },
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "version") {
    console.log("amc 0.1.0");
    return;
  }
  if (command === "mcp-serve") {
    runMcpServer();
    return; // stays alive on stdin
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: FLAG_SPEC[command] ?? {},
    allowPositionals: true,
    strict: false,
  });
  const flags = values as Record<string, never>;

  switch (command) {
    case "init":
      return cmdInit(flags);
    case "setup-claude":
      return cmdSetupClaude(flags);
    case "whoami":
      return cmdWhoami(flags);
    case "doctor":
      return cmdDoctor();
    case "invite":
      return cmdInvite(flags);
    case "connect":
      return cmdConnect(positionals, flags);
    case "requests":
      return cmdRequests(flags);
    case "accept":
      return cmdAccept(positionals);
    case "reject":
      return cmdReject(positionals, flags);
    case "peers":
      return cmdPeers(flags);
    case "peer":
      return cmdPeer(positionals, flags);
    case "share":
      return cmdShare(positionals, flags);
    case "grant":
      return cmdGrant(positionals, flags);
    case "revoke":
      return cmdRevokeGrant(positionals, flags);
    case "daemon":
      return cmdDaemon(positionals, flags);
    case "ask":
      return cmdAsk(positionals, flags);
    case "audit":
      return cmdAudit(flags);
    case "pause":
      return cmdPause();
    case "resume":
      return cmdResume();
    case "config":
      return cmdConfig(positionals);
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
