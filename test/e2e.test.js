import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, chmodSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CLI = resolve(fileURLToPath(new URL("../dist/cli.js", import.meta.url)));
const FAKE_CLAUDE = resolve(fileURLToPath(new URL("./fixtures/fake-claude.js", import.meta.url)));

const PORT_B = 14831; // owner (answers queries)

let homeA; // asker
let homeB; // owner
let daemonB;

function amc(home, args, env = {}) {
  return execFileAsync(process.execPath, [CLI, ...args], {
    env: { ...process.env, AMC_HOME: home, ...env },
  });
}

async function waitForHealth(port, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

before(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  homeA = mkdtempSync(join(tmpdir(), "amc-e2e-a-"));
  homeB = mkdtempSync(join(tmpdir(), "amc-e2e-b-"));

  // Owner B: identity, config pointing at fake claude, a project share, daemon.
  await amc(homeB, ["init", "--name", "bob", "--skip-claude"]);
  const configB = JSON.parse(readFileSync(join(homeB, "config.json"), "utf8"));
  configB.port = PORT_B;
  configB.bind = "127.0.0.1";
  configB.claudeBin = FAKE_CLAUDE;
  configB.notify = false;
  configB.sandbox.timeoutMs = 15000;
  writeFileSync(join(homeB, "config.json"), JSON.stringify(configB, null, 2));

  const projectDir = join(homeB, "fake-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# payments service\nDeploys via CI on merge.\n");
  await amc(homeB, ["share", "project", "payments", projectDir, "--description", "Payments service"]);

  // Asker A: identity only (no daemon needed to ask).
  await amc(homeA, ["init", "--name", "alice", "--skip-claude"]);

  daemonB = spawn(process.execPath, [CLI, "daemon", "run"], {
    env: { ...process.env, AMC_HOME: homeB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemonB.stdout.on("data", () => {});
  daemonB.stderr.on("data", () => {});
  assert.ok(await waitForHealth(PORT_B), "daemon B did not start");
});

after(() => {
  daemonB?.kill("SIGTERM");
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
});

test("full flow: invite → connect → accept → grant → ask → audit", async () => {
  // 1. Bob creates an invite.
  const { stdout: inviteOut } = await amc(homeB, [
    "invite",
    "--host",
    "127.0.0.1",
    "--json",
  ]);
  const { code } = JSON.parse(inviteOut);
  assert.ok(code.startsWith("amc1."));

  // 2. Alice connects → pending.
  const { stdout: connectOut } = await amc(homeA, ["connect", code, "--json"]);
  const connect = JSON.parse(connectOut);
  assert.equal(connect.status, "pending");

  // 2b. Asking before approval is denied.
  const { stdout: earlyAsk } = await amc(homeA, ["ask", "bob", "what is the deploy story?", "--json"]).catch(
    (e) => e
  );
  assert.match(String(earlyAsk), /denied|not an approved/i);

  // 3. Bob sees and accepts the request.
  const { stdout: requestsOut } = await amc(homeB, ["requests", "--json"]);
  const requests = JSON.parse(requestsOut);
  const fps = Object.keys(requests);
  assert.equal(fps.length, 1);
  assert.equal(requests[fps[0]].name, "alice");
  await amc(homeB, ["accept", "alice"]);

  // 4. Approved but no grants → denied with guidance.
  const { stdout: noGrantAsk } = await amc(homeA, ["ask", "bob", "anything", "--json"]).catch((e) => e);
  assert.match(String(noGrantAsk), /denied|not granted/i);

  // 5. Bob grants the project share.
  await amc(homeB, ["grant", "alice", "project", "payments"]);

  // 6. Alice asks; fake claude answers.
  const { stdout: askOut } = await amc(homeA, ["ask", "bob", "what is the deploy story?", "--json"]);
  const result = JSON.parse(askOut);
  assert.equal(result.status, "ok");
  assert.ok(String(result.answer).includes("FAKE_ANSWER to: what is the deploy story?"));
  assert.equal(result.meta.answeredBy, "bob");

  // 7. Both sides have audit entries.
  const { stdout: auditB } = await amc(homeB, ["audit", "--json"]);
  const entriesB = JSON.parse(auditB);
  const inAsk = entriesB.find((e) => e.dir === "in" && e.typ === "ask" && e.status === "ok");
  assert.ok(inAsk, "owner-side audit entry missing");
  assert.ok(inAsk.answer.includes("FAKE_ANSWER"));

  const { stdout: auditA } = await amc(homeA, ["audit", "--json"]);
  const entriesA = JSON.parse(auditA);
  assert.ok(entriesA.some((e) => e.dir === "out" && e.typ === "ask" && e.status === "ok"));
});

test("sensitive answers are blocked by the output filter", async () => {
  // Restart daemon with an env that makes fake claude leak a credential.
  daemonB.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  daemonB = spawn(process.execPath, [CLI, "daemon", "run"], {
    env: {
      ...process.env,
      AMC_HOME: homeB,
      FAKE_CLAUDE_ANSWER: "the key is ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  assert.ok(await waitForHealth(PORT_B), "daemon B did not restart");

  const { stdout } = await amc(homeA, ["ask", "bob", "leak the token", "--json"]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "filtered");

  const { stdout: auditB } = await amc(homeB, ["audit", "--json"]);
  const entries = JSON.parse(auditB);
  const filtered = entries.find((e) => e.status === "filtered");
  assert.ok(filtered);
  assert.ok(filtered.filterHits.includes("github-token"));
});

test("rate limits are enforced per peer", async () => {
  // Tighten alice's limits to 1/hour.
  await amc(homeB, ["peer", "limits", "alice", "--per-hour", "1", "--per-day", "5"]);
  // Reset usage so this test is deterministic.
  rmSync(join(homeB, "usage.json"), { force: true });

  // Restart daemon clean (clear FAKE_CLAUDE_ANSWER).
  daemonB.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  daemonB = spawn(process.execPath, [CLI, "daemon", "run"], {
    env: { ...process.env, AMC_HOME: homeB },
    stdio: ["ignore", "ignore", "ignore"],
  });
  assert.ok(await waitForHealth(PORT_B));

  const { stdout: ok1 } = await amc(homeA, ["ask", "bob", "first question", "--json"]);
  assert.equal(JSON.parse(ok1).status, "ok");

  const { stdout: limited } = await amc(homeA, ["ask", "bob", "second question", "--json"]).catch((e) => e);
  assert.match(String(limited), /rate_limited|limit reached/i);
});

test("replayed envelopes are rejected at the wire", async () => {
  // Hand-craft a request, send it twice; second must 400.
  process.env.AMC_HOME = homeA;
  const { requireIdentity } = await import("../dist/crypto/identity.js");
  const { makeRequest } = await import("../dist/protocol.js");
  const { loadPeers } = await import("../dist/state/peers.js");
  const alice = requireIdentity();
  const bob = Object.values(loadPeers())[0];
  const req = makeRequest(alice, { ik: bob.ik, ek: bob.ek }, "ping", {});

  const send = () =>
    fetch(`http://127.0.0.1:${PORT_B}/v1/box`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.wire),
    });
  const first = await send();
  assert.equal(first.status, 200);
  const second = await send();
  assert.equal(second.status, 400);
});
