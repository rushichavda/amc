import { seal, open, genReplyKeypair, type Wire } from "./crypto/envelope.js";
import { signPayload, verifyPayload, type Identity } from "./crypto/identity.js";
import { nowMs, randomId } from "./util.js";

/** Max allowed clock skew between peers for a request to be accepted. */
export const REQUEST_TTL_MS = 120_000;

export type RequestType = "hello" | "ping" | "ask";

export interface RequestPayload {
  typ: RequestType;
  id: string;
  ts: number;
  to: string; // recipient ik — binds the request to one recipient
  body: Record<string, unknown>;
}

export interface RequestInner {
  from: { name: string; ik: string; ek: string; host?: string; port?: number };
  rk: string; // ephemeral reply key (x25519 pub) — response is sealed to this
  payload: RequestPayload;
  sig: string; // ed25519(stableStringify(payload)) by from.ik
}

export interface ResponseInner {
  from: { ik: string };
  payload: { typ: "result"; id: string; ts: number; body: Record<string, unknown> };
  sig: string;
}

export interface PreparedRequest {
  wire: Wire;
  reply: { pub: string; d: string };
  id: string;
}

export function makeRequest(
  identity: Identity,
  peer: { ik: string; ek: string },
  typ: RequestType,
  body: Record<string, unknown>,
  selfAddress?: { host?: string; port?: number }
): PreparedRequest {
  const reply = genReplyKeypair();
  const payload: RequestPayload = { typ, id: randomId(), ts: nowMs(), to: peer.ik, body };
  const inner: RequestInner = {
    from: {
      name: identity.name,
      ik: identity.ik,
      ek: identity.ek,
      ...(selfAddress?.host ? { host: selfAddress.host } : {}),
      ...(selfAddress?.port ? { port: selfAddress.port } : {}),
    },
    rk: reply.pub,
    payload,
    sig: signPayload(identity, payload),
  };
  return { wire: seal(peer.ek, inner), reply, id: payload.id };
}

/** Open and authenticate an inbound request. Throws on any validation failure. */
export function openRequest(identity: Identity, wire: Wire): RequestInner {
  const inner = open(identity.ek, identity.ekD, wire) as RequestInner;
  if (!inner?.from?.ik || !inner.payload || !inner.sig || !inner.rk) {
    throw new Error("malformed request");
  }
  if (!verifyPayload(inner.from.ik, inner.payload, inner.sig)) {
    throw new Error("bad signature");
  }
  if (inner.payload.to !== identity.ik) {
    throw new Error("request not addressed to this identity");
  }
  const skew = Math.abs(nowMs() - inner.payload.ts);
  if (skew > REQUEST_TTL_MS) {
    throw new Error("request expired (check clock sync between machines)");
  }
  return inner;
}

export function makeResponse(
  identity: Identity,
  replyKey: string,
  requestId: string,
  body: Record<string, unknown>
): Wire {
  const payload = { typ: "result" as const, id: requestId, ts: nowMs(), body };
  const inner: ResponseInner = {
    from: { ik: identity.ik },
    payload,
    sig: signPayload(identity, payload),
  };
  return seal(replyKey, inner);
}

/** Open and authenticate a response sealed to our per-request reply key. */
export function openResponse(
  reply: { pub: string; d: string },
  expectedIk: string,
  expectedId: string,
  wire: Wire
): Record<string, unknown> {
  const inner = open(reply.pub, reply.d, wire) as ResponseInner;
  if (!inner?.payload || !inner.sig || !inner.from?.ik) throw new Error("malformed response");
  if (inner.from.ik !== expectedIk) throw new Error("response from unexpected identity");
  if (!verifyPayload(inner.from.ik, inner.payload, inner.sig)) throw new Error("bad response signature");
  if (inner.payload.id !== expectedId) throw new Error("response id mismatch");
  return inner.payload.body;
}

/** In-memory replay guard: remembers recently seen request ids. */
export class ReplayGuard {
  private seen = new Map<string, number>();

  check(id: string): boolean {
    this.prune();
    if (this.seen.has(id)) return false;
    this.seen.set(id, nowMs());
    return true;
  }

  private prune(): void {
    const cutoff = nowMs() - REQUEST_TTL_MS * 2;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }
}
