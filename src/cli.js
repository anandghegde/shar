import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { createStore } from "./store.js";
import { scanCredentialPaths } from "./watcher.js";
import { getStatus, start as startDaemon, stop as stopDaemon } from "./daemon.js";
import { pollAllProfiles } from "./quota.js";
import { installWrappers, pathExport } from "./wrapper.js";
import { pickOption } from "./picker.js";
import { claudeUsageLabels } from "./usage.js";
import {
  addClaudeProfile,
  launchClaudeProfile,
  listClaudeProfiles,
  resolveClaudeProfile,
  setupClaudeProviders,
  switchClaudeProvider
} from "./claude.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "shar");

export async function run(args, io = process) {
  const command = args[0] ?? (isInteractive(io) ? "pick" : "help");
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
    case "set-key":
      return setKeyCommand(store, args.slice(1), io);
    case "wrap":
      return wrapCommand(store, io);
    case "claude":
      return claudeCommand(store, args.slice(1), io);
    case "pick":
      return pickCommand(store, io);
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
  if (!result.profile) {
    throw new Error(`No credential files found for ${agent} at ${sourcePath}`);
  }
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
  const [profileName, maybeProvider] = args;
  if (!profileName) throw new Error("Usage: shar switch <profile>");

  if (profileName === "claude" && maybeProvider) {
    if (maybeProvider !== "subscription" && maybeProvider !== "foundry") {
      throw new Error("Usage: shar switch claude <subscription|foundry>");
    }
    const settingsPath = process.env.SHAR_CLAUDE_SETTINGS ??
      join(homedir(), ".claude", "settings.json");
    await switchClaudeProvider({
      configDir: store.paths.root,
      settingsPath,
      provider: maybeProvider
    });
    await store.setActive("claude", maybeProvider);
    io.stdout.write(`switched claude to ${maybeProvider}\n`);
    return;
  }

  if (profileName === "foundry" || profileName === "subscription") {
    const profiles = await store.listProfiles();
    const hasProfile = profiles.some((p) => p.name === profileName);
    if (!hasProfile) {
      const settingsPath = process.env.SHAR_CLAUDE_SETTINGS ??
        join(homedir(), ".claude", "settings.json");
      await switchClaudeProvider({
        configDir: store.paths.root,
        settingsPath,
        provider: profileName
      });
      await store.setActive("claude", profileName);
      io.stdout.write(`switched claude to ${profileName}\n`);
      return;
    }
  }

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

async function setKeyCommand(store, args, io) {
  const [agent, profile] = args;
  if (!agent || !profile) throw new Error("Usage: shar set-key <agent> <profile>");

  const config = store.agents[agent];
  if (!config) throw new Error(`Unknown agent: ${agent}`);

  const keyFile = config.wrapper?.keyFile ?? "api-key";
  if (!config.files?.includes(keyFile)) {
    throw new Error(`Agent ${agent} does not support API key files`);
  }
  if (!config.credentialPath) throw new Error(`No credential path configured for agent: ${agent}`);

  const key = (await readStdin(io)).trim();
  if (!key) throw new Error("Missing API key on stdin");

  await mkdir(config.credentialPath, { recursive: true, mode: 0o700 });
  await writeFile(join(config.credentialPath, keyFile), `${key}\n`, { mode: 0o600 });

  const result = await store.saveSnapshot({
    agent,
    profile,
    sourcePath: config.credentialPath
  });
  if (!result.profile) throw new Error(`Failed to save ${agent} API key profile`);
  await store.setActive(agent, result.profile);

  const wrap = await installWrappers({ configDir: store.paths.root, agents: store.agents });
  const action = result.created ? "saved" : "deduplicated";
  io.stdout.write(`${action} ${result.profile} ${agent} api-key\n`);
  io.stdout.write(`PATH: ${pathExport(wrap.binDir)}\n`);
}

async function wrapCommand(store, io) {
  const result = await installWrappers({ configDir: store.paths.root, agents: store.agents });
  if (result.installed.length === 0) {
    io.stdout.write("no wrappers to install\n");
    return;
  }
  for (const item of result.installed) {
    io.stdout.write(`installed ${item.command}\t${item.path}\n`);
  }
  io.stdout.write(`PATH: ${pathExport(result.binDir)}\n`);
}

async function claudeCommand(store, args, io) {
  const [subcommand, ...claudeArgs] = args;
  const settingsPath = process.env.SHAR_CLAUDE_SETTINGS ??
    join(homedir(), ".claude", "settings.json");

  if (subcommand === "setup") {
    if (claudeArgs.length > 0) throw new Error("Usage: shar claude setup");
    const result = await setupClaudeProviders({
      configDir: store.paths.root,
      settingsPath
    });
    if (!result.created) {
      io.stdout.write(`Claude providers already configured at ${result.overlayPath}\n`);
      return;
    }
    io.stdout.write(`Configured Claude subscription and Foundry providers.\n`);
    io.stdout.write(`Foundry settings: ${result.overlayPath}\n`);
    io.stdout.write(`Backup: ${result.backupPath}\n`);
    return;
  }

  if (subcommand === "switch") {
    const [provider] = claudeArgs;
    if (!provider || (provider !== "subscription" && provider !== "foundry")) {
      throw new Error("Usage: shar claude switch <subscription|foundry>");
    }
    const result = await switchClaudeProvider({
      configDir: store.paths.root,
      settingsPath,
      provider
    });
    await store.setActive("claude", provider);
    io.stdout.write(`switched claude to ${provider}\n`);
    return;
  }

  if (subcommand === "add") {
    return addClaudeProfileCommand(store, claudeArgs, settingsPath, io);
  }

  if (subcommand === "list") {
    const profiles = await listClaudeProfiles({ configDir: store.paths.root });
    for (const profile of profiles) {
      io.stdout.write(`${profile.name}\t${profile.kind}\t${profile.label}\n`);
    }
    return;
  }

  if (!subcommand) {
    throw new Error("Usage: shar claude <setup|switch|add|list|profile> [claude-args...]");
  }

  const profile = await resolveClaudeProfile({ configDir: store.paths.root, name: subcommand });
  await launchProfile(store, profile, claudeArgs, settingsPath, io);
}

async function addClaudeProfileCommand(store, args, settingsPath, io) {
  const usage = [
    "Usage: shar claude add <name> [--label <text>]",
    "       shar claude add <name> --claudish <model> [--label <text>]",
    "       printf '%s' '<token>' | shar claude add <name> --url <url> [--model <model>] [--label <text>]"
  ].join("\n");

  const [name, ...rest] = args;
  if (!name || rest.length % 2 !== 0) throw new Error(usage);

  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!["--label", "--claudish", "--url", "--model"].includes(flag)) throw new Error(usage);
    flags[flag.slice(2)] = rest[index + 1];
  }
  if (flags.claudish && (flags.url || flags.model)) throw new Error(usage);
  if (flags.model && !flags.url) throw new Error(usage);

  const configDir = store.paths.root;
  const label = flags.label;

  if (flags.claudish) {
    await addClaudeProfile({ configDir, name, kind: "claudish", model: flags.claudish, label });
    io.stdout.write(`added ${name} (claudish ${flags.claudish})\n`);
  } else if (flags.url) {
    const token = (await readStdin(io, usage)).trim();
    await addClaudeProfile({
      configDir,
      name,
      kind: "endpoint",
      url: flags.url,
      model: flags.model,
      token,
      label
    });
    io.stdout.write(`added ${name} (endpoint ${flags.url})\n`);
  } else {
    await addClaudeProfile({ configDir, settingsPath, name, kind: "account", label });
    io.stdout.write(`added ${name} (account); run: shar claude ${name}, then /login\n`);
  }
}

