import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { getStatus, isProcessAlive, start, stop } from "../src/daemon.js";
import { createStore } from "../src/store.js";

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), "shar-daemon-test-"));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("getStatus reports stopped when no pid file exists", async () => {
  const configDir = await makeTempRoot();
  const status = await getStatus(configDir);
  assert.deepEqual(status, { state: "stopped", pid: null });
});

test("getStatus clears a stale pid file and reports stopped", async () => {
  const configDir = await makeTempRoot();
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "daemon.pid"), "424242\n");

  const status = await getStatus(configDir, { checkAlive: () => false });

  assert.equal(status.state, "stopped");
  assert.equal(status.cleared, 424242);
  assert.equal(await exists(join(configDir, "daemon.pid")), false);
});

test("getStatus reports running when pid is alive", async () => {
  const configDir = await makeTempRoot();
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "daemon.pid"), "12345\n");

  const status = await getStatus(configDir, { checkAlive: () => true });

  assert.deepEqual(status, { state: "running", pid: 12345 });
});

test("start writes a pid file with the spawned pid", async () => {
  const configDir = await makeTempRoot();

  const result = await start(configDir, {
    spawnWorker: () => 9999,
    checkAlive: () => false
  });

  assert.deepEqual(result, { started: true, pid: 9999, alreadyRunning: false });
  const written = await readFile(join(configDir, "daemon.pid"), "utf8");
  assert.equal(written.trim(), "9999");
});

test("start refuses to overwrite a live pid file", async () => {
  const configDir = await makeTempRoot();
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "daemon.pid"), "1111\n");

  let spawned = false;
  const result = await start(configDir, {
    spawnWorker: () => {
      spawned = true;
      return 2222;
    },
    checkAlive: () => true
  });

  assert.deepEqual(result, { started: false, pid: 1111, alreadyRunning: true });
  assert.equal(spawned, false);
});

test("start replaces a stale pid file", async () => {
  const configDir = await makeTempRoot();
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "daemon.pid"), "3333\n");

  const result = await start(configDir, {
    spawnWorker: () => 4444,
    checkAlive: () => false
  });

  assert.deepEqual(result, { started: true, pid: 4444, alreadyRunning: false });
  const written = await readFile(join(configDir, "daemon.pid"), "utf8");
  assert.equal(written.trim(), "4444");
});

test("stop returns not running when no pid file exists", async () => {
  const configDir = await makeTempRoot();
  const result = await stop(configDir);
  assert.deepEqual(result, { stopped: false, reason: "not running" });
});

test("stop signals a live pid and removes the pid file", async () => {
  const configDir = await makeTempRoot();
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "daemon.pid"), "5555\n");

  const signaled = [];
  const result = await stop(configDir, {
    checkAlive: () => true,
    signalProcess: (pid) => signaled.push(pid)
  });

  assert.deepEqual(result, { stopped: true, pid: 5555, alive: true });
  assert.deepEqual(signaled, [5555]);
  assert.equal(await exists(join(configDir, "daemon.pid")), false);
});

test("stop cleans up a stale pid file without signaling", async () => {
  const configDir = await makeTempRoot();
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "daemon.pid"), "6666\n");

  const signaled = [];
  const result = await stop(configDir, {
    checkAlive: () => false,
    signalProcess: (pid) => signaled.push(pid)
  });

  assert.deepEqual(result, { stopped: true, pid: 6666, alive: false });
  assert.deepEqual(signaled, []);
  assert.equal(await exists(join(configDir, "daemon.pid")), false);
});

