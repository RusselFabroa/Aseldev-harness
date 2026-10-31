---
name: brain
description: Search and read Asel's Brain knowledge vault for relevant context, then cite the note paths used. Invoke with /brain search <terms>, /brain read <note path>, /brain context <question>, or /brain sources <question>.
---

# Brain

## Command forms

Treat the word immediately after `/brain` as the requested mode; the harness injects this skill but does not parse subcommands. Use:

- `/brain search <terms>` to find notes by distinctive keywords.
- `/brain read <note path>` to inspect one exact vault-relative `.md` path.
- `/brain context <question>` to search, read relevant matches, and answer with citations.
- `/brain sources <question>` to find relevant context and return the exact paths of notes actually read.

If no mode is given, use `context`. For an unknown mode, explain the four forms and use `context` if a question was provided.

Use the existing `brain_search` and `brain_read` tools to consult Asel's Brain. This skill is read-only: do not use `brain_write` unless Asel separately asks to save or update a note. Follow all Brain privacy and access rules provided in the system instructions. Never search, open, quote, link to, or write the private folder or any note containing credentials or personal contact details. If a result appears to expose private or credential/contact information, do not repeat it; stop and ask Asel for the specific needed detail.

## Search

For a topic or question:

1. Call `brain_search` with a concise query using the most distinctive terms.
2. Review the returned titles, snippets, and vault-relative paths. Search again with a narrower or alternate term when needed; do not claim the search covered the entire vault.
3. Report the most relevant matches with their exact note paths. Snippets are discovery aids, not a substitute for reading the note.

If `/brain` arrives without a topic, ask Asel what to look up.

If a tool reports that Brain is not configured, relay its Settings → Plugins → Brain guidance and stop rather than using shell, filesystem, or another route to access the vault.

## Read

To inspect a specific note, call `brain_read` with the exact vault-relative `.md` path returned by `brain_search` or provided by Asel. Summarize only the portions relevant to the request. Do not guess paths or read neighboring notes without searching for them first.

## Context

To answer a question using Brain context:

1. Search for the question's key terms and likely project or decision names.
2. Read only the promising notes returned by search.
3. Synthesize the relevant facts, distinguishing what the notes state from inference. Note any conflict or missing information instead of silently resolving it.
4. Cite each Brain note used by its exact vault-relative path, preferably beside the fact it supports.

Keep the lookup focused. Do not dump whole notes or unrelated personal context into the answer. Brain is not guaranteed to be exhaustive or current; mention that limitation when it affects the answer.

## Sources

When Brain contributes to an answer, include a short **Brain sources** list with the exact vault-relative paths of notes actually read. Do not cite search-result snippets as if the note itself was read. If no note was read, say that Brain search returned no source note rather than inventing a citation.
