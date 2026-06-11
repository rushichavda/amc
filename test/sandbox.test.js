import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const FAKE_CLAUDE = resolve(fileURLToPath(new URL("./fixtures/fake-claude.js", import.meta.url)));

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), "amc-sandbox-"));
  process.env.AMC_HOME = home;
  chmodSync(FAKE_CLAUDE, 0o755);
});
after(() => rmSync(home, { recursive: true, force: true }));

function baseConfig(overrides = {}) {
  return {
    name: "owner",
    port: 4711,
    bind: "127.0.0.1",
    advertiseHost: "",
    claudeBin: process.execPath, // spawn node with the fake script via args? no — see below
    paused: false,
    notify: false,
    sandbox: {
      model: "sonnet",
      timeoutMs: 10_000,
      maxConcurrent: 2,
      maxAnswerChars: 32_000,
      maxQuestionChars: 8_000,
      maxBudgetUsd: 0,
      effort: "medium",
      extraArgs: [],
      safeMode: true,
      keepWorkspaces: false,
    },
    limitsDefault: { perHour: 10, perDay: 40 },
    filter: { enabled: true, extraPatterns: [] },
    ...overrides,
  };
}

const scope = (projects, mcp) => ({
  ownerName: "owner",
  peerName: "alice",
  projects,
  mcp,
});

test("sandbox arg construction encodes the security boundary", async () => {
  const { buildSandboxArgs } = await import("../dist/sandbox/runner.js");
  const ws = mkdtempSync(join(tmpdir(), "amc-ws-"));
  const projects = [{ name: "foo", path: "/abs/code/foo", description: "payments" }];
  const mcp = [
    {
      name: "slack-eng",
      description: "eng slack",
      tools: ["read_channel", "search"],
      server: { command: "npx", args: ["slack-mcp"], env: { TOKEN: "x" } },
    },
  ];
  const { args } = buildSandboxArgs(baseConfig(), scope(projects, mcp), ws);

  // Isolation flags present.
  for (const required of [
    "-p",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--safe-mode",
    "--strict-mcp-config",
  ]) {
    assert.ok(args.includes(required), `missing ${required}`);
  }

  // Built-in tools limited to readers (projects granted).
  const toolsIdx = args.indexOf("--tools");
  assert.equal(args[toolsIdx + 1], "Read,Grep,Glob");

  // Allow rules: path-scoped Read + namespaced MCP tools only.
  const allowIdx = args.indexOf("--allowedTools");
  const allow = args[allowIdx + 1];
  assert.ok(allow.includes("Read(//abs/code/foo/**)"), `allow rules wrong: ${allow}`);
  assert.ok(allow.includes("mcp__slack-eng__read_channel"));
  assert.ok(allow.includes("mcp__slack-eng__search"));
  assert.ok(!allow.includes("Bash"));

  // Deny list includes the dangerous built-ins.
  const denyIdx = args.indexOf("--disallowedTools");
  for (const tool of ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task"]) {
    assert.ok(args[denyIdx + 1].includes(tool), `deny missing ${tool}`);
  }

  // Settings file written with deny rules for sensitive paths.
  const settingsIdx = args.indexOf("--settings");
  const settings = JSON.parse(readFileSync(args[settingsIdx + 1], "utf8"));
  assert.ok(settings.permissions.deny.some((d) => d.includes(".ssh")));
  assert.ok(settings.permissions.deny.some((d) => d.includes(".claude")));
  assert.ok(settings.permissions.deny.some((d) => d.includes(".env")));
  assert.deepEqual(settings.permissions.additionalDirectories, ["/abs/code/foo"]);

  // MCP config contains exactly the granted server.
  const mcpIdx = args.indexOf("--mcp-config");
  const mcpConfig = JSON.parse(readFileSync(args[mcpIdx + 1], "utf8"));
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["slack-eng"]);
  assert.equal(mcpConfig.mcpServers["slack-eng"].command, "npx");

  rmSync(ws, { recursive: true, force: true });
});

test("no projects granted → no filesystem tools at all", async () => {
  const { buildSandboxArgs } = await import("../dist/sandbox/runner.js");
  const ws = mkdtempSync(join(tmpdir(), "amc-ws2-"));
  const mcp = [
    { name: "gh", description: "", tools: ["search_code"], server: { command: "gh-mcp" } },
  ];
  const { args } = buildSandboxArgs(baseConfig(), scope([], mcp), ws);
  const toolsIdx = args.indexOf("--tools");
  assert.equal(args[toolsIdx + 1], "");
  assert.ok(!args.includes("--add-dir"));
  rmSync(ws, { recursive: true, force: true });
});

test("runSandbox end-to-end against fake claude", async () => {
  const { runSandbox } = await import("../dist/sandbox/runner.js");
  const config = baseConfig({ claudeBin: FAKE_CLAUDE });
  const result = await runSandbox({
    config,
    scope: scope([{ name: "p", path: tmpdir(), description: "" }], []),
    question: "what is the deploy status?",
  });
  assert.equal(result.status, "ok");
  assert.ok(result.answer.includes("FAKE_ANSWER to: what is the deploy status?"));
  assert.equal(result.meta.numTurns, 3);
});

test("runSandbox surfaces failures and timeouts", async () => {
  const { runSandbox } = await import("../dist/sandbox/runner.js");
  const config = baseConfig({ claudeBin: FAKE_CLAUDE });

  process.env.FAKE_CLAUDE_FAIL = "1";
  const failed = await runSandbox({
    config,
    scope: scope([{ name: "p", path: tmpdir(), description: "" }], []),
    question: "boom",
  });
  delete process.env.FAKE_CLAUDE_FAIL;
  assert.equal(failed.status, "error");

  process.env.FAKE_CLAUDE_HANG = "1";
  const hungConfig = baseConfig({ claudeBin: FAKE_CLAUDE });
  hungConfig.sandbox.timeoutMs = 1500;
  const timedOut = await runSandbox({
    config: hungConfig,
    scope: scope([{ name: "p", path: tmpdir(), description: "" }], []),
    question: "hang",
  });
  delete process.env.FAKE_CLAUDE_HANG;
  assert.equal(timedOut.status, "timeout");
});

test("no grants → no_grants without spawning", async () => {
  const { runSandbox } = await import("../dist/sandbox/runner.js");
  const result = await runSandbox({
    config: baseConfig({ claudeBin: "/nonexistent" }),
    scope: scope([], []),
    question: "anything",
  });
  assert.equal(result.status, "no_grants");
});
