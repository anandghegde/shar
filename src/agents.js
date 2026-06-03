import { join } from "node:path";
import { homedir } from "node:os";

export const PHASE1_AGENTS = Object.freeze({
  claude: Object.freeze({ credentialPath: join(homedir(), ".claude") }),
  codex: Object.freeze({ credentialPath: join(homedir(), ".codex") }),
  gh: Object.freeze({ credentialPath: join(homedir(), ".config", "gh") }),
  opencode: Object.freeze({ credentialPath: join(homedir(), ".config", "opencode") }),
  gemini: Object.freeze({ credentialPath: join(homedir(), ".config", "gcloud") }),
  factory: Object.freeze({
    credentialPath: join(homedir(), ".factory"),
    files: ["auth.v2.file", "auth.v2.key"]
  }),
  codebuff: Object.freeze({
    credentialPath: join(homedir(), ".config", "manicode", "credentials.json")
  })
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
