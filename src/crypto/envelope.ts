import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { b64u, fromB64u } from "../util.js";

/**
 * Sealed envelope ("NaCl box" pattern with Node stdlib):
 *   - fresh ephemeral X25519 keypair per message
 *   - shared = ECDH(ephemeral_priv, recipient_static_pub)
 *   - key   = HKDF-SHA256(shared, salt = ephPub || recipientPub, info = "amc-box-v1")
 *   - AES-256-GCM with random 96-bit IV
 *
 * Confidentiality + integrity come from GCM; sender authenticity comes from
 * the Ed25519 signature carried inside the plaintext (see protocol.ts).
 */
export interface Wire {
  v: 1;
  ek: string; // ephemeral x25519 pub, b64url
  n: string; // 12-byte IV, b64url
  c: string; // ciphertext || gcm tag, b64url
}

const INFO = Buffer.from("amc-box-v1", "utf8");

function deriveKey(shared: Buffer, ephPubRaw: Buffer, recipientPubRaw: Buffer): Buffer {
  const salt = Buffer.concat([ephPubRaw, recipientPubRaw]);
  return Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
}

export function seal(recipientEk: string, plaintextObj: unknown): Wire {
  const eph = generateKeyPairSync("x25519");
  const ephPubJwk = eph.publicKey.export({ format: "jwk" }) as { x: string };
  const recipientPub = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: recipientEk },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const key = deriveKey(shared, fromB64u(ephPubJwk.x), fromB64u(recipientEk));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const pt = Buffer.from(JSON.stringify(plaintextObj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, ek: ephPubJwk.x, n: b64u(iv), c: b64u(ct) };
}

export function open(myEk: string, myEkD: string, wire: Wire): unknown {
  if (!wire || wire.v !== 1 || !wire.ek || !wire.n || !wire.c) {
    throw new Error("malformed envelope");
  }
  const myPriv = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: myEk, d: myEkD },
    format: "jwk",
  });
  const ephPub = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: wire.ek },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey: myPriv, publicKey: ephPub });
  const key = deriveKey(shared, fromB64u(wire.ek), fromB64u(myEk));
  const iv = fromB64u(wire.n);
  const blob = fromB64u(wire.c);
  if (blob.length < 17) throw new Error("envelope too short");
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(0, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

/** One-shot X25519 keypair used as a per-request reply address. */
export function genReplyKeypair(): { pub: string; d: string } {
  const kp = generateKeyPairSync("x25519");
  const pub = kp.publicKey.export({ format: "jwk" }) as { x: string };
  const priv = kp.privateKey.export({ format: "jwk" }) as { d: string };
  return { pub: pub.x, d: priv.d };
}
