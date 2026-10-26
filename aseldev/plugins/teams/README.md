# Persistent teams

English | [中文](README.zh.md)

An opt-in AselDev plugin for coordinator-managed specialists. Host code, browser code, and scheduling live in this directory; no Harness core or shipped preset changes are required.

## Installation

From the checkout, run `powershell -NoProfile -ExecutionPolicy Bypass -File aseldev/setup-profile.ps1`. This builds the client, links `@aseldev/dsh-teams` into the profile plugin search directory, and adds its row to the AselDev profile patch. Refresh the existing Harness page after installation. If the running process cannot discover the new client package, restart the normal AselDev launcher; do not start a second server. Restart that launcher after updating host implementation code; a browser refresh alone is not a host-code update.

The profile patch and team data live under `$DSH_HOME` (the AselDev launcher uses `~/.dsh-aseldev`). Keep this directory backed up. Updating upstream source does not replace the saved team data. Upstream plugin API changes can still require adapting this plugin; commit or otherwise back up the AselDev source before pulling updates.

To disable the feature without deleting data, add an `id: aseldev-teams` / `disabled: true` override after the generated AselDev block in the profile patch. Re-enabling it retains the roster and history; interrupted assignments still require explicit recovery.

## Usage

1. Open a normal coordinator conversation and open **Team** in the sidebar. The conversation is the **Project Manager**: it plans, delegates through `team_manage`, reviews worker reports, and reports back. It does not implement the assignments itself.
2. The roster is seeded on first load with **Senior Backend Developer** (write), **Senior Frontend Developer** (write), and **Senior QA** (read); the earlier researcher/builder/reviewer entries are replaced. Add or edit roles in the Team panel.
3. Each role ships a default skill (`aseldev/skills/roles/<role>/SKILL.md`) that *is* its instructions, so a normal assignment needs no role description. The **PM skill** (`aseldev/skills/roles/pm/SKILL.md`) defines the coordinator's plan-and-delegate loop. **Settings → Teams** edits every role skill plus the ponytail level and the auto-continue budget; saving applies to the next assignment.
4. Assign a title, a complete prompt, optional dependencies, and workspace-relative file or directory reservations. A writing assignment requires reservations; `.` reserves the entire workspace. Directory reservations include descendants; globs and parent traversal are rejected. A UI assignment without a named design direction makes the frontend worker ask the PM, which names one of the installed taste skills (`design-taste-frontend`, `high-end-visual-design`, `gpt-taste`, …, see `aseldev/skills/`).
5. Choose the team's concurrency limit. Independent eligible assignments start while the coordinator is live. The coordinator can also assign work through `team_manage`.
6. The Team panel is a **status-only orbit ring**: one node per role around the PM core, showing working / queued / done / blocked / idle at a glance, with a live summary and the auto-refresh stamp. Click a role node to open that role's worker conversation when it has one; a paused team shows Resume. Assignments, retries, cancels, and follow-ups run through the PM conversation (`team_manage`), not the panel.

Writing workers apply ponytail at the configured level (`lite` | `full` | `ultra`, default `full`, from Settings → Teams); the PM passes it with each writing assignment. The PM continues automatically and stops at the auto-continue budget (or when the goal is met or blocked) and then reports progress.

Editing a specialist affects future assignments, not existing workers. Workers inherit their coordinator's workspace and model route. The saved instructions and mode are captured with the assignment; instructions reach the model in a logged assignment message, not an interpolated persona template. The tool policy blocks recursive delegation and team management.

## Settings → Teams

