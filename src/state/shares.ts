import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../config.js";
import { atomicWriteJson, readJson, expandTilde } from "../util.js";

export interface ProjectShare {
  path: string; // absolute path to a directory (or single file)
  description: string;
}

export interface McpShare {
  description: string;
  /** Exposed tool names on this server. Required: peers only ever see these. */
  tools: string[];
  server: {
    type?: string; // "stdio" (default)
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

export interface SharesFile {
  projects: Record<string, ProjectShare>;
  mcp: Record<string, McpShare>;
}

export function loadShares(): SharesFile {
  return readJson<SharesFile>(paths().shares, { projects: {}, mcp: {} });
}

export function saveShares(shares: SharesFile): void {
  atomicWriteJson(paths().shares, shares);
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function addProjectShare(name: string, path: string, description: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid share name: ${name}`);
  const abs = resolve(expandTilde(path));
  if (!existsSync(abs)) throw new Error(`path does not exist: ${abs}`);
  statSync(abs); // throws if unreadable
  const shares = loadShares();
  shares.projects[name] = { path: abs, description };
  saveShares(shares);
}

export function addMcpShare(name: string, share: McpShare): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid share name: ${name}`);
  if (!share.server?.command) throw new Error("mcp share needs a server command");
  if (!share.tools?.length) {
    throw new Error(
      "mcp share needs an explicit --tools list — peers only ever get the tools you name"
    );
  }
  const shares = loadShares();
  shares.mcp[name] = share;
  saveShares(shares);
}

export function removeShare(kind: "project" | "mcp", name: string): boolean {
  const shares = loadShares();
  const bucket = kind === "project" ? shares.projects : shares.mcp;
  if (!bucket[name]) return false;
  delete bucket[name];
  saveShares(shares);
  return true;
}

/** Resolve a peer's grant names into concrete share definitions (dropping stale names). */
export function resolveGrants(grants: { projects: string[]; mcp: string[] }): {
  projects: Array<{ name: string } & ProjectShare>;
  mcp: Array<{ name: string } & McpShare>;
} {
  const shares = loadShares();
  return {
    projects: grants.projects
      .filter((n) => shares.projects[n])
      .map((n) => ({ name: n, ...shares.projects[n] })),
    mcp: grants.mcp.filter((n) => shares.mcp[n]).map((n) => ({ name: n, ...shares.mcp[n] })),
  };
}
