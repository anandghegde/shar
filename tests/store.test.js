import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { createStore } from "../src/store.js";

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), "shar-test-"));
}

test("ensureLayout creates the expected storage directories", async () => {
  const configDir = await makeTempRoot();
  const store = createStore({ configDir });

  await store.ensureLayout();

  const profiles = await store.listProfiles();
  assert.deepEqual(profiles, []);
});

test("saveSnapshot deduplicates identical agent credentials by checksum", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source-claude");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), JSON.stringify({ account: "work" }));

  const store = createStore({ configDir });

  const first = await store.saveSnapshot({
    agent: "claude",
    profile: "work",
    sourcePath: sourceDir
  });
  const second = await store.saveSnapshot({
    agent: "claude",
    profile: "work-copy",
    sourcePath: sourceDir
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.profile, "work");
  assert.deepEqual(await store.listProfiles(), [{ name: "work", agents: ["claude"] }]);
});

test("forgetProfile removes active pointers that reference the forgotten profile", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source-codex");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "auth.json"), JSON.stringify({ account: "personal" }));

  const store = createStore({ configDir });
  await store.saveSnapshot({ agent: "codex", profile: "personal", sourcePath: sourceDir });
  await store.setActive("codex", "personal");

  await store.forgetProfile("personal");

  assert.equal(await store.getActive("codex"), null);
  assert.deepEqual(await store.listProfiles(), []);
});

test("showProfile returns metadata for saved agent snapshots", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source-gh");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "hosts.yml"), "github.com:\\n  user: octo\\n");

  const store = createStore({ configDir });
  await store.saveSnapshot({ agent: "gh", profile: "work", sourcePath: sourceDir });

  const profile = await store.showProfile("work");
  assert.equal(profile.name, "work");
  assert.deepEqual(profile.agents, ["gh"]);
  assert.match(profile.snapshots.gh.checksum, /^[a-f0-9]{64}$/);
});

test("restoreProfile copies saved snapshots to configured agent destinations", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source-claude");
  const destinationDir = join(configDir, "dest-claude");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), JSON.stringify({ account: "work" }));

  const store = createStore({
    configDir,
    agents: { claude: { credentialPath: destinationDir } }
  });
  await store.saveSnapshot({ agent: "claude", profile: "work", sourcePath: sourceDir });

  const result = await store.restoreProfile("work");

  assert.deepEqual(result.restoredAgents, ["claude"]);
  assert.equal(await readFile(join(destinationDir, "credentials.json"), "utf8"), "{\"account\":\"work\"}");
  assert.equal(await store.getActive("claude"), "work");
});

test("file-path agents (e.g. codebuff) round-trip save -> show -> switch -> restore", async () => {
  const configDir = await makeTempRoot();
  const sourceFile = join(configDir, "manicode-creds.json");
  const destinationFile = join(configDir, "dest", "credentials.json");
  await writeFile(sourceFile, JSON.stringify({ default: "work" }));

  const store = createStore({
    configDir,
    agents: { codebuff: { credentialPath: destinationFile } }
  });

  const saveResult = await store.saveSnapshot({
    agent: "codebuff",
    profile: "work",
    sourcePath: sourceFile
  });
  assert.equal(saveResult.created, true);

  const profile = await store.showProfile("work");
  assert.deepEqual(profile.agents, ["codebuff"]);

  await store.restoreProfile("work");
  assert.equal(
    await readFile(destinationFile, "utf8"),
    JSON.stringify({ default: "work" })
  );
});

test("setPin rejects unknown profiles and getPin/unpin round-trip the pin", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source-claude");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), "{}");

  const store = createStore({ configDir });
  await store.saveSnapshot({ agent: "claude", profile: "work", sourcePath: sourceDir });

  await assert.rejects(() => store.setPin("claude", "ghost"), /Profile not found: ghost/);

  await store.setPin("claude", "work");
  assert.equal(await store.getPin("claude"), "work");

  await store.unpin("claude");
  assert.equal(await store.getPin("claude"), null);
});

test("forgetProfile removes pins that reference the forgotten profile", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source-claude");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), "{}");

  const store = createStore({ configDir });
  await store.saveSnapshot({ agent: "claude", profile: "work", sourcePath: sourceDir });
  await store.setPin("claude", "work");

  await store.forgetProfile("work");

  assert.equal(await store.getPin("claude"), null);
});

