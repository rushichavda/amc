import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { paths, loadConfig, ensureHome } from "../config.js";
import { requireIdentity, fingerprint } from "../crypto/identity.js";
import { handleEnvelope } from "./handlers.js";
import type { Wire } from "../crypto/envelope.js";
import { shortTs } from "../util.js";

const MAX_BODY_BYTES = 64 * 1024;

function log(line: string): void {
  process.stdout.write(`[${shortTs(Date.now())}] ${line}\n`);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

export async function runDaemon(): Promise<void> {
  ensureHome();
  const identity = requireIdentity();
  const config = loadConfig();

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/health") {
        send(res, 200, { amc: true, v: 1 });
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/box") {
        send(res, 404, { error: "not found" });
        return;
      }
      const body = await readBody(req);
      let wire: Wire;
      try {
        wire = JSON.parse(body.toString("utf8")) as Wire;
      } catch {
        send(res, 400, { error: "bad request" });
        return;
      }
      const remoteIp = req.socket.remoteAddress ?? "unknown";
      const responseWire = await handleEnvelope(identity, wire, remoteIp, log);
      send(res, 200, responseWire);
    } catch (err) {
      // Envelope-level failure: no detail leaks to the network.
      log(`rejected request: ${(err as Error).message}`);
      send(res, 400, { error: "bad request" });
    }
  });

  // Long timeout: ask requests block on a sandbox run.
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 30 * 1000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, () => resolve());
  });

  writeFileSync(paths().pid, String(process.pid), { mode: 0o600 });
  log(`amc daemon listening on ${config.bind}:${config.port} as "${identity.name}"`);
  log(`identity fingerprint: ${fingerprint(identity.ik)}`);

  const shutdown = () => {
    log("shutting down");
    try {
      if (existsSync(paths().pid)) unlinkSync(paths().pid);
    } catch {
      /* best effort */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

