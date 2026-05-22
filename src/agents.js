import { join } from "node:path";
import { homedir } from "node:os";

export const PHASE1_AGENTS = Object.freeze({
  claude: Object.freeze({ credentialPath: join(homedir(), ".claude") }),
  codex: Object.freeze({ credentialPath: join(homedir(), ".codex") }),
  gh: Object.freeze({ credentialPath: join(homedir(), ".config", "gh") })
});

export function normalizeAgents(overrides = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(PHASE1_AGENTS)) {
    normalized[name] = { ...value };
  }

  for (const [name, value] of Object.entries(overrides)) {
    const override = typeof value === "string" ? { credentialPath: value } : value;
    normalized[name] = { ...(normalized[name] ?? {}), ...override };
  }

  return normalized;
}
