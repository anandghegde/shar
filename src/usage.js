import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { claudeAccountDir } from "./claude.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 3 * 60 * 1000;
const BACKOFF_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;
const OVERALL_TIMEOUT_MS = 5000;

const SURPLUS_OVERVIEW_URL = "https://api.surplusintelligence.ai/v1/buyer/overview";
const SURPLUS_CACHE_TTL_MS = 5 * 60 * 1000;
// /buyer/overview only breaks usage down by model for these ranges.
const SURPLUS_RANGES = new Set(["7d", "30d"]);

// Claude Code keys its Keychain entry to CLAUDE_CONFIG_DIR when that variable is set.
export function claudeKeychainService(claudeConfigDir) {
  if (!claudeConfigDir) return "Claude Code-credentials";
  const hash = createHash("sha256").update(claudeConfigDir.normalize("NFC")).digest("hex");
  return `Claude Code-credentials-${hash.slice(0, 8)}`;
}

export async function readOAuthCredential({
  service,
  securityBin = "security",
  exec = runExec
}) {
  let stdout;
  try {
    stdout = await exec(securityBin, ["find-generic-password", "-s", service, "-w"], {
      timeout: REQUEST_TIMEOUT_MS
    });
  } catch {
    return null;
  }

  try {
    const oauth = JSON.parse(stdout).claudeAiOauth;
    if (typeof oauth?.accessToken !== "string") return null;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch {
    return null;
  }
}

export async function fetchOAuthUsage({
  accessToken,
  version,
  url = USAGE_URL,
  fetcher = fetch
}) {
  const response = await fetcher(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": `claude-code/${version}`,
      accept: "application/json"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (response.status === 401 || response.status === 403) return { status: "expired" };
  if (response.status === 429) return { status: "limited" };
  if (!response.ok) return { status: "unavailable" };

  const body = await response.json();
  return {
    status: "ok",
    fiveHour: usageWindow(body.five_hour),
    sevenDay: usageWindow(body.seven_day)
  };
}

// Never throws: failures degrade to the last cached numbers plus a status.
export async function getClaudeUsage({
  configDir,
  name,
  claudeConfigDir,
  now = Date.now(),
  env = process.env,
  exec = runExec,
  fetcher = fetch
}) {
  const cachePath = join(configDir, "claude", "usage", `${name}.json`);
  const cache = await readCache(cachePath);
  const last = cache
    ? { fiveHour: cache.fiveHour, sevenDay: cache.sevenDay, fetchedAt: cache.fetchedAt }
    : {};

  if (cache?.fetchedAt && now - cache.fetchedAt < CACHE_TTL_MS) return { status: "ok", ...last };
  if (cache?.backoffUntil > now) return { status: "limited", ...last };

  const credential = await readOAuthCredential({
    service: claudeKeychainService(claudeConfigDir),
    securityBin: env.SHAR_SECURITY_BIN,
    exec
  });
  if (!credential) return { status: "login", ...last };
  if (credential.expiresAt && credential.expiresAt <= now) return { status: "expired", ...last };

  let result;
  try {
    result = await fetchOAuthUsage({
      accessToken: credential.accessToken,
      version: await claudeVersion({ env, exec }),
      url: env.SHAR_CLAUDE_USAGE_URL,
      fetcher
    });
  } catch {
    result = { status: "unavailable" };
  }

  if (result.status === "ok") {
    const fresh = { fiveHour: result.fiveHour, sevenDay: result.sevenDay, fetchedAt: now };
    await writeCache(cachePath, fresh);
    return { status: "ok", ...fresh };
  }
  if (result.status === "limited") {
    await writeCache(cachePath, { ...last, backoffUntil: now + BACKOFF_MS });
  }
  return { status: result.status, ...last };
}

// "surplus-gpt@gpt-6-astra" -> "gpt-6-astra"; null for non-Surplus specs.
export function surplusModelId(spec) {
  const match = /^surplus[\w-]*@([^:]+)/.exec(spec ?? "");
  return match ? match[1] : null;
}

export async function fetchSurplusOverview({
  apiKey,
  range,
  url = SURPLUS_OVERVIEW_URL,
  fetcher = fetch
}) {
  const response = await fetcher(`${url}?range=${range}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (response.status === 401 || response.status === 403) return { status: "rejected" };
  if (response.status === 429) return { status: "limited" };
  if (!response.ok) return { status: "unavailable" };

  const body = await response.json();
  if (body.coverage === false) return { status: "unavailable" };

  const models = {};
  for (const entry of body.by_model?.top ?? []) {
    const measures = entry.measures ?? {};
    models[entry.group] = {
      spent: measures.buyer_cost_micro,
      direct: measures.direct_cost_micro,
      saved: measures.savings_micro
    };
  }
  return { status: "ok", models };
}

// Never throws; same cache, backoff and last-known fallback as getClaudeUsage.
export async function getSurplusUsage({
  configDir,
  apiKey,
  range,
  now = Date.now(),
  env = process.env,
  fetcher = fetch
}) {
  const cachePath = join(configDir, "claude", "usage", `surplus-${range}.json`);
  const cache = await readCache(cachePath);
  const last = cache ? { models: cache.models, fetchedAt: cache.fetchedAt } : {};

  if (cache?.fetchedAt && now - cache.fetchedAt < SURPLUS_CACHE_TTL_MS) return { status: "ok", ...last };
  if (cache?.backoffUntil > now) return { status: "limited", ...last };

  let result;
  try {
    result = await fetchSurplusOverview({
      apiKey,
      range,
      url: env.SHAR_SURPLUS_USAGE_URL,
      fetcher
    });
  } catch {
    result = { status: "unavailable" };
  }

  if (result.status === "ok") {
    await writeCache(cachePath, { models: result.models, fetchedAt: now });
    return { status: "ok", models: result.models, fetchedAt: now };
  }
  if (result.status === "limited") {
    await writeCache(cachePath, { ...last, backoffUntil: now + BACKOFF_MS });
  }
  return { status: result.status, ...last };
}

export function formatSurplusUsage(modelId, usage, range, now = Date.now()) {
  const notes = [];
  if (usage.status === "rejected") notes.push("key rejected");
  if (usage.status === "limited") notes.push("rate limited");

  let text = "";
  const entry = usage.models?.[modelId];
  if (entry) {
    const percent = entry.direct > 0 ? ` (${Math.round((entry.saved / entry.direct) * 100)}%)` : "";
    text = `${range} ${formatDollars(entry.spent)} spent · ${formatDollars(entry.saved)} saved${percent}`;
    if (usage.status !== "ok") notes.push(`as of ${formatDuration(now - usage.fetchedAt)} ago`);
  } else if (usage.status === "ok") {
    text = `${range} no usage listed`;
  }

  const note = notes.length > 0 ? `(${notes.join(", ")})` : "";
  return [text, note].filter(Boolean).join(" ");
}

export function formatClaudeUsage(usage, now = Date.now()) {
  const parts = [];
  for (const [label, window] of [["5h", usage.fiveHour], ["7d", usage.sevenDay]]) {
    if (!window) continue;
    const reset = window.resetsAt != null && window.resetsAt <= now;
    const left = reset ? 100 : Math.max(0, Math.round(100 - window.used));
    const until = !reset && window.resetsAt ? ` ↻${formatDuration(window.resetsAt - now)}` : "";
    parts.push(`${label} ${left}% left${until}`);
  }

  const notes = [];
  if (usage.status === "expired") notes.push("login expired");
  if (usage.status === "login") notes.push("not logged in");
  if (usage.status === "limited") notes.push("rate limited");
  if (parts.length > 0 && usage.status !== "ok") notes.push(`as of ${formatDuration(now - usage.fetchedAt)} ago`);

  const note = notes.length > 0 ? `(${notes.join(", ")})` : "";
  return [parts.join(" · "), note].filter(Boolean).join(" ");
}

// name -> display text for subscription and Surplus profiles; empty text hides it.
export async function claudeUsageLabels({
  profiles,
  configDir,
  env = process.env,
  now = Date.now(),
  exec,
  fetcher
}) {
  const labels = new Map();
  if (env.SHAR_CLAUDE_USAGE === "0") return labels;

  const lookups = profiles
    .filter((profile) => profile.kind === "subscription" || profile.kind === "account")
    .map(async (profile) => {
      const claudeConfigDir = profile.kind === "account"
        ? claudeAccountDir(configDir, profile.name)
        : env.CLAUDE_CONFIG_DIR;
      try {
        const usage = await getClaudeUsage({
          configDir,
          name: profile.name,
          claudeConfigDir,
          now,
          env,
          exec,
          fetcher
        });
        labels.set(profile.name, formatClaudeUsage(usage, now));
      } catch {
        // Usage is decoration; never block the picker.
      }
    });

  const surplusProfiles = profiles.filter(
    (profile) => profile.kind === "claudish" && surplusModelId(profile.model)
  );
  if (surplusProfiles.length > 0 && env.SURPLUS_API_KEY) {
    const range = SURPLUS_RANGES.has(env.SHAR_SURPLUS_RANGE) ? env.SHAR_SURPLUS_RANGE : "30d";
    lookups.push((async () => {
      try {
        const usage = await getSurplusUsage({
          configDir,
          apiKey: env.SURPLUS_API_KEY,
          range,
          now,
          env,
          fetcher
        });
        for (const profile of surplusProfiles) {
          labels.set(
            profile.name,
            formatSurplusUsage(surplusModelId(profile.model), usage, range, now)
          );
        }
      } catch {
        // Usage is decoration; never block the picker.
      }
    })());
  }

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, OVERALL_TIMEOUT_MS);
  });
  await Promise.race([Promise.all(lookups), deadline]);
  clearTimeout(timer);
  return labels;
}

async function claudeVersion({ env, exec }) {
  const stdout = await exec(env.SHAR_REAL_CLAUDE ?? "claude", ["--version"], {
    timeout: REQUEST_TIMEOUT_MS
  });
  return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? "0.0.0";
}

function formatDollars(micro) {
  if (micro > 0 && micro < 10000) return "<$0.01";
  const dollars = (micro / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `$${dollars}`;
}

function usageWindow(value) {
  if (!value || typeof value.utilization !== "number") return null;
  const resetsAt = Date.parse(value.resets_at);
  return { used: value.utilization, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt };
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d${hours % 24}h`;
}

async function readCache(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

async function writeCache(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function runExec(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
