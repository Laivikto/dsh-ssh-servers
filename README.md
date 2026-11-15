# SSH Cloud Servers

Manage SSH servers from the DSH Desktop right sidebar: custom names, saved key or password credentials, and IPv4 / IPv6 / dual-stack display. After connecting, the card updates in place and an SSH terminal is established, and the read-only review prompt is copied to your clipboard so you can paste it wherever you like.

English | [简体中文](./README.zh.md)

仓库：<https://github.com/Laivikto/dsh-ssh-servers>

## Features

- **Native private-key picker** — no more pasting paths by hand. Click **Browse…**, choose a folder, pick the file from the list, and the absolute path is filled in automatically.
- **Live connection health** — checked every 30 seconds; `✓ Connected` / `✗ Unresponsive` shown directly on the server card.
- **In-place state changes** — after connecting you stay on the panel; the button turns into **Open new chat** so you decide when to move.
- **Prompt auto-copied** — the review prompt lands in your system clipboard on connect, ready to paste into any chat or editor, without occupying the input box.
- **IPv4 / IPv6 / dual-stack display** — addresses resolved and shown once saved.
- **Host-key policies** — trust-on-first-use (TOFU) or strict verification against `known_hosts`.

## Installation

```bash
# Install as a local plugin directory (development)
dsh plugin install link:"E:/dsh file/ssh-servers-plugin"

# Or from npm (once published)
npm install @laivikto/dsh-ssh-servers
```

You can also enable it in the DSH plugin manager UI.

## Usage

1. Open the **SSH Cloud Servers** panel from the SSH icon in the chat toolbar, the right-sidebar tab, or the guide entry.
2. Click **Add server** and fill in name, host, port, username, and auth mode.
   - **Private key**: click **Browse…** to pick a folder, or paste an absolute path. The plugin hands the path to the system OpenSSH; it never copies key contents.
   - **Password**: stored in the local DSH credential store, written only to the terminal on connect, never sent to the model.
3. Choose address display (IPv4 / IPv6 / dual-stack) and host-key policy, then save.
4. Click **Connect**. The card updates in place to `✓ Connected`, the button becomes **Open new chat**, and the review prompt is **copied to your clipboard**.
5. Use **Copy prompt** to copy it again at any time; **Open new chat** only opens the session — paste and send when you are ready.

## Panel states

| State | Meaning | Button |
| --- | --- | --- |
| `Needs setup` | Credentials not saved yet | Connect (disabled) |
| `Credentials ready` | Saved but not connected | Connect |
| `✓ Connected` | SSH link healthy (confirmed by 30s polling) | Open new chat |
| `✗ Unresponsive` | Link dropped or terminal exited | Open new chat |

> Health checks are non-intrusive: they only read terminal process state and on-screen disconnect markers. **No command is ever written into your terminal.**

## Security boundaries

- Passwords and key passphrases live in the local DSH credential store — never in plaintext config, chat history, or tool arguments.
- Credential records are bound to `host + port + username + authMode`. Another local program calling the connect endpoint cannot redirect a stored password to a different **literal** target; DNS changes and first-connection host keys still require your own verification.
- Connections use an empty SSH config (`-F NUL` / `/dev/null`) and disable `ProxyCommand`, `ProxyJump`, `LocalCommand`, and `RemoteCommand`, so `~/.ssh/config` cannot rewrite the real target or run extra commands at connect time.
- Private keys are read only by the local `ssh` process via `-i`. The plugin does not decrypt, copy, or upload them. The key path is passed through a terminal environment variable and does not appear in echoed commands, though OpenSSH debug output or terminal history may still contain it. Key **contents** are never sent to the model.
- The directory-listing endpoint returns only name, path, size, and a "looks like a key" flag — **never file contents**. It requires an absolute path and rejects newline and null-byte injection.
- Every remote command executed through the plugin requires confirmation in the UI. Each confirmation authorizes exactly one command.
- **The plugin cannot restrict other local tools in the chat.** If the chat also has local execution tools, the model may still attempt local commands. On connect, the plugin tries to install a tool guard allowing only `ssh_terminal_read`, `ssh_terminal_run`, web lookup, `skill`, and user confirmation; if the host version lacks support, only the prompt constrains the model. Key-file read permissions remain governed by your DSH permission mode and OS user.
- Trust-on-first-use cannot verify a server before the first connection; strict mode requires a correct `known_hosts` entry or the connection fails.
- The local DSH credential store file is readable by the current OS user. The plugin does not expose its path to the model, but local tools running as the same user could read it; this is not OS-keychain-grade isolation.
- Remote command output enters the chat context and may contain server details. Avoid running commands that print secrets on servers you do not trust.

## What it is not

- Not a standalone vulnerability scanner: no built-in CVE database, no automatic detection or remediation.
- Does not run checks in the background. Connecting only starts an SSH login; no remote inspection commands are executed.
- Does not generate SSH keys, do port forwarding, SFTP, or bastion/jump-host chaining.

## Requirements and limitations

- Windows requires the system OpenSSH client (`ssh.exe`).
- The native folder picker is available only in DSH Desktop (Windows / macOS); in a plain browser, **Browse…** tells you to enter the path manually.
- One chat tracks one SSH connection opened by this plugin; reconnecting replaces the previous agent terminal.
- Interactive second factors (keyboard-interactive / 2FA) must be completed manually in the right-side terminal.
- Strict host-key verification depends on the system `known_hosts`.

## Development

```bash
# Syntax check
npm run check

# Run tests (58 tests; DSH not required — API tests skip automatically)
npm test

# Watch mode
npm run test:watch
```

Test layout:

```
tests/
├── core.test.mjs        host/port/key-path normalization, SSH command construction
├── connection.test.mjs  auth waiting, failure detection, tool guard, command capture
├── features.test.mjs    key detection, hidden-file filtering, sorting, disconnect, state mapping
└── api.test.mjs         end-to-end API (port auto-detected, skipped when unavailable)
```

## License

[MIT](./LICENSE) © 2026 Laivikto
