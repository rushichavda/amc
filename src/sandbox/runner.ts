import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { paths, type Config } from "../config.js";
import { buildSystemPrompt, buildUserPrompt, type ScopeDescription } from "./prompt.js";
import { truncate } from "../util.js";

export interface SandboxResult {
  ok: boolean;
  status: "ok" | "error" | "timeout" | "busy" | "no_grants";
  answer?: string;
  errorMessage?: string;
  meta: { durationMs: number; numTurns?: number; costUsd?: number };
}

/** Built-in tools the sandbox may receive when project shares are granted. */
const FS_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Defense-in-depth deny list. With --safe-mode and an explicit --tools
 * whitelist most of these can never appear; we deny them anyway in case a
 * future claude version changes defaults.
 */
const DENY_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TodoWrite",
  "KillShell",
  "BashOutput",
  "SlashCommand",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
];

/**
 * Claude Code permission-rule path syntax: `Read(//abs/path/**)` where `//`
 * marks an absolute path (so the leading slash of the path itself is dropped).
 */
function readRule(absPath: string, suffix = ""): string {
  return `Read(//${absPath.replace(/^\/+/, "")}${suffix})`;
}

/** Home-relative paths the sandbox must never read even within added dirs. */
function sensitiveDenyRules(projectPaths: string[]): string[] {
  const home = homedir();
  const homeDeny = [
    ".amc",
    ".claude",
    ".ssh",
    ".aws",
    ".gnupg",
    ".config",
  ].map((d) => readRule(join(home, d), "/**"));
  homeDeny.push(readRule(join(home, ".claude.json")));
  homeDeny.push(readRule(join(home, ".netrc")));
  homeDeny.push(readRule(join(home, ".npmrc")));
  const perShare = projectPaths.flatMap((p) => [
    readRule(p, "/**/.env"),
    readRule(p, "/**/.env.*"),
    readRule(p, "/**/*.pem"),
    readRule(p, "/**/id_rsa*"),
    readRule(p, "/**/id_ed25519*"),
    readRule(p, "/**/credentials*.json"),
    readRule(p, "/.env"),
    readRule(p, "/.env.*"),
  ]);
  return [...homeDeny, ...perShare];
}

let running = 0;

