import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  claudeCredentialsPath,
  claudeKeychainService,
  claudeUsageLabels,
  fetchOAuthUsage,
  fetchSurplusOverview,
  formatClaudeUsage,
  formatSurplusUsage,
  getClaudeUsage,
  getSurplusUsage,
  readOAuthCredential,
  surplusModelId
} from "../src/usage.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function fakeExec({ credential, version = "2.1.296 (Claude Code)" }) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "--version") return `${version}\n`;
    if (credential === null) throw Object.assign(new Error("not found"), { code: 44 });
    return JSON.stringify({ claudeAiOauth: credential });
  };
  return { exec, calls };
}

function fakeFetch(status, body = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { fetcher, calls };
}

const USAGE_BODY = {
  five_hour: { utilization: 23, resets_at: "2026-10-12T14:10:00Z" },
  seven_day: { utilization: 41, resets_at: "2026-10-15T12:00:00Z" }
};

async function tempConfigDir() {
  return mkdtemp(join(tmpdir(), "shar-usage-test-"));
}

test("claudeKeychainService uses the bare name unless CLAUDE_CONFIG_DIR is set", () => {
  assert.equal(claudeKeychainService(undefined), "Claude Code-credentials");
  const dir = "/Users/me/.config/shar/claude/accounts/sub2";
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  assert.equal(claudeKeychainService(dir), `Claude Code-credentials-${hash}`);
});

test("readOAuthCredential parses the Keychain JSON and tolerates failures", async () => {
  const ok = fakeExec({ credential: { accessToken: "tok", expiresAt: NOW + HOUR } });
  assert.deepEqual(await readOAuthCredential({ service: "svc", exec: ok.exec }), {
    accessToken: "tok",
    expiresAt: NOW + HOUR,
    refreshable: false,
    refreshExpiresAt: undefined
  });
  assert.deepEqual(ok.calls[0].args, ["find-generic-password", "-s", "svc", "-w"]);

  assert.equal(await readOAuthCredential({ service: "svc", exec: fakeExec({ credential: null }).exec }), null);
  assert.equal(
    await readOAuthCredential({ service: "svc", exec: async () => "not json" }),
    null
  );
});

test("readOAuthCredential falls back to the credentials file when there is no Keychain", async () => {
  const dir = await tempConfigDir();
  const credentialsPath = claudeCredentialsPath(dir);
  assert.equal(credentialsPath, join(dir, ".credentials.json"));

  const noKeychain = async () => {
    throw Object.assign(new Error("spawn security ENOENT"), { code: "ENOENT" });
  };
  assert.equal(await readOAuthCredential({ service: "svc", credentialsPath, exec: noKeychain }), null);

  await writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "file-tok",
        refreshToken: "refresh",
        expiresAt: NOW + HOUR,
        refreshTokenExpiresAt: NOW + 30 * 24 * HOUR
      }
    })
  );
  assert.deepEqual(await readOAuthCredential({ service: "svc", credentialsPath, exec: noKeychain }), {
    accessToken: "file-tok",
    expiresAt: NOW + HOUR,
    refreshable: true,
    refreshExpiresAt: NOW + 30 * 24 * HOUR
  });
});

