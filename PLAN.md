# Shar — Intelligent Multi-Agent Account Switcher

> **shar** (शर) — Sanskrit for "arrow". Draw the right arrow from your quiver.

---

## Supported Agents (Target)

| Agent | Credential Location | Switching Mechanism | Usage Detection |
|---|---|---|---|
| **Claude Code** | `~/.claude/credentials.json` | Replace entire `~/.claude/` directory | Rate limit headers / API |
| **Codex CLI** | `~/.codex/` | Replace entire `~/.codex/` directory | API quota headers |
| **GitHub Copilot** | `~/.config/gh/` | Switch `GH_CONFIG_DIR` or swap `hosts.yml` | Copilot API token status |
| **Aider** | `~/.aider.conf.yml` + `~/.aider.keys` | Swap API keys in config | Model-specific API quotas |
| **OpenCode** | `~/.config/opencode/` | Swap credentials file | Provider API status |
| **Gemini CLI** | `~/.config/gcloud/` | Swap application default credentials | Gemini API quotas |
| **Codebuff** | `~/.config/manicode/credentials.json` | Swap the `default` key in shared JSON (active profile points to a different `.user` entry) | `POST /api/v1/usage` + `GET /api/user/subscription` (credit-based allowances: `allowedUsage` vs `used`) |
| **Droid/Factory** | `~/.factory/auth.v2.file` + `~/.factory/auth.v2.key` | Copy backed-up auth files in/out of `~/.factory/`; also supports `FACTORY_API_KEY` env var profiles | Rate limit from API responses |
| **CodexBar** | (TBD) | (TBD) | (TBD) |

---

## The Problem

Developers using multiple CLI coding agents (Claude Code, Codex CLI, GitHub Copilot, Aider, etc.) hit the same wall repeatedly:

1. **Multiple accounts per agent** — work vs personal, trial vs paid, different API keys
2. **No unified management** — each agent stores credentials differently (files, env vars, OAuth tokens)
3. **No automatic failover** — when one account runs out of credits, you manually swap files
4. **Manual profile creation** — every time you log in to a new account, you must remember to save it

---

## The Solution: Shar Daemon

Shar runs as a **lightweight background daemon** that:

1. **Auto-detects new profiles** — watches credential directories; when you log in to a new account, it automatically saves it
2. **Tracks usage and quotas** — monitors rate limits and token usage per profile per agent
3. **Intelligently switches** — when one account is rate-limited or exhausted, seamlessly switches to another with remaining credits
4. **Transparent wrappers** — optional PATH-based wrappers let agents automatically use the best available account

---

## How It Works

### 1. Auto-Detect New Profiles

The daemon watches credential directories via filesystem events (`fs.watch` / `fsevents`):

```
Watched paths:
  ~/.claude/                    Claude Code credentials
  ~/.codex/                     Codex CLI credentials
  ~/.config/gh/                 GitHub Copilot credentials
  ~/.aider.conf.yml             Aider config
  ~/.config/opencode/           OpenCode credentials
  ~/.config/gcloud/             Gemini CLI credentials
  ~/.config/manicode/credentials.json  Codebuff credentials (JSON with `default` pointer to `.user` entries)
  ~/.factory/auth.v2.file       Droid auth file
  ~/.factory/auth.v2.key        Droid auth key
```

When a change is detected (e.g., you run `claude login` with a different account), the daemon:

1. Computes a checksum of the new credential state
2. Compares against all known profiles
3. If it doesn't match any, it's a **new identity** — auto-saves as a new profile with a generated name (e.g., `claude-2026-05-18-1`) or prompts if interactive

### 2. Usage Tracking

| Source | What's Tracked |
|---|---|
| **Claude Code** | Rate limit headers from API calls, `anthropic-ratelimit-*` headers, remaining tokens |
| **Codex CLI** | OpenAI API usage, `x-ratelimit-remaining-*` headers |
| **GitHub Copilot** | GitHub Copilot API quota endpoint, premium request budget |
| **Aider** | API usage via response headers |
| **Codebuff** | `POST /api/v1/usage` for consumed credits; `GET /api/user/subscription` for allowance (credit-based: `allowedUsage` vs `used`, with `_usage` object tracking per-interval) |
| **Droid/Factory** | Rate limit from API response headers |

Usage data stored in `~/.config/shar/usage/`:

```json
{
  "claude": {
    "work": {
      "requestsRemaining": 4500,
      "tokensRemaining": 800000,
      "resetAt": "2026-05-19T00:00:00Z",
      "lastChecked": "2026-05-18T14:30:00Z"
    },
    "personal": {
      "requestsRemaining": 1200,
      "tokensRemaining": 200000,
      "resetAt": "2026-05-19T00:00:00Z",
      "lastChecked": "2026-05-18T14:25:00Z"
    }
  },
  "codebuff": {
    "work": {
      "allowedUsage": 100000,
      "used": 23450,
      "remaining": 76550,
      "currentPeriodStart": "2026-05-01T00:00:00Z",
      "lastChecked": "2026-05-18T14:30:00Z"
    }
  }
}
```

### 3. Intelligent Switching

Two modes:

**a) Pull mode (active switching)** — The daemon runs as `shard` and wraps agent binaries by manipulating `PATH`. When you run `claude`, `shard` intercepts, checks if the current profile has quota, and swaps credentials before launching if needed.

