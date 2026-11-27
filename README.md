# SSH Cloud Servers

Manage SSH servers from the DSH Desktop right sidebar: custom names, saved key or password credentials, and IPv4 / IPv6 / dual-stack display. After connecting, the card updates in place and an SSH terminal is established, and a task prompt is copied to your clipboard so you can paste it wherever you like. Once connected, open Remote files inside the host card when you need it.

English | [简体中文](./README.zh.md)

仓库：<https://github.com/Laivikto/dsh-ssh-servers>

## Features

- **Native private-key picker** — no more pasting paths by hand. Click **Browse…**, choose a folder, pick the file from the list, and the absolute path is filled in automatically.
- **Live connection health** — checked every 30 seconds; `✓ Connected` / `✗ Unresponsive` shown directly on the server card.
- **Reconnect in the original chat** — return to the previous chat and select **Reconnect in this chat** to restore its SSH tools.
- **Remember dock width** — resize the right sidebar while SSH is visible. The width is restored the next time you open the SSH panel, subject to the host window size.
- **Connection diagnostics** — get specific guidance for authentication, DNS, port, network, and host-key errors.
- **In-place state changes** — after connecting you stay on the panel; the button turns into **Open new chat** so you decide when to move.
- **Prompt auto-copied** — the task prompt lands in your system clipboard on connect, ready to paste into any chat or editor, without occupying the input box.
- **Remote file browser (now inside the host card)** — no second tab to switch to. Open the file browser inside a connected host card. It remembers the last directory for each host and collapses when the connection drops. It uses a separate `ssh` exec channel, so browsing never types into your terminal.
- **One 30-second heartbeat** — host health and the file browser share a single probe; it is skipped while the window is in the background and catches up on return.
- **SFTP upload** — check the destination before sending a file, then upload, rename, or confirm replacement. Files can be up to 32 MB. Check the destination file and compare its size after an interrupted upload.
- **Health snapshots** — capture root filesystem usage, memory, load, and optional systemd services for a connected Linux host. Compare or copy the last two captures.
- **IPv4 / IPv6 / dual-stack display** — addresses resolved and shown once saved, masked by default behind an eye toggle.
- **Host-key policies** — trust-on-first-use (TOFU) or strict verification against `known_hosts`.
- **Bilingual UI and errors** — the panel follows the interface language, and backend error messages (auth failures, unreadable directories, oversized files, …) are returned in the same language.

## Installation

Distributed via npm. Two ways to install — pick either one.

### Option 1: DSH Desktop (GUI)

1. Open DSH Desktop
2. Open **Settings → Plugins**
3. Click **Add plugin**
4. Enter the package name `@laivikto/dsh-ssh-servers`
5. Confirm, then restart DSH
6. An **SSH Cloud Servers** tab appears in the right sidebar

### Option 2: Command line (copy & paste)

```bash
dsh plugin add @laivikto/dsh-ssh-servers
```

With a specific profile:

```bash
dsh --profile desktop plugin add @laivikto/dsh-ssh-servers
```

Restart DSH after it finishes. Upgrade later with:

```bash
dsh plugin update
```

> The plugin manager writes the profile dependency and the `dsh.profile.bundles` entry for you — do not run `pnpm` or edit `cordis.patch.yml` by hand.

### Uninstall

Disable or remove the plugin under **Settings → Plugins**.

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
- The key-file listing endpoint returns only name, path, size, and a "looks like a key" flag — **never file contents**. The remote file endpoints (`fs-list` / `fs-preview` / `fs-download`) do return remote content to the local panel, but only for an absolute path on a host whose saved credential you already own; they are reachable only from the trusted DSH page (loopback plus Origin / `Sec-Fetch-Site` checks) and never hand content to the model. All paths reject newline and null-byte injection and are single-quote escaped before reaching the remote shell.
- The remote file channel honours your host-key policy: **strict** mode passes `StrictHostKeyChecking=yes`, so an unknown host key fails instead of being silently accepted.
- The file channel spawns a resolved absolute `ssh` binary with `shell: false`; on Windows the terminal also launches `ssh.exe` by absolute path (cmd searches the current directory first), so a planted `ssh.exe` in the current directory cannot hijack it.
- Changing a host's connection target (address, port, username, auth mode) or deleting the host immediately invalidates its existing SSH connection, so commands can never keep going to the old server while the card shows the new address.
- Every remote command executed through the plugin requires confirmation in the UI. Each confirmation authorizes exactly one command.
- **The plugin cannot restrict other local tools in the chat.** If the chat also has local execution tools, the model may still attempt local commands. On connect, the plugin tries to install a tool guard allowing only `ssh_terminal_read`, `ssh_terminal_run`, web lookup, `skill`, and user confirmation; if the host version lacks support, only the prompt constrains the model. Key-file read permissions remain governed by your DSH permission mode and OS user.
- Trust-on-first-use cannot verify a server before the first connection; strict mode requires a correct `known_hosts` entry or the connection fails.
- The local DSH credential store file is readable by the current OS user. The plugin does not expose its path to the model, but local tools running as the same user could read it; this is not OS-keychain-grade isolation.
- Remote command output enters the chat context and may contain server details. Avoid running commands that print secrets on servers you do not trust.

## What it is not

- Not a standalone vulnerability scanner: no built-in CVE database, no automatic detection or remediation.
- Does not run checks in the background. Connecting only starts an SSH login; no remote inspection commands are executed.
- Does not generate SSH keys, do port forwarding, or do bastion/jump-host chaining.

## Requirements and limitations

- Windows requires the system OpenSSH client (`ssh.exe`).
- The native folder picker is available only in DSH Desktop (Windows / macOS); in a plain browser, **Browse…** tells you to enter the path manually.
- One chat tracks one SSH connection opened by this plugin; when the same host reconnects successfully, the older connection is replaced (SSH tools in the old chat stop working).
- File browsing uses a separate background ssh channel and supports **key-authenticated** Linux / Unix hosts only; passphrase-protected keys must be added to ssh-agent first (on Windows, enable the "OpenSSH Authentication Agent" service). For password hosts, view files in the terminal.
- Upload uses the same key authentication, and needs an OpenSSH `sftp` client, a remote SFTP subsystem, and write permissions. No-overwrite uploads require hard-link support on the destination filesystem. Snapshots use Linux `/proc` and systemd for service states.
- Typing in the terminal hands it to you and the plugin can no longer write to it; click **Connect** in the panel again to let the AI continue.
- The ssh options used for the terminal connection require an OpenSSH client 7.6 or later (the 8.1 bundled with Windows 10 qualifies).
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
