# Shar Implementation Handoff

This file is the continuation checklist for implementation agents. `PLAN.md` remains the product brief; this file tracks exact engineering steps.

## Current Status

- [x] Node.js package scaffold created with zero runtime dependencies.
- [x] `node --test` test suite added.
- [x] Profile store implemented in `src/store.js`.
- [x] Basic CLI entrypoints added: `bin/shar`, `bin/shard`.
- [x] Current verification: `npm test` passes.

## Scope Rules

- Stay inside Phase 1 until all unchecked items below are complete.
- Do not implement quota polling, pins, wrappers, or Phase 1b agents yet.
- Keep runtime dependency-free unless there is a clear reason to update the product plan.
- Treat `~/.config/shar` storage as sensitive. Files that contain credentials should be written with `0600`; directories should be `0700`.

## Step 1: Credential Restore on Switch

Status: done.

Goal: `shar switch <profile>` should copy each saved agent snapshot back to the real credential path for that agent.

Files:
- Modify: `src/store.js`
- Modify: `src/cli.js`
- Test: `tests/store.test.js`
- Test: `tests/cli.test.js`

Implementation notes:
- Add a fixed Phase 1 agent registry:
  - `claude` -> `~/.claude`
  - `codex` -> `~/.codex`
  - `gh` -> `~/.config/gh`
- For tests, allow destination path overrides so tests never touch real home credentials.
- Before restore, create a backup under `~/.config/shar/backups/<timestamp>/<agent>`.
- Restore by copying the saved snapshot to the destination path after backup.
- Keep `switch` active-pointer behavior after successful restore.

Verification:
- [x] Add a test that saves a fake `claude` snapshot, switches to that profile, and verifies the destination contains the saved file.
- [x] Add a test that an existing destination is backed up before restore.
- [x] Run `npm test`.

## Step 2: Watcher Detection Without Daemonizing

Status: done.

Goal: implement testable credential change detection before adding process lifecycle behavior.

Files:
- Create: `src/agents.js`
- Create: `src/watcher.js`
- Modify: `src/cli.js` (added `shar watch` command)
- Modify: `src/store.js` (expose `agents` registry)
- Test: `tests/watcher.test.js`
- Test: `tests/cli.test.js`

Implementation notes:
- Keep this logic independent from a long-running process.
- Watcher should accept an agent registry and profile naming callback.
- Use checksum-based dedup already present in `store.saveSnapshot`.
- Prefer polling in tests over real `fs.watch` timing.

Verification:
- [x] Test that a changed watched path creates one profile.
- [x] Test that repeating the same content does not create duplicate profiles.
- [x] CLI test: `shar watch` saves a profile and dedupes on a second call.
- [x] Run `npm test` (14 tests passing).

Note: `store.checksumPath` originally walked directories using `stat`, which crashed on recursive symlinks under `~/.codex`. Fixed in Step 3 follow-up by switching to `lstat` and hashing symlinks by their target string without recursing.

## Step 3: Daemon Lifecycle

Status: done.

Goal: implement `shard start`, `shard stop`, and `shard status`.

Files:
- Create: `src/daemon.js`
- Create: `src/daemon-worker.js`
- Modify: `src/cli.js`
- Test: `tests/daemon.test.js`

Implementation notes:
- Start spawns `src/daemon-worker.js` detached and writes `daemon.pid`. The worker appends heartbeats to `daemon.log` and exits on SIGTERM/SIGINT.
- Stop reads the pid file, sends SIGTERM if the process is alive, and removes the pid file (handles stale pids without signaling).
- `getStatus` clears stale pid files transparently.
- `getStatus` / `start` / `stop` accept `checkAlive`, `spawnWorker`, and `signalProcess` injection points so the bulk of testing avoids real subprocesses.
- Worker poll interval is `SHARD_INTERVAL_MS` (default 30s).
- The worker scans configured credential paths each interval via `scanCredentialPaths` and logs `saved` / `deduplicated` outcomes to `daemon.log`. Reads `SHAR_AGENT_PATHS` for path overrides so tests can pin credential roots without touching real home credentials.
- No process-manager dependency.

Verification:
- [x] Test status with no PID.
- [x] Test stale PID cleanup (both via `getStatus` and via `stop`).
- [x] Tests for start refusing live pid file, replacing stale pid file, and stop signaling a live pid.
- [x] Real subprocess lifecycle test: `start` -> worker writes log -> `stop` -> process exits, pid file removed.
- [x] Worker scan test: spawned worker picks up a written credential file and saves a profile.
- [x] Run `npm test` (30 tests passing).

## Step 6: Phase 1b Agents (Phase 2)

Status: opencode, gemini, factory, codebuff done. Aider deferred.

Goal: extend the agent registry beyond the original three (claude, codex, gh).