**b) Push mode (reactive switching)** — You invoke agents normally. The daemon watches for rate-limit errors (429 status) in agent logs/API responses. On detection, it automatically swaps to the next available profile for that agent and re-executes the failed command.

### 4. Interaction Flow

```
# Start the daemon (runs in background)
shard start

# That's it. Everything else is automatic:
# - Login to a new Claude Code account → shar detects and saves it
# - Your work Claude runs out of credits → shar swaps to personal
# - Check what's available
shar list

# Manual overrides still work:
shar switch work     # Force switch to work profile
shar pin claude work # Pin claude to always use "work" profile
```

---

## Architecture

```
# Filesystem
~/.config/shar/
  profiles/
    work/
      claude/              # Snapshot of ~/.claude
      codex/               # Snapshot of ~/.codex
      gh/                  # Snapshot of ~/.config/gh
      codebuff/            # Snapshot of ~/.config/manicode/credentials.json
      droid/               # Snapshot of ~/.factory/auth.v2.file + auth.v2.key
      env                  # Environment variables (API keys)
    personal/
      ...
  active/                  # Current active profile per agent
    claude  -> work        # Symlink or pointer
    codex   -> personal
    codebuff -> work
    droid   -> personal
  usage/                   # Quota and rate-limit data
    claude-work.json
    codebuff-work.json
  daemon.pid               # PID file for the daemon
  daemon.log               # Daemon logs

# Process model
shard                      # Background daemon process
  ├── watcher              # fs.watch on credential directories
  ├── quota-poller         # Periodic quota checks via API
  ├── rate-limit-listener  # Watches for 429 / quota exhaustion
  └── switcher             # Swaps credentials when needed
```

---

## CLI Reference

```
Usage: shar <command> [<args>]

Daemon commands:
  start          Start the background daemon (shard)
  stop           Stop the daemon
  status         Check if daemon is running
  logs           Tail daemon logs

Profile commands:
  list           List all known profiles with usage info
  show [name]    Show profile details (default: active)
  switch <name>  Manually switch to a profile
  pin <agent> <profile>   Pin an agent to always use a specific profile
  unpin <agent>           Remove the pin
  forget <name>  Remove a profile

Info:
  usage          Show quota/usage for all profiles
  current        Show active profile per agent

Examples:
  shard start              # Start the daemon
  # ... login to a new Claude account normally ...
  shar list                # See it was auto-detected
  shar usage               # Check remaining credits
  shar switch personal     # Manual override if needed
  shar pin claude work     # Always use work for Claude
```

---

## Implementation Plan
- [x] Confirm project scope from existing plan and preserve it as the source of truth
- [x] Create a continuation-friendly execution order for the first implementation pass
- [x] Scaffold the repo with a minimal executable layout for the chosen runtime
- [x] Implement profile storage plus checksum-based profile deduplication
- [x] Add the first automated tests around profile persistence and detection
- [x] Implement basic CLI command plumbing: `save`, `list`, `show`, `switch`, `forget`, `shard status`
- [x] Implement credential restore on `switch` with backup and atomic copy semantics
- [x] Implement file watching for credential directories and profile auto-save
- [x] Implement daemon lifecycle commands: start, stop, status

### Handoff notes
- Initial Node.js scaffold and core store tests are in place. See `IMPLEMENTATION.md` for continuation steps.
- Keep changes minimal and aligned with the existing plan. Do not broaden scope into Phase 2 yet.

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **Daemon not cron** | Filesystem events for instant profile detection; no polling delay |
| **File-based storage** | Zero dependencies; follows `droid-account` / `codebuff-account` pattern |
| **Agent log monitoring** | For detecting rate limits without MITM/proxy |
| **Pull + Push switching** | Covers both proactive (before launch) and reactive (after hitting limit) |
| **Pin overrides** | Users may want specific accounts for specific agents regardless of quota |
| **Codebuff: shared JSON model** | Single `credentials.json` file with a `default` pointer — switch by updating the pointer, not swapping files |
| **Droid: binary auth files** | `auth.v2.file` + `auth.v2.key` are binary — switch by atomic file copy (same pattern as `droid-account`) |
| **Codebuff: credit-based quota** | Codebuff uses credit allowances (`allowedUsage` vs `used`) — pollable via their API, unlike Claude's opaque rate limits |
| **Droid: API key fallback** | Supports `FACTORY_API_KEY` env var as an alternative to auth file profiles — two distinct profile types |

---

## Tech Stack

- **Runtime**: Node.js (same ecosystem as your existing tools)
- **Dependencies**: Zero (pure Node.js — `fs.watch`, `child_process`, `http`)
- **Storage**: `~/.config/shar/` with chmod 600 on sensitive files
- **Daemonize**: Simple PID file + signal handling (`shard`), no external process manager

---

## Inspiration

```
droid-account/          # File-based auth file backup/restore (binary + API key profiles)
codebuff-account/       # Shared credentials JSON swap (credits tracking, usage polling)
mariotoffia/llm-switcher  # Per-provider slot model (env var approach for 13 providers)
```

---

## Open Source

- Name: `shar`
- CLI: `shar` (user-facing), `shard` (daemon)
- License: MIT
- Repository: `github/ahegde/shar`
- npm: `shar`
