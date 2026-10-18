# Agent Note: Persistent specialist teams as an external plugin

Status: implemented

English | [中文](2026-10-19-aseldev-persistent-teams.zh.md)

## Problem

A user needs reusable specialists, a coordinator conversation, shared files, and visible task status without maintaining an agent-loop fork. Temporary runtime packages do not survive process restart, and changing upstream composition manifests increases merge work when pulling official updates.

## Decision

The [AselDev teams plugin](../../../../aseldev/plugins/teams/README.md) lives outside the upstream package tree and loads through the user profile patch. A local package link makes its browser declaration discoverable by the existing client-module registry. Team data lives in the Harness home, independently of the checkout.

Saved specialists are definitions; workers are continuable child conversations. Each coordinator conversation owns its assignments and concurrency setting. The plugin consumes the existing [continuable subagent lifecycle](2026-07-28-continuable-subagent-conversations.md) rather than implementing a second agent driver, transcript format, or delivery authority. It does not widen parent-to-child authority or change the existing [current-turn interrupt](2026-08-06-continuable-subagent-interrupt.md) operation.

The task queue schedules assignments before inbox admission. A task spans a complete worker activation, so a terminal subagent event, not a guessed per-message completion, releases its concurrency slot and declared file reservations. Specialist definitions are captured at assignment time to keep later roster edits from changing in-flight work. Follow-ups use the same scheduler and retain the same worker conversation.

File reservations coordinate declared paths rather than preventing writes. Case-insensitive directory-prefix comparisons conservatively serialize overlaps. Read/write overlap is serialized too, because a review reading files while another worker rewrites them is not independent work. Unscoped readers reserve the whole workspace against writers. The coordinator, manual edits, unrelated agents, and path aliases are outside this coordination mechanism.

The JSON store is atomically replaced. Restart pauses teams and marks interrupted assignments blocked rather than replaying them: accepted inbox messages are not necessarily logged, and partially completed shared-file writes cannot safely be inferred from a task status.

## Alternatives considered

**Modify the loop and shipped presets.** Existing subagent, tool, prompt, HTTP, profile, and browser slot APIs provide the required operations. Core edits would add upstream merge conflicts without supplying a missing capability.

**Use temporary runtime plugins.** They are useful for probes but disappear on process restart and do not supply a permanent installed team definition.

**Use one-shot workers.** Their explicit result promises simplify collection, but they do not support the required reusable worker conversations and cold follow-ups.

**Treat reservations as filesystem locks.** Shared shells, symlinks, manual edits, and unrelated agents can bypass a path declaration. Describing advisory coordination as write isolation would promise a guarantee this plugin does not enforce.

**Resume every queued and active task automatically.** A restart can lose accepted inbox content while retaining partial file changes. Explicit recovery keeps replay authority with the user or coordinator.

## Consequences

The feature adds no upstream core edits or shipped preset changes. Official updates preserve the user data, but plugin API changes can still require local adaptation. The AselDev plugin and setup script need their own committed backup.

Workers inherit their coordinator's preset, workspace, and model route. Per-specialist model selection, independent presets, remote management, cross-process scheduling, durable inboxes, and automatic crash recovery are not provided. Team output is activation-wide, not a causally attributed per-message result. Cancellation retains reservations until worker settlement.

## Verification

The [scheduler tests](../../../../aseldev/plugins/teams/engine.test.mjs) cover persistence, interrupted restart, dependency failure, direct follow-ups, publication/settlement races, bounded concurrency across teams, cancellation, detached queries, and overlapping file reservations. The [Loader composition test](../../../../aseldev/plugins/teams/composition.test.mjs) drives real coordinator and worker turns, pins their logged input and output in a keyless transcript, and checks tool and HTTP-route removal through retained references after disposal. [Installation tests](../../../../aseldev/plugins/teams/setup.test.mjs) exercise idempotent profile setup in a temporary home, including stale links and refusal to replace real directories. The [browser smoke](../../../../aseldev/plugins/teams/browser-smoke.mjs) checks the installed panel on the existing GUI URL without changing saved user data.

Existing continuable lifecycle and interrupt notes retain their independent runtime rationale; this plugin consumes those operations and supersedes neither decision.
