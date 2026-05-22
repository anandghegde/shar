import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), "shar-cli-test-"));
}

function runShar(args, configDir, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["./bin/shar", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, SHAR_CONFIG_DIR: configDir, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("shar list prints known profiles", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), "{}");

  assert.equal((await runShar(["save", "claude", "work", sourceDir], configDir)).status, 0);
  const result = await runShar(["list"], configDir);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /work\s+claude/);
});

test("shar switch updates the active profile for all saved agents", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source");
  const destinationDir = join(configDir, "dest-codex");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "auth.json"), "{}");

  const env = { SHAR_AGENT_PATHS: JSON.stringify({ codex: destinationDir }) };
  await runShar(["save", "codex", "personal", sourceDir], configDir, env);
  const switchResult = await runShar(["switch", "personal"], configDir, env);
  const showResult = await runShar(["show", "personal"], configDir, env);

  assert.equal(switchResult.status, 0);
  assert.match(showResult.stdout, /codex\s+active/);
});

test("shar switch restores saved credentials to configured destination", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source");
  const destinationDir = join(configDir, "dest");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), "saved");

  const env = { SHAR_AGENT_PATHS: JSON.stringify({ claude: destinationDir }) };
  await runShar(["save", "claude", "work", sourceDir], configDir, env);
  const result = await runShar(["switch", "work"], configDir, env);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /switched work for claude/);
  assert.equal(await readFile(join(destinationDir, "credentials.json"), "utf8"), "saved");
});

test("shar watch saves a profile for an existing credential path", async () => {
  const configDir = await makeTempRoot();
  const credentialPath = join(configDir, "claude-creds");
  await mkdir(credentialPath, { recursive: true });
  await writeFile(join(credentialPath, "credentials.json"), "{}");

  const env = {
    SHAR_AGENT_PATHS: JSON.stringify({
      claude: credentialPath,
      codex: join(configDir, "missing-codex"),
      gh: join(configDir, "missing-gh")
    })
  };
  const result = await runShar(["watch"], configDir, env);

  assert.equal(result.status, 0, `watch failed: ${result.stderr}`);
  assert.match(result.stdout, /^claude\tsaved\tclaude-/m);
  assert.match(result.stdout, /^codex\tskipped$/m);
  assert.match(result.stdout, /^gh\tskipped$/m);

  const second = await runShar(["watch"], configDir, env);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /^claude\tdeduplicated\t/m);
});

test("shar forget removes profile and active pointer", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source");
  const destinationDir = join(configDir, "dest");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), "{}");

  const env = { SHAR_AGENT_PATHS: JSON.stringify({ claude: destinationDir }) };
  await runShar(["save", "claude", "work", sourceDir], configDir, env);
  await runShar(["switch", "work"], configDir, env);

  const forgetResult = await runShar(["forget", "work"], configDir, env);
  assert.equal(forgetResult.status, 0);
  assert.match(forgetResult.stdout, /forgot work/);

  const listResult = await runShar(["list"], configDir, env);
  assert.equal(listResult.status, 0);
  assert.match(listResult.stdout, /No profiles saved/);

  const showResult = await runShar(["show", "work"], configDir, env);
  assert.equal(showResult.status, 1);
  assert.match(showResult.stderr, /Profile not found: work/);
});

test("shar show on a missing profile exits nonzero", async () => {
  const configDir = await makeTempRoot();
  const result = await runShar(["show", "ghost"], configDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Profile not found: ghost/);
});

test("shar switch on a missing profile exits nonzero", async () => {
  const configDir = await makeTempRoot();
  const result = await runShar(["switch", "ghost"], configDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Profile not found: ghost/);
});

test("shar with an unknown command exits nonzero", async () => {
  const configDir = await makeTempRoot();
  const result = await runShar(["bogus"], configDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: bogus/);
});

test("shard status reports stopped before daemon implementation", async () => {
  const configDir = await makeTempRoot();
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["./bin/shard", "status"], {
      cwd: process.cwd(),
      env: { ...process.env, SHAR_CONFIG_DIR: configDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /stopped/);
});
