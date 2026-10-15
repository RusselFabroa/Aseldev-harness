# `@deepseek-ai/dsh-tool-brain`

The model-facing consumer of the brain seam ([`ctx.brain`](../brain/README.md)): two read-only tools, `brain_search` and `brain_read`, through which an agent can look up and load notes from the deployment's personal knowledge vault.

## What it does

Registers `brain_search(query)` and `brain_read(path)` on `ctx.tools`. `brain_search` runs the provider's bounded case-insensitive full-text search and returns `{ configured, matches }`, each match carrying the vault-relative `path`, the `title`, and a bounded snippet. `brain_read` returns one note's Markdown body as `{ path, title, content }`. The provider resolves at execution time via a strict optional-service read, so mount order relative to the provider row is irrelevant.

## Unconfigured and unmounted deployments

A vault path is a deployment choice owned by the provider's settings namespace, not by this package. While no path is set, `brain_search` answers the structured value `configured: false` with an empty match list, and `brain_read` fails with guidance pointing at Settings → Plugins → Brain — an honest answer instead of a bare provider error. A composition that mounts no brain provider at all fails loud on both tools (`knowledge-vault provider is not mounted`). Invalid input (a blank query) and provider rejections (an escaping or missing note path) surface as ordinary tool errors.

## Configuration

None. Search bounds (`maxResults`, `maxFileBytes`, `maxSnippetChars`) belong to the [`@deepseek-ai/dsh-brain-local`](../brain-local/README.md) provider config; this consumer adds no tunables of its own.

## Rendering

Both calls present as generic cards — a `search`-kind pending card for `brain_search` and a `read`-kind card for `brain_read`. The completed `brain_read` card renders the note body; there is no dedicated result view and no durable presentation metadata.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`brain_search` / `brain_read` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-brain).

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

### Tool-call history and result

#### What the model sees

Success renders the matched-note list or the full note body. Stable failures are ``Error: invalid brain_search call: `query` must be a non-empty string``, ``Error: the knowledge-vault provider is not mounted``, `Error: invalid note path: <path>`, `Error: note not found: <path>`, and the unconfigured-vault guidance for `brain_read`.

#### Token effect

Result growth tracks what the model requested: bounded snippets for searches, one whole note body per read. Note bodies are uncapped by this package and count toward the request until compaction; the provider's read bound caps a single note's bytes.

#### KV Cache effect

Append-only; newly visible results follow the reusable request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Read-only** — write-back (note creation/edit) is a separate design fork of the deliberately read-only brain seam.
- **No vault outline** — the model discovers notes only through `brain_search`; there is no list/tree tool, so discovery depends on query choice. An index-backed or embedding search may replace the substring scan behind the unchanged provider interface.
