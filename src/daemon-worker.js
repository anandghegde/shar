import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const configDir = process.argv[2];
if (!configDir) {
  console.error("daemon-worker requires a config directory argument");
  process.exit(1);
}

const intervalMs = Number.parseInt(process.env.SHARD_INTERVAL_MS ?? "30000", 10);
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

await log(`daemon started pid=${process.pid} interval=${intervalMs}ms`);

while (true) {
  await log("heartbeat");
  await wait(intervalMs);
}