test("daemon worker scans credential paths and saves a profile", async () => {
  const configDir = await makeTempRoot();
  const credentialDir = await makeTempRoot();
  await writeFile(join(credentialDir, "creds.json"), "test");

  const workerPath = new URL("../src/daemon-worker.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [workerPath, configDir], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SHARD_INTERVAL_MS: "50",
      SHAR_AGENT_PATHS: JSON.stringify({
        claude: credentialDir,
        codex: join(configDir, "missing-codex"),
        gh: join(configDir, "missing-gh"),
        opencode: join(configDir, "missing-opencode"),
        gemini: join(configDir, "missing-gemini"),
        factory: join(configDir, "missing-factory"),
        codebuff: join(configDir, "missing-codebuff.json")
      })
    }
  });
  child.unref();

  try {
    let profiles = [];
    for (let i = 0; i < 40; i++) {
      try {
        profiles = await readdir(join(configDir, "profiles"));
      } catch { /* not yet */ }
      if (profiles.length > 0) break;
      await wait(50);
    }
    assert.ok(profiles.length >= 1, `expected at least 1 profile, got ${profiles.length}`);
    const claudeSnapshot = join(configDir, "profiles", profiles[0], "claude", "creds.json");
    assert.equal(await readFile(claudeSnapshot, "utf8"), "test");
  } finally {
    child.kill("SIGTERM");
    for (let i = 0; i < 40; i++) {
      if (!isProcessAlive(child.pid)) break;
      await wait(50);
    }
  }
});

test("daemon worker polls quotas when SHARD_QUOTA_INTERVAL_MS is set", async () => {
  const configDir = await makeTempRoot();

  const sourceFile = join(configDir, "codebuff-src.json");
  await writeFile(
    sourceFile,
    JSON.stringify({ default: "alice", ".user": { alice: { authToken: "tok-xyz" } } })
  );
  const seedStore = createStore({
    configDir,
    agents: { codebuff: { credentialPath: join(configDir, "codebuff-dest.json") } }
  });
  await seedStore.saveSnapshot({ agent: "codebuff", profile: "work", sourcePath: sourceFile });

  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ allowedUsage: 100, used: 45, currentPeriodStart: "2026-05-01" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const workerPath = new URL("../src/daemon-worker.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [workerPath, configDir], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SHARD_INTERVAL_MS: "100000",
      SHARD_QUOTA_INTERVAL_MS: "50",
      SHAR_CODEBUFF_URL: `http://127.0.0.1:${port}/api/user/subscription`,
      SHAR_AGENT_PATHS: JSON.stringify({
        claude: join(configDir, "missing-claude"),
        codex: join(configDir, "missing-codex"),
        gh: join(configDir, "missing-gh"),
        opencode: join(configDir, "missing-opencode"),
        gemini: join(configDir, "missing-gemini"),
        factory: join(configDir, "missing-factory"),
        codebuff: join(configDir, "codebuff-dest.json")
      })
    }
  });
  child.unref();

  try {
    let usage = null;
    for (let i = 0; i < 40; i++) {
      try {
        usage = JSON.parse(
          await readFile(join(configDir, "usage", "codebuff", "work.json"), "utf8")
        );
      } catch { /* not yet */ }
      if (usage) break;
      await wait(50);
    }
    assert.ok(usage, "expected codebuff usage file to be written");
    assert.equal(usage.remaining, 55);
    assert.ok(requests.length > 0, "expected at least one HTTP request");
    assert.equal(requests[0].auth, "Bearer tok-xyz");
  } finally {
    child.kill("SIGTERM");
    for (let i = 0; i < 40; i++) {
      if (!isProcessAlive(child.pid)) break;
      await wait(50);
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("start then stop spawns a real worker that exits on SIGTERM", async () => {
  const configDir = await makeTempRoot();

  const startResult = await start(configDir);
  assert.equal(startResult.started, true);
  assert.equal(typeof startResult.pid, "number");

  // Wait until the worker has had a chance to set up signal handlers and
  // write its first log line — keeps the SIGTERM path deterministic.
  for (let i = 0; i < 20; i++) {
    if (await exists(join(configDir, "daemon.log"))) break;
    await wait(50);
  }

  const stopResult = await stop(configDir);
  assert.equal(stopResult.stopped, true);
  assert.equal(stopResult.pid, startResult.pid);

  for (let i = 0; i < 40; i++) {
    if (!isProcessAlive(startResult.pid)) break;
    await wait(50);
  }
  assert.equal(isProcessAlive(startResult.pid), false);
  assert.equal(await exists(join(configDir, "daemon.pid")), false);
});
