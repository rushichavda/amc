# amc — ask my Claude

Peer-to-peer scoped queries between teammates' Claudes.

Your teammate asks *their* Claude a question about *your* domain — your projects, your services. Their Claude calls yours. Yours answers from a **fresh, sandboxed session** that can only see what you explicitly granted. Nobody copy-pastes anything, and your private Claude context is never touched.

```
alice's Claude ──ask_peer("bob", "how does payments deploy?")──▶ bob's amc daemon
                                                                      │
                                                                      ▼
                                                          fresh sandboxed claude -p
                                                          (only bob's granted scope)
                                                                      │
alice's Claude ◀───────────── scoped answer ──────────────────────────┘
```

**No API key. No cloud relay. No server.** Inference for inbound queries runs through the owner's existing Claude Code login (subscription or API key — whatever they already use). Install, connect, done.

## Why

Teams using Claude individually do manual relay work: A asks B a question about B's codebase → B asks their Claude → B copy-pastes the answer back. B is a human pipe between two AI systems. amc removes the pipe while keeping B in control of exactly what's reachable.

## Install

```bash
npm install -g ask-my-claude
amc init            # creates your identity + registers ask_peer with Claude Code
```

Requirements: Node ≥ 20, [Claude Code](https://claude.com/claude-code) ≥ 2.x logged in. macOS/Linux.

## Quickstart (two teammates: Bob shares, Alice asks)

**Bob (the owner):**

```bash
amc init --name bob
amc share project payments ~/code/payments --description "Payments service"
amc daemon start
amc invite                      # prints an invite code — send it to Alice over Slack
# ...after Alice connects:
amc accept alice
amc grant alice project payments
```

**Alice (the asker):**

```bash
amc init --name alice
amc connect amc1.eyJua...       # Bob's invite code
```

That's it. Now in Alice's normal Claude Code session:

> **Alice:** how does bob's payments service get deployed?
>
> **Claude:** *(calls `ask_peer("bob", "How does the payments service get deployed?")`)*
> According to bob's Claude: deploys happen every Tuesday via the Jenkins job WIDGET-42…

Alice can also ask from the terminal: `amc ask bob "how do deploys work?"`

## What can be shared

| Share type | Command | What the peer's queries can do |
|---|---|---|
| **Project** | `amc share project api ~/code/api` | Read-only `Read`/`Grep`/`Glob` over that directory. No writes, no bash, no network. `.env`, keys, and credentials are deny-listed. |
| **MCP server** | `amc share mcp slack --from-claude slack --tools slack_read_channel` | Exactly the named tools on that server — imported from your existing Claude Code MCP config. |

Grants are **per peer, default nothing**. Alice granted `payments` doesn't see your other five projects. A second teammate gets their own grant set.

> **Scoping MCP credentials:** a shared MCP server runs with the credentials in its config. The tool allowlist controls *which operations* a peer can invoke; the credential controls *what data those operations can see*. For real within-service scoping (e.g. only some Slack channels), point the share at a credential that's limited to that scope — e.g. a Slack app that's only a member of the channels you want visible.

## How a peer query runs (the security model, short version)

Every inbound query spawns a **brand-new `claude -p` process** with:

- `--safe-mode` — no CLAUDE.md, no hooks, no plugins, no skills, none of your MCP servers
- `--no-session-persistence` — leaves no transcript
- `--tools "Read,Grep,Glob"` (or *no* built-in tools if only MCP is granted)
- `--strict-mcp-config` — only the granted MCP servers exist
- permission rules pinning reads to granted paths, deny rules for `~/.ssh`, `~/.claude*`, `.env`, keys
- a hardened system prompt that treats the question and all tool output as untrusted data
- an output filter that blocks answers containing credential/PII patterns
- per-peer rate limits (default 10/hour, 40/day) and a wall-clock timeout

Your main Claude session — memory, history, your MCP connections — is **never in the request path**. Every query, grant used, and answer is logged to `~/.amc/audit.log` (`amc audit`).

On the wire: Ed25519 identities, X25519 + AES-256-GCM sealed envelopes, signed requests with replay protection. Invite codes bootstrap trust; the owner confirms every new peer by hand.

Read [SECURITY.md](SECURITY.md) for the full threat model — **including the residual risks**. Prompt injection is mitigated, not solved.

## Day-to-day commands

```bash
amc peers --ping          # who's connected, who's online, what they granted you
amc audit --since 2h      # everything that flowed through your daemon
amc pause | amc resume    # kill-switch for inbound queries
amc revoke alice --all    # take everything back
amc peer limits alice --per-hour 5
amc doctor                # check the whole setup
```

## Team patterns

- **Multiple projects, distinct owners** — each owner shares their own projects; `list_peers` tells everyone's Claude who has what, so questions route themselves.
- **Remote teams** — any reachable address works. [Tailscale](https://tailscale.com) is the recommended transport: `amc invite --host your-machine.tailnet.ts.net` gives you encrypted connectivity across networks with zero port forwarding.
- **Onboarding** — share the repo + a docs folder to the new teammate, let them interrogate it through their own Claude.
- **Offline owners** — askers get a clean "peer unreachable"; the daemon answers only while the owner's machine is up.

## How it plugs into Claude Code

amc registers itself as a **user-scope MCP server** (`claude mcp add-json amc ...` — done automatically by `amc init`). Your main Claude sees two tools:

- `ask_peer(peer, question, context?)` — ask a teammate's Claude
- `list_peers()` — who's reachable and what they've granted you

The daemon and sandbox live entirely outside Claude Code; only the thin MCP client runs inside your session.

## Configuration

`~/.amc/config.json` (edit via `amc config set <key> <value>`):

| Key | Default | Meaning |
|---|---|---|
| `port` / `bind` | `4711` / `0.0.0.0` | Daemon listen address |
| `advertiseHost` | auto | Address put in invites (set your Tailscale name here) |
| `sandbox.model` | `sonnet` | Model for inbound-query sandboxes (`haiku` for cheap/fast) |
| `sandbox.timeoutMs` | `180000` | Per-query wall clock |
| `sandbox.maxConcurrent` | `2` | Parallel sandboxes |
| `limitsDefault` | `10/hr, 40/day` | Default per-peer rate limits |
| `filter.enabled` | `true` | Sensitive-output blocking |

## Development

```bash
npm install && npm test     # zero runtime deps; tests use a fake claude binary
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for components, wire protocol, and design rationale.

## License

MIT
