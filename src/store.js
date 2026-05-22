import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { normalizeAgents } from "./agents.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "shar");

export function createStore({ configDir = DEFAULT_CONFIG_DIR, agents = {} } = {}) {
  const agentRegistry = normalizeAgents(agents);
  const paths = {
    root: configDir,
    profiles: join(configDir, "profiles"),
    active: join(configDir, "active"),
    pins: join(configDir, "pins"),
    usage: join(configDir, "usage"),
    backups: join(configDir, "backups")
  };

  async function ensureLayout() {
    await mkdir(paths.profiles, { recursive: true, mode: 0o700 });
    await mkdir(paths.active, { recursive: true, mode: 0o700 });
    await mkdir(paths.pins, { recursive: true, mode: 0o700 });
    await mkdir(paths.usage, { recursive: true, mode: 0o700 });
  }

  async function listProfiles() {
    await ensureLayout();
    const names = await safeReaddir(paths.profiles);
    const profiles = [];

    for (const name of names.sort()) {
      const profilePath = join(paths.profiles, name);
      if (!(await isDirectory(profilePath))) continue;
      profiles.push({ name, agents: await listProfileAgents(profilePath) });
    }

    return profiles;
  }

  async function saveSnapshot({ agent, profile, sourcePath }) {
    validateName("agent", agent);
    validateName("profile", profile);
    await ensureLayout();

    const checksum = await checksumPath(sourcePath);
    const existing = await findSnapshotByChecksum(agent, checksum);
    if (existing) {
      return { created: false, profile: existing.profile, agent, checksum };
    }

    const target = join(paths.profiles, profile, agent);
    await mkdir(join(paths.profiles, profile), { recursive: true, mode: 0o700 });
    await rm(target, { recursive: true, force: true });
    await cp(sourcePath, target, { recursive: true, preserveTimestamps: true });
    await writeMetadata(profile, agent, { agent, checksum, sourcePath });

    return { created: true, profile, agent, checksum };
  }

  async function showProfile(name) {
    validateName("profile", name);
    await ensureLayout();

    const profilePath = join(paths.profiles, name);
    if (!(await isDirectory(profilePath))) return null;

    const agents = await listProfileAgents(profilePath);
    const snapshots = {};
    for (const agent of agents) {
      snapshots[agent] = await readMetadata(name, agent);
    }

    return { name, agents, snapshots };
  }

  async function forgetProfile(name) {
    validateName("profile", name);
    await ensureLayout();
    await rm(join(paths.profiles, name), { recursive: true, force: true });
    await removeActivePointers(name);
    await removePinPointers(name);
  }

  async function restoreProfile(name, { backupId = makeBackupId() } = {}) {
    validateName("profile", name);
    await ensureLayout();

    const profile = await showProfile(name);
    if (!profile) throw new Error(`Profile not found: ${name}`);

    const restoredAgents = [];
    for (const agent of profile.agents) {
      const destination = agentRegistry[agent]?.credentialPath;
      if (!destination) throw new Error(`No credential path configured for agent: ${agent}`);

      await restoreAgentSnapshot({
        agent,
        backupId,
        destination,
        profile: name,
        source: join(paths.profiles, name, agent)
      });
      await setActive(agent, name);
      restoredAgents.push(agent);
    }

    return { profile: name, restoredAgents, backupId };
  }

  async function setActive(agent, profile) {
    validateName("agent", agent);
    validateName("profile", profile);
    await ensureLayout();
    await writeFile(join(paths.active, agent), `${profile}\n`, { mode: 0o600 });
  }

  async function getActive(agent) {
    validateName("agent", agent);
    await ensureLayout();
    try {
      const value = await readFile(join(paths.active, agent), "utf8");
      return value.trim() || null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function setPin(agent, profile) {
    validateName("agent", agent);
    validateName("profile", profile);
    await ensureLayout();
    const exists = await isDirectory(join(paths.profiles, profile));
    if (!exists) throw new Error(`Profile not found: ${profile}`);
    await writeFile(join(paths.pins, agent), `${profile}\n`, { mode: 0o600 });
  }

  async function getPin(agent) {
    validateName("agent", agent);
    await ensureLayout();
    try {
      const value = await readFile(join(paths.pins, agent), "utf8");
      return value.trim() || null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function unpin(agent) {
    validateName("agent", agent);
    await ensureLayout();
    await rm(join(paths.pins, agent), { force: true });
  }

  async function findSnapshotByChecksum(agent, checksum) {
    const profiles = await listProfiles();
    for (const item of profiles) {
      if (!item.agents.includes(agent)) continue;
      const metadata = await readMetadata(item.name, agent);
      if (metadata.checksum === checksum) {
        return { profile: item.name, metadata };
      }
    }
    return null;
  }

  async function listProfileAgents(profilePath) {
    const entries = await safeReaddir(profilePath);
    const agents = [];
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) continue;
      if (await exists(join(profilePath, entry))) agents.push(entry);
    }
    return agents;
  }

  async function writeMetadata(profile, agent, metadata) {
    const metadataPath = join(paths.profiles, profile, `.${agent}.json`);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600
    });
  }

  async function readMetadata(profile, agent) {
    const metadataPath = join(paths.profiles, profile, `.${agent}.json`);
    return JSON.parse(await readFile(metadataPath, "utf8"));
  }

  async function removeActivePointers(profile) {
    const agents = await safeReaddir(paths.active);
    for (const agent of agents) {
      const active = await getActive(agent);
      if (active === profile) {
        await rm(join(paths.active, agent), { force: true });
      }
    }
  }

  async function removePinPointers(profile) {
    const agents = await safeReaddir(paths.pins);
    for (const agent of agents) {
      const pinned = await getPin(agent);
      if (pinned === profile) {
        await rm(join(paths.pins, agent), { force: true });
      }
    }
  }

  return {
    paths,
    agents: agentRegistry,
    ensureLayout,
    listProfiles,
    saveSnapshot,
    restoreProfile,
    showProfile,
    forgetProfile,
    setActive,
    getActive,
    setPin,
    getPin,
    unpin
  };
}

async function restoreAgentSnapshot({ agent, backupId, destination, source, profile }) {
  if (await exists(destination)) {
    const backupPath = join(dirname(source), "..", "..", "backups", backupId, agent);
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await rm(backupPath, { recursive: true, force: true });
    await cp(destination, backupPath, { recursive: true, preserveTimestamps: true });
  }

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, preserveTimestamps: true });
}

async function checksumPath(path) {
  const hash = createHash("sha256");
  await updateHash(hash, path, "");
  return hash.digest("hex");
}

async function updateHash(hash, path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    hash.update(`link:${label}\0${target}\0`);
    return;
  }
  if (info.isDirectory()) {
    hash.update(`dir:${label}\0`);
    const entries = await readdir(path);
    for (const entry of entries.sort()) {
      await updateHash(hash, join(path, entry), join(label, entry));
    }
    return;
  }

  if (info.isFile()) {
    hash.update(`file:${label}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  }
}

async function safeReaddir(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function validateName(label, value) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value ?? "")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function makeBackupId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
