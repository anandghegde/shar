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
