---
name: send-changes-to-brain
description: Save a dated summary of what changed in the current session (files edited, decisions made, open items) to today's dev-log note in Asel's Brain, the Obsidian vault, then suggest where else it could be filed. Run only when the user types /send-changes-to-brain.
disable-model-invocation: true
---

# Send changes to brain

Write this session's changes into today's dev-log note in Asel's Brain with the `brain_write` tool, then suggest where the lasting parts could also be filed. Only the dev-log note is written without asking; project and knowledge notes are updated only when Asel says yes.

## 1. Collect the changes

Build the summary from what actually happened in this session:

- **Changed files**: every file created, edited, or deleted, with one line on why. If the workspace is a git repo, run `git status --short` and `git diff --stat` to confirm the list; never invent files.
- **Decisions**: choices the user made or approved, and the reason when one was given.
- **Open items**: anything unfinished, failing, or explicitly deferred.
- **Next steps**: only steps the user agreed to or asked for.

Leave out secrets, API keys, tokens, and credential values even if they appeared in the session. Never link to or quote anything from `05 - Private`.

## 2. Format the entry

```markdown
**Workspace:** <workspace folder name>

### Changed files
- `path/to/file` — why

### Decisions
- ...

### Open items
- ...

### Next steps
- ...
```

Omit a section that would be empty. Keep each bullet to one line. Do not add a date or time heading: `brain_write` adds `## YYYY-MM-DD HH:mm · <heading>` itself.

## 3. Save it to today's dev log

Call `brain_write` once:

| Argument | Value |
| --- | --- |
| `action` | `"create"` |
| `folder` | `"01 - Inbox"` |
| `title` | the workspace folder name (the file becomes `01 - Inbox/YYYY-MM-DD - <workspace>.md`) |
| `heading` | a short session title, e.g. `"Brain write tool"` |
| `content` | the entry from step 2 |
| `type` | `"dev-log"` |
| `tags` | `["dev-log", "aseldev-harness"]` |
| `ifExists` | `"append"` (later runs the same day add a new section to the same note) |

The tool writes the frontmatter and the `Parent:` link on the first run of the day. Inbox writes need no approval.

If `brain_write` is not available or refuses the call, show its message and stop. Only as a fallback when the tool is missing (older build), pipe the entry into `scripts/save-note.mjs` beside this file (`node "<this skill's folder>/scripts/save-note.mjs" --workspace "<workspace>"`, entry on stdin); that helper is being retired.

## 4. Suggest filing

After saving, look for lasting knowledge in the entry and list at most five suggestions, each with the exact target and the one or two lines you would add:

- a decision or change for a project → that project's change log or overview under `02 - Projects` (find the note with `brain_search`; give its path);
- a reusable lesson or how-to → a note under `04 - Technical Knowledge`;
- a reusable agent instruction → `03 - AI Skills`.

Write nothing for these yet. Ask Asel which ones to file. Only for the ones he says yes to, call `brain_write` with `action: "append"`, the `note` path, a short `heading` and the lines; he will also get an approval prompt for each, because those folders are outside the Inbox. If nothing lasting came up, say so in one line and skip the list.

Never suggest writing to `05 - Private`, `00 - AI Assistant Start Here` (the guide and Knowledge Base), `99 - Archive` or `_Templates`; the tool refuses them anyway.

## 5. Report

Tell Asel the dev-log note path and whether it was created or appended to, then the suggestions from step 4 (or that there were none).
