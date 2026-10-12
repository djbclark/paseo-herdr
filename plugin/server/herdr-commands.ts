const SHELL_SAFE = /^[A-Za-z0-9_.@%+=:,\/-]+$/;
const shellQuote = (value: string): string => SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
const herdrCommand = (herdrSession: string | null): string => `herdr${herdrSession ? ` --session ${shellQuote(herdrSession)}` : ""}`;
/** Command a user runs in a terminal to attach to a launched agent. */
export const attachCommand = (herdrSession: string | null, agentName: string): string =>
  `${herdrCommand(herdrSession)} agent attach ${shellQuote(agentName)}`;
/** Command a user runs in a terminal to read a pane's recent output (works after the agent is gone). */
export const paneReadCommand = (herdrSession: string | null, paneId: string): string =>
  `${herdrCommand(herdrSession)} pane read ${shellQuote(paneId)}`;