async function pickCommand(store, io) {
  const profiles = await listClaudeProfiles({ configDir: store.paths.root });
  const usage = await claudeUsageLabels({ profiles, configDir: store.paths.root });
  const profile = await pickOption({
    title: "Launch Claude Code with:",
    options: profiles.map((candidate) => ({
      name: candidate.name,
      label: [candidate.label, usage.get(candidate.name)].filter(Boolean).join("  "),
      value: candidate
    })),
    input: io.stdin,
    output: io.stdout
  });
  if (!profile) return;

  await launchProfile(store, profile, [], claudeSettingsPath(), io);
}

async function launchProfile(store, profile, claudeArgs, settingsPath, io) {
  const result = await launchClaudeProfile({
    profile,
    args: claudeArgs,
    configDir: store.paths.root,
    settingsPath,
    claudeJsonPath: process.env.SHAR_CLAUDE_JSON ?? join(homedir(), ".claude.json"),
    warn: (message) => io.stderr.write(`shar: ${message}\n`)
  });
  if (result.signal) throw new Error(`Claude exited from signal ${result.signal}`);
  if (result.code !== 0) io.exitCode = result.code ?? 1;
}

function claudeSettingsPath() {
  return process.env.SHAR_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

function isInteractive(io) {
  return Boolean(io.stdin?.isTTY && io.stdout?.isTTY);
}

async function readStdin(io, usage = "Usage: printf '%s' '<key>' | shar set-key <agent> <profile>") {
  const stdin = io.stdin;
  if (!stdin) throw new Error("Missing stdin");
  if (stdin.isTTY) {
    throw new Error(usage);
  }

  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  set-key <agent> <profile>
  wrap
  claude <setup|switch|add|list|profile> [claude-args...]
  pick              (default in a terminal) choose a Claude profile to launch
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
