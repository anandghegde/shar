import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { createStore } from "./store.js";
import { scanCredentialPaths } from "./watcher.js";
import { getStatus, start as startDaemon, stop as stopDaemon } from "./daemon.js";
import { pollAllProfiles } from "./quota.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "shar");

export async function run(args, io = process) {
  const command = args[0] ?? "help";
  const store = createStore({
    configDir: process.env.SHAR_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
    agents: parseAgentPathOverrides(process.env.SHAR_AGENT_PATHS)
  });

  switch (command) {
    case "save":
      return saveCommand(store, args.slice(1), io);
    case "list":
      return listCommand(store, io);
    case "show":
      return showCommand(store, args.slice(1), io);
    case "switch":
      return switchCommand(store, args.slice(1), io);
    case "forget":
      return forgetCommand(store, args.slice(1), io);
    case "pin":
      return pinCommand(store, args.slice(1), io);
    case "unpin":
      return unpinCommand(store, args.slice(1), io);
    case "current":
      return currentCommand(store, io);
    case "logs":
      return logsCommand(store, args.slice(1), io);
    case "usage":
      return usageCommand(store, args.slice(1), io);
    case "best":
      return bestCommand(store, args.slice(1), io);
    case "auto-switch":
      return autoSwitchCommand(store, args.slice(1), io);
    case "watch":
      return watchCommand(store, io);
    case "daemon":
      return daemonCommand(store, args.slice(1), io);
    case "help":
    case "--help":
    case "-h":
      io.stdout.write(helpText());
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function saveCommand(store, args, io) {
  const [agent, profile, sourcePath] = args;
  if (!agent || !profile || !sourcePath) {
    throw new Error("Usage: shar save <agent> <profile> <source-path>");
  }

  const result = await store.saveSnapshot({ agent, profile, sourcePath });
  const action = result.created ? "saved" : "deduplicated";
  io.stdout.write(`${action} ${result.profile} ${result.agent} ${result.checksum}\n`);
}

async function listCommand(store, io) {
  const profiles = await store.listProfiles();
  if (profiles.length === 0) {
    io.stdout.write("No profiles saved.\n");
    return;
  }

  for (const profile of profiles) {
    io.stdout.write(`${profile.name}\t${profile.agents.join(",")}\n`);
  }
}

async function showCommand(store, args, io) {
  const [profileName] = args;
  if (!profileName) throw new Error("Usage: shar show <profile>");

  const profile = await store.showProfile(profileName);
  if (!profile) throw new Error(`Profile not found: ${profileName}`);

  io.stdout.write(`${profile.name}\n`);
  for (const agent of profile.agents) {
    const active = (await store.getActive(agent)) === profile.name ? "active" : "inactive";
    io.stdout.write(`${agent}\t${active}\t${profile.snapshots[agent].checksum}\n`);
  }
}

async function switchCommand(store, args, io) {
  const [profileName] = args;
  if (!profileName) throw new Error("Usage: shar switch <profile>");

  const result = await store.restoreProfile(profileName);
  io.stdout.write(`switched ${profileName} for ${result.restoredAgents.join(",")}\n`);
}

async function forgetCommand(store, args, io) {
  const [profileName] = args;
  if (!profileName) throw new Error("Usage: shar forget <profile>");

  await store.forgetProfile(profileName);
  io.stdout.write(`forgot ${profileName}\n`);
}

async function pinCommand(store, args, io) {
  const [agent, profileName] = args;
  if (!agent || !profileName) throw new Error("Usage: shar pin <agent> <profile>");

  await store.setPin(agent, profileName);
  io.stdout.write(`pinned ${agent} ${profileName}\n`);
}

async function unpinCommand(store, args, io) {
  const [agent] = args;
  if (!agent) throw new Error("Usage: shar unpin <agent>");

  await store.unpin(agent);
  io.stdout.write(`unpinned ${agent}\n`);
}

async function currentCommand(store, io) {
  const agents = Object.keys(store.agents).sort();
  for (const agent of agents) {
    const active = (await store.getActive(agent)) ?? "-";
    const pinned = (await store.getPin(agent)) ?? "-";
    io.stdout.write(`${agent}\tactive:${active}\tpinned:${pinned}\n`);
  }
}

async function logsCommand(store, args, io) {
  const limit = Number.parseInt(args[0] ?? "50", 10);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Usage: shar logs [lines]");

  const logPath = join(store.paths.root, "daemon.log");
  let content;
  try {
    content = await readFile(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      io.stdout.write("no daemon logs yet\n");
      return;
    }
    throw error;
  }

  const lines = content.split("\n").filter(Boolean);
  for (const line of lines.slice(-limit)) io.stdout.write(`${line}\n`);
}

async function usageCommand(store, args, io) {
  const [sub] = args;
  if (sub === "refresh") {
    const results = await pollAllProfiles({ store });
    for (const item of results) {
      if (item.supported === false) {
        io.stdout.write(`${item.agent}\tunsupported\n`);
        continue;
      }
      if (item.profiles && item.profiles.length === 0) {
        io.stdout.write(`${item.agent}\tno profiles\n`);
        continue;
      }
      if (item.ok) io.stdout.write(`${item.agent}\t${item.profile}\trefreshed\n`);
      else io.stdout.write(`${item.agent}\t${item.profile}\terror\t${item.error}\n`);
    }
    return;
  }
  if (sub) throw new Error("Usage: shar usage [refresh]");

  const entries = await store.listUsage();
  if (entries.length === 0) {
    io.stdout.write("no usage data yet\n");
    return;
  }
  for (const { agent, profile, data } of entries) {
    const remaining = data?.remaining ?? "-";
    const allowed = data?.allowedUsage ?? "-";
    const checked = data?.lastChecked ?? "-";
    io.stdout.write(`${agent}\t${profile}\tremaining:${remaining}\tallowed:${allowed}\tchecked:${checked}\n`);
  }
}

async function bestCommand(store, args, io) {
  const [agent] = args;
  if (!agent) throw new Error("Usage: shar best <agent>");

  const profile = await store.pickBestProfile(agent);
  if (!profile) throw new Error(`No profile with available quota for ${agent}`);
  io.stdout.write(`${profile}\n`);
}

async function autoSwitchCommand(store, args, io) {
  const [agent] = args;
  if (!agent) throw new Error("Usage: shar auto-switch <agent>");

  const profile = await store.pickBestProfile(agent);
  if (!profile) throw new Error(`No profile with available quota for ${agent}`);
  await store.restoreAgent(agent, profile);
  io.stdout.write(`switched ${agent} to ${profile}\n`);
}

async function watchCommand(store, io) {
  const results = await scanCredentialPaths({ store, agents: store.agents });
  for (const { agent, profile, created } of results) {
    if (!profile) {
      io.stdout.write(`${agent}\tskipped\n`);
      continue;
    }
    const action = created ? "saved" : "deduplicated";
    io.stdout.write(`${agent}\t${action}\t${profile}\n`);
  }
}

async function daemonCommand(store, args, io) {
  const [subcommand] = args;
  switch (subcommand) {
    case "status": {
      const status = await getStatus(store.paths.root);
      if (status.state === "running") io.stdout.write(`running ${status.pid}\n`);
      else io.stdout.write("stopped\n");
      return;
    }
    case "start": {
      const result = await startDaemon(store.paths.root);
      if (result.alreadyRunning) io.stdout.write(`already running ${result.pid}\n`);
      else io.stdout.write(`started ${result.pid}\n`);
      return;
    }
    case "stop": {
      const result = await stopDaemon(store.paths.root);
      if (!result.stopped) io.stdout.write("not running\n");
      else if (result.alive) io.stdout.write(`stopped ${result.pid}\n`);
      else io.stdout.write(`cleared stale pid ${result.pid}\n`);
      return;
    }
    default:
      throw new Error("Usage: shard <start|stop|status>");
  }
}

function helpText() {
  return `Usage: shar <command> [args]

Commands:
  save <agent> <profile> <source-path>
  list
  show <profile>
  switch <profile>
  forget <profile>
  pin <agent> <profile>
  unpin <agent>
  current
  logs [lines]
  usage [refresh]
  best <agent>
  auto-switch <agent>
  watch
  shard <start|stop|status>
`;
}

function parseAgentPathOverrides(value) {
  if (!value) return {};

  try {
    return JSON.parse(value);
  } catch {
    throw new Error("SHAR_AGENT_PATHS must be valid JSON");
  }
}
