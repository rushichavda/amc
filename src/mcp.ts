import { createInterface } from "node:readline";
import { loadPeers, resolvePeer } from "./state/peers.js";
import { askPeer, pingPeer } from "./client.js";
import { loadIdentity } from "./crypto/identity.js";

/**
 * Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited) exposing amc to
 * the user's main Claude Code session. Registered via `amc setup-claude`.
 *
 * Tools:
 *   ask_peer(peer, question, context?, timeout_seconds?)
 *   list_peers()
 */

const PROTOCOL_FALLBACK = "2025-06-18";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: number | string | null | undefined, result: unknown): void {
  write({ jsonrpc: "2.0", id: id ?? null, result });
}

function replyError(id: number | string | null | undefined, code: number, message: string): void {
  write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

const TOOLS = [
  {
    name: "ask_peer",
    description:
      "Ask a teammate's Claude a question, answered by an isolated sandbox on their machine using only the context they explicitly granted you (their project code, docs, or connected services). Use this when a question concerns a teammate's domain: their projects, their services, decisions or status only they would know. The answer may take 1-3 minutes. Use list_peers first if you are unsure who knows what.",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "The peer's name or fingerprint as shown by list_peers",
        },
        question: {
          type: "string",
          description:
            "A clear, self-contained question. The peer's sandbox has no context from this conversation, so include everything needed to answer.",
        },
        context: {
          type: "string",
          description: "Optional extra background for the peer's sandbox (e.g. what you already know).",
        },
        timeout_seconds: {
          type: "number",
          description: "How long to wait for the answer (default 240).",
        },
      },
      required: ["peer", "question"],
    },
  },
  {
    name: "list_peers",
    description:
      "List connected amc peers, whether they are reachable right now, and what scope (projects/services) each has granted us. Use this to decide whom to ask_peer.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callAskPeer(args: Record<string, unknown>) {
  const peerName = String(args.peer ?? "");
  const question = String(args.question ?? "");
  if (!peerName || !question) {
    return textResult("ask_peer requires `peer` and `question`.", true);
  }
  let resolved;
  try {
    resolved = resolvePeer(peerName);
  } catch (err) {
    const names = Object.values(loadPeers())
      .map((p) => p.name)
      .join(", ");
    return textResult(
      `${(err as Error).message}. Known peers: ${names || "(none — connect one with \`amc connect\`)"}`,
      true
    );
  }
  const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds ?? 240), 10), 600) * 1000;
  try {
    const result = await askPeer(
      resolved.peer,
      question,
      args.context ? String(args.context) : undefined,
      timeoutMs
    );
    const status = String(result.status ?? "unknown");
    if (status === "ok") {
      const meta = result.meta as { answeredBy?: string; durationMs?: number } | undefined;
      const took = meta?.durationMs ? ` in ${Math.round(meta.durationMs / 1000)}s` : "";
      return textResult(
        `Answer from ${meta?.answeredBy ?? resolved.peer.name}'s Claude (sandboxed${took}):\n\n${String(result.answer ?? "")}`
      );
    }
    return textResult(
      `Peer "${resolved.peer.name}" did not answer (status: ${status}): ${String(result.message ?? "no detail")}`,
      true
    );
  } catch (err) {
    return textResult(`Could not reach "${resolved.peer.name}": ${(err as Error).message}`, true);
  }
}

async function callListPeers() {
  const peers = Object.entries(loadPeers()).filter(([, p]) => !p.blocked);
  if (peers.length === 0) {
    return textResult(
      "No peers connected. Connect to a teammate with `amc connect <their-invite-code>` in a terminal."
    );
  }
  const lines: string[] = [];
  await Promise.all(
    peers.map(async ([fp, peer]) => {
      let line = `- ${peer.name} (${fp})`;
      try {
        const pong = await pingPeer(peer, 4000);
        const status = String(pong.status ?? "unknown");
        if (status === "approved") {
          const grants = pong.grants as
            | {
                projects?: Array<{ name: string; description: string }>;
                mcp?: Array<{ name: string; description: string; tools: string[] }>;
              }
            | undefined;
          const scopeBits: string[] = [];
          for (const p of grants?.projects ?? []) {
            scopeBits.push(`project "${p.name}"${p.description ? ` (${p.description})` : ""}`);
          }
          for (const m of grants?.mcp ?? []) {
            scopeBits.push(`service "${m.name}"${m.description ? ` (${m.description})` : ""}`);
          }
          const paused = pong.paused ? " [PAUSED]" : "";
          line += ` — online${paused}. Granted to us: ${scopeBits.length ? scopeBits.join("; ") : "nothing yet"}`;
        } else {
          line += ` — reachable, but our connection is ${status}`;
        }
      } catch {
        line += " — offline/unreachable";
      }
      lines.push(line);
    })
  );
  lines.sort();
  return textResult(
    `amc peers:\n${lines.join("\n")}\n\nAsk one with ask_peer(peer, question). Questions are answered by an isolated sandbox using only the granted scope.`
  );
}

export function runMcpServer(): void {
  const identity = loadIdentity();
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcRequest;
    try {
      msg = JSON.parse(trimmed) as RpcRequest;
    } catch {
      return; // not JSON — ignore
    }
    void dispatch(msg).catch((err) => {
      if (msg.id !== undefined && msg.id !== null) {
        replyError(msg.id, -32603, `internal error: ${(err as Error).message}`);
      }
    });
  });

  rl.on("close", () => process.exit(0));

  async function dispatch(msg: RpcRequest): Promise<void> {
    switch (msg.method) {
      case "initialize": {
        const requested = (msg.params?.protocolVersion as string) ?? PROTOCOL_FALLBACK;
        reply(msg.id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: "amc", version: "0.1.0" },
        });
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return; // notifications need no reply
      case "ping":
        reply(msg.id, {});
        return;
      case "tools/list":
        reply(msg.id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = msg.params?.name as string;
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
        if (!identity) {
          reply(msg.id, textResult("amc is not initialized — run `amc init` in a terminal first.", true));
          return;
        }
        if (name === "ask_peer") {
          reply(msg.id, await callAskPeer(args));
        } else if (name === "list_peers") {
          reply(msg.id, await callListPeers());
        } else {
          replyError(msg.id, -32602, `unknown tool: ${name}`);
        }
        return;
      }
      default:
        if (msg.id !== undefined && msg.id !== null) {
          replyError(msg.id, -32601, `method not found: ${msg.method}`);
        }
    }
  }
}
