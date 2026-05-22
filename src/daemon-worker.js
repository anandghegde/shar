import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { createStore } from "./store.js";
import { scanCredentialPaths } from "./watcher.js";
import { pollAllProfiles } from "./quota.js";

const configDir = process.argv[2];
if (!configDir) {
  console.error("daemon-worker requires a config directory argument");
  process.exit(1);
}

const intervalMs = Number.parseInt(process.env.SHARD_INTERVAL_MS ?? "30000", 10);
const quotaIntervalMs = Number.parseInt(process.env.SHARD_QUOTA_INTERVAL_MS ?? "0", 10);
const logPath = join(configDir, "daemon.log");

async function log(message) {
  await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
}

const shutdown = async (signal) => {
  await log(`received ${signal}, exiting`);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const store = createStore({
  configDir,
  agents: parseAgentPathOverrides(process.env.SHAR_AGENT_PATHS)
});

await log(
  `daemon started pid=${process.pid} interval=${intervalMs}ms quotaInterval=${quotaIntervalMs}ms`
);

async function scanLoop() {
  while (true) {
    try {
      const results = await scanCredentialPaths({ store, agents: store.agents });
      for (const { agent, profile, created } of results) {
        if (!profile) continue;
        const action = created ? "saved" : "deduplicated";
        await log(`${action} ${agent} ${profile}`);
      }
    } catch (error) {
      await log(`scan error: ${error.message}`);
    }
    await wait(intervalMs);
  }
}

async function quotaLoop() {
  while (true) {
    try {
      const results = await pollAllProfiles({ store });
      for (const item of results) {
        if (item.ok) await log(`quota refreshed ${item.agent} ${item.profile}`);
        else if (item.ok === false) await log(`quota error ${item.agent} ${item.profile}: ${item.error}`);
      }
    } catch (error) {
      await log(`quota error: ${error.message}`);
    }
    await wait(quotaIntervalMs);
  }
}

const loops = [scanLoop()];
if (quotaIntervalMs > 0) loops.push(quotaLoop());
await Promise.all(loops);

function parseAgentPathOverrides(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
