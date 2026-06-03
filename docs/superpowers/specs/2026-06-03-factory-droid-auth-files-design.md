# Design Spec: Selective File-Based Agent Snapshot and Restore

## Context
The `shar` tool supports switching between profiles for various AI agent CLIs. 
One of the supported agents, `factory`, stores its authentication state in `~/.factory/auth.v2.file` and `~/.factory/auth.v2.key`. 
Currently, `shar` treats the entire `~/.factory` folder as the agent's credential path, which means it snapshots the whole directory and wipes it clean before restoring, destroying unrelated configuration data (such as settings, CLI hints, logs, and telemetry).

## Goal
Modify `shar` to support selective, file-level backup, checksumming, and restoration for agents (like `factory`) that store credentials in a shared directory.

## Design

### 1. Agent Configuration
Extend `PHASE1_AGENTS` in `src/agents.js` to support an optional `files` field specifying paths relative to the agent's `credentialPath`:

```javascript
factory: Object.freeze({
  credentialPath: join(homedir(), ".factory"),
  files: ["auth.v2.file", "auth.v2.key"]
})
```

### 2. Checksum Logic (`src/store.js`)
Update `checksumPath` to support selective files:
```javascript
async function checksumPath(path, files) {
  const hash = createHash("sha256");
  if (files && files.length > 0) {
    for (const file of files) {
      const filePath = join(path, file);
      if (await exists(filePath)) {
        await updateHash(hash, filePath, file);
      }
    }
  } else {
    await updateHash(hash, path, "");
  }
  return hash.digest("hex");
}
```

### 3. Save Snapshot Logic (`src/store.js`)
Update `saveSnapshot` to copy only specified files when `files` is configured:
- Create the target folder.
- Loop over `files` and copy each existing file individually.
- Otherwise, fallback to full directory copy.

### 4. Restore Logic (`src/store.js`)
Update `restoreAgentSnapshot` to selectively copy only specified files:
- **Backup**: Copy only the listed `files` from `destination` to `backupPath`, leaving other files untouched.
- **Restore**: Create/verify the destination directory, remove only the listed `files` from `destination`, and copy them over from the profile snapshot.

## Verification Plan
1. Add unit tests in `tests/store.test.js` to:
   - Verify `saveSnapshot` hashes and copies only the configured files.
   - Verify `restoreAgent` restores only the configured files and does not delete adjacent files in the destination directory.
2. Run `npm test` to ensure all tests pass.
3. Import the existing factory credentials and switch profiles to verify correct behavior.
