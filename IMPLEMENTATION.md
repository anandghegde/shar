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
