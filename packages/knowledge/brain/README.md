# `@deepseek-ai/dsh-brain`

Read-only knowledge-vault capability seam (`ctx.brain`). It defines the vault vocabulary (`BrainStatus`, `BrainTreeNode`, `BrainSearchMatch`, `BrainError`) and the abstract `BrainService` a local vault provider implements: `list` (whole-tree walk), `search` (bounded full-text substring match), and `read` (single note by vault-relative path).

## Model Experience

None, as this package is the Service Definition only: it contributes no tokens, tools, prompt sections, or context, and the model-facing consumer lives in [`@deepseek-ai/dsh-tool-brain`](../tool-brain/README.md).

#### KV Cache effect

None; nothing in this package reaches a model request.

## Known Limitations and Deferred Work

- Search is an in-process substring scan over note bodies (bounded by the provider's configured caps), not an index. A ripgrep- or FTS-backed search may replace it if vaults grow large.
- No wikilink resolution, backlinks, tag pane, or graph — the sidebar surface is browse + search + preview only.
