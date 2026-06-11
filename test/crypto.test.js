import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), "amc-crypto-"));
  process.env.AMC_HOME = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

test("envelope seal/open roundtrip, tamper and wrong-recipient rejection", async () => {
  const { seal, open, genReplyKeypair } = await import("../dist/crypto/envelope.js");
  const alice = genReplyKeypair();
  const bob = genReplyKeypair();

  const wire = seal(alice.pub, { hello: "world", n: 42 });
  assert.deepEqual(open(alice.pub, alice.d, wire), { hello: "world", n: 42 });

  // Wrong recipient cannot open.
  assert.throws(() => open(bob.pub, bob.d, wire));

  // Tampered ciphertext fails GCM auth.
  const tampered = { ...wire, c: wire.c.slice(0, -4) + (wire.c.endsWith("AAAA") ? "BBBB" : "AAAA") };
  assert.throws(() => open(alice.pub, alice.d, tampered));
});

test("request/response framing: signatures, recipient binding, freshness, replay", async () => {
  const { createIdentity } = await import("../dist/crypto/identity.js");
  const { makeRequest, openRequest, makeResponse, openResponse, ReplayGuard } = await import(
    "../dist/protocol.js"
  );

  process.env.AMC_HOME = mkdtempSync(join(tmpdir(), "amc-a-"));
  const alice = createIdentity("alice");
  process.env.AMC_HOME = mkdtempSync(join(tmpdir(), "amc-b-"));
  const bob = createIdentity("bob");

  // Alice → Bob
  const req = makeRequest(alice, { ik: bob.ik, ek: bob.ek }, "ask", { q: "hi" });
  const inner = openRequest(bob, req.wire);
  assert.equal(inner.from.name, "alice");
  assert.equal(inner.payload.body.q, "hi");
  assert.equal(inner.payload.to, bob.ik);

  // Not addressed to Alice — she must reject it.
  assert.throws(() => openRequest(alice, req.wire));

  // Replay guard blocks a second use of the same id.
  const guard = new ReplayGuard();
  assert.equal(guard.check(inner.payload.id), true);
  assert.equal(guard.check(inner.payload.id), false);

  // Bob → Alice response, sealed to the per-request reply key.
  const respWire = makeResponse(bob, inner.rk, inner.payload.id, { status: "ok", answer: "yo" });
  const body = openResponse(req.reply, bob.ik, req.id, respWire);
  assert.equal(body.answer, "yo");

  // Response signed by an imposter is rejected.
  const respWire2 = makeResponse(alice, inner.rk, inner.payload.id, { status: "ok" });
  assert.throws(() => openResponse(req.reply, bob.ik, req.id, respWire2));
});

test("expired requests are rejected", async () => {
  const { createIdentity } = await import("../dist/crypto/identity.js");
  const { makeRequest, openRequest } = await import("../dist/protocol.js");

  process.env.AMC_HOME = mkdtempSync(join(tmpdir(), "amc-c-"));
  const a = createIdentity("a");
  process.env.AMC_HOME = mkdtempSync(join(tmpdir(), "amc-d-"));
  const b = createIdentity("b");

  const req = makeRequest(a, { ik: b.ik, ek: b.ek }, "ping", {});
  // Re-seal a stale payload by opening, aging, and re-wrapping is complex;
  // instead just verify the skew check path with a hand-built stale request.
  const { seal } = await import("../dist/crypto/envelope.js");
  const { signPayload } = await import("../dist/crypto/identity.js");
  const stalePayload = { typ: "ping", id: "stale-id", ts: Date.now() - 10 * 60 * 1000, to: b.ik, body: {} };
  const staleInner = {
    from: { name: "a", ik: a.ik, ek: a.ek },
    rk: req.reply.pub,
    payload: stalePayload,
    sig: signPayload(a, stalePayload),
  };
  const staleWire = seal(b.ek, staleInner);
  assert.throws(() => openRequest(b, staleWire), /expired/);
});
