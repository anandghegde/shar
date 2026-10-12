# Claude Code Providers

Claude Code stores subscription OAuth credentials in the macOS Keychain. Microsoft Foundry is selected separately by environment values in `~/.claude/settings.json`.

Run the one-time migration while the existing settings file contains the working Foundry configuration:

```sh
shar claude setup
```

This command:

- keeps shared Claude preferences in `~/.claude/settings.json`
- moves Foundry-specific values to `~/.config/shar/claude/foundry.settings.json`
- backs up the original settings under `~/.config/shar/backups/claude-settings/`
- writes settings, overlays, and backups with mode `0600`

### Switching Active Provider in settings.json

Switch `~/.claude/settings.json` directly between Foundry and Subscription:

```sh
shar switch claude foundry
shar switch claude subscription
```

*(You can also use `shar claude switch foundry` or `shar switch foundry`).*

When switched:
- `foundry`: Merges Foundry environment variables into `~/.claude/settings.json`, so typing bare `claude` in your terminal runs Microsoft Foundry.
- `subscription`: Strips Foundry environment variables from `~/.claude/settings.json`, so typing bare `claude` uses your macOS Keychain subscription login.
- Every switch automatically creates a backup of `~/.claude/settings.json` under `~/.config/shar/backups/claude-settings/` with mode `0600`.
- The active pointer is tracked in `shar current`.

---

### Per-Command Execution Without Modifying settings.json

Choose the provider when starting Claude Code for an individual session:

```sh
shar claude subscription
shar claude foundry
```

If subscription status reports `loggedIn: false`, complete the browser login once:

```sh
shar claude subscription auth login
```

Arguments after the provider are passed to Claude Code:

```sh
shar claude subscription --continue
shar claude foundry --model opus
```

The Foundry command applies the protected overlay with Claude Code's `--settings` option. The subscription command removes inherited provider and API credential environment variables from the child process so the existing `/login` subscription credential is selected.

---

## Named Profiles and the Launcher

Beyond `foundry` and `subscription`, shar keeps a registry of named Claude profiles in `~/.config/shar/claude/profiles.json`. Add one with `shar claude add`, then launch it by name:

```sh
shar claude add glm --claudish surplus@glm-5.3 --label "Surplus GLM 5.3"
shar claude add sub2                                   # second subscription
printf '%s' "$TOKEN" | shar claude add litellm --url https://llm.example.test --model gpt-x

shar claude list
shar claude glm -p "hello"                             # args pass through
```

Running bare `shar` in a terminal shows a numbered picker of every profile (`foundry`, `subscription`, then your registered ones). Pick by number or name; `q` quits. Outside a terminal, bare `shar` still prints help, and `shar pick` opens the picker explicitly.

Profile kinds:

| Kind | Added with | Launches |
|---|---|---|
| `foundry` / `subscription` | built in | as described above |
| `claudish` | `--claudish <model>` | `claudish -m <model> [args]`. Foundry env is stripped so the claudish proxy is respected; other env (such as provider API keys) is inherited. |
| `account` | no flags | `claude` with `CLAUDE_CONFIG_DIR=~/.config/shar/claude/accounts/<name>` |
| `endpoint` | `--url`, token on stdin | `claude --settings <name>.settings.json` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, optional `ANTHROPIC_MODEL`), mode `0600` |

The names `setup`, `switch`, `add`, `list`, `pick`, `foundry` and `subscription` are reserved.

### Accounts (multiple subscriptions)

Claude Code keys its macOS Keychain entry to `CLAUDE_CONFIG_DIR`, so each account has its own login. The first time, run `shar claude <name>` and `/login`.

An account directory is a symlink farm of `~/.claude`, so skills, hooks, plugins, `CLAUDE.md`, history and memory are shared across accounts. These are not shared:

- `.claude.json`, which holds the account identity and relocates with `CLAUDE_CONFIG_DIR`
- dated backups

Because user-scope MCP servers also live in `.claude.json`, each launch writes them to a temporary `--mcp-config=<file>` (mode `0600`, deleted on exit). MCP OAuth logins and per-project (local-scope) MCP servers are not carried over.

Notes:

- Links are re-synced on every launch, so new `~/.claude` entries appear automatically. If Claude replaces the linked `settings.json` or `CLAUDE.md` with a real file, shar keeps it as `<name>.shar-conflict` and re-links.
- `settings.json` is shared, so an account launch refuses to run while `~/.claude/settings.json` overrides subscription auth (for example after `shar switch claude foundry`). Run `shar switch claude subscription` or `shar claude setup` first.
