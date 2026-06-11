import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  KeyObject,
} from "node:crypto";
import { existsSync } from "node:fs";
import { paths } from "../config.js";
import { atomicWriteJson, readJson, stableStringify, nowMs } from "../util.js";

/**
 * An amc identity: Ed25519 for signing (ik = identity key) and X25519 for
 * encryption (ek). Public halves are base64url raw keys (the JWK `x` value);
 * private halves are the JWK `d` values, stored 0600 in identity.json.
 */
export interface Identity {
  name: string;
  ik: string; // ed25519 public, b64url
  ikD: string; // ed25519 private (jwk d), b64url
  ek: string; // x25519 public, b64url
  ekD: string; // x25519 private (jwk d), b64url
  createdAt: number;
}

export function createIdentity(name: string): Identity {
  const ed = generateKeyPairSync("ed25519");
  const x = generateKeyPairSync("x25519");
  const edPub = ed.publicKey.export({ format: "jwk" }) as { x: string };
  const edPriv = ed.privateKey.export({ format: "jwk" }) as { d: string };
  const xPub = x.publicKey.export({ format: "jwk" }) as { x: string };
  const xPriv = x.privateKey.export({ format: "jwk" }) as { d: string };
  const identity: Identity = {
    name,
    ik: edPub.x,
    ikD: edPriv.d,
    ek: xPub.x,
    ekD: xPriv.d,
    createdAt: nowMs(),
  };
  atomicWriteJson(paths().identity, identity);
  return identity;
}

export function loadIdentity(): Identity | null {
  if (!existsSync(paths().identity)) return null;
  const identity = readJson<Identity | null>(paths().identity, null);
  if (!identity || !identity.ik || !identity.ikD) return null;
  return identity;
}

export function requireIdentity(): Identity {
  const identity = loadIdentity();
  if (!identity) {
    throw new Error("no identity found — run `amc init` first");
  }
  return identity;
}

/** Human-friendly fingerprint of an identity key: 16 hex chars grouped by 4. */
export function fingerprint(ik: string): string {
  const hex = createHash("sha256").update(Buffer.from(ik, "base64url")).digest("hex").slice(0, 16);
  return hex.replace(/(.{4})(?=.)/g, "$1-");
}

function edPrivateKeyObject(identity: Identity): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: identity.ik, d: identity.ikD },
    format: "jwk",
  });
}

export function edPublicKeyObject(ik: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: ik }, format: "jwk" });
}

/** Sign a JSON-serializable payload with the identity's Ed25519 key. */
export function signPayload(identity: Identity, payload: unknown): string {
  const data = Buffer.from(stableStringify(payload), "utf8");
  return cryptoSign(null, data, edPrivateKeyObject(identity)).toString("base64url");
}

/** Verify a payload signature against a peer's public identity key. */
export function verifyPayload(ik: string, payload: unknown, sig: string): boolean {
  try {
    const data = Buffer.from(stableStringify(payload), "utf8");
    return cryptoVerify(null, data, edPublicKeyObject(ik), Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}
