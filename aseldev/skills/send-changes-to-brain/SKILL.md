---
name: send-changes-to-brain
description: Save a dated summary of what changed in the current session (files edited, decisions made, open items) as a Markdown note in Asel's Brain, the Obsidian vault. Run only when the user types /send-changes-to-brain.
disable-model-invocation: true
---

# Send changes to brain

Write one note into the user's vault that captures what this session changed, then report the note path.

## 1. Collect the changes

Build the summary from what actually happened in this session:

- **Changed files**: every file created, edited, or deleted, with one line on why. If the workspace is a git repo, run `git status --short` and `git diff --stat` to confirm the list; never invent files.
- **Decisions**: choices the user made or approved, and the reason when one was given.
- **Open items**: anything unfinished, failing, or explicitly deferred.
- **Next steps**: only steps the user agreed to or asked for.

Leave out secrets, API keys, tokens, and credential values even if they appeared in the session.

## 2. Format the note body

```markdown
## <HH:mm> · <short session title>

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

Omit a section that would be empty. Keep each bullet to one line.

## 3. Save it with the helper

Pipe the body into the helper script beside this file. It resolves the vault (env `ASELDEV_BRAIN_VAULT`, else the `brain.path` setting in `$DSH_HOME/settings.yaml`), writes to `01 - Inbox/<YYYY-MM-DD> - <workspace>.md`, creates the note with frontmatter the first time, and appends to it on later runs the same day.

PowerShell:

```powershell
@'
<note body from step 2>
'@ | node "<this skill's folder>/scripts/save-note.mjs" --workspace "<workspace folder name>"
```

bash:

```bash
node "<this skill's folder>/scripts/save-note.mjs" --workspace "<workspace folder name>" <<'EOF_NOTE'
<note body from step 2>
EOF_NOTE
```

Optional flags: `--folder "<vault subfolder>"` (default `01 - Inbox`), `--date YYYY-MM-DD`.

## 4. Report

Tell the user the note path the script printed, and whether it created a new note or appended to today's note. If the script fails, show its error message and do not retry with a different location unless the user says so.
