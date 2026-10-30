# paseo4herdr

Forked from https://github.com/sdananjay/paseo-herdr

A [Paseo](https://paseo.sh) plugin for chatting with [OMP](https://github.com/can1357/oh-my-pi) agents that run in [Herdr](https://herdr.dev) terminal sessions.

The agent keeps running in its Herdr pane. Paseo shows the same conversation on your desktop or phone, and you can type in Paseo or in the terminal. It adds a **Herdr** screen that lists your live agents, an **OMP (Herdr)** provider for importing and starting agents, and Paseo cards for OMP's tool approvals and questions.

> **Alpha.** Expect rough edges. Please [open an issue](https://github.com/djbclark/paseo4herdr/issues) with the output of `paseo plugin logs herdr-harness` when something breaks.

## How it works

```
Paseo (desktop / phone)
   |  plugin API: provider, Herdr screen, permission cards
Plugin server (herdr-harness, runs in the Paseo daemon)
   |  Herdr socket: agent list, status events, panes, stop key
Herdr  ->  terminal pane running OMP
                |  omp-input-<pid>/sock
          input companion (paseo4herdr-input.ts, loaded by OMP)
```

1. The plugin finds your OMP agents through Herdr's socket and reads each agent's conversation from OMP's own session file, so Paseo and the terminal always show the same history.
2. A prompt typed in Paseo goes to the running OMP process through the input companion, a small OMP extension the install step writes. Prompts typed in the terminal appear in Paseo as they are written to the session file.
3. Herdr's agent status (idle, working, blocked) drives the turn state, and Stop in Paseo sends Escape to the pane.
4. Tool approvals and OMP's questions are read from the companion and shown as Paseo cards. The first answer, in Paseo or in the terminal, wins.

## Quick start

1. Install the plugin (see [Install](#install)).
2. Restart any OMP agents that were already running, so they load the input companion. Agents that started earlier open read-only until then.
3. Open **Herdr** in Paseo's sidebar. Your Herdr workspaces and agents are listed with live status.
4. Tap an agent. The first tap opens a Paseo chat attached to the running agent, with its earlier conversation.
5. Send a message. It reaches the agent in its Herdr pane; the reply appears in Paseo and in the terminal.

To start a new agent instead, enter a folder under **Start a chat** on the Herdr screen, or choose **OMP (Herdr)** as the provider when you create an agent.

## Documentation

| Doc | For |
|---|---|
| [`docs/USAGE.md`](docs/USAGE.md) | Day-to-day use: the Herdr screen, importing and starting agents, approvals, Stop, settings |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Symptoms, causes and fixes; logs; how to verify or remove the install; what to put in a bug report |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Contributors: module map, the three seams, turn lifecycle, companion install, running the tests |
| [`plugin/OVERVIEW.md`](plugin/OVERVIEW.md) | The short description Paseo shows for the plugin, with its current limits |

## Requirements

| | Version |
|---|---|
| Paseo daemon | 0.11.1 or later |
| Herdr | 0.9.3 or later, with `herdr integration install omp` |
| OMP | 18.4.12 (the version tested so far) |
| Node | on the daemon host's `PATH` (runs the install step) |

Run `omp` once before installing, so OMP's agent directory exists.

## Install

1. Turn on **Enable plugins** under **Settings → Plugins** on your Paseo daemon. Plugins run unsandboxed with your user's access, so only install plugins you trust.
2. Install from GitHub:

   ```bash
   paseo plugin install git:djbclark/paseo4herdr:plugin
   ```

   You can also paste `git:djbclark/paseo4herdr:plugin` into **Settings → Plugins → Plugin source**.

3. Restart OMP agents that were already running. The install writes an input companion into OMP's extensions directory, and OMP loads extensions only at startup. Until restarted, those agents are read-only in Paseo. On the **Herdr** screen, **Restart to enable input** restarts an idle agent in place.
4. Open **Herdr** in Paseo's sidebar and tap an agent.

### What the install writes

Paseo runs `node scripts/install-omp-companion.mjs` on install and on every update. It writes `paseo4herdr-input.ts` into `$PI_CODING_AGENT_DIR/extensions`, otherwise `~/.omp/agent/extensions`, and prints the path first. It also removes the pre-rename companion `paseo-herdr-input.ts` from that directory when it is one this project wrote, so OMP does not load two. It fails without writing anything if OMP's agent directory is missing, and it never replaces a file it didn't write. Install logs are in `$PASEO_HOME/daemon.log`.

To remove the companion, run this from a clone of this repository:

```bash
node plugin/scripts/install-omp-companion.mjs --uninstall
```

## Update

```bash
paseo plugin update herdr-harness
```

Updates follow this repository's default branch. After an update, restart your OMP agents so they load the new companion.

## Configure

**Settings → Plugins → herdr-harness** sets which Herdr session to use, shows the effective target, and turns the OMP harness on or off. Without settings, the plugin resolves the Herdr socket in this order, reading the daemon's environment:

1. the **Herdr socket path** setting,
2. `HERDR_SOCKET_PATH`,
3. the **Herdr session** setting,
4. `HERDR_SESSION`,
5. Herdr's default session (`$XDG_CONFIG_HOME/herdr/herdr.sock`, else `~/.config/herdr/herdr.sock`).

A named session lives at `sessions/<name>/herdr.sock` in the same directory. Only a **Herdr session** setting that names a non-default session, with no socket path setting and no `HERDR_SOCKET_PATH`, lets Paseo start that Herdr session when it isn't running; every other target is connect-only. See [`docs/USAGE.md`](docs/USAGE.md#settings).

## Develop

```bash
cd plugin
npm install --legacy-peer-deps
npm run typecheck
npx vitest run test/<file>.test.ts
```

Install a working copy with `paseo plugin install /absolute/path/to/plugin`, then run `npm run install:omp-companion` yourself; directory installs don't run the install step. After changing `harness-extension/omp.ts`, run `npm run sync:companion-hash`.

## Upgrading from paseo-herdr

The project was renamed from `paseo-herdr`. The plugin id (`herdr-harness`), the `OMP (Herdr)` provider and saved chats are unchanged. The input companion was renamed, so:

1. Install from `git:djbclark/paseo4herdr:plugin` (see [Install](#install)). If you originally installed from the `paseo-herdr` repository, install from this source rather than relying on `paseo plugin update` to follow the rename.
2. The install step writes `paseo4herdr-input.ts` and removes the old `paseo-herdr-input.ts` from OMP's extensions directory, but only when the file starts with the old marker line (`// paseo-herdr OMP input companion.`). A file you wrote under that name is left alone, with a message. OMP loads every file in that directory, so a leftover old companion would mean two are active.
3. Restart your OMP agents. OMP loads extensions only at startup.
4. Check the result. From a clone of this repository, `node plugin/scripts/install-omp-companion.mjs --print-path` prints where the companion belongs; confirm `paseo4herdr-input.ts` is there and `paseo-herdr-input.ts` is gone. On the **Herdr** screen, an agent that loaded the new companion has no "Read-only" line. While the old file is still present, the `OMP (Herdr)` provider status reports "OMP input companion is outdated". See [Verify the install](docs/TROUBLESHOOTING.md#verify-the-install).

## License

[MIT](LICENSE)
