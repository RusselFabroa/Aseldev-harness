# AselDev Skills

Personal skills for AselDev Harness (and any agent that reads `SKILL.md` folders).
This folder is the single source of truth: edit skills here, never copies.

## Layout

```
aseldev-skills/
  <skill-name>/          folder name = the skill's `name`, kebab-case
    SKILL.md             frontmatter + instructions
    scripts/             optional helpers the skill runs
    references/          optional extra docs the skill reads on demand
```

## Frontmatter cheat sheet

```yaml
---
name: my-skill                    # must equal the folder name
description: When to use it ...   # the agent decides from this line alone
disable-model-invocation: true    # optional: only YOU can run it, via /my-skill
user-invocable: false             # optional: hide it from the / menu (agent-only)
---
```

- Command skills (save / post / send) → `disable-model-invocation: true`.
- Knowledge skills (rules, conventions) → leave both keys out.
- No hardcoded paths or secrets: read them from env vars or the harness settings.

## How the harness loads this folder

This folder lives in the AselDev Harness repository (`aseldev/skills`), so your
skills travel with `git pull`. `aseldev/setup-profile.ps1` (run by
`rebuild-aseldev.cmd`) adds the `aseldev-skills-manager` plugin to your profile;
it watches only this folder, so new or edited skills appear without a restart.

To use a different folder, open Settings > Skills, type the full path in
"Skills folder" and click "Use this folder" (saved in
`~/.dsh-aseldev/settings.yaml` as `aseldev-skills.path`; "Use default" comes back here).
