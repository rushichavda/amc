import { paths } from "../config.js";
import { atomicWriteJson, readJson, nowMs } from "../util.js";
import { fingerprint } from "../crypto/identity.js";

export interface PeerGrants {
  projects: string[];
  mcp: string[];
}

export interface PeerEntry {
  name: string; // local alias (unique among peers)
  ik: string;
  ek: string;
  host: string;
  port: number;
  approved: boolean; // do WE accept queries from them
  blocked?: boolean;
  via: "invite" | "hello";
  addedAt: number;
  lastSeenAt?: number;
  grants: PeerGrants;
  limits?: { perHour: number; perDay: number };
}

export type PeersFile = { peers: Record<string, PeerEntry> }; // keyed by fingerprint(ik)

export function loadPeers(): Record<string, PeerEntry> {
  return readJson<PeersFile>(paths().peers, { peers: {} }).peers;
}

export function savePeers(peers: Record<string, PeerEntry>): void {
  atomicWriteJson(paths().peers, { peers });
}

export function upsertPeer(entry: Omit<PeerEntry, "addedAt"> & { addedAt?: number }): string {
  const peers = loadPeers();
  const fp = fingerprint(entry.ik);
  const existing = peers[fp];
  peers[fp] = {
    ...entry,
    addedAt: existing?.addedAt ?? entry.addedAt ?? nowMs(),
    grants: existing?.grants ?? entry.grants ?? { projects: [], mcp: [] },
  };
  savePeers(peers);
  return fp;
}

export function findPeerByIk(ik: string): { fp: string; peer: PeerEntry } | null {
  const fp = fingerprint(ik);
  const peer = loadPeers()[fp];
  return peer ? { fp, peer } : null;
}

/** Resolve a peer by local alias or fingerprint (full or unambiguous prefix). */
export function resolvePeer(nameOrFp: string): { fp: string; peer: PeerEntry } {
  const peers = loadPeers();
  const needle = nameOrFp.toLowerCase();
  const matches = Object.entries(peers).filter(
    ([fp, p]) =>
      p.name.toLowerCase() === needle ||
      fp === needle ||
      fp.replace(/-/g, "").startsWith(needle.replace(/-/g, ""))
  );
  if (matches.length === 0) throw new Error(`unknown peer: ${nameOrFp} (see \`amc peers\`)`);
  if (matches.length > 1) throw new Error(`ambiguous peer: ${nameOrFp}`);
  return { fp: matches[0][0], peer: matches[0][1] };
}

export function touchPeer(fp: string): void {
  const peers = loadPeers();
  if (peers[fp]) {
    peers[fp].lastSeenAt = nowMs();
    savePeers(peers);
  }
}

/** Ensure a peer alias is unique; append a numeric suffix when taken. */
export function uniquePeerName(desired: string, ownIk?: string): string {
  const peers = loadPeers();
  const taken = new Set(
    Object.entries(peers)
      .filter(([, p]) => !ownIk || p.ik !== ownIk)
      .map(([, p]) => p.name.toLowerCase())
  );
  let name = desired || "peer";
  let i = 2;
  while (taken.has(name.toLowerCase())) name = `${desired}-${i++}`;
  return name;
}
