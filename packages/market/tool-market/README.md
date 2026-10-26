# @deepseek-ai/dsh-tool-market

English | [中文](README.zh.md)

Model-facing plugin-market tools over `ctx.market`: `market_search` finds installable DSH plugins, and `plugin_install` installs one into the configured profile. This package owns the schemas, the argument checks the DSL cannot express, result formatting, and render intent; registry access and package management stay in the provider.

`plugin_install` is a security-sensitive operation — it runs the machine user's package manager and changes what the next boot mounts — so it asks the approval seam (`ctx.get('approval')`) before installing and fails closed: no approval channel, no agent to route the question through, a rejection, a cancellation, or an `unavailable` answer all end the call with an explanatory error and no install. A grant is one-shot and covers exactly the package named in the request.

| Tool | Render intent | Notes |
|---|---|---|
| `market_search` | generic, `kind: 'read'` | Concurrency-safe registry read; the provider's entry bound caps the result |
| `plugin_install` | generic, `kind: 'execute'` | Serialized by the registry's default non-safe classification; asks approval first |

## Config

| Field | Default | Meaning |
|---|---|---|
| `searchTimeoutMs` | `30000` | Cooperative budget for one `market_search` call |
| `installTimeoutMs` | `300000` | Cooperative budget for one `plugin_install` call |

Both are attached as `ToolDefinition.timeoutMs` for [`dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) to enforce.

## Model Experience

### `market_search`

#### What the model sees

The schema is catalogued under [`market_search`](../../../docs/tool-catalog.md#market_search). The tool description states that it searches the plugin registry for installable DSH plugins and returns each name, version, and description; the `query` parameter asks for words describing what the plugin should do, and `limit` says the deployment caps the count. The result text lists one `- name@version — description` line per plugin, then instructs installing one with `plugin_install`; an empty result says no installable plugins matched and names both discovery rules — the `@deepseek-ai/dsh-` scope and the `dsh` manifest field.

#### Token effect

Variable: one line per returned entry, capped by the deployment's `maxResults` (default 10) plus two fixed sentences.

#### KV Cache effect

Append-only; a call's result follows the reusable request prefix. The unconditional tool schema is stable across calls, so registering this package does not invalidate a reusable prefix beyond the first request that carries it.

### `plugin_install`

#### What the model sees

The schema is catalogued under [`plugin_install`](../../../docs/tool-catalog.md#plugin_install). The tool description states that installing runs the machine user's package manager, changes what the next boot mounts, and requires user approval. `package` must be the exact name `market_search` returned; `version` pins an exact published version. The result text names the installed package and version, the profile directory, and — because the running process never mounts a new plugin — that a restart is required. A refused call throws the reason: the user rejected it, the approval was cancelled, no approval channel exists, the package is not a published DSH plugin, or the package manager failed with its own stderr tail.

#### Token effect

Fixed: one short sentence per call, plus the package-manager stderr tail (capped by the provider's `maxOutputBytes`) when an install fails.

#### KV Cache effect

Append-only; a call's result follows the reusable request prefix and never rewrites an earlier message.

## Known Limitations and Deferred Work

- **No uninstall or upgrade tool.** The seam exposes search and install only.
- **The model cannot see what is already installed.** Search reports the registry, not the profile, so a second `plugin_install` of the same package is reported as a fresh install.
- **A grant is per call.** The approval seam offers `allowed-once` only, so repeated installs ask repeatedly.
- **The approval gate covers this tool, not the wire.** An install requested through `market/install` from the Web settings tab asks nobody; [`dsh-market`](../market/README.md) owns that limitation and the reason the seam cannot answer a wire-initiated ask.
- **`market_search` has no result view.** Its completed card keeps the pending generic title and the raw result content, because the entry list is already flat text a UI can render unchanged.
