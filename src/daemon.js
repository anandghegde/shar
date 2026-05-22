import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PID_FILE = "daemon.pid";

export async function readPidFile(configDir) {
  try {
    const value = (await readFile(join(configDir, PID_FILE), "utf8")).trim();
    const pid = Number.parseInt(value, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export async function getStatus(configDir, { checkAlive = isProcessAlive } = {}) {
  const pid = await readPidFile(configDir);
  if (pid === null) return { state: "stopped", pid: null };
  if (checkAlive(pid)) return { state: "running", pid };

  await rm(join(configDir, PID_FILE), { force: true });
  return { state: "stopped", pid: null, cleared: pid };
}

export async function start(
  configDir,
  { spawnWorker = defaultSpawnWorker, checkAlive = isProcessAlive } = {}
) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const status = await getStatus(configDir, { checkAlive });
  if (status.state === "running") {
    return { started: false, pid: status.pid, alreadyRunning: true };
  }

  const pid = spawnWorker(configDir);
  await writeFile(join(configDir, PID_FILE), `${pid}\n`, { mode: 0o600 });
  return { started: true, pid, alreadyRunning: false };
}

export async function stop(
  configDir,
  { signalProcess = defaultSignalProcess, checkAlive = isProcessAlive } = {}
) {
  const pid = await readPidFile(configDir);
  if (pid === null) return { stopped: false, reason: "not running" };

  const alive = checkAlive(pid);
  if (alive) signalProcess(pid);
  await rm(join(configDir, PID_FILE), { force: true });
  return { stopped: true, pid, alive };
}

function defaultSignalProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function defaultSpawnWorker(configDir) {
  const workerPath = new URL("./daemon-worker.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [workerPath, configDir], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  child.unref();
  return child.pid;
}
