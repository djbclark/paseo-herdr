# Troubleshooting paseo4herdr

Each entry gives the message or symptom as the plugin shows it, the cause, and the fix. For how things normally work see [USAGE.md](USAGE.md).

## Quick index

| Symptom | Go to |
|---|---|
| "Read-only: it started before the input companion was installed." | [Agent is read-only](#agent-is-read-only) |
| Provider status mentions the "OMP input companion" | [Companion missing, outdated or foreign](#companion-missing-outdated-or-foreign) |
| "OMP agent directory not found at …; run omp once first" | [OMP agent directory missing](#omp-agent-directory-missing) |
| "Herdr unavailable: …", "Herdr is not running at …", "Herdr not running: …" | [Herdr is unavailable](#herdr-is-unavailable) |
| "Herdr 0.9.3 or newer required", "Herdr at … is version …" | [Herdr version too old](#herdr-version-too-old) |
| `Herdr integration "omp" is not installed` or outdated | [Herdr's OMP integration is missing](#herdrs-omp-integration-is-missing) |
| A chat went read-only with a warning notice | [A chat froze](#a-chat-froze) |
| "Agent is already working", "OMP has a terminal draft …" | [Messages from Paseo are refused](#messages-from-paseo-are-refused) |
| Restart errors | [Restart to enable input fails](#restart-to-enable-input-fails) |
| New agent fails | [New agent fails](#new-agent-fails) |
| "Couldn't open a chat: …" | [Couldn't open a chat](#couldnt-open-a-chat) |
| "This conversation belongs to Herdr session …" | [Chat belongs to another Herdr session](#chat-belongs-to-another-herdr-session) |
| Approval card didn't act, or came back | [Approvals](#approvals) |
| Open in terminal is missing | [Open in terminal is missing](#open-in-terminal-is-missing) |

## Agent is read-only

**Cause.** OMP loads extensions only at startup. An OMP process that started before the input companion was installed (or before it was updated) has no input endpoint, so Paseo can read its conversation but can't send to it. The Herdr screen shows "Read-only: it started before the input companion was installed." and a chat that tries to validate it freezes with **Input companion unavailable**.

**Fix.**

1. Make sure the companion is current ([Verify the install](#verify-the-install)).
2. On the Herdr screen, wait until the agent is idle, then choose **Restart to enable input**. The agent is restarted in the same pane on the same session.
3. Or do it by hand: quit OMP in its pane and run `omp --resume <session>` in the same pane. The message shown in the chat contains the exact command.

Paseo never restarts an agent unless you confirm it.

## Companion missing, outdated or foreign

The `OMP (Herdr)` provider reports one of these. The provider stays available and imported agents are read-only until it is fixed. The Herdr screen shows the same state as a warning at the top (it names the command to run, and appears whenever the companion isn't current and OMP is enabled in settings); the screen never installs anything itself.

| Status text | Meaning | Fix |
|---|---|---|
| "OMP input companion is not installed; imported agents are read-only." | `paseo4herdr-input.ts` isn't in OMP's extensions directory. | Run `paseo plugin update herdr-harness`, or the installer directly ([below](#run-the-installer-by-hand)), then restart OMP agents. |
| "OMP input companion is outdated." | The installed file differs from this plugin's, or an old `paseo-herdr-input.ts` is still present next to a current one (OMP would load both). | Run `paseo plugin update herdr-harness`, or rerun the installer. It updates the file and removes the old companion. |
| "A different file exists at …. To replace it, run `node scripts/install-omp-companion.mjs --force` from the installed plugin directory." | A file named `paseo4herdr-input.ts` exists that this project didn't write (it doesn't start with the marker line). | Inspect it. If it is safe to lose, run the installer with `--force`. |
| "Input companion check failed: …" | The check itself threw, for example an unreadable directory. | Fix the error shown (permissions on OMP's extensions directory). |

### Run the installer by hand

Paseo runs the installer (`node scripts/install-omp-companion.mjs`) on `paseo plugin install` and `paseo plugin update`, so for a Git install the usual repair is:

```bash
paseo plugin update herdr-harness
```

To run it directly, use the installed plugin directory as the working directory; there is no `npm run` script to look for outside a clone. The plugin directory is the DIRECTORY column of `paseo plugin ls` for `herdr-harness`; use that when it is available. For a Git install it is `$PASEO_HOME/plugins/herdr-harness/<id>/checkout/plugin` (`~/.paseo/plugins/herdr-harness/<id>/checkout/plugin` by default); `<id>` is a generated folder name, so `ls -t "${PASEO_HOME:-$HOME/.paseo}/plugins/herdr-harness"` to find it (a reinstall can leave an older `<id>` folder behind: the live one is the newest, first in that listing, and the one `paseo plugin ls` shows), then `cd` into `<id>/checkout/plugin`. An npm install (`npm:` in the SOURCE column) has no `checkout` folder: its directory is `<id>/node_modules/<package name>`, again as `paseo plugin ls` shows it. This is the layout Paseo created when this was written, not a documented contract: if the path isn't there, look for `install-omp-companion.mjs` under `$PASEO_HOME/plugins`. A plugin installed from a directory doesn't run the install step at all, so developers run it from a clone's `plugin/` directory (or `node plugin/scripts/install-omp-companion.mjs` from the repository root):

```bash
node scripts/install-omp-companion.mjs            # install or update
node scripts/install-omp-companion.mjs --force    # replace a file it didn't write
node scripts/install-omp-companion.mjs --uninstall
node scripts/install-omp-companion.mjs --print-path
```

(In a clone, `npm run install:omp-companion` in `plugin/` is the same as the first line.) The installer prints where it writes, and prints one of `installed`, `updated`, `replaced` or `already current`. Output of a Paseo-run install is in `$PASEO_HOME/daemon.log`.

## OMP agent directory missing

> OMP agent directory not found at …; run omp once first

**Cause.** The installer writes into OMP's agent directory and won't create it. That directory is `$PI_CODING_AGENT_DIR` if set (a leading `~` is expanded), otherwise `~/<PI_CONFIG_DIR or .omp>/agent`. Nothing was written.

**Fix.** Run `omp` once so it creates its directory, then install or update again. If your OMP uses a different directory, set `PI_CODING_AGENT_DIR` in the environment the installer runs in, and in the daemon's environment so the plugin looks in the same place.

## Herdr is unavailable

The Herdr screen shows **Herdr unavailable: …**, or a provider reports "Herdr not running: …" or "Herdr unavailable: …". The text names the socket path it tried.

| Message | Cause | Fix |
|---|---|---|
| Herdr is not running at `<socket>` (…). The default Herdr session is never started automatically | Nothing is listening at the default socket. | Start Herdr, or set a **Herdr session** in settings to a named session, which Paseo may start. |
| …HERDR_SOCKET_PATH is set in the daemon environment; Paseo only connects to it | The socket from the environment is dead. | Start the Herdr that owns it, or unset the variable for the daemon. |
| …A socket path is set in settings; Paseo only connects to it | The **Herdr socket path** setting points at a dead socket. | Start that Herdr or clear the setting. |
| …HERDR_SESSION comes from the environment; only a session named in these settings is started automatically | Same, via `HERDR_SESSION`. | Start the session, or name it in the **Herdr session** setting. |
| Could not start Herdr session "…" for … | Auto-start couldn't launch `herdr` (not on the daemon's `PATH`?). | Make `herdr` available to the daemon, or start the session yourself. |
| Started Herdr session "…" but … did not answer in time | The server started but didn't answer within 10 seconds. | Check that session by running `herdr --session <name>` yourself. |
| Herdr at `<socket>` is not usable: … | The socket exists but answered with an error (protocol or permissions). | Read the error text; check the socket's owner and permissions. |

The daemon reads its own environment, not your shell's. Check what the plugin resolved under **Settings → Herdr → Effective target** or the **Connection** card on the Herdr screen; the order of precedence is in [USAGE.md](USAGE.md#how-the-herdr-socket-is-chosen).

Other errors on the same screen:

| Message | Cause |
|---|---|
| Couldn't check which agents already have a Paseo chat: … | Listing Paseo's chats failed. Agents still show, but rows may say "No chat yet" for an agent that has one. Refresh. |
| herdr request timed out / herdr socket closed without a response | Herdr stopped answering. Check that it is running and responsive. |

## Herdr version too old

> Herdr 0.9.3 or newer required

or, on the Herdr screen, "Herdr at … is version X; 0.9.3 or newer is required". Upgrade Herdr. Herdr 0.9.3 is the minimum the plugin accepts.

## Herdr's OMP integration is missing

> Herdr integration "omp" is not installed (herdr integration install omp)

**Cause.** Herdr's OMP integration is a prerequisite: while it isn't installed, the provider reports Herdr as unavailable.

**Fix.** Run `herdr integration install omp`. If the status says the integration is **outdated**, the provider still works; run the same command to update it.

## A chat froze

A warning notice appears in the chat and input is disabled. The conversation stays readable. See the table in [USAGE.md](USAGE.md#read-only-agents-and-restart-to-enable-input) for each notice. The common causes and fixes:

| Notice | Fix |
|---|---|
| Input companion unavailable | Verify the companion, then restart the agent. |
| The bound agent was replaced | Something else is now running in the pane. Open the agent you want from the Herdr screen. |
| The native session changed / The native conversation branched | You ran `/new`, `/resume` or similar in the terminal. Open the current conversation from the Herdr screen. Don't import it through Paseo's built-in OMP provider; that starts a second OMP process on the same file. |
| OMP agent unavailable | The pane is gone (Herdr restarted or the pane was closed). Start a new agent. `herdr pane read <pane>` shows what a closed pane last printed, if the pane still exists. |
| This OMP agent is already open in another conversation | Close or archive the other Paseo chat on the agent, then reopen. |
| This pane is handled by another provider | Herdr now detects a different agent kind in the pane. |
| History unavailable | The agent has no session file the plugin can read. |

"Lost connection to Herdr" is not a freeze: input is suspended and resumes by itself when Herdr answers again.

## Messages from Paseo are refused

| Message | Cause | Fix |
|---|---|---|
| Agent is already working | A turn is in progress. | Wait, or press **Stop**. |
| The active conversation has an unfinished or unknown turn; finish it in the terminal | Herdr or OMP shows the agent as busy. | Finish or abort in the terminal. |
| OMP has a terminal draft. Send or remove that draft in the terminal before sending a Paseo prompt | The terminal input box has text. The plugin never overwrites or deletes a draft. | Send or clear it in the terminal. |
| OMP has pending messages … / OMP is working … | OMP has queued messages or is mid-turn. | Wait. |
| Input is suspended until Herdr and the bound native session are reconciled | Connection was lost, or the agent changed. | Wait a few seconds; refresh the Herdr screen. |
| This conversation is read-only; import the current native session separately to continue | The chat is frozen. | See [A chat froze](#a-chat-froze). |
| Only plain-text messages are supported | The message had an attachment or other non-text part. | Send text only. |
| Prompt delivery is uncertain (notice) | Paseo couldn't confirm the message arrived. It is never sent twice. | Check the terminal; press **Stop** if a turn started that you don't want. |
| Interrupt could not be delivered (notice) | The stop key couldn't be sent to the pane. | Press Esc in the terminal. |
| Interrupt has not ended the turn (notice) | Esc was sent, but OMP is still working after 10 seconds. | Press Esc in the terminal. |
| OMP kept text in its input box / may have kept your message in its input box (notice) | You stopped before OMP recorded the message and OMP restored it into its input box. | Clear the input box in the terminal (**⋯ → Open in terminal**). |
| The agent may not have received your message (notice) | You stopped right after sending. This agent cannot discard restored text, and Herdr had already typed the message into the terminal, so it may be in the input box or recorded late. | Check the terminal before sending anything again. |

## Restart to enable input fails

| Message | Cause |
|---|---|
| Only an idle or finished agent can be restarted; this one is working. | Wait until it is idle. |
| OMP reports no saved session for this agent, so a restart couldn't resume it. | OMP has no session to resume. Quit and start OMP by hand. |
| The pane's foreground process isn't OMP; nothing was changed. | The pane is no longer running OMP. |
| OMP didn't exit within 5 s; nothing was started. Check the pane in a terminal. | OMP ignored SIGTERM. Quit it in the terminal. |
| OMP stopped, but starting it again failed: … Run `omp --resume …` in the pane. | The restart started halfway. Run the command shown in the pane. |
| OMP was started again but input couldn't be verified after 30 s; check the pane in a terminal. | OMP restarted but the companion didn't answer. Verify the companion is current, and that OMP's tmp directory is the one the daemon sees ([Verify the install](#verify-the-install)). |
| The agent is no longer running in Herdr. / The agent moved to another pane; refresh and try again. | Refresh the Herdr screen. |
| Can't restart this agent: Paseo's chat list is unavailable (…) | The plugin couldn't list Paseo's chats. Try again. |
| OMP is turned off in the Herdr plugin settings | Turn **Enable OMP agents** on. |

## New agent fails

| Message | Cause | Fix |
|---|---|---|
| OMP input companion is not installed … / is outdated … | Starting an agent is refused while the companion isn't current, since it would be read-only. | [Run the installer](#run-the-installer-by-hand). |
| Working directory must be an absolute path / does not exist or is not a directory | Bad folder. | Enter an existing absolute folder; `~` is expanded on the daemon. |
| Herdr started the pane in … instead of …; closed the new tab | Herdr fell back to another directory. The plugin closed what it created. | Check the folder's permissions. |
| Herdr rejected agent.start (…) / Herdr kept reporting the new pane as busy | Herdr refused to start OMP. | Check Herdr's output; check that `omp` is on the `PATH` Herdr uses. |
| omp exited right after starting / exited before it became ready. Last pane output: … | OMP crashed on start. | Read the pane output in the message; try `omp` in that folder yourself. |
| Herdr became unreachable during launch … | Herdr stopped answering. | Check Herdr and the pane. |
| OMP is turned off in the Herdr plugin settings | Settings. | Turn **Enable OMP agents** on. |

A failed launch tells you what it created and gives `herdr agent attach` or `herdr pane read` commands to inspect it.

## Couldn't open a chat

"Couldn't open a chat: …" appears on an agent row when attaching a chat to the running agent failed, for example "The Herdr agent in terminal … is no longer running" or "This OMP agent is already open in another conversation". Use **Import it instead**, which opens the folder's workspace; there choose **⋯ → Import session** and pick the agent by the name and pane shown.

## Chat belongs to another Herdr session

> This conversation belongs to Herdr session "…", but the Herdr plugin now targets …

The chat was created on one Herdr session and the plugin settings now point at another. Change the settings back to reopen it. See [One Herdr session at a time](USAGE.md#one-herdr-session-at-a-time).

## Approvals

| Symptom | Cause |
|---|---|
| Card disappears and the chat says "Decided in the terminal; details were not retained" | It was answered in the terminal and the details were out of reach. |
| The card came back | Your decision wasn't sent, or delivery was uncertain and the agent still shows the request. Decide again or use the terminal. |
| A "Needs approval in the terminal" notice instead of a card | The plugin can't read approvals from this agent. Attach and decide in the terminal. |

## Open in terminal is missing

**Open in terminal** needs the daemon to find `herdr` on its `PATH` and the `herdr` CLI to reach the same socket by session name. The attach command in the **⋯** sheet names only the session (`herdr --session <name> agent attach <name>` for a named one), so with a custom socket path make sure the terminal you run it in reaches the same Herdr.

## Verify the install

1. **Where it belongs.** From a clone, `node plugin/scripts/install-omp-companion.mjs --print-path` prints the path: `$PI_CODING_AGENT_DIR/extensions/paseo4herdr-input.ts`, otherwise `~/.omp/agent/extensions/paseo4herdr-input.ts` (`PI_CONFIG_DIR` replaces `.omp`).
2. **That it is current.** Rerunning the installer prints `already current: <path>` when the file matches. Or compare checksums: `shasum -a 256 <installed file> plugin/harness-extension/omp.ts` should show the same hash twice.
3. **That no old companion remains.** `paseo-herdr-input.ts` must not be in the same directory.
4. **That a running agent loaded it.** The agent's row on the Herdr screen has no "Read-only" line. In a shell, `ls -d "${TMPDIR:-/tmp}"/omp-input-*/sock` lists one socket per OMP process that loaded the companion (`omp-input-<pid>/sock`); the daemon must see the same temporary directory as OMP.
5. **That Herdr is ready.** The **Connection** card on the Herdr screen shows "Connected, Herdr x.y.z", and the provider status for `OMP (Herdr)` has no diagnostic.

## Uninstall

1. Remove the plugin using Paseo's plugin management.
2. Remove the companion from a clone of this repository:

   ```bash
   node plugin/scripts/install-omp-companion.mjs --uninstall
   ```

   It removes `paseo4herdr-input.ts` and, if present, the old `paseo-herdr-input.ts`, but only files that start with this project's marker lines. A file it didn't write is refused with a message and left in place.
3. Restart OMP agents so they unload the companion.

Herdr agents keep running; they only lose the Paseo side.

## Logs

| Where | What |
|---|---|
| `paseo plugin logs herdr-harness` | The plugin's server output. |
| `$PASEO_HOME/daemon.log` | The Paseo daemon's log, including the output of the install step on install and update. |

## What to put in a bug report

Open an issue at <https://github.com/djbclark/paseo4herdr/issues>.

Start with **Settings → Herdr → Diagnostics → Copy diagnostics** and paste the result. It holds the plugin version, the resolved Herdr target (socket, session, source, auto-start), Herdr's version (and `autoStarted`: whether this plugin started Herdr, possibly because of this very report) or why it couldn't be reached, the input companion state and path, and, for each Herdr agent, its pane id and whether input is ready, with counts. It never holds prompts, titles, working folders, transcript text, environment values or file contents. Your home directory shows as `~` in the socket and companion paths and in the error text. That is all it hides: the Herdr session name, paths outside your home directory (such as `/tmp/...` sockets), `file://` URLs and any other text in an error are shown as they are, and they can contain your user name, so read the report before you post it publicly. If the client has no clipboard access, the same JSON is shown in a selectable block instead. It covers the plugin version, the Herdr version and the Effective target below; the rest still has to come from you. Include:

1. What you did, what you expected and what happened, including the exact message or notice text.
2. The output of `paseo plugin logs herdr-harness`, and the relevant part of `$PASEO_HOME/daemon.log`.
3. Versions: Paseo daemon, Herdr (shown on the Connection card), OMP, and the plugin version (`version` in `plugin/package.json`, or the commit you installed).
4. The **Effective target** (socket, session, auto-start) from the Herdr settings screen.
5. The output of the installer's `--print-path` and `ls -l` of OMP's extensions directory (it shows which companion files are present).
6. The provider status text for `OMP (Herdr)`.
7. The Herdr screen row for the agent, if it concerns one, including any "Read-only" line.

Remove anything private (paths, prompts) from logs before posting.
