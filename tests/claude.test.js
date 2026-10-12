import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";

import {
  foundrySettingsPath,
  launchClaude,
  setupClaudeProviders,
  switchClaudeProvider
} from "../src/claude.js";

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "shar-claude-test-"));
  const configDir = join(root, "shar");
  const settingsPath = join(root, ".claude", "settings.json");
  await mkdir(join(root, ".claude"), { recursive: true });
  return { root, configDir, settingsPath };
}

function spawnRecorder(exitCode = 0) {
  const calls = [];
  return {
    calls,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", exitCode, null));
      return child;
    }
  };
}

test("setupClaudeProviders extracts only Foundry settings and creates a backup", async () => {
  const { configDir, settingsPath } = await makeFixture();
  const original = {
    cleanupPeriodDays: 90,
    env: {
      COMMON_VALUE: "shared",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test",
      ANTHROPIC_FOUNDRY_API_KEY: "foundry-test-key",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "foundry-opus"
    },
    permissions: { allow: ["Read"] }
  };
  await writeFile(settingsPath, `${JSON.stringify(original)}\n`);

  const result = await setupClaudeProviders({
    configDir,
    settingsPath,
    now: () => new Date("2026-08-29T10:11:12.345Z")
  });

  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    cleanupPeriodDays: 90,
    env: { COMMON_VALUE: "shared" },
    permissions: { allow: ["Read"] }
  });
  assert.deepEqual(JSON.parse(await readFile(result.overlayPath, "utf8")), {
    env: {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test",
      ANTHROPIC_FOUNDRY_API_KEY: "foundry-test-key",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "foundry-opus"
    }
  });
  assert.deepEqual(JSON.parse(await readFile(result.backupPath, "utf8")), original);
  assert.equal((await stat(result.overlayPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("setupClaudeProviders is idempotent after the Foundry overlay exists", async () => {
  const { configDir, settingsPath } = await makeFixture();
  await writeFile(settingsPath, JSON.stringify({
    env: {
      COMMON_VALUE: "shared",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "test-resource"
    }
  }));

  await setupClaudeProviders({ configDir, settingsPath });
  const second = await setupClaudeProviders({ configDir, settingsPath });

  assert.equal(second.created, false);
  assert.equal(second.overlayPath, foundrySettingsPath(configDir));
  assert.equal(second.backupPath, null);
});

test("launchClaude starts Foundry with the protected settings overlay", async () => {
  const { configDir, settingsPath } = await makeFixture();
  const overlayPath = foundrySettingsPath(configDir);
  await mkdir(join(configDir, "claude"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ env: { COMMON_VALUE: "shared" } }));
  await writeFile(overlayPath, JSON.stringify({ env: { CLAUDE_CODE_USE_FOUNDRY: "1" } }));
  const recorder = spawnRecorder();

  const result = await launchClaude({
    provider: "foundry",
    args: ["--continue"],
    configDir,
    settingsPath,
    env: {
      SHAR_REAL_CLAUDE: "/test/bin/claude",
      ANTHROPIC_API_KEY: "generic-key",
      KEEP_VALUE: "yes"
    },
    spawnProcess: recorder.spawnProcess
  });

  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(recorder.calls[0].command, "/test/bin/claude");
  assert.deepEqual(recorder.calls[0].args, ["--settings", overlayPath, "--continue"]);
  assert.equal(recorder.calls[0].options.env.KEEP_VALUE, "yes");
  assert.equal(recorder.calls[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(recorder.calls[0].options.env.SHAR_REAL_CLAUDE, undefined);
});

test("launchClaude starts subscription auth without inherited provider or API overrides", async () => {
  const { configDir, settingsPath } = await makeFixture();
  await writeFile(settingsPath, JSON.stringify({ env: { COMMON_VALUE: "shared" } }));
  const recorder = spawnRecorder();

  await launchClaude({
    provider: "subscription",
    args: ["auth", "status"],
    configDir,
    settingsPath,
    env: {
      SHAR_REAL_CLAUDE: "/test/bin/claude",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "foundry-opus",
      ANTHROPIC_API_KEY: "generic-key",
      KEEP_VALUE: "yes"
    },
    spawnProcess: recorder.spawnProcess
  });

  assert.deepEqual(recorder.calls[0].args, ["auth", "status"]);
  assert.equal(recorder.calls[0].options.env.KEEP_VALUE, "yes");
  assert.equal(recorder.calls[0].options.env.CLAUDE_CODE_USE_FOUNDRY, undefined);
  assert.equal(recorder.calls[0].options.env.ANTHROPIC_FOUNDRY_API_KEY, undefined);
  assert.equal(recorder.calls[0].options.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(recorder.calls[0].options.env.ANTHROPIC_API_KEY, undefined);
});

test("launchClaude refuses subscription auth while user settings select Foundry", async () => {
  const { configDir, settingsPath } = await makeFixture();
  await writeFile(settingsPath, JSON.stringify({
    env: { CLAUDE_CODE_USE_FOUNDRY: "1" }
  }));

  await assert.rejects(
    () => launchClaude({ provider: "subscription", configDir, settingsPath }),
    /run: shar claude setup/
  );
});

test("switchClaudeProvider toggles between foundry and subscription", async () => {
  const { configDir, settingsPath } = await makeFixture();
  const overlayPath = foundrySettingsPath(configDir);
  await mkdir(join(configDir, "claude"), { recursive: true });
  await writeFile(overlayPath, JSON.stringify({
    env: {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "foundry-opus"
    }
  }));

  const initialSettings = {
    cleanupPeriodDays: 90,
    env: { COMMON_VAR: "kept" }
  };
  await writeFile(settingsPath, JSON.stringify(initialSettings));

  // Switch to foundry
  const toFoundry = await switchClaudeProvider({
    configDir,
    settingsPath,
    provider: "foundry"
  });
  assert.equal(toFoundry.provider, "foundry");
  assert.ok(toFoundry.backupPath);

  const foundryConfig = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(foundryConfig.env.COMMON_VAR, "kept");
  assert.equal(foundryConfig.env.CLAUDE_CODE_USE_FOUNDRY, "1");
  assert.equal(foundryConfig.env.ANTHROPIC_FOUNDRY_BASE_URL, "https://foundry.example.test");
  assert.equal(foundryConfig.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "foundry-opus");

  // Switch back to subscription
  const toSub = await switchClaudeProvider({
    configDir,
    settingsPath,
    provider: "subscription"
  });
  assert.equal(toSub.provider, "subscription");
  assert.ok(toSub.backupPath);

  const subConfig = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(subConfig.env.COMMON_VAR, "kept");
  assert.equal(subConfig.env.CLAUDE_CODE_USE_FOUNDRY, undefined);
  assert.equal(subConfig.env.ANTHROPIC_FOUNDRY_BASE_URL, undefined);
  assert.equal(subConfig.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
});
