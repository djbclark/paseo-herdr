# Using paseo4herdr

This guide covers day-to-day use. For installation see the [README](../README.md); when something goes wrong see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## The Herdr screen

Open it from **Herdr** in Paseo's sidebar, from the command center (**Open Herdr home**), or from the **Herdr** button in the composer of any Herdr chat. It refreshes every 4 seconds, and **Refresh** reloads it at once.

The screen shows, top to bottom:

| Element | What it is |
|---|---|
| **Herdr unavailable: …** | Red line when the plugin can't reach Herdr. The text names the socket it tried. See [Herdr is unavailable](TROUBLESHOOTING.md#herdr-is-unavailable). |
| Workspace cards | One card per Herdr workspace: its label, its folder (the first pane's working directory) and its agents. A workspace with none shows "No agents running." |
| Agent rows | One row per agent in the workspace's tabs. See below. |
| **New agent** button | At the bottom of a workspace card that has a folder. Starts a new OMP agent in that folder. Hidden when OMP agents are turned off in settings. |
| **Start a chat** | A folder field plus **New agent**, for a folder that has no workspace yet. Hidden when Herdr is unreachable or OMP agents are off. |
| **New workspace** | A folder field, an optional label, and **Create workspace**. Creates an empty Herdr workspace (not focused in Herdr); the label defaults to the folder's name. |
| **Connection** | The effective Herdr target (socket, session, whether auto-start is on), the Herdr version when connected, and "(auto-started by Paseo)" when Paseo started the Herdr server. |

### Agent rows

Each row shows the agent's name, its status, and a second line with the harness, Herdr pane and folder, for example `OMP · pane w2:p1 · /Users/me/project`. The name is the terminal title with the prompt glyph removed, else the Herdr agent name.

Status is Herdr's own: **Idle**, **Working**, **Blocked** (waiting for a decision), **Done** or **Unknown**.

Tap the row to open its chat:

- If the agent already has a Paseo chat, that chat opens. When several live chats are bound to one agent, the newest owns the row.
- If not, the row says "No chat yet: tap to open one." and tapping creates a chat attached to the running agent (no new process) and loads its earlier conversation.
- If creating the chat fails, the row shows "Couldn't open a chat: …" and an **Import it instead** button. It opens the folder's workspace; use **⋯ → Import session** there and pick the agent by the name and pane shown in the toast.
- "No Paseo provider handles this agent kind." means Herdr reports the agent as something other than OMP. Only OMP agents are supported.

The **⋯** button opens a sheet with:

| Action | What it does |
|---|---|
| **Open in terminal** | Opens a Paseo terminal named `Herdr: <agent>` in the agent's folder, running `herdr agent attach`. Shown only when the daemon can find `herdr` on its `PATH` and the `herdr` CLI would reach the same socket by session name; a custom socket path that the session name wouldn't reach hides it. |
| **Restart agent** | The same restart as **Restart to enable input**, offered for any restartable agent; see [Read-only agents](#read-only-agents-and-restart-to-enable-input). It fails with a message unless the agent is idle or done. |
| Attach command and **Copy** | The `herdr agent attach <name>` command (with `--session <name>` for a named session) to run in any terminal on the same computer. |

## Importing an agent or starting one

**Import** an agent that is already running in Herdr by tapping it on the Herdr screen, or through Paseo's own **Import session** with the **OMP (Herdr)** provider. Import agents only through **OMP (Herdr)**. Importing the same session through Paseo's built-in OMP provider as well starts a second OMP process on the same session file.

**Start** a new agent from the Herdr screen (**New agent** or **Start a chat**) or from Paseo's agent form with the **OMP (Herdr)** provider and a folder. The plugin then:

1. Looks for a Herdr pane already in that folder. If it finds one, it adds a tab labelled `paseo` to that pane's workspace. Otherwise it creates a workspace named after the folder. Neither is focused in Herdr.
2. Starts `omp` in the new pane as a Herdr agent named `paseo-<6 hex digits>`, passing `--model` and `--thinking` when you picked them in Paseo.
3. Waits up to 30 seconds for the agent to be ready, then opens the chat.

If the input companion isn't current, starting is refused up front with the companion's diagnostic, because the new agent would be read-only. If the launch fails, the error says what Herdr created and how to attach to or inspect the pane.

The agent keeps running in Herdr when you close the Paseo chat. A notice in the new chat shows the attach command.

### Folder fields

The folder fields suggest as you type (after a 150 ms pause), with a label for where each suggestion came from:

| Label | Source |
|---|---|
| **Herdr** | A folder one of Herdr's agents or panes is in |
| **Paseo** | A folder of one of Paseo's workspaces |
| (none) | A directory found on the daemon's disk |

An empty field lists up to 15 known folders; a typed path lists up to 20 matches. Typing a path lists its matching subdirectories; hidden directories appear only when what you typed after the last `/` starts with `.`. Choosing a suggestion fills the field with the path and a trailing `/`, so you can keep descending.

A leading `~` or `~/` is expanded by the daemon, using the daemon user's home directory, which is not necessarily the home of the machine you are looking at. The path must end up absolute and must exist as a directory.

## Chatting from Paseo and from the terminal

The agent is one OMP process in one Herdr pane. You can use both ends, one at a time:

- **Paseo to OMP.** A message is delivered to OMP through the input companion. Paseo refuses to send while OMP is working ("Agent is already working"), while the terminal has an unsent draft in its input box ("OMP has a terminal draft…"), or while a previous turn is unfinished. Clear or send the draft in the terminal first.
- **Terminal to Paseo.** Anything you type in the terminal is written to OMP's session file; the plugin follows that file and shows new messages and replies in the Paseo chat.
- **Granularity.** Replies arrive as OMP writes complete messages to its session file, not token by token.
- **Model and thinking level.** Changes in Paseo's pickers apply to the running OMP session, but only while OMP is idle. A model switched in the terminal shows up in Paseo.
- **Stop.** **Stop** in Paseo sends Escape to the pane, the same as pressing Esc in OMP. OMP keeps running. If the turn hasn't ended 10 seconds later, a warning notice says so. If Paseo can't tell whether a prompt arrived, **Stop** doesn't send a key and doesn't resend anything.

If you open a conversation in OMP's `/new` or `/resume` from the terminal, the Paseo chat freezes read-only ("The native session changed"). Open the new conversation from the Herdr screen.

## Approvals and questions

When OMP asks to run a tool, or asks you a question, the plugin shows it as a card in the Paseo chat:

- **Tool approvals** show the tool, OMP's reason and the arguments (long arguments are cut at 2,048 characters), with **Allow** and **Deny**.
- **Questions** show OMP's question and options. You can pick an option, type your own answer, or choose **Chat instead** to dismiss the question and answer in the conversation.

The first answer wins, whether it comes from Paseo or from the terminal. Either way the chat gets a line such as "Approved in Paseo", "Denied in the terminal", "Answered in Paseo: …" or "Timed out in OMP (default option used)". These lines are saved with the chat and survive a plugin reload.

Things you may see:

| Message | Meaning |
|---|---|
| Your decision was not sent | The agent refused it before anything was written, and the card comes back. |
| Your decision may not have reached the agent | Delivery was uncertain. The card returns if the agent still shows the request. Decide again, or decide in the terminal. |
| The agent changed | The agent was replaced or the session changed; the card is withdrawn. Decide in the terminal. |
| That answer could not be used | A question was answered with nothing selected. It is shown again. |
| Paseo shows a generic outcome for a terminal decision | Paseo's own permission record may differ from what was decided; the chat line is accurate. |

If the plugin can't read approvals from the agent, it falls back to a "Needs approval in the terminal" notice while the agent is blocked. Run `herdr agent attach <name>` and decide there.

## Read-only agents and Restart to enable input

OMP loads extensions only when it starts. An OMP process that started before the input companion was installed has no input endpoint, so Paseo can show its conversation but can't send to it. The Herdr screen marks it:

> Read-only: it started before the input companion was installed.

**Restart to enable input** appears when the agent is idle or done. (While it is working, the row says "Restart is available once it's idle.") The confirmation says exactly what happens: OMP is sent SIGTERM, then started again in the same pane with `--resume` on the same session, and anything typed in its terminal but not sent is lost. The plugin waits up to 5 seconds for OMP to exit and up to 30 seconds for the restarted agent to prove its input works. It never force-kills and never starts twice.

The old chat stays read-only. If the agent had a chat, the plugin opens a fresh one on the same conversation after the restart and archives the old one; archived chats can be restored from Paseo's archive.

A chat can also freeze while it is open, with a warning notice naming the reason:

| Notice | Cause |
|---|---|
| Input companion unavailable | The agent has no input companion, or its identity didn't match. Restart it, as above. |
| The bound agent was replaced | Another process took over the pane, or the OMP process was replaced. Input is never sent to a replacement. |
| The native session changed / The native conversation branched | The conversation in the pane is no longer the one this chat followed. Open the current one from the Herdr screen. |
| OMP agent unavailable | The agent is gone from Herdr, or can't be recovered unambiguously. |
| This OMP agent is already open in another conversation | Another live Paseo chat owns this agent; the other one keeps control. |
| History unavailable | The agent has no readable session file. |

A separate, non-freezing warning, "Conversation continued in another process", appears when another OMP process continues the same conversation in a separate copy. The copy isn't followed; the chat stays on the original file.

## Herdr and OMP going away

If the plugin loses its connection to Herdr, the chat shows "Lost connection to Herdr" and input is suspended. Input resumes when the connection is restored. If a turn was running for more than 60 seconds of outage it is marked failed ("the agent may still be running in the terminal").

If an agent disappears from Herdr (for example, the pane is closed or Herdr restarts and the agent isn't recovered), its chat goes read-only with the notice "OMP agent unavailable". Tapping an agent that replaces it on the Herdr screen opens a new chat.

## Settings

Open **Herdr settings** from the command center, or use **Settings → Plugins → herdr-harness**.

| Setting | Effect |
|---|---|
| **Enable OMP agents** | On by default. Off: no new OMP discovery, import or launch, and **New agent** is hidden. Chats that are already open keep working and can finish or stop. |
| **Herdr session** | A named Herdr session; empty means the default session. |
| **Herdr socket path** | An explicit socket path. Overrides everything else when set. |

Press **Save** after editing the two text fields. The **Effective target** section shows the socket, the session, whether auto-start is on and, when it is off, why.

### How the Herdr socket is chosen

The first match wins:

| Order | Source | Auto-start |
|---|---|---|
| 1 | **Herdr socket path** setting | Off. Paseo only connects. |
| 2 | `HERDR_SOCKET_PATH` in the daemon's environment | Off |
| 3 | **Herdr session** setting (non-default name) | **On** |
| 4 | `HERDR_SESSION` in the daemon's environment | Off |
| 5 | The default session | Off. The default Herdr session is never started automatically. |

Sockets are looked up under `$XDG_CONFIG_HOME/herdr`, else `~/.config/herdr`: `herdr.sock` for the default session and `sessions/<name>/herdr.sock` for a named one. `HERDR_SESSION=default` and a **Herdr session** of `default` both mean the default session.

Auto-start runs `herdr --session <name> server` detached, and waits up to 10 seconds for it to answer. It only happens when the socket is absent or refusing connections, never because of a version or protocol error. Paseo never stops Herdr.

The plugin reads the environment of the Paseo daemon, not of your shell. Set `HERDR_SOCKET_PATH` or `HERDR_SESSION` where the daemon is started.

### One Herdr session at a time

A chat remembers the Herdr session it was created on. After you change settings to another session, new operations use the new target, but reopening a chat that belongs to the old session fails with "This conversation belongs to Herdr session …, but the Herdr plugin now targets …". Change the settings back to reopen it. Open chats are never moved to another Herdr.

## Known limits

- Replies appear a message at a time, not token by token.
- Only agents Herdr lists as agents are supported, and only OMP. Plain shell panes don't appear.
- Only plain-text messages can be sent from Paseo.
- If an agent disappears from Herdr, its chat goes read-only; a new chat is needed for any agent that replaces it.
