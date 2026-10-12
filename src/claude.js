import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, childArgs, { env: childEnv, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
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
