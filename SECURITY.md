# Security model

amc lets a semi-trusted peer cause inference and tool calls on your machine. This document is the honest version of what protects you and what doesn't.

## Trust levels

| Level | Who/what | Stance |
|---|---|---|
| Trusted | You, your machine, your `claude` binary | Full control |
| Semi-trusted | Approved peers | May query, only within explicit grants |
| Untrusted | Peer questions, all tool results, all file contents | Treated as data; may contain prompt injection |
| Hostile | Anyone on the network without an approved key | Cannot interact beyond a rejected envelope |

## Guarantees (enforced by construction)

1. **Your main Claude is never in the request path.** Inbound queries spawn a fresh `claude -p` process. Your interactive sessions, their history, and your memory files are not inputs to it.
2. **Default deny.** A new peer has no grants. Accepting a connection grants *reachability*, not access. Every share is granted per peer, by name.
3. **The sandbox's tool surface is a whitelist.**
   - `--safe-mode`: no CLAUDE.md, hooks, plugins, skills, or your configured MCP servers.
   - `--tools "Read,Grep,Glob"` only when a project is granted; *no built-in tools at all* for MCP-only grants.
   - `--strict-mcp-config`: only the ephemeral config containing the granted servers exists.
   - `--disallowedTools` + settings deny rules as a second layer: `Bash`, `Write`, `Edit`, `WebFetch`, `WebSearch`, `Task`, etc. are denied even if a future claude version changes defaults.
   - In `-p` (non-interactive) mode, any un-allowlisted permission request is auto-denied — there is no human to click "allow".
4. **Path jail for reads.** Allowed: `Read(//granted/project/**)`. Denied regardless of allow rules: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.claude*`, `~/.amc`, `~/.netrc`, `~/.npmrc`, plus `.env*`, `*.pem`, `id_rsa*`, `id_ed25519*`, `credentials*.json` inside granted projects. Deny wins over allow in Claude Code's permission system.
5. **Authenticated, encrypted transport.** Ed25519 identity keys; every request signed and bound to the recipient's key; X25519+HKDF+AES-256-GCM sealed envelopes; responses sealed to a per-request ephemeral key; ±120s freshness window plus replay cache. Stolen invite codes expire (default 7d) and are single-use; the owner still confirms every peer by hand.
6. **Rate and concurrency caps.** Per-peer hourly/daily limits, a global sandbox concurrency cap, a per-question size cap, a per-query wall-clock timeout, and an answer size cap. A hostile peer cannot melt your subscription quota faster than your configured ceiling.
7. **Full audit.** Every hello/ping/ask, its grants, duration, and the verbatim answer are appended to `~/.amc/audit.log` (mode 0600). `amc pause` is an instant kill-switch.
8. **Output filter.** Final answers are scanned for credential and PII patterns (private key blocks, cloud/API tokens, JWTs, SSNs, Luhn-valid card numbers, `key=value` secrets, your custom regexes). A hit blocks the whole answer and notifies you.

## Residual risks (read this part)

- **Prompt injection is mitigated, not solved.** A file in a granted project (or data behind a granted MCP tool) can contain instructions to the sandbox. The sandbox cannot write, browse, or shell out, so the blast radius is limited to *what it can already read* — but a successful injection could steer an answer to include scope data the asker didn't ask for. The output filter catches credential-shaped leaks, not semantic ones. **Do not grant directories containing data you wouldn't show the peer in a screen share.**
- **Within-tool scope is only as tight as the credential.** Sharing a Slack MCP with `--tools slack_read_channel` limits *operations*, not *which channels the underlying token can see*. amc deliberately does not parse and filter tool results (that approach is brittle and bypassable). Scope the credential itself: a dedicated Slack app in two channels, a fine-grained GitHub PAT for one repo, etc.
- **Granted read scope is the peer's read scope.** Any secret accidentally committed inside a granted project (outside the deny patterns) is reachable. Grant narrow paths.
- **The deny patterns are heuristics.** `secrets.yaml` with an unusual name will not be caught by path rules; the output filter is regex-level. Defense-in-depth, not a guarantee.
- **Owner-side claude behavior:** the sandbox depends on documented Claude Code flags (`--safe-mode`, `--strict-mcp-config`, `--tools`, permission rules). A regression in a future claude release could weaken a layer; the deny lists are duplicated across flags and settings to reduce single-point failure. Pin your claude version if you need stability.
- **Metadata exposure.** An approved peer learns your daemon is online and the names/descriptions of shares granted *to them* (by design, so their Claude knows what it can ask).
- **LAN exposure.** The daemon binds `0.0.0.0:4711` by default and presents only the sealed-envelope endpoint. Unauthenticated requests are rejected, but on hostile networks prefer binding to a Tailscale interface address.

## Reporting

Open a GitHub issue for non-sensitive reports. For sensitive vulnerabilities, contact the maintainer directly (see repository profile).
