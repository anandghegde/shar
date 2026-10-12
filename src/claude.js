import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";

const BUILTIN_PROFILES = Object.freeze([
  Object.freeze({ name: "foundry", kind: "foundry", label: "Foundry" }),
  Object.freeze({ name: "subscription", kind: "subscription", label: "Personal subscription" })
]);

const RESERVED_PROFILE_NAMES = new Set(["setup", "switch", "add", "list", "pick"]);
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

// Account dirs mirror ~/.claude except identity state and dated backups.
const ACCOUNT_LINK_SKIP = /^\.claude\.json|^\.credentials\.json|(^|\.)(backup|bak)([.-]|$)|^_?backups$/;
const ACCOUNT_CANONICAL_FILES = new Set(["settings.json", "CLAUDE.md"]);

const FOUNDRY_SCOPED_ENV = new Set([
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ENABLE_PROMPT_CACHING_1H"
]);

const SUBSCRIPTION_AUTH_OVERRIDES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX"
]);

export function foundrySettingsPath(configDir) {
  return join(configDir, "claude", "foundry.settings.json");
}

export async function setupClaudeProviders({ configDir, settingsPath, now = () => new Date() }) {
  const settings = await readSettings(settingsPath);
  const env = settings.env ?? {};
  if (!isObject(env)) throw new Error(`Claude settings env must be an object: ${settingsPath}`);

  const foundryEnv = {};
  const sharedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (isFoundryEnvKey(key)) foundryEnv[key] = value;
    else sharedEnv[key] = value;
  }

  const overlayPath = foundrySettingsPath(configDir);
  if (Object.keys(foundryEnv).length === 0) {
    if (await exists(overlayPath)) {
      return { created: false, overlayPath, backupPath: null };
    }
    throw new Error(`No Microsoft Foundry settings found in ${settingsPath}`);
  }
  if (!foundryEnv.CLAUDE_CODE_USE_FOUNDRY) {
    throw new Error(`Missing CLAUDE_CODE_USE_FOUNDRY in ${settingsPath}`);
  }

  const blockers = Object.keys(sharedEnv).filter((key) => SUBSCRIPTION_AUTH_OVERRIDES.has(key));
  if (blockers.length > 0) {
    throw new Error(`Subscription auth is overridden in ${settingsPath}: ${blockers.join(", ")}`);
  }

  const backupDir = join(configDir, "backups", "claude-settings");
  const backupName = now().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${backupName}.json`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await writeJson(backupPath, settings);

  await writeJson(overlayPath, { env: foundryEnv });

  const sharedSettings = { ...settings };
  if (Object.keys(sharedEnv).length > 0) sharedSettings.env = sharedEnv;
  else delete sharedSettings.env;
  await writeJson(settingsPath, sharedSettings);

  return { created: true, overlayPath, backupPath };
}

export async function switchClaudeProvider({
  configDir,
  settingsPath,
  provider,
  now = () => new Date()
}) {
  if (provider !== "foundry" && provider !== "subscription") {
    throw new Error(`Unknown Claude provider: ${provider}`);
  }

  const settings = await readSettings(settingsPath);
  const env = settings.env ?? {};
  if (!isObject(env)) throw new Error(`Claude settings env must be an object: ${settingsPath}`);

  const overlayPath = foundrySettingsPath(configDir);
  if (!(await exists(overlayPath))) {
    throw new Error(`Claude Foundry is not configured; run: shar claude setup`);
  }

  const overlay = await readSettings(overlayPath);
  const foundryEnv = overlay.env ?? {};
  if (!isObject(foundryEnv)) throw new Error(`Foundry settings env must be an object: ${overlayPath}`);

  const backupDir = join(configDir, "backups", "claude-settings");
  const backupName = now().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${backupName}.json`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await writeJson(backupPath, settings);

  const updatedSettings = { ...settings };
  const updatedEnv = { ...env };

  if (provider === "foundry") {
    for (const [key, value] of Object.entries(foundryEnv)) {
      updatedEnv[key] = value;
    }
    updatedSettings.env = updatedEnv;
    if (overlay.model) {
      updatedSettings.model = overlay.model;
    }
  } else {
    for (const key of Object.keys(updatedEnv)) {
      if (isFoundryEnvKey(key)) {
        delete updatedEnv[key];
      }
    }
    if (Object.keys(updatedEnv).length > 0) {
      updatedSettings.env = updatedEnv;
    } else {
      delete updatedSettings.env;
    }
  }

  await writeJson(settingsPath, updatedSettings);
  return { provider, backupPath };
}

