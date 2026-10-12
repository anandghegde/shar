import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";

import {
  addClaudeProfile,
  claudeAccountDir,
  claudeEndpointSettingsPath,
  claudeProfilesPath,
  foundrySettingsPath,
  launchClaude,
  launchClaudeProfile,
  listClaudeProfiles,
  resolveClaudeProfile,
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

async function seedClaudeHome(settingsPath) {
  const home = join(settingsPath, "..");
  await writeFile(settingsPath, JSON.stringify({ cleanupPeriodDays: 90 }));
  await writeFile(join(home, "CLAUDE.md"), "# rules\n");
  await mkdir(join(home, "skills"), { recursive: true });
  await mkdir(join(home, "projects"), { recursive: true });
  await mkdir(join(home, "backups"), { recursive: true });
  await writeFile(join(home, ".claude.json"), "{}");
  await writeFile(join(home, "settings.json.backup.20260101"), "{}");
  await writeFile(join(home, "CLAUDE.md.backup-20260101"), "old");
}

test("addClaudeProfile registers profiles listed after the built-ins", async () => {
  const { configDir } = await makeFixture();
  await addClaudeProfile({
    configDir,
    name: "glm",
    kind: "claudish",
    model: "surplus@glm-5.3",
    label: "Surplus GLM 5.3"
  });
  await addClaudeProfile({ configDir, name: "sol", kind: "claudish", model: "surplus-gpt@gpt-6.1-sol" });

  const profiles = await listClaudeProfiles({ configDir });
  assert.deepEqual(profiles.map((p) => p.name), ["foundry", "subscription", "glm", "sol"]);
  assert.equal(profiles[2].label, "Surplus GLM 5.3");
  assert.equal(profiles[3].label, "sol");
  assert.equal(profiles[3].model, "surplus-gpt@gpt-6.1-sol");
  assert.equal((await stat(claudeProfilesPath(configDir))).mode & 0o777, 0o600);
});

test("addClaudeProfile rejects reserved, invalid, duplicate and incomplete profiles", async () => {
  const { configDir } = await makeFixture();
  const claudish = { kind: "claudish", model: "surplus@glm-5.3" };

  await assert.rejects(() => addClaudeProfile({ configDir, name: "foundry", ...claudish }), /reserved/);
  await assert.rejects(() => addClaudeProfile({ configDir, name: "add", ...claudish }), /reserved/);
  await assert.rejects(() => addClaudeProfile({ configDir, name: "../x", ...claudish }), /Invalid/);
  await addClaudeProfile({ configDir, name: "glm", ...claudish });
  await assert.rejects(() => addClaudeProfile({ configDir, name: "glm", ...claudish }), /already exists/);
  await assert.rejects(
    () => addClaudeProfile({ configDir, name: "nomodel", kind: "claudish" }),
    /require a model/
  );
  await assert.rejects(
    () => addClaudeProfile({ configDir, name: "ep", kind: "endpoint", url: "https://x.test" }),
    /require a token/
  );
});

test("resolveClaudeProfile finds built-ins and rejects unknown names", async () => {
  const { configDir } = await makeFixture();

  assert.equal((await resolveClaudeProfile({ configDir, name: "foundry" })).kind, "foundry");
  await assert.rejects(
    () => resolveClaudeProfile({ configDir, name: "ghost" }),
    /Unknown Claude profile: ghost; run: shar claude list/
  );
});

test("launchClaudeProfile runs claudish with the model and drops Foundry env", async () => {
  const { configDir, settingsPath } = await makeFixture();
  const recorder = spawnRecorder();

  await launchClaudeProfile({
    profile: { name: "glm", kind: "claudish", model: "surplus@glm-5.3" },
    args: ["-p", "hi"],
    configDir,
    settingsPath,
    env: {
      SHAR_REAL_CLAUDISH: "/test/bin/claudish",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
      SURPLUS_API_KEY: "keep"
    },
    spawnProcess: recorder.spawnProcess
  });

  const [call] = recorder.calls;
  assert.equal(call.command, "/test/bin/claudish");
  assert.deepEqual(call.args, ["-m", "surplus@glm-5.3", "-p", "hi"]);
  assert.equal(call.options.env.SURPLUS_API_KEY, "keep");
  assert.equal(call.options.env.CLAUDE_CODE_USE_FOUNDRY, undefined);
  assert.equal(call.options.env.ANTHROPIC_FOUNDRY_API_KEY, undefined);
  assert.equal(call.options.env.SHAR_REAL_CLAUDISH, undefined);
});

test("launchClaudeProfile delegates built-in kinds to the existing providers", async () => {
  const { configDir, settingsPath } = await makeFixture();
  await writeFile(settingsPath, "{}");
  const recorder = spawnRecorder();

  await launchClaudeProfile({
    profile: { name: "subscription", kind: "subscription" },
    args: ["--continue"],
    configDir,
    settingsPath,
    env: { SHAR_REAL_CLAUDE: "/test/bin/claude", ANTHROPIC_API_KEY: "generic" },
    spawnProcess: recorder.spawnProcess
  });

  assert.equal(recorder.calls[0].command, "/test/bin/claude");
  assert.deepEqual(recorder.calls[0].args, ["--continue"]);
  assert.equal(recorder.calls[0].options.env.ANTHROPIC_API_KEY, undefined);
});

test("endpoint profiles keep a private overlay and launch claude with it", async () => {
  const { configDir, settingsPath } = await makeFixture();
  await addClaudeProfile({
    configDir,
    name: "litellm",
    kind: "endpoint",
    url: "https://llm.example.test",
    token: "endpoint-token",
    model: "gpt-x"
  });

  const overlayPath = claudeEndpointSettingsPath(configDir, "litellm");
  assert.deepEqual(JSON.parse(await readFile(overlayPath, "utf8")), {
    env: {
      ANTHROPIC_BASE_URL: "https://llm.example.test",
      ANTHROPIC_AUTH_TOKEN: "endpoint-token",
      ANTHROPIC_MODEL: "gpt-x"
    }
  });
  assert.equal((await stat(overlayPath)).mode & 0o777, 0o600);

  const recorder = spawnRecorder();
  await launchClaudeProfile({
    profile: await resolveClaudeProfile({ configDir, name: "litellm" }),
    args: ["chat"],
    configDir,
    settingsPath,
    env: {
      SHAR_REAL_CLAUDE: "/test/bin/claude",
      ANTHROPIC_API_KEY: "generic",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      KEEP_VALUE: "yes"
    },
    spawnProcess: recorder.spawnProcess
  });

  const [call] = recorder.calls;
  assert.equal(call.command, "/test/bin/claude");
  assert.deepEqual(call.args, ["--settings", overlayPath, "chat"]);
  assert.equal(call.options.env.KEEP_VALUE, "yes");
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.options.env.CLAUDE_CODE_USE_FOUNDRY, undefined);
});