Files:
- Modify: `src/agents.js`
- Modify: `src/store.js` (`listProfileAgents` now surfaces file-based snapshots, not only directories).
- Test: `tests/store.test.js`
- Test: `tests/cli.test.js` / `tests/daemon.test.js` (override the new agent paths so tests stay hermetic and never touch real home credentials).

Implementation notes:
- New default registry entries:
  - `opencode` -> `~/.config/opencode`
  - `gemini`   -> `~/.config/gcloud`
  - `factory`  -> `~/.factory` (snapshots `auth.v2.file` + `auth.v2.key` together)
  - `codebuff` -> `~/.config/manicode/credentials.json` (single file)
- `listProfileAgents` previously filtered to directories only, which hid file-based snapshots. Switched to `exists()` so a profile directory containing `codebuff` (a file) is visible to `show` / `restoreProfile`.
- Aider is deferred: it stores two distinct files at `~/.aider.conf.yml` and `~/.aider.keys`, which needs multi-path agent support that is a bigger refactor of the registry shape.

Verification:
- [x] Store test for codebuff-style file-path round-trip (`save` -> `show` -> `restoreProfile` -> destination file contents match).
- [x] Watch CLI test and daemon-worker scan test override every registry agent so the suite never reads real `~/.config/...` paths.
- [x] Run `npm test` (37 tests passing).

## Step 5: Pins and Inspection Commands (Phase 2)

Status: done.

Goal: add `pin`, `unpin`, `current`, `logs` per PLAN.md CLI reference.

Files:
- Modify: `src/store.js` (pin/unpin helpers, `paths.pins`, pin cleanup on `forgetProfile`).
- Modify: `src/cli.js` (new commands and help text).
- Test: `tests/store.test.js`, `tests/cli.test.js`.

Implementation notes:
- Pins live under `~/.config/shar/pins/<agent>` and contain only the profile name. `setPin` validates the profile exists; `forgetProfile` removes both active pointers and pins that reference the forgotten profile.
- `current` iterates the agent registry and prints `agent\tactive:<name>\tpinned:<name>` (`-` for unset).
- `logs` reads `daemon.log` and prints the last N lines (default 50). Missing log prints `no daemon logs yet`.
- No quota- or switching-aware behavior wired up yet — pins are pure metadata until the intelligent switcher lands.

Verification:
- [x] Store tests: pin round-trip, pin cleanup on forget.
- [x] CLI tests: pin rejects unknown profile, unpin removes file, current reports active+pinned for every registered agent, logs prints tail and placeholder.
- [x] Run `npm test` (36 tests passing).

## Step 7: Quota Polling Framework (Phase 2)

Status: done (codebuff only).

Goal: build the dispatcher + first real poller so `shar usage` and `shar usage refresh` work end-to-end.

Files:
- Create: `src/quota.js`
- Create: `src/pollers/codebuff.js`
- Modify: `src/store.js` (`writeUsage`, `readUsage`, `listUsage`, persisted under `paths.usage/<agent>/<profile>.json`).
- Modify: `src/cli.js` (`usage`, `usage refresh` + help text).
- Test: `tests/quota.test.js`, `tests/cli.test.js`.

Implementation notes:
- Storage shape is `~/.config/shar/usage/<agent>/<profile>.json` (subdir per agent) because both agent and profile names may contain `-`; a flat naming scheme would be ambiguous. Mode is 0600 for files, 0700 for directories.
- `pollAllProfiles({ store, agents, pollers, fetcher })` iterates the agent registry, looks up the per-agent poller, then iterates every profile that has a snapshot for that agent. Agents without a poller are reported as `{ supported: false }`; agents with no matching profile are reported as `{ supported: true, profiles: [] }`. Individual poller failures are captured per-result so a single bad profile does not abort the whole run.
- `codebuffPoller({ snapshotPath, fetcher })` reads the saved `credentials.json`, pulls the `default` user's `authToken` out of `.user`, calls `GET https://www.codebuff.com/api/user/subscription`, and returns `{ allowedUsage, used, remaining, currentPeriodStart, lastChecked }`. Fetcher is injectable so tests never hit the network.
- CLI: `shar usage` prints per-agent/profile rows from `listUsage`; `shar usage refresh` dispatches `pollAllProfiles` with the real `fetch`. No usage data yet prints `no usage data yet`.
- Other agents (claude, codex, gh, opencode, gemini, factory) intentionally have no poller yet; each will land as its own follow-up when the corresponding auth flow can be verified against real credentials.
- Daemon-level periodic polling is a separate follow-up; this step ships the on-demand CLI path only.

