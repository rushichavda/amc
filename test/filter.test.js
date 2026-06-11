import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSensitive } from "../dist/sandbox/filter.js";

test("catches credential-shaped strings", () => {
  assert.ok(scanSensitive("here is sk-ant-api03-abcdefghijklmnop").hits.includes("anthropic-key"));
  assert.ok(scanSensitive("AKIAIOSFODNN7EXAMPLE is the key").hits.includes("aws-access-key"));
  assert.ok(
    scanSensitive("token ghp_abcdefghijklmnopqrstuvwxyz0123456789").hits.includes("github-token")
  );
  assert.ok(scanSensitive("xoxb-123456789012-abcdefghij").hits.includes("slack-token"));
  assert.ok(
    scanSensitive("-----BEGIN RSA PRIVATE KEY-----").hits.includes("private-key-block")
  );
  assert.ok(scanSensitive("ssn: 123-45-6789").hits.includes("ssn"));
  assert.ok(
    scanSensitive('api_key = "abcdef1234567890abcdef"').hits.includes("generic-secret-assignment")
  );
});

test("catches Luhn-valid card numbers, ignores Luhn-invalid digit runs", () => {
  assert.ok(scanSensitive("card: 4111 1111 1111 1111").hits.includes("card-number"));
  assert.equal(scanSensitive("ticket id 1234 5678 9012 3456 yes").hits.includes("card-number"), false);
});

test("clean engineering text passes", () => {
  const text =
    "The auth flow lives in src/auth/login.ts:42. It validates the JWT header shape, then calls verifySession(). Deploy happens via GitHub Actions on merge to main.";
  assert.deepEqual(scanSensitive(text).hits, []);
});

test("custom extra patterns work and bad regexes are ignored", () => {
  assert.ok(scanSensitive("project DARKSTAR is secret", ["darkstar"]).hits.length > 0);
  assert.deepEqual(scanSensitive("hello", ["[invalid"]).hits, []);
});
