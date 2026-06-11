import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadShares,
  addProjectShare,
  addMcpShare,
  removeShare,
  type McpShare,
} from "../state/shares.js";
import { loadPeers, savePeers, resolvePeer } from "../state/peers.js";

interface ClaudeMcpServerDef {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** Read MCP servers the user already configured in Claude Code (user scope + cwd project scope). */
export function readClaudeMcpServers(): Record<string, ClaudeMcpServerDef> {
  const out: Record<string, ClaudeMcpServerDef> = {};
  const userConfig = join(homedir(), ".claude.json");
  if (existsSync(userConfig)) {
    try {
      const parsed = JSON.parse(readFileSync(userConfig, "utf8")) as {
        mcpServers?: Record<string, ClaudeMcpServerDef>;
      };
      Object.assign(out, parsed.mcpServers ?? {});
    } catch {
      /* unreadable — ignore */
    }
  }
  const projectConfig = join(process.cwd(), ".mcp.json");
  if (existsSync(projectConfig)) {
    try {
      const parsed = JSON.parse(readFileSync(projectConfig, "utf8")) as {
        mcpServers?: Record<string, ClaudeMcpServerDef>;
      };
      Object.assign(out, parsed.mcpServers ?? {});
    } catch {
      /* ignore */
    }
  }
  return out;
}

export async function cmdShare(positional: string[], flags: Record<string, unknown>): Promise<void> {
  const [sub, ...rest] = positional;
  switch (sub) {
    case "project": {
      const [name, path] = rest;
      if (!name || !path) {
        throw new Error('usage: amc share project <name> <path> [--description "..."]');
      }
      addProjectShare(name, path, String(flags.description ?? ""));
      console.log(`sharing project "${name}" — grant it to a peer with: amc grant <peer> project ${name}`);
      return;
    }
    case "mcp": {
      const [name] = rest;
      if (!name) {
        throw new Error(
          'usage: amc share mcp <name> (--from-claude <server> | --command <cmd> [--args "<a b c>"]) --tools t1,t2 [--description "..."]'
        );
      }
      const tools = String(flags.tools ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      let server: McpShare["server"];
      if (flags["from-claude"]) {
        const claudeServers = readClaudeMcpServers();
        const source = claudeServers[String(flags["from-claude"])];
        if (!source) {
          const names = Object.keys(claudeServers).join(", ") || "(none found)";
          throw new Error(`no MCP server "${flags["from-claude"]}" in your Claude Code config. Found: ${names}`);
        }
        if (!source.command) {
          throw new Error(
            "that server is URL-based (SSE/HTTP) — share it manually with --command, or use a stdio server"
          );
        }
        server = {
          type: source.type ?? "stdio",
          command: source.command,
          args: source.args ?? [],
          env: source.env ?? {},
        };
      } else if (flags.command) {
        server = {
          type: "stdio",
          command: String(flags.command),
          args: flags.args ? String(flags.args).split(" ").filter(Boolean) : [],
          env: parseEnvFlags(flags.env),
        };
      } else {
        throw new Error("provide --from-claude <server-name> or --command <cmd>");
      }
      addMcpShare(name, { description: String(flags.description ?? ""), tools, server });
      console.log(
        `sharing MCP "${name}" (tools: ${tools.join(", ")}) — grant it with: amc grant <peer> mcp ${name}`
      );
      console.log(
        "note: peers get these tools with the SAME credentials the server uses for you. For true scoping, point this share at a credential limited to what you want visible (e.g. a Slack app that is only in specific channels)."
      );
      return;
    }
    case "list": {
      const shares = loadShares();
      if (flags.json) {
        console.log(JSON.stringify(shares, null, 2));
        return;
      }
      const projects = Object.entries(shares.projects);
      const mcp = Object.entries(shares.mcp);
      if (projects.length === 0 && mcp.length === 0) {
        console.log("nothing shared yet — `amc share project <name> <path>` or `amc share mcp <name> ...`");
        return;
      }
      for (const [name, p] of projects) {
        console.log(`project  ${name.padEnd(16)} ${p.path}  ${p.description}`);
      }
      for (const [name, m] of mcp) {
        console.log(`mcp      ${name.padEnd(16)} tools:[${m.tools.join(",")}]  ${m.description}`);
      }
      return;
    }
    case "remove": {
      const [kind, name] = rest;
      if ((kind !== "project" && kind !== "mcp") || !name) {
        throw new Error("usage: amc share remove <project|mcp> <name>");
      }
      if (!removeShare(kind, name)) throw new Error(`no such ${kind} share: ${name}`);
      // Also strip it from any peer grants.
      const peers = loadPeers();
      for (const peer of Object.values(peers)) {
        const bucket = kind === "project" ? peer.grants.projects : peer.grants.mcp;
        const idx = bucket.indexOf(name);
        if (idx >= 0) bucket.splice(idx, 1);
      }
      savePeers(peers);
      console.log(`removed ${kind} share "${name}" (and revoked it from all peers)`);
      return;
    }
    case "claude-servers": {
      const servers = readClaudeMcpServers();
      const names = Object.keys(servers);
      if (names.length === 0) {
        console.log("no MCP servers found in your Claude Code config (~/.claude.json or ./.mcp.json)");
        return;
      }
      for (const name of names) {
        const s = servers[name];
        console.log(`${name.padEnd(20)} ${s.command ? `${s.command} ${(s.args ?? []).join(" ")}` : (s.url ?? "?")}`);
      }
      console.log('\nshare one with: amc share mcp <share-name> --from-claude <name> --tools <t1,t2> --description "..."');
      return;
    }
    default:
      throw new Error("usage: amc share <project|mcp|list|remove|claude-servers> ...");
  }
}

function parseEnvFlags(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const items = Array.isArray(env) ? env : env ? [env] : [];
  for (const item of items) {
    const s = String(item);
    const eq = s.indexOf("=");
    if (eq > 0) out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

export async function cmdGrant(positional: string[], flags: { list?: boolean }): Promise<void> {
  const [peerName, kind, shareName] = positional;
  if (!peerName) throw new Error("usage: amc grant <peer> <project|mcp> <share-name>");
  const { fp, peer } = resolvePeer(peerName);

  if (flags.list || !kind) {
    console.log(`grants for ${peer.name}:`);
    console.log(`  projects: ${peer.grants.projects.join(", ") || "(none)"}`);
    console.log(`  mcp:      ${peer.grants.mcp.join(", ") || "(none)"}`);
    return;
  }
  if ((kind !== "project" && kind !== "mcp") || !shareName) {
    throw new Error("usage: amc grant <peer> <project|mcp> <share-name>");
  }
  const shares = loadShares();
  const exists = kind === "project" ? shares.projects[shareName] : shares.mcp[shareName];
  if (!exists) {
    throw new Error(`no such ${kind} share "${shareName}" — create it first (see \`amc share list\`)`);
  }
  if (!peer.approved) {
    throw new Error(`${peer.name} is not an approved peer — accept their request first (\`amc requests\`)`);
  }
  const peers = loadPeers();
  const bucket = kind === "project" ? peers[fp].grants.projects : peers[fp].grants.mcp;
  if (!bucket.includes(shareName)) bucket.push(shareName);
  savePeers(peers);
  console.log(`granted ${kind} "${shareName}" to ${peer.name}`);
  if (kind === "mcp") {
    console.log("reminder: their queries will use this server with its existing credentials — scope the credential, not just the tools.");
  }
}

export async function cmdRevokeGrant(positional: string[], flags: { all?: boolean }): Promise<void> {
  const [peerName, kind, shareName] = positional;
  if (!peerName) throw new Error("usage: amc revoke <peer> <project|mcp> <share-name>  (or --all)");
  const { fp, peer } = resolvePeer(peerName);
  const peers = loadPeers();
  if (flags.all) {
    peers[fp].grants = { projects: [], mcp: [] };
    savePeers(peers);
    console.log(`revoked ALL grants from ${peer.name}`);
    return;
  }
  if ((kind !== "project" && kind !== "mcp") || !shareName) {
    throw new Error("usage: amc revoke <peer> <project|mcp> <share-name>  (or amc revoke <peer> --all)");
  }
  const bucket = kind === "project" ? peers[fp].grants.projects : peers[fp].grants.mcp;
  const idx = bucket.indexOf(shareName);
  if (idx < 0) throw new Error(`${peer.name} does not have ${kind} "${shareName}"`);
  bucket.splice(idx, 1);
  savePeers(peers);
  console.log(`revoked ${kind} "${shareName}" from ${peer.name}`);
}
