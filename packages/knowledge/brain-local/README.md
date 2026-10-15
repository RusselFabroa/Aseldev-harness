# `@deepseek-ai/dsh-brain-local`

Local-filesystem provider for the brain seam (`ctx.brain`). It walks one configured directory of Markdown notes and serves the folder/note tree, a bounded case-insensitive full-text search, and single-note reads. The vault path is a `brain` settings namespace layered over the composition entry, so the Web configuration surface can repoint it live.

## Model Experience

None, as this package is the provider half of the seam: it contributes no tokens, tools, prompt sections, or context, and the model-facing consumer lives in [`@deepseek-ai/dsh-tool-brain`](../tool-brain/README.md).

#### KV Cache effect

None; nothing in this package reaches a model request.

## Known Limitations and Deferred Work

- Search is an in-process substring scan over note bodies, bounded by `maxResults` / `maxFileBytes`. A ripgrep- or FTS-backed search may replace it if vaults grow large.