test("account profiles mirror ~/.claude except identity state and backups", async () => {
  const { configDir, settingsPath } = await makeFixture();
  await seedClaudeHome(settingsPath);

  await addClaudeProfile({ configDir, settingsPath, name: "sub2", kind: "account" });

  const dir = claudeAccountDir(configDir, "sub2");
  assert.deepEqual((await readdir(dir)).sort(), ["CLAUDE.md", "projects", "settings.json", "skills"]);
  assert.equal(await readlink(join(dir, "settings.json")), settingsPath);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("account launch isolates CLAUDE_CONFIG_DIR and hands over user MCP servers", async () => {
  const { root, configDir, settingsPath } = await makeFixture();
  await seedClaudeHome(settingsPath);
  const claudeJsonPath = join(root, ".claude.json");
  const servers = { mem0: { command: "mem0-mcp", env: { MEM0_KEY: "secret" } } };
  await writeFile(claudeJsonPath, JSON.stringify({ mcpServers: servers, numStartups: 3 }));
  await addClaudeProfile({ configDir, settingsPath, name: "sub2", kind: "account" });

  const calls = [];
  const seen = {};
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    seen.path = args[0].slice("--mcp-config=".length);
    seen.mcp = JSON.parse(readFileSync(seen.path, "utf8"));
    seen.mode = readFileSyncMode(seen.path);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };

  await launchClaudeProfile({
    profile: await resolveClaudeProfile({ configDir, name: "sub2" }),
    args: ["--continue"],
    configDir,
    settingsPath,
    claudeJsonPath,
    env: {
      SHAR_REAL_CLAUDE: "/test/bin/claude",
      ANTHROPIC_API_KEY: "generic",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      KEEP_VALUE: "yes"
    },
    spawnProcess
  });

  const [call] = calls;
  assert.equal(call.command, "/test/bin/claude");
  assert.ok(call.args[0].startsWith("--mcp-config="));
  assert.equal(call.args[1], "--continue");
  assert.equal(call.options.env.CLAUDE_CONFIG_DIR, claudeAccountDir(configDir, "sub2"));
  assert.equal(call.options.env.KEEP_VALUE, "yes");
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.options.env.CLAUDE_CODE_USE_FOUNDRY, undefined);
  assert.deepEqual(seen.mcp, { mcpServers: servers });
  assert.equal(seen.mode, 0o600);
  await assert.rejects(() => stat(seen.path), { code: "ENOENT" });
});

