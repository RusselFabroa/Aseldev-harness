# `@deepseek-ai/dsh-client-ui-brain`

Asel's Brain sidebar section: a read-only Obsidian-like knowledge-vault browser. It fills the shell's `sidebar.brain` slot above the workspace browser with a folder/note tree, a full-text search box, and an inline Markdown reading view, all over the `brain.*` host capability.

## Model Experience

None, as this package is presentation only: it renders the vault baseline and Host read results without changing any model request.

#### KV Cache effect

None; nothing in this package reaches a model request.

## Known Limitations and Deferred Work

- The section reads the vault read-only; no note creation or editing.
- No wikilink resolution, backlinks, tag pane, or graph view.
