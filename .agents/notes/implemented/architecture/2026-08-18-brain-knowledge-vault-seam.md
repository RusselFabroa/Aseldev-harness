# Agent Note: Brain knowledge-vault capability seam

Status: implemented

English | [中文](2026-08-18-brain-knowledge-vault-seam.zh.md)

## Problem

The Web surface had no way to surface a person's existing Markdown knowledge: the sidebar browses Workspaces and Sessions only, and no host capability exposes a read-only directory of notes to the browser or to a model. A person with an Obsidian-style vault wanted that knowledge visible in the sidebar ("Asel's Brain") and, later, reachable by any session through on-demand tools — without the harness coupling itself to Obsidian's own format or writing back into the vault.

Folding the feature into the Workspace domain was wrong on two counts: Workspaces own project directories and per-directory session accounting, while a knowledge vault is a single read-only directory with no sessions; and the model-facing access path (tools) is a different consumer from the UI's read path.

## Decision

The vault is a first-class read-only capability seam, mirroring `ctx.fs` / `ctx.web`:

1. `@deepseek-ai/dsh-brain` (`packages/knowledge/brain`) is the Service Definition: the `BrainStatus` / `BrainTreeNode` / `BrainSearchMatch` vocabulary, the `BrainError` codes, and the abstract `ctx.brain` service with `status`, `list`, `search`, and `read`. All addresses are vault-relative `/`-separated strings.
2. `@deepseek-ai/dsh-brain-local` (`packages/knowledge/brain-local`) is the provider: walks a configured directory, serves the folder/note tree, an in-process bounded substring search, and single-note reads. It registers a `brain` settings namespace (path + `maxResults` / `maxFileBytes` / `maxSnippetChars` bounds) layered over the composition entry, so the Settings surface repoints it live.
3. The wire is three host RPCs — `brain.list` (`{ status, tree }`), `brain.search` (`{ items }`), `brain.read` (`{ path, title, content }`) — in `packages/host/apiproxy/src/api/brain.ts` + `brain.schema.ts`, with new `brain-*` error codes. `brain.list` returns `status.configured === false` as a success for an unconfigured vault; only `read` fails (`brain-unconfigured` / `brain-not-found` / `brain-invalid-path` / `brain-io`).
4. `@deepseek-ai/dsh-client-ui-brain` (`packages/client/ui-brain`) registers the `sidebar.brain` slot (declared by `ui-sidebar`, rendered above `sidebar.workspaces`): a section header + search box, a collapsible folder/note tree, and an inline Markdown reading view with a back button. The vault baseline lives in the client object layer (`BrainRuntime` in `dsh-client-runtime`), exposed through a new `useBrain` standard hook, matching `useWorkspaces`.
5. `ui-settings-plugins` ships a `BrainCard` keyed by the `brain` namespace so the vault path is editable under Settings → Plugins.

The vault is read-only by design: no provider method mutates the directory, and the browser never accepts an arbitrary host path (only vault-relative paths, rejected if absolute or escaping). Search is an in-process substring scan rather than an index or embeddings — bounded so a large vault cannot blow the result or scan size, and upgradeable to ripgrep/FTS later.

## Alternatives considered

### Why not reuse the Workspace domain?

A vault is not a Workspace: Workspaces carry session accounting, per-directory project semantics, and the directory-picker flow. Treating a knowledge directory as a Workspace would surface it under the wrong section and give it session rows it does not have. The seam keeps the two domains independent.

### Why not reuse `ctx.fs` + the existing ripgrep tool directly?

`ctx.fs` is the agent's sandboxed filesystem capability, scoped per session and permission-gated; the vault is a host-level, always-read-only resource shared by the UI and (later) tools. A dedicated `ctx.brain` gives one authoritative containment boundary (vault-relative paths only) and one settings namespace, instead of scattering vault-path knowledge across consumers.

### Why not use an index or embeddings now?

The initial consumer is a personal vault, small enough that a bounded substring scan is correct and simple. An index (SQLite FTS or ripgrep) or embedding retrieval would add a durable cache, a sync problem, and a model-injection design before the read-only surfacing exists. The `brain` seam leaves the search implementation behind the provider so it can be swapped without touching the wire or the UI.

## Consequences

- Three new packages and one new settings namespace plus three `brain.*` RPCs; the seam is the single place the vault path, containment, and search bounds are owned.
- The sidebar gains a bounded section above the Workspace browser; when the sidebar collapses to the rail, the section unmounts (wide-only).
- No model-facing tool shipped at first; the consumer now exists as [`@deepseek-ai/dsh-tool-brain`](2026-08-19-brain-tool-consumer-and-composition.md) (`brain_search` / `brain_read`). Write-back, wikilinks/backlinks, and the graph view remain deferred.
