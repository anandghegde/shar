import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { createStore } from "../src/store.js";
import { scanCredentialPaths } from "../src/watcher.js";

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), "shar-watcher-test-"));
}

test("scanCredentialPaths saves a profile for an existing watched credential path", async () => {
  const configDir = await makeTempRoot();
  const credentialPath = join(configDir, "claude-creds");
  await mkdir(credentialPath, { recursive: true });
  await writeFile(join(credentialPath, "credentials.json"), "account");

  const store = createStore({ configDir });
  const results = await scanCredentialPaths({
    store,
    agents: { claude: { credentialPath } },
    makeProfileName: ({ agent }) => `${agent}-detected`
  });

  assert.deepEqual(results, [
    { agent: "claude", profile: "claude-detected", created: true }
  ]);
  assert.deepEqual(await store.listProfiles(), [
    { name: "claude-detected", agents: ["claude"] }
  ]);
});

test("scanCredentialPaths deduplicates repeated credential content", async () => {
  const configDir = await makeTempRoot();
  const credentialPath = join(configDir, "codex-creds");
  await mkdir(credentialPath, { recursive: true });
  await writeFile(join(credentialPath, "auth.json"), "same");

  let count = 0;
  const store = createStore({ configDir });
  const makeProfileName = () => `detected-${++count}`;
  await scanCredentialPaths({
    store,
    agents: { codex: { credentialPath } },
    makeProfileName
  });
  const results = await scanCredentialPaths({
    store,
    agents: { codex: { credentialPath } },
    makeProfileName
  });

  assert.deepEqual(results, [{ agent: "codex", profile: "detected-1", created: false }]);
  assert.deepEqual(await store.listProfiles(), [
    { name: "detected-1", agents: ["codex"] }
  ]);
});

test("scanCredentialPaths skips missing credential paths", async () => {
  const configDir = await makeTempRoot();
  const store = createStore({ configDir });

  const results = await scanCredentialPaths({
    store,
    agents: { gh: { credentialPath: join(configDir, "missing") } },
    makeProfileName: ({ agent }) => agent
  });

  assert.deepEqual(results, [{ agent: "gh", profile: null, created: false }]);
  assert.deepEqual(await store.listProfiles(), []);
});