test("saveSnapshot handles recursive symlinks without hanging", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source-claude");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), JSON.stringify({ account: "work" }));
  await symlink(".", join(sourceDir, "loop"));

  const store = createStore({ configDir });

  const result = await store.saveSnapshot({
    agent: "claude",
    profile: "work",
    sourcePath: sourceDir
  });

  assert.equal(result.created, true);
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
});

test("pickBestProfile returns the pinned profile when one is set", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "src");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), "{}");

  const store = createStore({ configDir });
  await store.saveSnapshot({ agent: "claude", profile: "work", sourcePath: sourceDir });
  await store.saveSnapshot({ agent: "claude", profile: "personal", sourcePath: sourceDir });
  await store.writeUsage("claude", "work", { remaining: 10 });
  await store.writeUsage("claude", "personal", { remaining: 999 });
  await store.setPin("claude", "work");

  assert.equal(await store.pickBestProfile("claude"), "work");
});

test("pickBestProfile picks the profile with the largest remaining quota", async () => {
  const configDir = await makeTempRoot();
  const store = createStore({ configDir });

  await store.writeUsage("codebuff", "a", { remaining: 5 });
  await store.writeUsage("codebuff", "b", { remaining: 50 });
  await store.writeUsage("codebuff", "c", { remaining: 20 });

  assert.equal(await store.pickBestProfile("codebuff"), "b");
});

test("pickBestProfile skips profiles with zero/null remaining and returns null when none qualify", async () => {
  const configDir = await makeTempRoot();
  const store = createStore({ configDir });

  await store.writeUsage("codebuff", "exhausted", { remaining: 0 });
  await store.writeUsage("codebuff", "unknown", { remaining: null });

  assert.equal(await store.pickBestProfile("codebuff"), null);
});

test("restoreAgent restores only the named agent and sets it active", async () => {
  const configDir = await makeTempRoot();
  const claudeSource = join(configDir, "claude-src");
  const codexSource = join(configDir, "codex-src");
  const claudeDest = join(configDir, "claude-dest");
  const codexDest = join(configDir, "codex-dest");
  await mkdir(claudeSource, { recursive: true });
  await mkdir(codexSource, { recursive: true });
  await writeFile(join(claudeSource, "credentials.json"), "claude-data");
  await writeFile(join(codexSource, "auth.json"), "codex-data");

  const store = createStore({
    configDir,
    agents: {
      claude: { credentialPath: claudeDest },
      codex: { credentialPath: codexDest }
    }
  });
  await store.saveSnapshot({ agent: "claude", profile: "work", sourcePath: claudeSource });
  await store.saveSnapshot({ agent: "codex", profile: "work", sourcePath: codexSource });

  const result = await store.restoreAgent("claude", "work");
  assert.equal(result.agent, "claude");
  assert.equal(result.profile, "work");
  assert.equal(await readFile(join(claudeDest, "credentials.json"), "utf8"), "claude-data");
  assert.equal(await store.getActive("claude"), "work");

  let codexExists = true;
  try { await readFile(join(codexDest, "auth.json"), "utf8"); } catch { codexExists = false; }
  assert.equal(codexExists, false);
  assert.equal(await store.getActive("codex"), null);
});

test("restoreAgent rejects when the profile has no snapshot for the agent", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "src");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "credentials.json"), "{}");

  const store = createStore({
    configDir,
    agents: { claude: { credentialPath: join(configDir, "dest") } }
  });
  await store.saveSnapshot({ agent: "claude", profile: "work", sourcePath: sourceDir });

  await assert.rejects(
    () => store.restoreAgent("codex", "work"),
    /Profile work has no snapshot for agent codex/
  );
});

test("restoreProfile backs up an existing destination before copying credentials", async () => {
  const configDir = await makeTempRoot();
  const sourceDir = join(configDir, "source-codex");
  const destinationDir = join(configDir, "dest-codex");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(destinationDir, { recursive: true });
  await writeFile(join(sourceDir, "auth.json"), "new");
  await writeFile(join(destinationDir, "auth.json"), "old");

  const store = createStore({
    configDir,
    agents: { codex: { credentialPath: destinationDir } }
  });
  await store.saveSnapshot({ agent: "codex", profile: "personal", sourcePath: sourceDir });

  const result = await store.restoreProfile("personal", { backupId: "test-backup" });

  assert.deepEqual(result.restoredAgents, ["codex"]);
  assert.equal(await readFile(join(destinationDir, "auth.json"), "utf8"), "new");
  assert.equal(
    await readFile(join(configDir, "backups", "test-backup", "codex", "auth.json"), "utf8"),
    "old"
  );
});
