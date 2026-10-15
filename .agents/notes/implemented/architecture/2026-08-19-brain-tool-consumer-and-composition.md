# Agent Note: Brain tool consumer and settings-first composition

Status: implemented

English | [中文](2026-08-19-brain-tool-consumer-and-composition.zh.md)

## Problem

The brain seam ([knowledge-vault capability seam](2026-08-18-brain-knowledge-vault-seam.md)) shipped without its Consumer role: `ctx.brain` had a Service Definition and a local provider, but no model-facing tool, so no session could reach the vault. The deployment's vault path also lived as a hardcoded personal absolute path in the shipped Web composition, so the capability was not configurable through settings alone, and no assembled-application test covered any brain surface.

## Decision

1. `@deepseek-ai/dsh-tool-brain` (`packages/knowledge/tool-brain`) completes the seam: it registers `brain_search(query)` and `brain_read(path)` on `ctx.tools`. The provider resolves per call through a strict optional-service read (`ctx.get('brain')`), so mount order relative to the provider row is irrelevant. An unconfigured vault is a domain state rather than an error: `brain_search` answers the structured value `configured: false` with an empty match list, `brain_read` fails with guidance toward Settings → Plugins → Brain, and a composition that mounts no provider fails loud on both. Search and scan bounds stay provider-owned; the consumer adds none.
2. Composition ownership moves down a layer: `dsh-base` inserts the single `brain-local` row, unconfigured by default, so TUI, headless, and Web share one host-plane instance. The Web patch keeps only `ui-brain` plus a disabled `tool-brain` row, and the `standard` agent preset mounts the consumer for its sessions. Loader entry ids are unique across the composed profile — a layer must not re-insert an id another layer already inserts; the duplicate `brain-local` row fails the profile at load.
3. The vault path is settings-first: the persisted user setting (the `brain:` section of `$DSH_HOME/settings.yaml`, edited under Settings → Plugins → Brain) layers over the empty composition default. A personal deployment configures once and survives harness updates; nothing personal ships in the repository.
4. Coverage boots the real Loader over a temporary vault in package tests, and the synthesized `brain-tool-round` fixture replays a search-and-read round through the assembled Web UI keylessly (recorded fixtures need an API key; synthesized ones keep replay hermetic).

## Alternatives considered

### Why not inject a vault outline into every prompt?

`agent.inject()` of a vault map would spend tokens on each request and pin model-visible text the log must reconstruct, for value that on-demand tools deliver more cheaply. Discovery stays pull-based through `brain_search`.

### Why not keep the provider row Web-only?

The vault is a host-level resource. A base-owned row gives TUI and headless the same configure-through-settings behavior and prevents per-surface rows from drifting apart.

### Why not write-back now?

Mutation stays deferred with wikilinks/backlinks and the graph view: writing needs its own conflict and Obsidian co-existence design behind the deliberately read-only seam.

## Consequences

- Sessions on the `standard` preset can search and read the vault. The schema cost is fixed and prefix-stable per request; results scale with queries and whole-note reads until compaction, bounded by the provider's caps.
- Every surface shows the unconfigured default honestly; first-run guidance points at Settings → Plugins → Brain.
- A dedicated center-column reading workspace remains future work: the `conversation` and `details` slots are single-occupancy ui-conversation registrations, so it requires a layout-owned region switch rather than an additional slot registrant.
