import { loadConfig } from "./config.js";
import { requireIdentity } from "./crypto/identity.js";
import { makeRequest, openResponse, type RequestType } from "./protocol.js";
import type { Wire } from "./crypto/envelope.js";
import type { PeerEntry } from "./state/peers.js";
import { appendAudit } from "./audit.js";
import { fingerprint } from "./crypto/identity.js";

export interface PeerAddress {
  ik: string;
  ek: string;
  host: string;
  port: number;
}

/**
 * Send one sealed request to a peer's daemon and return the authenticated
 * response body. Used by the CLI, the MCP server, and `amc connect`.
 */
export async function sendToPeer(
  peer: PeerAddress,
  typ: RequestType,
  body: Record<string, unknown>,
  timeoutMs = 240_000
): Promise<Record<string, unknown>> {
  const identity = requireIdentity();
  const config = loadConfig();
  if (!peer.host || !peer.port) {
    throw new Error("peer has no known address — set one with `amc peer set-host <peer> <host:port>`");
  }
  const selfAddress = { host: config.advertiseHost || undefined, port: config.port };
  const { wire, reply, id } = makeRequest(identity, peer, typ, body, selfAddress);

  let response: Response;
  try {
    response = await fetch(`http://${peer.host}:${peer.port}/v1/box`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wire),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = (err as Error & { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
    if (cause === "TimeoutError" || (err as Error).name === "TimeoutError") {
      throw new Error(`peer did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`peer unreachable at ${peer.host}:${peer.port} (${cause ?? "network error"})`);
  }
  if (!response.ok) {
    throw new Error(`peer rejected the request (HTTP ${response.status})`);
  }
  const responseWire = (await response.json()) as Wire;
  return openResponse(reply, peer.ik, id, responseWire);
}

/** Ask a peer's sandboxed Claude a question. Audits the outbound query locally. */
export async function askPeer(
  peer: PeerEntry,
  question: string,
  context?: string,
  timeoutMs = 240_000
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { q: question };
  if (context) body.context = context;
  const started = Date.now();
  try {
    const result = await sendToPeer(peer, "ask", body, timeoutMs);
    appendAudit({
      dir: "out",
      typ: "ask",
      peerFp: fingerprint(peer.ik),
      peerName: peer.name,
      status: String(result.status ?? "unknown"),
      question: question.slice(0, 2000),
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    appendAudit({
      dir: "out",
      typ: "ask",
      peerFp: fingerprint(peer.ik),
      peerName: peer.name,
      status: "error",
      question: question.slice(0, 2000),
      detail: (err as Error).message,
      durationMs: Date.now() - started,
    });
    throw err;
  }
}

export async function pingPeer(peer: PeerEntry, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return sendToPeer(peer, "ping", {}, timeoutMs);
}

export async function helloPeer(
  peer: PeerAddress,
  token: string,
  timeoutMs = 10_000
): Promise<Record<string, unknown>> {
  return sendToPeer(peer, "hello", { token }, timeoutMs);
}
