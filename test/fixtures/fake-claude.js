#!/usr/bin/env node
// Fake `claude` binary for tests. Mimics `claude -p --output-format json`:
// reads the prompt from stdin, echoes a canned result JSON to stdout.
// Behavior switches:
//   FAKE_CLAUDE_ANSWER       — override the answer text
//   FAKE_CLAUDE_FAIL=1       — exit non-zero with stderr noise
//   FAKE_CLAUDE_HANG=1       — never respond (for timeout tests)
//   FAKE_CLAUDE_ARGS_FILE    — dump argv JSON to this path (for arg assertions)

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args, null, 2));
}

let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_HANG === "1") {
    setInterval(() => {}, 1000); // hang forever
    return;
  }
  if (process.env.FAKE_CLAUDE_FAIL === "1") {
    process.stderr.write("fake claude exploded\n");
    process.exit(1);
  }
  const questionMatch = stdin.match(/<peer_question>\n([\s\S]*?)\n<\/peer_question>/);
  const question = questionMatch ? questionMatch[1] : "(no question)";
  const answer = process.env.FAKE_CLAUDE_ANSWER ?? `FAKE_ANSWER to: ${question}`;
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    num_turns: 3,
    result: answer,
    session_id: "fake-session",
    total_cost_usd: 0.0123,
  };
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
});
