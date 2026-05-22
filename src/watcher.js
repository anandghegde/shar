import { stat } from "node:fs/promises";

export async function scanCredentialPaths({
  store,
  agents,
  makeProfileName = defaultProfileName
}) {
  const results = [];

  for (const [agent, config] of Object.entries(agents).sort()) {
    const credentialPath = config.credentialPath;
    if (!credentialPath || !(await exists(credentialPath))) {
      results.push({ agent, profile: null, created: false });
      continue;
    }

    const profile = makeProfileName({ agent, credentialPath });
    const result = await store.saveSnapshot({
      agent,
      profile,
      sourcePath: credentialPath
    });
    results.push({
      agent,
      profile: result.profile,
      created: result.created
    });
  }

  return results;
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

function defaultProfileName({ agent }) {
  return `${agent}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
