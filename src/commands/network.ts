import { loadConfig } from "../config.js";
import { requireIdentity, fingerprint } from "../crypto/identity.js";
import { createInvite, loadInvites, revokeInvite, consumeInvite } from "../state/invites.js";
import {
  loadPeers,
  savePeers,
  resolvePeer,
  findPeerByIk,
  uniquePeerName,
} from "../state/peers.js";
import { loadRequests, removeRequest } from "../state/requests.js";
import { approveRequest } from "../daemon/handlers.js";
import { helloPeer, pingPeer } from "../client.js";
import { b64u, fromB64u, parseDuration, guessLanAddress, shortTs } from "../util.js";

interface InviteCode {
  n: string; // owner name
  h: string; // host
  p: number; // port
  ik: string;
  ek: string;
  t: string; // invite token
}

export async function cmdInvite(flags: {
  label?: string;
  ttl?: string;
  multi?: boolean;
  host?: string;
  list?: boolean;
  revoke?: string;
  json?: boolean;
}): Promise<void> {
  const identity = requireIdentity();
  const config = loadConfig();

  if (flags.list) {
    const invites = loadInvites();
    if (Object.keys(invites).length === 0) {
      console.log("no active invites");
      return;
    }
    for (const [token, inv] of Object.entries(invites)) {
      const state = inv.expiresAt > Date.now() ? `expires ${shortTs(inv.expiresAt)}` : "EXPIRED";
      console.log(`${token}  ${inv.multi ? "multi" : "single"}  ${state}  ${inv.label}`);
    }
    return;
  }
  if (flags.revoke) {
    console.log(revokeInvite(flags.revoke) ? "revoked" : "no such invite token");
    return;
  }

  const host = flags.host || config.advertiseHost || (await guessLanAddress());
  if (!host) {
    throw new Error(
      "could not detect an address to advertise — pass --host <ip-or-hostname> (Tailscale DNS names work great)"
    );
  }
  const ttlMs = parseDuration(flags.ttl ?? "7d");
  const token = createInvite(ttlMs, !!flags.multi, flags.label ?? "");
  const code: InviteCode = {
    n: identity.name,
    h: host,
    p: config.port,
    ik: identity.ik,
    ek: identity.ek,
    t: token,
  };
  const encoded = "amc1." + b64u(Buffer.from(JSON.stringify(code), "utf8"));
  if (flags.json) {
    console.log(JSON.stringify({ code: encoded, host, port: config.port, token }));
    return;
  }
  console.log(`invite code (share over Slack/email — valid ${flags.ttl ?? "7d"}${flags.multi ? ", multi-use" : ", single-use"}):\n`);
  console.log(`  ${encoded}\n`);
  console.log(`your teammate runs:  amc connect ${encoded.slice(0, 24)}…`);
  console.log(`then you run:        amc accept <their-name>   (after their request arrives)`);
  console.log(`\nnote: they will connect to ${host}:${config.port} — make sure your daemon is running and reachable.`);
}

export async function cmdConnect(positional: string[], flags: { name?: string; json?: boolean }): Promise<void> {
  requireIdentity();
  const codeStr = positional[0];
  if (!codeStr) throw new Error("usage: amc connect <invite-code> [--name alias]");
  if (!codeStr.startsWith("amc1.")) throw new Error("invalid invite code (must start with amc1.)");
  let code: InviteCode;
  try {
    code = JSON.parse(fromB64u(codeStr.slice(5)).toString("utf8")) as InviteCode;
  } catch {
    throw new Error("invalid invite code (could not decode)");
  }
  if (!code.ik || !code.ek || !code.h || !code.p || !code.t) {
    throw new Error("invalid invite code (missing fields)");
  }

  const existing = findPeerByIk(code.ik);
  const name = flags.name || existing?.peer.name || uniquePeerName(code.n, code.ik);
  const peers = loadPeers();
  const fp = fingerprint(code.ik);
  peers[fp] = {
    name,
    ik: code.ik,
    ek: code.ek,
    host: code.h,
    port: code.p,
    approved: true, // we initiated trust by using their invite
    via: "invite",
    addedAt: existing?.peer.addedAt ?? Date.now(),
    grants: existing?.peer.grants ?? { projects: [], mcp: [] },
  };
  savePeers(peers);

  let status = "unreachable";
  let message = "";
  try {
    const res = await helloPeer({ ik: code.ik, ek: code.ek, host: code.h, port: code.p }, code.t);
    status = String(res.status ?? "unknown");
    message = String(res.message ?? "");
  } catch (err) {
    message = (err as Error).message;
  }

  if (flags.json) {
    console.log(JSON.stringify({ peer: name, fingerprint: fp, status, message }));
    return;
  }
  console.log(`stored peer "${name}" (${fp})`);
  switch (status) {
    case "pending":
      console.log(`connection request sent — waiting for ${code.n} to run: amc accept ${"<your-name>"}`);
      break;
    case "approved":
      console.log("already approved — you're connected. Try: amc ask " + name + ' "hello"');
      break;
    case "denied":
      console.log(`request denied: ${message}`);
      break;
    default:
      console.log(`could not reach their daemon (${message}) — peer stored; re-run this command when they're online.`);
  }
}

