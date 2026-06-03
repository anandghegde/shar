# Factory Droid Auth Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify `shar`'s agent configuration and store implementation to support selective file-level backup, checksumming, and restoration for specific agents (like `factory`) that share credential folders.

**Architecture:** Extend the `PHASE1_AGENTS` configuration with a `files` array defining relative files to manage. Update `store.js` functions `checksumPath`, `saveSnapshot`, and `restoreAgentSnapshot` to selectively target only those files when specified.

**Tech Stack:** Node.js, `node:fs/promises`, `node:crypto`

---

### Task 1: Update Agent Configuration in `src/agents.js`

**Files:**
- Modify: `src/agents.js:10`

- [ ] **Step 1: Edit agent configuration**
  Update the `factory` property of `PHASE1_AGENTS` in `src/agents.js` to include the `files` array.
  ```javascript
  factory: Object.freeze({
    credentialPath: join(homedir(), ".factory"),
    files: ["auth.v2.file", "auth.v2.key"]
  }),
  ```

- [ ] **Step 2: Run tests to verify no regressions**
  Run: `npm test`
  Expected: PASS (existing 54 tests)

- [ ] **Step 3: Commit**
  ```bash
  git add src/agents.js
  git commit -m "feat: add selective files property to factory agent config"
  ```

---

### Task 2: Implement Selective File Storage Logic in `src/store.js`

**Files:**
- Modify: `src/store.js`

- [ ] **Step 1: Update checksumPath function signature and implementation**
  Modify `checksumPath` to accept a `files` argument and selectively hash only those files if they exist.
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

- [ ] **Step 2: Update saveSnapshot function**
  Modify `saveSnapshot` to use `files` array from config and only copy specified files if configured.
  ```javascript
    const config = agentRegistry[agent];
    const files = config?.files;

    const checksum = await checksumPath(sourcePath, files);
    const existing = await findSnapshotByChecksum(agent, checksum);
    if (existing) {
      return { created: false, profile: existing.profile, agent, checksum };
    }

    const target = join(paths.profiles, profile, agent);
    await mkdir(join(paths.profiles, profile), { recursive: true, mode: 0o700 });
    await rm(target, { recursive: true, force: true });

    if (files && files.length > 0) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const srcFile = join(sourcePath, file);
        const destFile = join(target, file);
        if (await exists(srcFile)) {
          await cp(srcFile, destFile, { preserveTimestamps: true });
        }
      }
    } else {
      await cp(sourcePath, target, { recursive: true, preserveTimestamps: true });
    }
  ```

- [ ] **Step 3: Update restoreAgentSnapshot function**
  Update `restoreAgentSnapshot` to selectively copy only the configured `files` during both backup and restoration.
  ```javascript
  async function restoreAgentSnapshot({ agent, backupId, destination, source, profile, files }) {
    if (await exists(destination)) {
      const backupPath = join(dirname(source), "..", "..", "backups", backupId, agent);
      await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
      if (files && files.length > 0) {
        await mkdir(backupPath, { recursive: true, mode: 0o700 });
        for (const file of files) {
          const destFile = join(destination, file);
          const backFile = join(backupPath, file);
          if (await exists(destFile)) {
            await cp(destFile, backFile, { preserveTimestamps: true });
          }
        }
      } else {
        await rm(backupPath, { recursive: true, force: true });
        await cp(destination, backupPath, { recursive: true, preserveTimestamps: true });
      }
    }

    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

    if (files && files.length > 0) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const srcFile = join(source, file);
        const destFile = join(destination, file);
        if (await exists(srcFile)) {
          await rm(destFile, { force: true });
          await cp(srcFile, destFile, { preserveTimestamps: true });
        }
      }
    } else {
      await rm(destination, { recursive: true, force: true });
      await cp(source, destination, { recursive: true, preserveTimestamps: true });
    }
  }
  ```

- [ ] **Step 4: Update restoreAgentSnapshot callers**
  Pass `files: agentRegistry[agent]?.files` from `restoreProfile` and `restoreAgent` in `src/store.js`.
  In `restoreProfile`:
  ```javascript
        await restoreAgentSnapshot({
          agent,
          backupId,
          destination,
          profile: name,
          source: join(paths.profiles, name, agent),
          files: agentRegistry[agent]?.files
        });
  ```
  In `restoreAgent`:
  ```javascript
      await restoreAgentSnapshot({
        agent,
        backupId,
        destination,
        source,
        profile,
        files: agentRegistry[agent]?.files
      });
  ```

- [ ] **Step 5: Run tests to verify no regressions**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 6: Commit**
  ```bash
  git add src/store.js
  git commit -m "feat: implement selective file-level backup, hashing, and restore in store.js"
  ```

---

### Task 3: Add Tests for Selective File-Level Operations

**Files:**
- Modify: `tests/store.test.js`

- [ ] **Step 1: Write test case**
  Add a test verifying `saveSnapshot` and `restoreProfile` only touch configured `files` and preserve adjacent files in destination folder.
  ```javascript
  test("file-subset agents (e.g. factory) round-trip save -> show -> switch -> restore", async () => {
    const configDir = await makeTempRoot();
    const sourceDir = join(configDir, "factory-source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "auth.v2.file"), "file-content");
    await writeFile(join(sourceDir, "auth.v2.key"), "key-content");
    await writeFile(join(sourceDir, "unrelated.txt"), "ignored-content");

    const destinationDir = join(configDir, "dest", "factory");
    await mkdir(destinationDir, { recursive: true });
    await writeFile(join(destinationDir, "unrelated.txt"), "original-adjacent-content");

    const store = createStore({
      configDir,
      agents: {
        factory: {
          credentialPath: destinationDir,
          files: ["auth.v2.file", "auth.v2.key"]
        }
      }
    });

    const saveResult = await store.saveSnapshot({
      agent: "factory",
      profile: "work",
      sourcePath: sourceDir
    });
    assert.equal(saveResult.created, true);

    const snapshotFolder = join(configDir, "profiles", "work", "factory");
    assert.equal(await exists(join(snapshotFolder, "auth.v2.file")), true);
    assert.equal(await exists(join(snapshotFolder, "auth.v2.key")), true);
    assert.equal(await exists(join(snapshotFolder, "unrelated.txt")), false);

    await store.restoreProfile("work");

    assert.equal(await readFile(join(destinationDir, "auth.v2.file"), "utf8"), "file-content");
    assert.equal(await readFile(join(destinationDir, "auth.v2.key"), "utf8"), "key-content");
    assert.equal(await readFile(join(destinationDir, "unrelated.txt"), "utf8"), "original-adjacent-content");
  });
  ```

- [ ] **Step 2: Run tests to verify they all pass**
  Run: `npm test`
  Expected: PASS (55 tests passing)

- [ ] **Step 3: Commit**
  ```bash
  git add tests/store.test.js
  git commit -m "test: add test coverage for selective file-based agent backup/restore"
  ```
