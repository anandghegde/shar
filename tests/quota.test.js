import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { createStore } from "../src/store.js";
import { codebuffPoller } from "../src/pollers/codebuff.js";
import { pollAllProfiles } from "../src/quota.js";

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), "shar-quota-test-"));
}

test("store writeUsage/readUsage round-trips JSON payloads", async () => {
  const configDir = await makeTempRoot();
  const store = createStore({ configDir });

  await store.writeUsage("codebuff", "work", { remaining: 50 });
  assert.deepEqual(await store.readUsage("codebuff", "work"), { remaining: 50 });
  assert.equal(await store.readUsage("codebuff", "missing"), null);
});

test("store listUsage enumerates all written agent/profile pairs", async () => {
  const configDir = await makeTempRoot();
  const store = createStore({ configDir });

  await store.writeUsage("codebuff", "work", { remaining: 10 });
  await store.writeUsage("codebuff", "personal", { remaining: 20 });
  await store.writeUsage("claude", "work", { remaining: 30 });

  const list = await store.listUsage();
  assert.deepEqual(
    list.map(({ agent, profile }) => `${agent}/${profile}`).sort(),
    ["claude/work", "codebuff/personal", "codebuff/work"]
  );
});

test("codebuffPoller reads token and parses subscription response", async () => {
  const configDir = await makeTempRoot();
  const snapshotPath = join(configDir, "credentials.json");
  await writeFile(
    snapshotPath,
    JSON.stringify({
      default: "alice",
      ".user": { alice: { authToken: "tok-123" } }
    })
  );

  let receivedUrl;
  let receivedHeaders;
  const fetcher = async (url, init) => {
    receivedUrl = url;
    receivedHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          allowedUsage: 100,
          used: 30,
          currentPeriodStart: "2026-05-01T00:00:00Z"
        };
      }
    };
  };

  const result = await codebuffPoller({ snapshotPath, fetcher });
  assert.equal(receivedUrl, "https://www.codebuff.com/api/user/subscription");
  assert.equal(receivedHeaders.Authorization, "Bearer tok-123");
  assert.equal(result.allowedUsage, 100);
  assert.equal(result.used, 30);
  assert.equal(result.remaining, 70);
  assert.equal(result.currentPeriodStart, "2026-05-01T00:00:00Z");
  assert.match(result.lastChecked, /^\d{4}-\d{2}-\d{2}T/);
});

test("codebuffPoller throws on non-ok response", async () => {
  const configDir = await makeTempRoot();
  const snapshotPath = join(configDir, "credentials.json");
  await writeFile(
    snapshotPath,
    JSON.stringify({ default: "a", ".user": { a: { authToken: "t" } } })
  );

  const fetcher = async () => ({ ok: false, status: 401, async json() { return {}; } });
  await assert.rejects(() => codebuffPoller({ snapshotPath, fetcher }), /401/);
});

test("pollAllProfiles skips unsupported agents and persists supported ones", async () => {
  const configDir = await makeTempRoot();
  const sourceFile = join(configDir, "src.json");
  await writeFile(
    sourceFile,
    JSON.stringify({ default: "alice", ".user": { alice: { authToken: "tok" } } })
  );

  const store = createStore({
    configDir,
    agents: {
      codebuff: { credentialPath: join(configDir, "dest.json") },
      claude: { credentialPath: join(configDir, "missing-claude") }
    }
  });
  await store.saveSnapshot({ agent: "codebuff", profile: "work", sourcePath: sourceFile });

  const fetcher = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { allowedUsage: 100, used: 25 };
    }
  });

  const results = await pollAllProfiles({ store, fetcher });

  const codebuff = results.find((r) => r.agent === "codebuff" && r.profile === "work");
  assert.ok(codebuff?.ok);
  assert.equal(codebuff.data.remaining, 75);

  const claude = results.find((r) => r.agent === "claude");
  assert.equal(claude.supported, false);

  const persisted = await store.readUsage("codebuff", "work");
  assert.equal(persisted.remaining, 75);
});

test("pollAllProfiles records errors without aborting other agents", async () => {
  const configDir = await makeTempRoot();
  const goodSource = join(configDir, "good.json");
  const badSource = join(configDir, "bad.json");
  await writeFile(
    goodSource,
    JSON.stringify({ default: "alice", ".user": { alice: { authToken: "ok" } } })
  );
  await writeFile(badSource, JSON.stringify({ default: "bob", ".user": {} }));

  const store = createStore({
    configDir,
    agents: { codebuff: { credentialPath: join(configDir, "dest.json") } }
  });
  await store.saveSnapshot({ agent: "codebuff", profile: "good", sourcePath: goodSource });
  await store.saveSnapshot({ agent: "codebuff", profile: "bad", sourcePath: badSource });

  const fetcher = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { allowedUsage: 10, used: 1 };
    }
  });

  const results = await pollAllProfiles({ store, fetcher });
  const good = results.find((r) => r.profile === "good");
  const bad = results.find((r) => r.profile === "bad");
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /authToken/);
});