export async function cmdRequests(flags: { json?: boolean }): Promise<void> {
  const requests = loadRequests();
  const entries = Object.entries(requests);
  if (flags.json) {
    console.log(JSON.stringify(requests, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("no pending connection requests");
    return;
  }
  for (const [fp, r] of entries) {
    console.log(`${r.name}  ${fp}  from ${r.ip}  at ${shortTs(r.ts)}`);
  }
  console.log(`\naccept with: amc accept <name>   reject with: amc reject <name>`);
}

function findRequest(nameOrFp: string): { fp: string } {
  const requests = loadRequests();
  const needle = nameOrFp.toLowerCase();
  const matches = Object.entries(requests).filter(
    ([fp, r]) =>
      r.name.toLowerCase() === needle ||
      fp === needle ||
      fp.replace(/-/g, "").startsWith(needle.replace(/-/g, ""))
  );
  if (matches.length === 0) throw new Error(`no pending request matching "${nameOrFp}" (see \`amc requests\`)`);
  if (matches.length > 1) throw new Error(`ambiguous: ${nameOrFp}`);
  return { fp: matches[0][0] };
}

export async function cmdAccept(positional: string[]): Promise<void> {
  const target = positional[0];
  if (!target) throw new Error("usage: amc accept <name-or-fingerprint>");
  const { fp } = findRequest(target);
  const pending = loadRequests()[fp];
  const { name } = approveRequest(fp);
  removeRequest(fp);
  if (pending?.token) consumeInvite(pending.token);
  console.log(`accepted "${name}" (${fp}) — they can now reach your daemon, but have NO grants yet.`);
  console.log(`grant scope with:  amc grant ${name} project <share-name>   (see \`amc share list\`)`);
}

export async function cmdReject(positional: string[], flags: { block?: boolean }): Promise<void> {
  const target = positional[0];
  if (!target) throw new Error("usage: amc reject <name-or-fingerprint> [--block]");
  const { fp } = findRequest(target);
  const pending = removeRequest(fp);
  if (flags.block && pending) {
    const peers = loadPeers();
    peers[fp] = {
      name: uniquePeerName(pending.name),
      ik: pending.ik,
      ek: pending.ek,
      host: pending.host,
      port: pending.port,
      approved: false,
      blocked: true,
      via: "hello",
      addedAt: Date.now(),
      grants: { projects: [], mcp: [] },
    };
    savePeers(peers);
    console.log(`rejected and blocked ${pending.name} (${fp})`);
    return;
  }
  console.log(`rejected request from ${pending?.name ?? fp}`);
}

export async function cmdPeers(flags: { json?: boolean; ping?: boolean }): Promise<void> {
  const peers = loadPeers();
  const entries = Object.entries(peers);
  if (flags.json) {
    console.log(JSON.stringify(peers, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("no peers — create an invite (`amc invite`) or use someone else's (`amc connect <code>`)");
    return;
  }
  for (const [fp, p] of entries) {
    const flagsStr = [
      p.blocked ? "BLOCKED" : p.approved ? "approved" : "not-approved",
      p.grants.projects.length + p.grants.mcp.length > 0
        ? `grants:[${[...p.grants.projects, ...p.grants.mcp].join(",")}]`
        : "grants:none",
    ].join("  ");
    let live = "";
    if (flags.ping && !p.blocked) {
      try {
        const pong = await pingPeer(p, 4000);
        live = `  online(${String(pong.status)})`;
      } catch {
        live = "  offline";
      }
    }
    console.log(`${p.name.padEnd(16)} ${fp}  ${p.host}:${p.port}  ${flagsStr}${live}`);
  }
}

export async function cmdPeer(positional: string[], flags: Record<string, unknown>): Promise<void> {
  const [action, target, ...rest] = positional;
  if (!action || !target) {
    throw new Error("usage: amc peer <remove|set-host|limits|block|unblock> <peer> [...]");
  }
  const { fp, peer } = resolvePeer(target);
  const peers = loadPeers();
  switch (action) {
    case "remove":
      delete peers[fp];
      savePeers(peers);
      console.log(`removed ${peer.name}`);
      return;
    case "set-host": {
      const hostPort = rest[0];
      if (!hostPort) throw new Error("usage: amc peer set-host <peer> <host:port>");
      const [host, portStr] = hostPort.split(":");
      peers[fp].host = host;
      peers[fp].port = portStr ? parseInt(portStr, 10) : peers[fp].port || 4711;
      savePeers(peers);
      console.log(`${peer.name} → ${peers[fp].host}:${peers[fp].port}`);
      return;
    }
    case "limits": {
      const perHour = flags["per-hour"] ? parseInt(String(flags["per-hour"]), 10) : undefined;
      const perDay = flags["per-day"] ? parseInt(String(flags["per-day"]), 10) : undefined;
      const config = loadConfig();
      peers[fp].limits = {
        perHour: perHour ?? peers[fp].limits?.perHour ?? config.limitsDefault.perHour,
        perDay: perDay ?? peers[fp].limits?.perDay ?? config.limitsDefault.perDay,
      };
      savePeers(peers);
      console.log(`${peer.name} limits: ${peers[fp].limits!.perHour}/hour, ${peers[fp].limits!.perDay}/day`);
      return;
    }
    case "block":
      peers[fp].blocked = true;
      peers[fp].approved = false;
      savePeers(peers);
      console.log(`blocked ${peer.name}`);
      return;
    case "unblock":
      peers[fp].blocked = false;
      savePeers(peers);
      console.log(`unblocked ${peer.name} (still not approved — accept a new request or set grants)`);
      return;
    default:
      throw new Error(`unknown peer action: ${action}`);
  }
}
