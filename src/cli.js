import { join } from "node:path";
import { homedir } from "node:os";

import { createStore } from "./store.js";
import { scanCredentialPaths } from "./watcher.js";
import { getStatus, start as startDaemon, stop as stopDaemon } from "./daemon.js";

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