export async function launchClaude({
  provider,
  args = [],
  configDir,
  settingsPath,
  env = process.env,
  spawnProcess = spawn
}) {
  const command = env.SHAR_REAL_CLAUDE ?? "claude";
  const childEnv = { ...env };
  delete childEnv.SHAR_REAL_CLAUDE;

  let childArgs = args;
  if (provider === "foundry") {
    const overlayPath = foundrySettingsPath(configDir);
    if (!(await exists(overlayPath))) {
      throw new Error("Claude Foundry is not configured; run: shar claude setup");
    }
    for (const key of SUBSCRIPTION_AUTH_OVERRIDES) {
      if (key !== "CLAUDE_CODE_USE_FOUNDRY") delete childEnv[key];
    }
    childArgs = ["--settings", overlayPath, ...args];
  } else if (provider === "subscription") {
    await assertSubscriptionSettings(settingsPath);
    for (const key of Object.keys(childEnv)) {
      if (SUBSCRIPTION_AUTH_OVERRIDES.has(key) || isFoundryEnvKey(key)) delete childEnv[key];
    }
  } else {
    throw new Error(`Unknown Claude provider: ${provider}`);
  }

  return runChild(command, childArgs, childEnv, spawnProcess);
}

export function claudeProfilesPath(configDir) {
  return join(configDir, "claude", "profiles.json");
}

export function claudeAccountDir(configDir, name) {
  return join(configDir, "claude", "accounts", name);
}

export function claudeEndpointSettingsPath(configDir, name) {
  return join(configDir, "claude", `${name}.settings.json`);
}

export async function listClaudeProfiles({ configDir }) {
  const registered = await readProfileRegistry(configDir);
  return [
    ...BUILTIN_PROFILES,
    ...Object.entries(registered).map(([name, entry]) => ({ label: name, ...entry, name }))
  ];
}

export async function resolveClaudeProfile({ configDir, name }) {
  const profiles = await listClaudeProfiles({ configDir });
  const profile = profiles.find((candidate) => candidate.name === name);
  if (!profile) throw new Error(`Unknown Claude profile: ${name}; run: shar claude list`);
  return profile;
}

export async function addClaudeProfile({
  configDir,
  settingsPath,
  name,
  kind,
  label,
  model,
  url,
  token
}) {
  if (!name || !PROFILE_NAME.test(name)) throw new Error(`Invalid Claude profile name: ${name}`);
  if (RESERVED_PROFILE_NAMES.has(name) || BUILTIN_PROFILES.some((p) => p.name === name)) {
    throw new Error(`Claude profile name is reserved: ${name}`);
  }
  const registry = await readProfileRegistry(configDir);
  if (registry[name]) throw new Error(`Claude profile already exists: ${name}`);

  const entry = { kind };
  if (label) entry.label = label;

  if (kind === "claudish") {
    if (!model) throw new Error("Claudish profiles require a model");
    entry.model = model;
  } else if (kind === "endpoint") {
    if (!url) throw new Error("Endpoint profiles require a URL");
    if (!token) throw new Error("Endpoint profiles require a token");
    const env = { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token };
    if (model) env.ANTHROPIC_MODEL = model;
    await writeJson(claudeEndpointSettingsPath(configDir, name), { env });
  } else if (kind === "account") {
    await syncAccountLinks({
      sourceDir: dirname(settingsPath),
      targetDir: claudeAccountDir(configDir, name)
    });
  } else {
    throw new Error(`Unknown Claude profile kind: ${kind}`);
  }

  await writeJson(claudeProfilesPath(configDir), { profiles: { ...registry, [name]: entry } });
  return { name, ...entry };
}

