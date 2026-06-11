import { paths } from "../config.js";
import { atomicWriteJson, readJson, nowMs, randomId } from "../util.js";

export interface InviteEntry {
  createdAt: number;
  expiresAt: number;
  multi: boolean; // multi-use invites survive accepts
  label: string;
}

type InvitesFile = Record<string, InviteEntry>;

export function loadInvites(): InvitesFile {
  return readJson<InvitesFile>(paths().invites, {});
}

export function createInvite(ttlMs: number, multi: boolean, label: string): string {
  const invites = loadInvites();
  const token = randomId(12);
  invites[token] = { createdAt: nowMs(), expiresAt: nowMs() + ttlMs, multi, label };
  atomicWriteJson(paths().invites, invites);
  return token;
}

export function validateInvite(token: string): boolean {
  const entry = loadInvites()[token];
  return !!entry && entry.expiresAt > nowMs();
}

/** Consume a single-use invite (called on accept, not on hello — spam must not burn it). */
export function consumeInvite(token: string): void {
  const invites = loadInvites();
  const entry = invites[token];
  if (entry && !entry.multi) {
    delete invites[token];
    atomicWriteJson(paths().invites, invites);
  }
}

export function revokeInvite(token: string): boolean {
  const invites = loadInvites();
  if (!invites[token]) return false;
  delete invites[token];
  atomicWriteJson(paths().invites, invites);
  return true;
}
