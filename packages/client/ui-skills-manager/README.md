# `@deepseek-ai/dsh-client-ui-skills-manager`

AselDev addition. Adds **Settings → Skills**: a page that lists the skills in the `aseldev-skills` folder and lets you create, edit (the whole `SKILL.md`), and delete them. Deleted skills move to `aseldev-skills/.trash/`. The file operations are served by the separate host plugin `aseldev-plugins/skills-manager/host.ts`, loaded from the profile patch; this package is presentation only.

## Model Experience

None, as this package is presentation only: it edits skill files on disk, and the skill loader picks the changes up for later turns.

#### KV Cache effect

None; nothing in this package reaches a model request.

## Known Limitations and Deferred Work

- Edits the `SKILL.md` file only; scripts and reference files beside it are listed but edited elsewhere.
- No rename: create the new name, copy the text, delete the old one.
