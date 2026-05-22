import { readFile } from "node:fs/promises";

const SUBSCRIPTION_URL = "https://www.codebuff.com/api/user/subscription";

export async function codebuffPoller({ snapshotPath, fetcher = fetch } = {}) {
  if (!snapshotPath) throw new Error("codebuffPoller requires snapshotPath");

  const creds = JSON.parse(await readFile(snapshotPath, "utf8"));
  const username = creds.default;
  const token = creds?.[".user"]?.[username]?.authToken;
  if (!token) throw new Error("codebuff credentials missing authToken for default user");

  const response = await fetcher(SUBSCRIPTION_URL, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`codebuff subscription request failed: ${response.status}`);
  }

  const body = await response.json();
  const allowedUsage = body.allowedUsage ?? null;
  const used = body.used ?? null;
  const remaining = allowedUsage != null && used != null ? allowedUsage - used : null;

  return {
    allowedUsage,
    used,
    remaining,
    currentPeriodStart: body.currentPeriodStart ?? null,
    lastChecked: new Date().toISOString()
  };
}
