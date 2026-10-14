# Herdr

Chat with OMP agents that run in [Herdr](https://herdr.dev) terminal sessions, from Paseo on your desktop or phone. The agent keeps running in its terminal. Paseo and the terminal see the same conversation, and you can type in either one.

This is an alpha release.

## What you get

- A **Herdr** screen in the sidebar that lists your live Herdr agents, grouped by workspace, with live status. Tap an agent to open its chat. An agent without a chat gets one attached to the same running process, with its earlier conversation.
- **OMP (Herdr)** as a provider. Import a running agent through Import session, or start a new agent from the agent form or the Herdr screen. Each new agent gets its own Herdr tab.
- Prompts from Paseo go to the running OMP process. Prompts typed in the terminal show up in the Paseo chat. Stop in Paseo aborts the turn and leaves OMP running.
- Model and thinking level changes from Paseo apply to the same OMP session.
- Tool approvals and OMP's questions appear as Paseo cards. Answer in Paseo or in the terminal; the first answer wins.
- **Open in terminal** attaches to the agent inside Paseo. From your own terminal, `herdr agent attach <name>` reaches the same process.

## Requirements

- Herdr 0.9.3 or later, with its OMP integration installed (`herdr integration install omp`).
- OMP. Verified with 18.4.12. Run `omp` once before installing this plugin so its agent directory exists.
- Paseo daemon 0.11.1 or later, with plugins enabled.
- `node` on the daemon host's `PATH`, for the install step.

## What installation changes

Installing or updating this plugin writes one file, `paseo-herdr-input.ts`, into OMP's extensions directory (`$PI_CODING_AGENT_DIR/extensions`, otherwise `~/.omp/agent/extensions`). This input companion lets Paseo send prompts and answers to a running OMP agent. The install step prints the path before it writes.

- It fails, and installs nothing, when OMP's agent directory doesn't exist. Run `omp` once, then install again.
- It never replaces a file it didn't write.
- OMP loads extensions only at startup. Agents that were already running stay read-only until restarted. On the Herdr screen, **Restart to enable input** restarts an idle agent in place.

## Limits

- No token streaming. OMP writes complete messages, so replies appear a message at a time.
- Herdr agents also appear in their normal Paseo workspaces. Paseo has no way for a plugin to hide them.
- Import a Herdr agent only through **OMP (Herdr)**. Importing it through Paseo's built-in OMP plugin as well starts a second OMP process on the same session file.
- Refresh agent during a running turn stops that turn.
- `/new` and `/resume` in the terminal freeze the current Paseo chat. Open the new conversation from the Herdr screen.
- Stopping the Herdr server stops its agents. Open chats go read-only, and tapping the agent opens a new chat.
- Approval cards in the real app have had limited testing. The terminal still works for every decision.