Verification:
- [x] Store tests: `writeUsage`/`readUsage` round-trip, `listUsage` enumerates all agent/profile pairs.
- [x] Poller test: codebuff parses subscription response, throws on non-ok HTTP.
- [x] Dispatcher tests: `pollAllProfiles` skips unsupported agents, persists supported ones, captures per-profile errors without aborting.
- [x] CLI tests: `shar usage` placeholder + populated display, `shar usage refresh` reports `unsupported` for agents without a poller and `no profiles` when codebuff has nothing to poll.
- [x] Run `npm test` (45 tests passing).

## Step 8: Daemon-Driven Periodic Quota Polling (Phase 2)

Status: done.

Goal: keep `~/.config/shar/usage/*` fresh in the background without requiring the user to run `shar usage refresh` manually.

Files:
- Modify: `src/daemon-worker.js` (split scan and quota into independent loops).
- Modify: `src/pollers/codebuff.js` (allow URL override via `SHAR_CODEBUFF_URL` so tests can target a local HTTP server).
- Test: `tests/daemon.test.js` (new integration test spawning the worker against a `node:http` mock).

Implementation notes:
- Disabled by default: `SHARD_QUOTA_INTERVAL_MS` is `0` unless set. Existing daemon tests stay safe because they do not opt in. Operators enable polling by setting the env var on `shard start`.
- The worker now runs two independent `while (true)` loops (`scanLoop`, `quotaLoop`) under `Promise.all`. They share the store but progress on their own intervals. A failure in one loop is logged and does not block the other.
- The codebuff URL is read from `process.env.SHAR_CODEBUFF_URL` at call time, defaulting to the real endpoint. This keeps the production hardcoded URL, but lets tests point at `http://127.0.0.1:<port>`.
- Daemon log format: `quota refreshed <agent> <profile>` on success, `quota error <agent> <profile>: <message>` on per-profile failure, `quota error: <message>` on dispatcher failure.

Verification:
- [x] Integration test: stand up a `node:http` mock returning a subscription payload, seed a codebuff snapshot, spawn the worker with `SHARD_QUOTA_INTERVAL_MS=50` and `SHAR_CODEBUFF_URL` pointed at the mock, assert the usage file appears with `remaining` computed correctly and the request carried the expected bearer token.
- [x] Existing `daemon worker scans credential paths` test continues to pass (no quota interference because the env var stays unset).
- [x] Run `npm test` (46 tests passing).

## Step 9: Quota-Aware Picker + Auto-Switch (Phase 2)

Status: done.

Goal: deliver the first slice of intelligent switching — pick the profile with the most remaining quota and apply it.

Files:
- Modify: `src/store.js` (`pickBestProfile`, `restoreAgent`).
- Modify: `src/cli.js` (`shar best <agent>`, `shar auto-switch <agent>` + help text).
- Test: `tests/store.test.js`, `tests/cli.test.js`.

Implementation notes:
- `pickBestProfile(agent)` priority: pin → highest `remaining` from `~/.config/shar/usage/<agent>/*.json` → `null`. Profiles with `remaining` of `null` or `<= 0` are skipped so we never auto-pick an exhausted account.
- `restoreAgent(agent, profile)` mirrors the per-agent path inside `restoreProfile` (backup → copy → setActive) but only for a single agent. This is what enables intelligent switching: swap one agent without disturbing the others.
- `shar best <agent>` is read-only and exits non-zero with a clear stderr message when no profile qualifies. Useful in shell scripts: `name=$(shar best codebuff) && shar auto-switch codebuff`.
- `shar auto-switch <agent>` is the apply path — picks + restores in one call. The 429-driven push mode in PLAN.md will reuse the same helper later.
- Staleness of `lastChecked` is not yet considered. With daemon polling enabled (Step 8) the data refreshes on its own. Adding a TTL guard is a follow-up.

Verification:
- [x] Store: pin wins over higher `remaining`; otherwise highest `remaining` wins; zero/null is skipped; `restoreAgent` only touches the named agent and rejects when the snapshot is missing.
- [x] CLI: `shar best` prints the chosen profile, exits 1 with stderr message when none qualifies; `shar auto-switch` restores the file at the configured destination and sets the active pointer.
- [x] Run `npm test` (54 tests passing).

## Step 4: CLI Completion for Phase 1

Status: done.

Goal: ensure `list`, `show`, `switch`, and `forget` match the product plan well enough for MVP use.

Files:
- Modify: `src/cli.js`
- Test: `tests/cli.test.js`

Implementation notes:
- `save` exists as an implementation helper but is not in the product CLI reference. Keep it for now unless replacing it with watcher-only behavior.
- Improve output formatting only when tests need it. Avoid cosmetic churn.
- `forget` should remove snapshots and active pointers. It already does this at store level.

Verification:
- [x] Add tests for `forget` (CLI integration test, asserts profile + active pointer gone).
- [x] Add tests for missing profile errors (`shar show ghost`, `shar switch ghost`).
- [x] Add test for invalid command error (`shar bogus`).
- [x] Run `npm test` (18 tests passing).
