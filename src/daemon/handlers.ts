import { execFile } from "node:child_process";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import type { Identity } from "../crypto/identity.js";
import { fingerprint } from "../crypto/identity.js";
import {
  openRequest,
  makeResponse,
  ReplayGuard,
  type RequestInner,
} from "../protocol.js";
import type { Wire } from "../crypto/envelope.js";
import { loadPeers, savePeers, findPeerByIk, touchPeer, uniquePeerName } from "../state/peers.js";
import { resolveGrants } from "../state/shares.js";
import { validateInvite } from "../state/invites.js";
import { addRequest, loadRequests } from "../state/requests.js";
import { checkAndIncrement } from "../state/usage.js";
import { appendAudit } from "../audit.js";
import { runSandbox } from "../sandbox/runner.js";
import { scanSensitive } from "../sandbox/filter.js";

const replayGuard = new ReplayGuard();

export type Logger = (line: string) => void;

/**
 * Handle one inbound sealed envelope. Returns the sealed response wire.
 * Throws only on envelope-level failures (caller answers HTTP 400).
 */
export async function handleEnvelope(
  identity: Identity,
  wire: Wire,
  remoteIp: string,
  log: Logger
): Promise<Wire> {
  const inner = openRequest(identity, wire);
  if (!replayGuard.check(inner.payload.id)) {
    throw new Error("replayed request id");
  }
  const config = loadConfig(); // re-read per request: CLI edits files directly
  const respond = (body: Record<string, unknown>) =>
    makeResponse(identity, inner.rk, inner.payload.id, body);

  switch (inner.payload.typ) {
    case "hello":
      return respond(await handleHello(identity, config, inner, remoteIp, log));
    case "ping":
      return respond(handlePing(identity, config, inner, log));
    case "ask":
      return respond(await handleAsk(identity, config, inner, log));
    default:
      return respond({ status: "error", message: "unknown request type" });
  }
}

async function handleHello(
  identity: Identity,
  config: Config,
  inner: RequestInner,
  remoteIp: string,
  log: Logger
): Promise<Record<string, unknown>> {
  const from = inner.from;
  const fp = fingerprint(from.ik);
  const existing = findPeerByIk(from.ik);

  if (existing?.peer.blocked) {
    return { status: "denied", message: "blocked" };
  }
  if (existing?.peer.approved) {
    touchPeer(fp);
    return { status: "approved", owner: identity.name, grants: grantSummary(existing.peer) };
  }
  if (loadRequests()[fp]) {
    return { status: "pending", owner: identity.name };
  }

  const token = String(inner.payload.body.token ?? "");
  if (!validateInvite(token)) {
    log(`hello from ${from.name} (${fp}) rejected: invalid/expired invite token`);
    return { status: "denied", message: "invalid or expired invite" };
  }

  const stored = addRequest(fp, {
    name: from.name,
    ik: from.ik,
    ek: from.ek,
    host: from.host ?? "",
    port: from.port ?? 0,
    ip: remoteIp,
    ts: Date.now(),
    token,
  });
  if (!stored) {
    return { status: "denied", message: "too many pending requests" };
  }

  appendAudit({
    dir: "in",
    typ: "hello",
    peerFp: fp,
    peerName: from.name,
    status: "pending",
    detail: `from ${remoteIp}`,
  });
  log(`connection request from "${from.name}" (${fp}) — run: amc accept ${from.name}`);
  notify(config, `Connection request from ${from.name}`, `Run: amc accept ${from.name}`);
  return { status: "pending", owner: identity.name };
}

function handlePing(
  identity: Identity,
  config: Config,
  inner: RequestInner,
  _log: Logger
): Record<string, unknown> {
  const found = findPeerByIk(inner.from.ik);
  if (!found || found.peer.blocked) return { status: "unknown", owner: identity.name };
  if (!found.peer.approved) return { status: "pending", owner: identity.name };
  touchPeer(found.fp);
  return {
    status: "approved",
    owner: identity.name,
    paused: config.paused,
    grants: grantSummary(found.peer),
    limits: found.peer.limits ?? config.limitsDefault,
  };
}

