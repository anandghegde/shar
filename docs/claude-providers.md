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