export async function runSandbox(opts: {
  config: Config;
  scope: ScopeDescription;
  question: string;
  context?: string;
}): Promise<SandboxResult> {
  const { config, scope } = opts;
  const started = Date.now();

  if (scope.projects.length === 0 && scope.mcp.length === 0) {
    return {
      ok: false,
      status: "no_grants",
      errorMessage: "peer has no grants",
      meta: { durationMs: 0 },
    };
  }
  if (running >= config.sandbox.maxConcurrent) {
    return {
      ok: false,
      status: "busy",
      errorMessage: "too many concurrent queries",
      meta: { durationMs: 0 },
    };
  }

  running += 1;
  mkdirSync(paths().tmp, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(paths().tmp, "run-"));
  try {
    return await execClaude(opts, workspace, started);
  } finally {
    running -= 1;
    if (!config.sandbox.keepWorkspaces) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function buildArgs(opts: {
  config: Config;
  scope: ScopeDescription;
  workspace: string;
}): { args: string[]; mcpConfigPath?: string } {
  const { config, scope, workspace } = opts;
  const projectPaths = scope.projects.map((p) => p.path);

  // 1. Built-in tool whitelist: filesystem readers only when projects granted.
  const builtinTools = projectPaths.length > 0 ? FS_TOOLS.join(",") : "";

  // 2. Allow rules: path-scoped reads + the granted MCP tools.
  const allow: string[] = [];
  if (projectPaths.length > 0) {
    for (const p of projectPaths) allow.push(readRule(p, "/**"));
    allow.push("Grep", "Glob");
  }
  for (const m of scope.mcp) {
    for (const tool of m.tools) allow.push(`mcp__${m.name}__${tool}`);
  }

  // 3. Ephemeral settings file with explicit permissions.
  const settings = {
    permissions: {
      defaultMode: "default",
      allow,
      deny: [...DENY_TOOLS, ...sensitiveDenyRules(projectPaths)],
      additionalDirectories: projectPaths,
    },
  };
  const settingsPath = join(workspace, "amc-settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  // 4. Ephemeral MCP config containing ONLY granted servers.
  let mcpConfigPath: string | undefined;
  if (scope.mcp.length > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const m of scope.mcp) {
      mcpServers[m.name] = {
        type: m.server.type ?? "stdio",
        command: m.server.command,
        args: m.server.args ?? [],
        env: m.server.env ?? {},
      };
    }
    mcpConfigPath = join(workspace, "amc-mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  }

  const args: string[] = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--permission-mode",
    "default",
    "--settings",
    settingsPath,
    "--append-system-prompt",
    buildSystemPrompt(scope),
    "--model",
    config.sandbox.model,
    "--effort",
    config.sandbox.effort,
    "--tools",
    builtinTools,
  ];
  if (config.sandbox.safeMode) args.push("--safe-mode");
  // Always strict: even with no granted MCP servers this blocks the owner's own servers.
  args.push("--strict-mcp-config");
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  for (const p of projectPaths) args.push("--add-dir", p);
  if (allow.length > 0) args.push("--allowedTools", allow.join(","));
  args.push("--disallowedTools", DENY_TOOLS.join(","));
  if (config.sandbox.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(config.sandbox.maxBudgetUsd));
  }
  args.push(...config.sandbox.extraArgs);
  return { args, mcpConfigPath };
}

/** Exported for tests: deterministic arg construction without spawning. */
export function buildSandboxArgs(config: Config, scope: ScopeDescription, workspace: string) {
  return buildArgs({ config, scope, workspace });
}

function execClaude(
  opts: { config: Config; scope: ScopeDescription; question: string; context?: string },
  workspace: string,
  started: number
): Promise<SandboxResult> {
  const { config, scope } = opts;
  const { args } = buildArgs({ config, scope, workspace });
  const prompt = buildUserPrompt({
    peerName: scope.peerName,
    question: opts.question,
    context: opts.context,
  });

  return new Promise((resolvePromise) => {
    const child = spawn(config.claudeBin, args, {
      cwd: workspace,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AMC_SANDBOX: "1" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const killTree = () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* gone */
        }
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* gone */
        }
      }, 5000).unref();
    };

    const timer = setTimeout(() => {
      killTree();
      finish({
        ok: false,
        status: "timeout",
        errorMessage: `sandbox timed out after ${config.sandbox.timeoutMs}ms`,
        meta: { durationMs: Date.now() - started },
      });
    }, config.sandbox.timeoutMs);

    child.on("error", (err) => {
      finish({
        ok: false,
        status: "error",
        errorMessage: `failed to start ${config.claudeBin}: ${err.message}`,
        meta: { durationMs: Date.now() - started },
      });
    });

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      const durationMs = Date.now() - started;
      const parsed = parseResultJson(stdout);
      if (parsed && parsed.type === "result") {
        const meta = {
          durationMs,
          numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
          costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
        };
        if (parsed.subtype === "success" && typeof parsed.result === "string" && !parsed.is_error) {
          finish({
            ok: true,
            status: "ok",
            answer: truncate(parsed.result, config.sandbox.maxAnswerChars),
            meta,
          });
        } else {
          finish({
            ok: false,
            status: "error",
            errorMessage: `sandbox ended with ${parsed.subtype ?? "unknown"}${
              typeof parsed.result === "string" ? `: ${parsed.result.slice(0, 300)}` : ""
            }`,
            meta,
          });
        }
        return;
      }
      finish({
        ok: false,
        status: "error",
        errorMessage: `claude exited (code ${code}); stderr: ${stderr.slice(-500) || "(empty)"}`,
        meta: { durationMs },
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

interface ClaudeResultJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
}

function parseResultJson(stdout: string): ClaudeResultJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Normal case: a single JSON object on stdout.
  try {
    return JSON.parse(trimmed) as ClaudeResultJson;
  } catch {
    /* fall through */
  }
  // Defensive: find the last parseable line that looks like a result object.
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const obj = JSON.parse(candidate) as ClaudeResultJson;
      if (obj && obj.type === "result") return obj;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}
