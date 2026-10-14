# paseo-herdr

A [Paseo](https://paseo.sh) plugin for chatting with [OMP](https://github.com/can1357/oh-my-pi) agents that run in [Herdr](https://herdr.dev) terminal sessions.

The agent keeps running in its Herdr pane. Paseo shows the same conversation on your desktop or phone, and you can type in Paseo or in the terminal. It adds a **Herdr** screen that lists your live agents, an **OMP (Herdr)** provider for importing and starting agents, and Paseo cards for OMP's tool approvals and questions.

> **Alpha.** Expect rough edges. Please [open an issue](https://github.com/sdananjay/paseo-herdr/issues) with the output of `paseo plugin logs herdr-harness` when something breaks.

See [`plugin/OVERVIEW.md`](plugin/OVERVIEW.md) for what it does and its current limits.

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
   paseo plugin install git:sdananjay/paseo-herdr:plugin --ref v0.1.0-alpha.1
   ```

   You can also paste `git:sdananjay/paseo-herdr:plugin` into **Settings → Plugins → Plugin source**.

3. Restart OMP agents that were already running. The install writes an input companion into OMP's extensions directory, and OMP loads extensions only at startup. Until restarted, those agents are read-only in Paseo. On the **Herdr** screen, **Restart to enable input** restarts an idle agent in place.
4. Open **Herdr** in Paseo's sidebar and tap an agent.

### What the install writes

Paseo runs `node scripts/install-omp-companion.mjs` on install and on every update. It writes `paseo-herdr-input.ts` into `$PI_CODING_AGENT_DIR/extensions`, otherwise `~/.omp/agent/extensions`, and prints the path first. It fails without writing anything if OMP's agent directory is missing, and it never replaces a file it didn't write. Install logs are in `$PASEO_HOME/daemon.log`.

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

**Settings → Plugins → herdr-harness** sets which Herdr session to use, shows the effective target, and turns the OMP harness on or off. Without settings, the plugin uses `HERDR_SOCKET_PATH`, then `HERDR_SESSION`, then Herdr's default session, read from the daemon's environment.

## Develop

```bash
cd plugin
npm install --legacy-peer-deps
npm run typecheck
npx vitest run test/<file>.test.ts
```

Install a working copy with `paseo plugin install /absolute/path/to/plugin`, then run `npm run install:omp-companion` yourself; directory installs don't run the install step. After changing `harness-extension/omp.ts`, run `npm run sync:companion-hash`.

## License

[MIT](LICENSE)