test("fetchOAuthUsage sends the OAuth headers and maps statuses", async () => {
  const ok = fakeFetch(200, USAGE_BODY);
  const usage = await fetchOAuthUsage({ accessToken: "tok", version: "2.1.296", fetcher: ok.fetcher });

  const { headers } = ok.calls[0].options;
  assert.equal(ok.calls[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(headers.authorization, "Bearer tok");
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(headers["user-agent"], "claude-code/2.1.296");
  assert.equal(usage.status, "ok");
  assert.equal(usage.fiveHour.used, 23);
  assert.equal(usage.sevenDay.resetsAt, Date.parse("2026-10-15T12:00:00Z"));

  const stat401 = await fetchOAuthUsage({ accessToken: "t", version: "1", fetcher: fakeFetch(401).fetcher });
  const stat429 = await fetchOAuthUsage({ accessToken: "t", version: "1", fetcher: fakeFetch(429).fetcher });
  assert.equal(stat401.status, "expired");
  assert.equal(stat429.status, "limited");
});

test("getClaudeUsage fetches, caches privately and serves the cache within the TTL", async () => {
  const configDir = await tempConfigDir();
  const exec = fakeExec({ credential: { accessToken: "tok", expiresAt: NOW + HOUR } });
  const http = fakeFetch(200, USAGE_BODY);
  const base = { configDir, name: "subscription", now: NOW, env: {}, exec: exec.exec, fetcher: http.fetcher };

  const first = await getClaudeUsage(base);
  assert.equal(first.status, "ok");
  assert.equal(first.fiveHour.used, 23);
  assert.equal(http.calls.length, 1);
  assert.equal((await stat(join(configDir, "claude", "usage", "subscription.json"))).mode & 0o777, 0o600);

  const second = await getClaudeUsage({ ...base, now: NOW + 60_000 });
  assert.equal(second.status, "ok");
  assert.equal(http.calls.length, 1);

  const third = await getClaudeUsage({ ...base, now: NOW + 4 * 60_000 });
  assert.equal(http.calls.length, 2);
  assert.equal(third.status, "ok");
});

test("getClaudeUsage serves last-known numbers when the token expired or login is missing", async () => {
  const configDir = await tempConfigDir();
  const cachePath = join(configDir, "claude", "usage");
  await mkdir(cachePath, { recursive: true });
  await writeFile(
    join(cachePath, "sub2.json"),
    JSON.stringify({
      fetchedAt: NOW - 3 * HOUR,
      fiveHour: { used: 80, resetsAt: NOW - HOUR },
      sevenDay: { used: 41, resetsAt: NOW + 24 * HOUR }
    })
  );
  const http = fakeFetch(200, USAGE_BODY);

  const expired = await getClaudeUsage({
    configDir,
    name: "sub2",
    now: NOW,
    env: {},
    exec: fakeExec({ credential: { accessToken: "tok", expiresAt: NOW - 1000 } }).exec,
    fetcher: http.fetcher
  });
  assert.equal(expired.status, "expired");
  assert.equal(expired.sevenDay.used, 41);

  const idle = await getClaudeUsage({
    configDir,
    name: "sub2",
    now: NOW,
    env: {},
    exec: fakeExec({
      credential: { accessToken: "tok", refreshToken: "r", expiresAt: NOW - 1000, refreshTokenExpiresAt: NOW + HOUR }
    }).exec,
    fetcher: http.fetcher
  });
  assert.equal(idle.status, "idle");
  assert.equal(idle.sevenDay.used, 41);

  const deadRefresh = await getClaudeUsage({
    configDir,
    name: "sub2",
    now: NOW,
    env: {},
    exec: fakeExec({
      credential: { accessToken: "tok", refreshToken: "r", expiresAt: NOW - 1000, refreshTokenExpiresAt: NOW - 1000 }
    }).exec,
    fetcher: http.fetcher
  });
  assert.equal(deadRefresh.status, "expired");

  const noLogin = await getClaudeUsage({
    configDir,
    name: "sub2",
    claudeConfigDir: configDir,
    now: NOW,
    env: {},
    exec: fakeExec({ credential: null }).exec,
    fetcher: http.fetcher
  });
  assert.equal(noLogin.status, "login");
  assert.equal(http.calls.length, 0);
});

test("getClaudeUsage backs off after a 429 instead of hammering the endpoint", async () => {
  const configDir = await tempConfigDir();
  const exec = fakeExec({ credential: { accessToken: "tok", expiresAt: NOW + HOUR } });
  const http = fakeFetch(429);
  const base = { configDir, name: "subscription", now: NOW, env: {}, exec: exec.exec, fetcher: http.fetcher };

  assert.equal((await getClaudeUsage(base)).status, "limited");
  assert.equal(http.calls.length, 1);
  assert.equal((await getClaudeUsage({ ...base, now: NOW + 60_000 })).status, "limited");
  assert.equal(http.calls.length, 1);

  const cache = JSON.parse(await readFile(join(configDir, "claude", "usage", "subscription.json"), "utf8"));
  assert.ok(cache.backoffUntil > NOW);
});

test("getClaudeUsage treats a network failure as unavailable", async () => {
  const configDir = await tempConfigDir();
  const exec = fakeExec({ credential: { accessToken: "tok", expiresAt: NOW + HOUR } });

  const usage = await getClaudeUsage({
    configDir,
    name: "subscription",
    now: NOW,
    env: {},
    exec: exec.exec,
    fetcher: async () => {
      throw new Error("offline");
    }
  });

  assert.equal(usage.status, "unavailable");
});

test("formatClaudeUsage shows what is left, reset times and staleness", () => {
  const fresh = formatClaudeUsage({
    status: "ok",
    fetchedAt: NOW,
    fiveHour: { used: 23, resetsAt: NOW + 2 * HOUR + 10 * 60_000 },
    sevenDay: { used: 41, resetsAt: NOW + 3 * 24 * HOUR }
  }, NOW);
  assert.equal(fresh, "5h 77% left ↻2h10m · 7d 59% left ↻3d");

  const stale = formatClaudeUsage({
    status: "expired",
    fetchedAt: NOW - 3 * HOUR,
    fiveHour: { used: 80, resetsAt: NOW - HOUR },
    sevenDay: { used: 41, resetsAt: NOW + 24 * HOUR }
  }, NOW);
  assert.equal(stale, "5h 100% left · 7d 59% left ↻1d (login expired, as of 3h ago)");

  assert.equal(formatClaudeUsage({ status: "login" }, NOW), "(not logged in)");
  assert.equal(formatClaudeUsage({ status: "idle" }, NOW), "(refreshes on launch)");
  assert.equal(formatClaudeUsage({ status: "unavailable" }, NOW), "");
});

test("claudeUsageLabels covers subscription and account profiles only and can be disabled", async () => {
  const configDir = await tempConfigDir();
  const exec = fakeExec({ credential: { accessToken: "tok", expiresAt: NOW + HOUR } });
  const http = fakeFetch(200, USAGE_BODY);
  const profiles = [
    { name: "foundry", kind: "foundry", label: "Foundry" },
    { name: "subscription", kind: "subscription", label: "Personal subscription" },
    { name: "glm", kind: "claudish", label: "GLM" },
    { name: "sub2", kind: "account", label: "sub2" }
  ];

  const labels = await claudeUsageLabels({
    profiles,
    configDir,
    env: {},
    now: NOW,
    exec: exec.exec,
    fetcher: http.fetcher
  });
  assert.deepEqual([...labels.keys()].sort(), ["sub2", "subscription"]);
  assert.equal(labels.get("subscription"), "5h 77% left ↻2h10m · 7d 59% left ↻3d");

  const services = exec.calls
    .filter((call) => call.args[0] === "find-generic-password")
    .map((call) => call.args[2]);
  assert.ok(services.includes("Claude Code-credentials"));
  assert.ok(services.some((service) => /^Claude Code-credentials-[0-9a-f]{8}$/.test(service)));

  const off = await claudeUsageLabels({
    profiles,
    configDir,
    env: { SHAR_CLAUDE_USAGE: "0" },
    now: NOW,
    exec: exec.exec,
    fetcher: http.fetcher
  });
  assert.equal(off.size, 0);
});

const SURPLUS_BODY = {
  coverage: true,
  by_model: {
    dimension: "model",
    top: [
      {
        group: "gpt-6-astra",
        measures: { buyer_cost_micro: 2977178, direct_cost_micro: 298525110, savings_micro: 295547932 }
      },
      {
        group: "glm-5.3",
        measures: { buyer_cost_micro: 4177929, direct_cost_micro: 149383510, savings_micro: 145205581 }
      },
      {
        group: "glm-5.3-flash",
        measures: { buyer_cost_micro: 63, direct_cost_micro: 3705, savings_micro: 3642 }
      }
    ]
  }
};

test("surplusModelId extracts the model from Surplus claudish specs only", () => {
  assert.equal(surplusModelId("surplus-gpt@gpt-6-astra"), "gpt-6-astra");
  assert.equal(surplusModelId("surplus@glm-5.3"), "glm-5.3");
  assert.equal(surplusModelId("surplus@glm-5.3:3"), "glm-5.3");
  assert.equal(surplusModelId("openrouter@vendor/model"), null);
  assert.equal(surplusModelId(undefined), null);
});

test("fetchSurplusOverview authenticates with the key and maps per-model measures", async () => {
  const http = fakeFetch(200, SURPLUS_BODY);
  const result = await fetchSurplusOverview({ apiKey: "inf_test", range: "30d", fetcher: http.fetcher });

  assert.equal(http.calls[0].url, "https://api.surplusintelligence.ai/v1/buyer/overview?range=30d");
  assert.equal(http.calls[0].options.headers.authorization, "Bearer inf_test");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.models["glm-5.3"], {
    spent: 4177929,
    direct: 149383510,
    saved: 145205581
  });

  const rejected = await fetchSurplusOverview({ apiKey: "k", range: "7d", fetcher: fakeFetch(401).fetcher });
  const limited = await fetchSurplusOverview({ apiKey: "k", range: "7d", fetcher: fakeFetch(429).fetcher });
  const noCoverage = await fetchSurplusOverview({
    apiKey: "k",
    range: "7d",
    fetcher: fakeFetch(200, { coverage: false }).fetcher
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(limited.status, "limited");
  assert.equal(noCoverage.status, "unavailable");
});

test("getSurplusUsage caches for five minutes and backs off after a 429", async () => {
  const configDir = await tempConfigDir();
  const http = fakeFetch(200, SURPLUS_BODY);
  const base = { configDir, apiKey: "k", range: "30d", now: NOW, env: {}, fetcher: http.fetcher };

  assert.equal((await getSurplusUsage(base)).status, "ok");
  await getSurplusUsage({ ...base, now: NOW + 4 * 60_000 });
  assert.equal(http.calls.length, 1);
  await getSurplusUsage({ ...base, now: NOW + 6 * 60_000 });
  assert.equal(http.calls.length, 2);
  assert.equal((await stat(join(configDir, "claude", "usage", "surplus-30d.json"))).mode & 0o777, 0o600);

  const limited = fakeFetch(429);
  const later = { ...base, now: NOW + 20 * 60_000, fetcher: limited.fetcher };
  const first = await getSurplusUsage(later);
  assert.equal(first.status, "limited");
  assert.ok(first.models["glm-5.3"]);
  await getSurplusUsage({ ...later, now: NOW + 21 * 60_000 });
  assert.equal(limited.calls.length, 1);
});

test("formatSurplusUsage shows spend, savings and the saved percentage", () => {
  const usage = {
    status: "ok",
    fetchedAt: NOW,
    models: {
      "gpt-6-astra": { spent: 2977178, direct: 298525110, saved: 295547932 },
      "glm-5.3-flash": { spent: 63, direct: 3705, saved: 3642 }
    }
  };

  assert.equal(
    formatSurplusUsage("gpt-6-astra", usage, "30d", NOW),
    "30d $2.98 spent · $295.55 saved (99%)"
  );
  assert.equal(
    formatSurplusUsage("glm-5.3-flash", usage, "30d", NOW),
    "30d <$0.01 spent · <$0.01 saved (98%)"
  );
  assert.equal(formatSurplusUsage("kimi-k3", usage, "30d", NOW), "30d no usage listed");

  const stale = { ...usage, status: "limited", fetchedAt: NOW - 2 * HOUR };
  assert.equal(
    formatSurplusUsage("gpt-6-astra", stale, "30d", NOW),
    "30d $2.98 spent · $295.55 saved (99%) (rate limited, as of 2h ago)"
  );
  assert.equal(formatSurplusUsage("gpt-6-astra", { status: "rejected" }, "30d", NOW), "(key rejected)");
  assert.equal(formatSurplusUsage("gpt-6-astra", { status: "unavailable" }, "30d", NOW), "");
});

test("claudeUsageLabels labels Surplus claudish profiles from one overview request", async () => {
  const configDir = await tempConfigDir();
  const http = fakeFetch(200, SURPLUS_BODY);
  const profiles = [
    { name: "astra", kind: "claudish", model: "surplus-gpt@gpt-6-astra", label: "Astra" },
    { name: "glm", kind: "claudish", model: "surplus@glm-5.3", label: "GLM" },
    { name: "other", kind: "claudish", model: "openrouter@x/y", label: "Other" }
  ];

  const labels = await claudeUsageLabels({
    profiles,
    configDir,
    env: { SURPLUS_API_KEY: "inf_test" },
    now: NOW,
    fetcher: http.fetcher
  });

  assert.equal(http.calls.length, 1);
  assert.equal(labels.get("astra"), "30d $2.98 spent · $295.55 saved (99%)");
  assert.equal(labels.get("glm"), "30d $4.18 spent · $145.21 saved (97%)");
  assert.equal(labels.has("other"), false);

  const week = fakeFetch(200, SURPLUS_BODY);
  await claudeUsageLabels({
    profiles,
    configDir: await tempConfigDir(),
    env: { SURPLUS_API_KEY: "inf_test", SHAR_SURPLUS_RANGE: "7d" },
    now: NOW,
    fetcher: week.fetcher
  });
  assert.match(week.calls[0].url, /range=7d$/);

  const noKey = fakeFetch(200, SURPLUS_BODY);
  const none = await claudeUsageLabels({
    profiles,
    configDir: await tempConfigDir(),
    env: {},
    now: NOW,
    fetcher: noKey.fetcher
  });
  assert.equal(none.size, 0);
  assert.equal(noKey.calls.length, 0);
});
