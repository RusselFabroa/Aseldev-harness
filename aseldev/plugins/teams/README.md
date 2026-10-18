# Persistent teams

English | [中文](README.zh.md)

An opt-in AselDev plugin for coordinator-managed specialists. Host code, browser code, and scheduling live in this directory; no Harness core or shipped preset changes are required.

## Installation

From the checkout, run `powershell -NoProfile -ExecutionPolicy Bypass -File aseldev/setup-profile.ps1`. This builds the client, links `@aseldev/dsh-teams` into the profile plugin search directory, and adds its row to the AselDev profile patch. Refresh the existing Harness page after installation. If the running process cannot discover the new client package, restart the normal AselDev launcher; do not start a second server. Restart that launcher after updating host implementation code; a browser refresh alone is not a host-code update.

The profile patch and team data live under `$DSH_HOME` (the AselDev launcher uses `~/.dsh-aseldev`). Keep this directory backed up. Updating upstream source does not replace the saved team data. Upstream plugin API changes can still require adapting this plugin; commit or otherwise back up the AselDev source before pulling updates.

To disable the feature without deleting data, add an `id: aseldev-teams` / `disabled: true` override after the generated AselDev block in the profile patch. Re-enabling it retains the roster and history; interrupted assignments still require explicit recovery.

## Usage

1. Open a normal coordinator conversation and open **Team** in the sidebar.
2. Create or edit saved specialists. A specialist has a name, instructions, and read or write mode. The initial roster contains Researcher, Builder, and Reviewer.
3. Assign a title, a complete prompt, optional dependencies, and workspace-relative file or directory reservations. A writing assignment requires reservations; `.` reserves the entire workspace. Directory reservations include descendants; globs and parent traversal are rejected.
4. Choose the team's concurrency limit. Independent eligible assignments start while the coordinator is live. The coordinator can also assign work through `team_manage`.
5. Inspect status and results, open a worker conversation, cancel work, or send a follow-up through the Team panel. A worker is a durable conversation; the specialist is its reusable definition, not a permanently running agent.

Editing a specialist affects future assignments, not existing workers. Workers inherit their coordinator's workspace and model route. The saved instructions and mode are captured with the assignment; instructions reach the model in a logged assignment message, not an interpolated persona template. The tool policy blocks recursive delegation and team management.

## Scheduling and durability

Each coordinator conversation owns its own task history and concurrency setting. Specialist definitions are shared across coordinator conversations. Team metadata is written atomically to `teams/state.json` in the Harness home; worker transcripts use the existing session persistence.

Tasks move from queued to starting to working, then done, failed, canceled, or blocked. Canceling retains its slot and file reservations until a real worker terminal event arrives. A failed dependency blocks downstream work until an explicit retry. Lowering a concurrency limit does not cancel already running workers.

The per-team concurrency default is three. The plugin-wide ceiling defaults to twelve and applies across teams. Both are host plugin configuration fields, `maxActive` and `maxLimit`; `dir` selects the team data directory. Increase the ceiling deliberately when jobs justify it.

After a process or plugin restart, teams are paused and interrupted assignments are blocked. Inspect the shared files before retrying an assignment, then explicitly resume queued work. Accepted but unlogged worker inbox messages are not durable; the plugin never silently replays them. A retry or direct follow-up reuses the worker conversation when one exists.

A displayed result is the final text for the worker's complete activation, not a guaranteed result of one individual inbox message. Stop requests are cancellation requests, not instantaneous termination.

## Host configuration

Set host fields in the `aseldev-teams` profile row. Keep user overrides outside the generated setup block.

| Field | Purpose |
|---|---|
| `dir` | Data directory; defaults to `$DSH_HOME/teams`. |
| `maxActive`, `maxLimit` | Default per-team concurrency and plugin-wide ceiling. Existing teams retain their own setting; lower saved team limits before lowering the ceiling below them. |
| `provider` | Registered continuable subagent provider; defaults to `spawn`. |
| `model` | Optional worker-wide `provider`, `model`, and `maxTokens` overrides. Without these, creation inherits the coordinator route. |
| `personaMode` | `append` uses the team persona; `inherit` retains the preset persona. This is not a saved per-specialist preset. |
| `readTools` | Explicit inspection-tool allow-list for read specialists. Configure only tools you trust not to mutate shared files. |
| `delegationTools` | Additional tool names denied to writing workers. Built-in delegation restrictions still apply. |
| `interruptWaitMs` | Wait budget for a stop request; defaults to 15000 milliseconds. A stop request does not itself prove termination. |

## Shared-file coordination

Reservations serialize overlapping declared editing scopes, including overlapping readers and writers. Path comparisons are case-insensitive, and matching relative paths are conservatively serialized across teams even in different workspaces. An unscoped reader reserves the entire workspace against writers.

Reservations are advisory coordination, not filesystem locks or a sandbox. They do not prevent manual edits, coordinator edits, unrelated subagents, tools writing outside a declared scope, or symlink/path aliases. Keep prompts scoped and review changed files. Read specialists receive a restricted set of inspection tools rather than shell or mutation tools. These policies coordinate trusted workers; writing workers retain shell access and are not sandboxed by this plugin.

## Model Experience

### What the model sees

Coordinators receive `team_manage`, which lists specialists, configures concurrency, assigns tasks, checks status, retries, cancels, and sends follow-ups. Worker completion notices use the existing subagent mechanism. Team workers cannot call coordinator-only actions or start further delegates.

### Token effect

One tool definition and a short coordination instruction are added to the coordinator prompt. Assignment prompts, returned task state, and existing worker reports consume tokens proportional to their content.

### KV Cache effect

The tool definition and coordination instructions are stable while the plugin remains mounted. Task status is returned through tool results rather than rewriting the system prompt on every progress change.

## Known Limitations and Deferred Work

- Workers use the coordinator's preset and model route; per-specialist presets and model overrides are not provided.
- Saved specialists are editable, but deletion and task-history pruning are not provided. The JSON store grows with usage and targets small local teams rather than large task queues.
- Open the coordinator conversation before resuming queued work. An offline coordinator is not silently reconstructed by the scheduler.
- The local HTTP API is restricted to loopback callers with a same-origin custom header. Remote/LAN team management is not supported.
- Cross-process coordination, a durable inbox, automatic crash recovery, filesystem locks, and recursive worker teams are not provided.

## Checks

With the normal Harness dependencies and library artifacts installed, run `npm --prefix aseldev/plugins/teams test` to build both halves, strictly typecheck the sources, and run client, scheduler, host, Loader-composition, and isolated installation tests. The installation suite does not modify your active profile. Run `node aseldev/plugins/teams/browser-smoke.mjs --fixtures` against the existing GUI to verify the mounted panel and its controls without changing saved user data. No test starts a replacement GUI server.