function readFileSyncMode(path) {
  return statSync(path).mode & 0o777;
}

test("account launch skips --mcp-config when no user MCP servers exist", async () => {
  const { root, configDir, settingsPath } = await makeFixture();
  await seedClaudeHome(settingsPath);
  await addClaudeProfile({ configDir, settingsPath, name: "sub2", kind: "account" });
  const recorder = spawnRecorder();

  await launchClaudeProfile({
    profile: await resolveClaudeProfile({ configDir, name: "sub2" }),
    args: ["auth", "status"],
    configDir,
    settingsPath,
    claudeJsonPath: join(root, "missing.claude.json"),
    env: {},
    spawnProcess: recorder.spawnProcess
  });

  assert.deepEqual(recorder.calls[0].args, ["auth", "status"]);
});

test("account launch refuses while user settings override subscription auth", async () => {
  const { root, configDir, settingsPath } = await makeFixture();
  await seedClaudeHome(settingsPath);
  await addClaudeProfile({ configDir, settingsPath, name: "sub2", kind: "account" });
  await writeFile(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_USE_FOUNDRY: "1" } }));

  await assert.rejects(
    async () => launchClaudeProfile({
      profile: await resolveClaudeProfile({ configDir, name: "sub2" }),
      configDir,
      settingsPath,
      claudeJsonPath: join(root, ".claude.json"),
      spawnProcess: spawnRecorder().spawnProcess
    }),
    /run: shar claude setup/
  );
});

test("account launch fails clearly when the account was never added", async () => {
  const { configDir, settingsPath } = await makeFixture();
  await seedClaudeHome(settingsPath);

  await assert.rejects(
    () => launchClaudeProfile({
      profile: { name: "sub9", kind: "account" },
      configDir,
      settingsPath,
      spawnProcess: spawnRecorder().spawnProcess
    }),
    /run: shar claude add sub9/
  );
});

test("account launch re-links a replaced settings.json and picks up new entries", async () => {
  const { root, configDir, settingsPath } = await makeFixture();
  await seedClaudeHome(settingsPath);
  await addClaudeProfile({ configDir, settingsPath, name: "sub2", kind: "account" });

  const dir = claudeAccountDir(configDir, "sub2");
  await rm(join(dir, "settings.json"));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ forked: true }));
  await mkdir(join(settingsPath, "..", "agents"));

  const warnings = [];
  await launchClaudeProfile({
    profile: await resolveClaudeProfile({ configDir, name: "sub2" }),
    configDir,
    settingsPath,
    claudeJsonPath: join(root, "missing.claude.json"),
    warn: (message) => warnings.push(message),
    env: {},
    spawnProcess: spawnRecorder().spawnProcess
  });

  assert.equal(await readlink(join(dir, "settings.json")), settingsPath);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "settings.json.shar-conflict"), "utf8")), {
    forked: true
  });
  assert.equal(await readlink(join(dir, "agents")), join(settingsPath, "..", "agents"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /settings\.json.*shar-conflict/);
});
