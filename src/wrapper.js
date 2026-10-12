import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function wrapperBinDir(configDir) {
  return join(configDir, "bin");
}

export function buildWrapperScript({ command, keyFile, envVar }) {
  const quotedKeyFile = shSingleQuote(keyFile);
  const quotedCommand = shSingleQuote(command);
  const quotedEnvVar = shSingleQuote(envVar);

  return `#!/bin/sh
set -eu

KEY_FILE=${quotedKeyFile}
COMMAND=${quotedCommand}
ENV_VAR=${quotedEnvVar}
WRAPPER_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -f "$KEY_FILE" ]; then
  key=$(tr -d '\\r\\n' < "$KEY_FILE")
  if [ -n "$key" ]; then
    export "$ENV_VAR=$key"
  fi
fi

path_without_wrapper() {
  old_path=$PATH
  new_path=
  old_ifs=$IFS
  IFS=:
  for part in $old_path; do
    if [ "$part" = "$WRAPPER_DIR" ]; then
      continue
    fi
    if [ -n "$new_path" ]; then
      new_path="$new_path:$part"
    else
      new_path=$part
    fi
  done
  IFS=$old_ifs
  printf '%s' "$new_path"
}

if [ -n "\${SHAR_REAL_DROID:-}" ] && [ "$COMMAND" = "droid" ]; then
  REAL=$SHAR_REAL_DROID
elif [ -n "\${SHAR_REAL_BIN:-}" ]; then
  REAL=$SHAR_REAL_BIN
else
  REAL=$(PATH="$(path_without_wrapper)" command -v "$COMMAND" || true)
fi

if [ -z "$REAL" ] || [ "$REAL" = "$WRAPPER_DIR/$COMMAND" ]; then
  echo "shar: $COMMAND binary not found (set SHAR_REAL_DROID or install the real CLI)" >&2
  exit 127
fi

exec "$REAL" "$@"
`;
}

export async function installWrappers({ configDir, agents }) {
  const binDir = wrapperBinDir(configDir);
  await mkdir(binDir, { recursive: true, mode: 0o700 });

  const installed = [];
  for (const [agent, config] of Object.entries(agents).sort()) {
    const wrapper = config?.wrapper;
    if (!wrapper?.command || !wrapper.envVar || !wrapper.keyFile) continue;
    if (!config.credentialPath) continue;

    const path = join(binDir, wrapper.command);
    const script = buildWrapperScript({
      command: wrapper.command,
      keyFile: join(config.credentialPath, wrapper.keyFile),
      envVar: wrapper.envVar
    });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755);
    installed.push({ agent, command: wrapper.command, path });
  }

  return { binDir, installed };
}

export function pathExport(binDir) {
  return `export PATH="${binDir}:$PATH"`;
}

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
