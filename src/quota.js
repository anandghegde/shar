import { join } from "node:path";

import { codebuffPoller } from "./pollers/codebuff.js";

export const DEFAULT_POLLERS = Object.freeze({
  codebuff: codebuffPoller
});

export async function pollAllProfiles({
  store,
  agents = store.agents,
  pollers = DEFAULT_POLLERS,
  fetcher
} = {}) {
  if (!store) throw new Error("pollAllProfiles requires store");

  const results = [];
  const profiles = await store.listProfiles();

  for (const agent of Object.keys(agents).sort()) {
    const poller = pollers[agent];
    if (!poller) {
      results.push({ agent, supported: false });
      continue;
    }

    const matchingProfiles = profiles.filter((p) => p.agents.includes(agent));
    if (matchingProfiles.length === 0) {
      results.push({ agent, supported: true, profiles: [] });
      continue;
    }

    for (const { name } of matchingProfiles) {
      const snapshotPath = join(store.paths.profiles, name, agent);
      try {
        const data = await poller({ snapshotPath, fetcher });
        await store.writeUsage(agent, name, data);
        results.push({ agent, profile: name, data, ok: true });
      } catch (error) {
        results.push({ agent, profile: name, error: error.message, ok: false });
      }
    }
  }

  return results;
}