async function handleAsk(
  identity: Identity,
  config: Config,
  inner: RequestInner,
  log: Logger
): Promise<Record<string, unknown>> {
  const from = inner.from;
  const found = findPeerByIk(from.ik);
  const fp = fingerprint(from.ik);
  const peerName = found?.peer.name ?? from.name;
  const question = String(inner.payload.body.q ?? "");
  const context = inner.payload.body.context ? String(inner.payload.body.context) : undefined;

  const audit = (status: string, extra: Record<string, unknown> = {}) =>
    appendAudit({
      dir: "in",
      typ: "ask",
      peerFp: fp,
      peerName,
      status,
      question: question.slice(0, 2000),
      ...extra,
    } as never);

  if (!found || found.peer.blocked || !found.peer.approved) {
    audit("denied", { detail: "peer not approved" });
    return { status: "denied", message: "you are not an approved peer of this owner" };
  }
  if (config.paused) {
    audit("denied", { detail: "paused" });
    return { status: "paused", message: `${identity.name} has paused amc queries` };
  }
  if (!question || question.length > config.sandbox.maxQuestionChars) {
    audit("denied", { detail: "bad question size" });
    return { status: "error", message: "question missing or too long" };
  }

  const limits = found.peer.limits ?? config.limitsDefault;
  const rate = checkAndIncrement(fp, limits);
  if (!rate.ok) {
    audit("rate_limited", { detail: rate.reason });
    return { status: "rate_limited", message: rate.reason };
  }

  const grants = resolveGrants(found.peer.grants);
  if (grants.projects.length === 0 && grants.mcp.length === 0) {
    audit("denied", { detail: "no grants" });
    return {
      status: "denied",
      message: `${identity.name} has not granted you any scope yet (they can run: amc grant ${peerName} ...)`,
    };
  }

  touchPeer(fp);
  log(`query from "${peerName}": ${question.slice(0, 120)}${question.length > 120 ? "…" : ""}`);
  notify(config, `amc query from ${peerName}`, question.slice(0, 80));

  const result = await runSandbox({
    config,
    scope: { ownerName: identity.name, peerName, projects: grants.projects, mcp: grants.mcp },
    question,
    context,
  });

  if (!result.ok) {
    audit(result.status, { detail: result.errorMessage, durationMs: result.meta.durationMs });
    const peerMessage =
      result.status === "busy"
        ? "owner's sandbox is busy — try again in a minute"
        : result.status === "timeout"
          ? "query timed out on the owner's machine"
          : "owner's sandbox could not run this query";
    return { status: result.status === "busy" ? "busy" : "error", message: peerMessage };
  }

  const answer = result.answer ?? "";
  if (config.filter.enabled) {
    const { hits } = scanSensitive(answer, config.filter.extraPatterns);
    if (hits.length > 0) {
      audit("filtered", {
        filterHits: hits,
        answer,
        durationMs: result.meta.durationMs,
        numTurns: result.meta.numTurns,
      });
      log(`BLOCKED response to "${peerName}" — sensitive patterns: ${hits.join(", ")}`);
      notify(config, "amc blocked a response", `to ${peerName}: ${hits.join(", ")}`);
      return {
        status: "filtered",
        message: `response blocked by ${identity.name}'s sensitive-content filter`,
      };
    }
  }

  audit("ok", {
    answer,
    durationMs: result.meta.durationMs,
    numTurns: result.meta.numTurns,
    costUsd: result.meta.costUsd,
    grantsUsed: found.peer.grants,
  });
  return {
    status: "ok",
    answer,
    meta: {
      durationMs: result.meta.durationMs,
      numTurns: result.meta.numTurns,
      answeredBy: identity.name,
    },
  };
}

function grantSummary(peer: { grants: { projects: string[]; mcp: string[] } }) {
  const resolved = resolveGrants(peer.grants);
  return {
    projects: resolved.projects.map((p) => ({ name: p.name, description: p.description })),
    mcp: resolved.mcp.map((m) => ({ name: m.name, description: m.description, tools: m.tools })),
  };
}

/** Approve a pending request from the CLI side (shared by `amc accept`). */
export function approveRequest(fp: string): { name: string } {
  const pending = loadRequests()[fp];
  if (!pending) throw new Error(`no pending request with fingerprint ${fp}`);
  const peers = loadPeers();
  const name = uniquePeerName(pending.name);
  peers[fp] = {
    name,
    ik: pending.ik,
    ek: pending.ek,
    host: pending.host,
    port: pending.port,
    approved: true,
    via: "hello",
    addedAt: Date.now(),
    grants: { projects: [], mcp: [] },
  };
  savePeers(peers);
  return { name };
}

function notify(config: Config, title: string, message: string): void {
  if (!config.notify || process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile(
    "osascript",
    ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
    () => {
      /* best effort */
    }
  );
}
