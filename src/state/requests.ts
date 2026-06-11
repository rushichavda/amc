import { paths } from "../config.js";
import { atomicWriteJson, readJson, nowMs } from "../util.js";

/** A pending inbound connection request (a `hello` we haven't accepted yet). */
export interface PendingRequest {
  name: string;
  ik: string;
  ek: string;
  host: string;
  port: number;
  ip: string;
  ts: number;
  token: string; // the invite token they presented
}

type RequestsFile = Record<string, PendingRequest>; // keyed by fingerprint

const MAX_PENDING = 25;

export function loadRequests(): RequestsFile {
  return readJson<RequestsFile>(paths().requests, {});
}

export function addRequest(fp: string, request: PendingRequest): boolean {
  const requests = loadRequests();
  if (!requests[fp] && Object.keys(requests).length >= MAX_PENDING) return false;
  requests[fp] = { ...request, ts: nowMs() };
  atomicWriteJson(paths().requests, requests);
  return true;
}

export function removeRequest(fp: string): PendingRequest | null {
  const requests = loadRequests();
  const entry = requests[fp] ?? null;
  if (entry) {
    delete requests[fp];
    atomicWriteJson(paths().requests, requests);
  }
  return entry;
}
