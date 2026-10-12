# Vendored OMP history mapper

This directory contains a trimmed, self-contained copy of Paseo's OMP history
mapper closure so the `herdr-omp` provider replays native OMP transcripts
faithfully without importing anything private from `@getpaseo/server`.

**Source:** `paseo/packages/server/src/server/agent/providers/omp/`
and two files outside it, at commit `804335b`
(`fix(files): rename untracked bracket paths without matching siblings (#6573)`).

## File map

| Vendored file | Source file (same commit) | Notes |
|---|---|---|
| `history.ts` | `providers/omp/history.ts` | Active-chain walk, entry→message mapping, compaction, custom-message, telemetry/control filtering. `toReversed`/`toSorted` (ES2023) replaced with `slice().reverse()` / `slice().sort()` to stay ES2022. |
| `history-hooks.ts` | `providers/omp/history-hooks.ts` | Advisor/system-notice/tool-detail/id hooks. |
| `message-history.ts` | `providers/omp/message-history.ts` | `OmpHistoryMapper` (user/custom/assistant/toolResult/bash mapping). |
| `tool-call-detail.ts` | `providers/omp/tool-call-detail.ts` | Tool arg/result parsing and core tool detail mapping. |
| `tool-call-mapper.ts` | `providers/omp/tool-call-mapper.ts` | Device/extended/opaque tool detail mapping. |
| `tool-call-id.ts` | `providers/omp/tool-call-id.ts` | Poll/subagent call-id resolution. `toSorted` replaced with `slice().sort()`. |
| `custom-message.ts` | `providers/omp/custom-message.ts` | Custom-message display/id/skill-prompt helpers. |
| `advisor-message.ts` | `providers/omp/advisor-message.ts` | Advisor note → tool row. |
| `system-notice.ts` | `providers/omp/system-notice.ts` | `<system-notice>` → notification row. |
| `map-custom-message.ts` | `providers/custom-message.ts` (one directory up, distinct from omp/custom-message.ts) | Custom message → tool call. |
| `provider-history-timestamps.ts` | `provider-history-timestamps.ts` (two directories up) | Timestamp normalization. |
| `rpc-types.ts` | `providers/omp/rpc-types.ts` | Trimmed to the OMP RPC message/todo schemas the mapper closure needs. |
| `sdk-types.ts` | `agent-sdk-types.ts` (two directories up) | Trimmed `AgentTimelineItem`, `ToolCallDetail`, `AgentStreamEvent`, `AgentProvider`, `JsonValue`, `AgentTaskItem`. |

The mapper closure also needs `todo-mapper.ts`, `subagent-title.ts`, and
`mcp-bridge.ts` upstream; this delivery does not replay subagent transcripts or
OMP todo state (deferred), so those are not vendored and no imports reference
them.

## Invariant

`rg "from \"\.\./" harness/omp/vendor` must find no import paths escaping
`harness/omp/vendor/`; the closure is self-contained. `rg "from \"\.\./" harness/omp`
(one level up, i.e. `harness/omp/` proper) must find no imports escaping the
adapter — the adapter imports only `@getpaseo/plugin/server/provider` types and
core files (`../types.js`, `../../file-tail.js`, `../../herdr/schema.js`).

## Divergences

- **ES2023 → ES2022:** `Array.prototype.toReversed`/`toSorted` are not in the
  plugin's `lib` target (`ES2022`); replaced with `slice().reverse()` /
  `slice().sort()` (identical semantics for these call sites).
- **Telemetry rows skipped in the adapter** (not here): `credential_pin`,
  `model_usage`, and `service_tier_change` rows are appended to the OMP chain
  but carry no rendered content. Upstream's live streamer never surfaces them;
  the adapter skips them in `to-provider-items.ts` so replay matches the OMP TUI.