export async function launchClaudeProfile({
  profile,
  args = [],
  configDir,
  settingsPath,
  claudeJsonPath,
  warn = () => {},
  env = process.env,
  spawnProcess = spawn
}) {
  if (profile.kind === "foundry" || profile.kind === "subscription") {
    return launchClaude({ provider: profile.kind, args, configDir, settingsPath, env, spawnProcess });
  }

  const childEnv = { ...env };

  if (profile.kind === "claudish") {
    const command = childEnv.SHAR_REAL_CLAUDISH ?? "claudish";
    delete childEnv.SHAR_REAL_CLAUDISH;
    deleteEnvWhere(childEnv, isFoundryEnvKey);
    return runChild(command, ["-m", profile.model, ...args], childEnv, spawnProcess);
  }

  const command = childEnv.SHAR_REAL_CLAUDE ?? "claude";
  delete childEnv.SHAR_REAL_CLAUDE;
  deleteEnvWhere(childEnv, isProviderEnvKey);

  if (profile.kind === "endpoint") {
    const overlayPath = claudeEndpointSettingsPath(configDir, profile.name);
    if (!(await exists(overlayPath))) {
      throw new Error(`Claude endpoint is not configured: ${profile.name}`);
    }
    return runChild(command, ["--settings", overlayPath, ...args], childEnv, spawnProcess);
  }

  if (profile.kind === "account") {
    await assertSubscriptionSettings(settingsPath);
    const accountDir = claudeAccountDir(configDir, profile.name);
    if (!(await exists(accountDir))) {
      throw new Error(`Claude account is not set up: ${profile.name}; run: shar claude add ${profile.name}`);
    }

    const { repaired } = await syncAccountLinks({ sourceDir: dirname(settingsPath), targetDir: accountDir });
    for (const name of repaired) {
      warn(`${name} in ${profile.name} diverged from ~/.claude; kept as ${name}.shar-conflict`);
    }
    childEnv.CLAUDE_CONFIG_DIR = accountDir;

    const mcpConfigPath = await writeMcpConfig({ configDir, name: profile.name, claudeJsonPath });
    try {
      // --mcp-config is variadic; the = form keeps it from swallowing later args.
      const childArgs = mcpConfigPath ? [`--mcp-config=${mcpConfigPath}`, ...args] : args;
      return await runChild(command, childArgs, childEnv, spawnProcess);
    } finally {
      if (mcpConfigPath) await rm(mcpConfigPath, { force: true });
    }
  }

  throw new Error(`Unknown Claude profile kind: ${profile.kind}`);
}

// Symlinks every top-level ~/.claude entry into an account's CLAUDE_CONFIG_DIR so
// it shares skills, hooks, plugins, history and memory; credentials stay isolated.
async function syncAccountLinks({ sourceDir, targetDir }) {
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const repaired = [];

  for (const name of await readdir(sourceDir)) {
    if (ACCOUNT_LINK_SKIP.test(name)) continue;
    const source = join(sourceDir, name);
    const target = join(targetDir, name);

    const current = await lstatOrNull(target);
    if (current?.isSymbolicLink()) {
      if ((await readlink(target)) === source) continue;
      await unlink(target);
    } else if (current) {
      // Claude replaced the link with a real file; keep it for diffing and re-link.
      if (!ACCOUNT_CANONICAL_FILES.has(name)) continue;
      await rename(target, `${target}.shar-conflict`);
      repaired.push(name);
    }
    await symlink(source, target);
  }

  return { repaired };
}

// User-scope MCP servers live in ~/.claude.json, which relocates with
// CLAUDE_CONFIG_DIR, so hand them to the account session explicitly.
async function writeMcpConfig({ configDir, name, claudeJsonPath }) {
  let content;
  try {
    content = await readFile(claudeJsonPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  let servers;
  try {
    servers = JSON.parse(content).mcpServers;
  } catch {
    throw new Error(`Invalid Claude config JSON: ${claudeJsonPath}`);
  }
  if (!isObject(servers) || Object.keys(servers).length === 0) return null;

  const path = join(configDir, "claude", "run", `${name}-${process.pid}.mcp.json`);
  await writeJson(path, { mcpServers: servers });
  return path;
}

async function readProfileRegistry(configDir) {
  const path = claudeProfilesPath(configDir);
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  try {
    const value = JSON.parse(content);
    if (!isObject(value.profiles)) throw new Error("missing profiles");
    return value.profiles;
  } catch {
    throw new Error(`Invalid Claude profiles file: ${path}`);
  }
}

function runChild(command, args, env, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function deleteEnvWhere(env, predicate) {
  for (const key of Object.keys(env)) {
    if (predicate(key)) delete env[key];
  }
}

function isProviderEnvKey(key) {
  return SUBSCRIPTION_AUTH_OVERRIDES.has(key) || isFoundryEnvKey(key);
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertSubscriptionSettings(settingsPath) {
  const settings = await readSettings(settingsPath);
  const env = settings.env ?? {};
  if (!isObject(env)) throw new Error(`Claude settings env must be an object: ${settingsPath}`);

  const blockers = Object.keys(env).filter((key) => SUBSCRIPTION_AUTH_OVERRIDES.has(key));
  if (blockers.length > 0) {
    throw new Error(`Claude settings still override subscription auth; run: shar claude setup`);
  }
}

async function readSettings(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Claude settings not found: ${path}`);
    throw error;
  }

  try {
    const value = JSON.parse(content);
    if (!isObject(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`Invalid Claude settings JSON: ${path}`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

function isFoundryEnvKey(key) {
  return key === "CLAUDE_CODE_USE_FOUNDRY" ||
    key.startsWith("ANTHROPIC_FOUNDRY_") ||
    FOUNDRY_SCOPED_ENV.has(key);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