A **Settings → Teams** section lists the Project Manager skill and every role skill in editable text areas, with per-role saves, a ponytail-level selector, and the auto-continue round budget. It reads and writes through the same loopback-trusted host API as the Team panel. A saved role skill also updates the stored role text so the panel and the board show what a worker receives. Settings are persisted in the Harness settings store; role skills live under the `rolesDir` folder (default: this checkout's `aseldev/skills/roles`).

## Sidebar entry

The browser half registers one `sidebar.launcher` entry unless the plugin row sets `showLauncher: false`. Nothing else changes when it is off: the host engine, the tools, every assignment, and the Settings → Teams section stay as they are, and the panel contribution itself is unchanged — only its launcher button is not registered.

A plugin row config does not reach the browser, so the browser half reads `GET /aseldev-teams/api/launcher` once before registering; the answer is `{"showLauncher": boolean}` behind the same loopback guard and `x-aseldev-teams: 1` header as every other route. It registers when the answer is `true`, and also when the request fails or the route is missing, so a broken host never hides the panel silently. That read never delays the dictionaries or the settings section.

`aseldev/setup-profile.ps1` writes `showLauncher: false` for this profile, because the isometric office registers its own `sidebar.launcher` entry there; the office supersedes the Team entry by default. Set `showLauncher: true` to show both buttons, or remove the office row to keep only this one.

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
| `workerDelegation` | `true` lets **writing** workers use delegation tools (`subagent`, `send_message`, `workflow`, ...). Default `false`. Nested workers run outside the coordinator's concurrency and reservation coordination, so exclusive editing scopes are no longer guaranteed; team control stays coordinator-only. |
| `interruptWaitMs` | Wait budget for a stop request; defaults to 15000 milliseconds. A stop request does not itself prove termination. |
| `rolesDir` | Folder holding role skills (`<role>/SKILL.md`). Defaults to this checkout's `aseldev/skills/roles`; the Settings → Teams section edits the files there. |
| `ponytailLevel` | Default ponytail intensity for writing assignments: `lite`, `full`, or `ultra`. Default `full`. |
| `autoRounds` | Rounds the Project Manager runs automatically since the user's last message before it must report. Default 8. |
| `showLauncher` | `false` keeps the browser half from registering its `sidebar.launcher` entry. Default `true`. One row configures both halves, so the host validates this field; see [Sidebar entry](#sidebar-entry). |

## Shared-file coordination

Reservations serialize overlapping declared editing scopes, including overlapping readers and writers. Path comparisons are case-insensitive, and matching relative paths are conservatively serialized across teams even in different workspaces. An unscoped reader reserves the entire workspace against writers.

Reservations are advisory coordination, not filesystem locks or a sandbox. They do not prevent manual edits, coordinator edits, unrelated subagents, tools writing outside a declared scope, or symlink/path aliases. Keep prompts scoped and review changed files. Read specialists receive a restricted set of inspection tools rather than shell or mutation tools. These policies coordinate trusted workers; writing workers retain shell access and are not sandboxed by this plugin.

Delegation is denied to workers by default. Setting `workerDelegation: true` lets a **writing** worker start its own subagents; those nested workers are outside the coordinator's concurrency limit and path reservations, so overlapping edits can no longer be serialized. Team control (`team_manage`) stays coordinator-only in every configuration.

## Model Experience

### What the model sees

Coordinators receive the Project Manager skill plus one dynamic line stating the auto-continue budget and the ponytail level; the line changes only when Settings → Teams changes. Workers receive a short team-worker statement, and their role skill text rides the assignment. Worker completion notices use the existing subagent mechanism. Team workers cannot call coordinator-only actions or start further delegates.

### Token effect

The PM skill and coordination line are added to every coordinator assembly; a role skill is added to the assignment prompt of the assignments that use that role. Assignment prompts, returned task state, and existing worker reports consume tokens proportional to their content.

### KV Cache effect

The PM skill, the coordination line, and the tool definition are stable while the files and settings stay unchanged; a settings edit is the only rewording trigger. Task status is returned through tool results rather than rewriting the system prompt on every progress change.

## Known Limitations and Deferred Work

- Workers use the coordinator's preset and model route; per-specialist presets and model overrides are not provided.
- Role skills are files read at assignment start; the stored role text is the fallback and the Settings → Teams save mirrors the two. Editing a skill file by hand takes effect on the next assignment, but the panel text updates only after a Settings save.
- Saved specialists are editable, but deletion and task-history pruning are not provided. The JSON store grows with usage and targets small local teams rather than large task queues.
- Open the coordinator conversation before resuming queued work. An offline coordinator is not silently reconstructed by the scheduler.
- The local HTTP API is restricted to loopback callers with a same-origin custom header. Remote/LAN team management is not supported.
- Cross-process coordination, a durable inbox, automatic crash recovery, filesystem locks, and recursive worker teams are not provided.
- Ponytail is vendored from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT) as `aseldev/skills/ponytail*`; the design taste skills are vendored under `aseldev/skills/`.

## Checks

With the normal Harness dependencies and library artifacts installed, run `npm --prefix aseldev/plugins/teams test` to build both halves, strictly typecheck the sources, and run client, scheduler, host, Loader-composition, and isolated installation tests. The installation suite does not modify your active profile. Run `node aseldev/plugins/teams/browser-smoke.mjs --fixtures` against the existing GUI to verify the mounted panel and its controls without changing saved user data. No test starts a replacement GUI server.
