# AselDev Harness

My personal build of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), a plugin-based AI agent that runs on your own computer and opens in your browser at **http://127.0.0.1:3080**.

What this build adds on top of DeepSeek Harness:

| Feature | Where to find it |
|---|---|
| **AselDev branding**: name, `‹A›` code-bracket logo, favicon | Sidebar, browser tab |
| **ChatGPT / Codex sign-in**: use your ChatGPT plan instead of an API key | Settings → Models → OpenAI Codex |
| **Asel's Brain**: one sidebar button opens a large window over your Markdown (Obsidian) vault: folder tree, search, reader | Sidebar → Asel's Brain |
| **Brain for agents**: every agent can search, read and write the vault (`brain_write`: Inbox notes at once, other folders after a Yes/No prompt), gets the guide's core card in every chat, and can never reach `05 - Private` | Any chat, `/send-changes-to-brain` |
| **Skills page**: browse, create, edit and delete your personal skills; pick the skills folder | Settings → Skills, and type `/` in a chat |
| **Artifacts**: the agent makes live pages, documents, SVGs and diagrams, with versions, a sandboxed viewer and a library | Chat cards, Sidebar → Artifacts |
| **Helper scripts**: one-click rebuild and start | `rebuild-aseldev.cmd`, `start-aseldev.cmd` |

Everything runs locally. Your chats, sign-ins and artifacts stay in `%USERPROFILE%\.dsh-aseldev` on each computer and are **never** part of this repository.

---

## 1. What you need (once per computer)

| Tool | Version | How to check | Get it |
|---|---|---|---|
| Windows | 10 or 11 | | The scripts are PowerShell / `.cmd` (see [Other systems](#other-systems)) |
| Git | any recent | `git --version` | https://git-scm.com/download/win |
| Node.js | **24 LTS** (or 22.19+) | `node -v` | https://nodejs.org |
| pnpm | **11** | `pnpm -v` | `npm install -g pnpm@11.7.0` |
| A browser | Chrome or Edge | | |

Open a **new** terminal after installing so `node` and `pnpm` are found.

## 2. First-time setup on a new computer

**Step 1: clone the repository.** Pick a short folder outside OneDrive (the install has a lot of files):

```powershell
git clone https://github.com/RusselFabroa/Aseldev-harness.git C:\AselDev\Aseldev-harness
cd C:\AselDev\Aseldev-harness
```

**Step 2: install, build and start.** Double-click **`rebuild-aseldev.cmd`** in that folder, or run:

```powershell
.\rebuild-aseldev.cmd
```

It does everything in order:

1. stops anything already running on port 3080
2. `pnpm install`, which downloads packages (takes a few minutes the first time)
3. `pnpm run build`, which compiles everything (also a few minutes the first time)
4. `aseldev\setup-profile.ps1`, which points your profile at this folder's plugins and skills
5. starts AselDev Harness

The build log is saved to `%USERPROFILE%\.dsh-aseldev\last-build.log`. When you see `dsh web: http://127.0.0.1:3080`, it's running. Keep that window open while you use it.

**Step 3: open it.** Go to **http://127.0.0.1:3080** in your browser.

**Step 4: connect a model.** Open **Settings (bottom left) → Models** and choose one:
- **OpenAI Codex → Sign in** uses your ChatGPT account (a browser window opens to log in).
- **Add an API key** for DeepSeek, OpenRouter, Anthropic and others. Keys are stored in `%USERPROFILE%\.dsh-aseldev\.credentials.yaml` on this computer only.

**Step 5 (optional): personal setup.**
- **Brain**: Settings → Plugins → Brain → *Vault path*, the full path of your Obsidian vault.
- **Skills**: Settings → Skills. By default they live in this repo's `aseldev\skills` folder, so they travel with `git pull`. You can point the page at another folder there.

That's it. From now on, use **`start-aseldev.cmd`** to start.

## 3. Everyday use

| I want to… | Do this |
|---|---|
| Start the app | Double-click `start-aseldev.cmd`, then open http://127.0.0.1:3080 |
| Stop the app | Close its window (or press `Ctrl+C` in it) |
| Apply code changes | Double-click `rebuild-aseldev.cmd` |
| Check everything like a fresh clone (after a pull from DeepSeek, or when another computer fails to build) | `.\rebuild-aseldev.cmd full` |
| Get changes made on another computer | `git pull`, then `rebuild-aseldev.cmd` |
| Save and share my changes | `git add -A`, `git commit -m "…"`, `git push` |

### Getting DeepSeek's own updates

This repository keeps DeepSeek's history, so their updates merge in. In a new clone, add their repo once:

```powershell
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
```

Then, whenever you want their latest:

```powershell
git fetch upstream
git merge upstream/master
.\rebuild-aseldev.cmd
```

If git reports conflicts, they're almost always in files listed under [What is customized](#what-is-customized). Keep both sides' intent, then commit.

## 4. Where things live

**In this repository** (shared across computers):

| Path | What |
|---|---|
| `aseldev\plugins\skills-manager\host.ts` | Settings → Skills backend and the skill loader for your skills folder |
| `aseldev\plugins\artifacts\host.ts` | The agent's `artifact` tool, version storage and the sandboxed viewer pages |
| `aseldev\plugins\brain\host.ts` | Brain rules for agents: the `05 - Private` block, the core card, and the `brain_write` tool |
| `aseldev\skills\` | Your personal skills (`<name>\SKILL.md`) |
| `aseldev\setup-profile.ps1` | Connects the plugins and the skills folder to your profile |
| `start-aseldev.cmd`, `rebuild-aseldev.cmd` | Start / rebuild helpers |
| `packages\…` | The harness itself, with the AselDev changes |

**On each computer only** (`%USERPROFILE%\.dsh-aseldev`, never committed):

| Path | What |
|---|---|
| `settings.yaml` | Your settings (model, theme, Brain path, skills folder) |
| `.credentials.yaml` | API keys and sign-ins. **Never share or commit this.** |
| `sessions\` | Your conversations |
| `artifacts\` | Saved artifacts, one folder per artifact, one file per version |
| `profiles\web\cordis.patch.yml` | Your profile; the `# >>> aseldev` block is written by `setup-profile.ps1` |
| `last-start.log`, `last-build.log` | Output of the last start and build, for troubleshooting |

AselDev uses its own `.dsh-aseldev` folder, so it never clashes with the official `npx @deepseek-ai/dsh` (which uses `.dsh`).

## 5. What is customized

<a id="what-is-customized"></a>

| Area | Packages / files |
|---|---|
| Branding | `packages/client/ui-primitives` (`FishLogo.tsx`, `BrandWordmark.tsx`), `apps/web/index.html`, `apps/web/public/*` |
| Codex sign-in | `packages/llm/llm-pi-ai` (`sign-in.ts`), `packages/host/apiproxy`, `packages/client/connection`, `packages/client/ui-settings-models` (`SignInPanel.tsx`) |
| Brain | `packages/knowledge/*`, `packages/client/ui-brain`, `packages/client/ui-settings-plugins` (`BrainCard.tsx`) |
| Skills page | `packages/client/ui-skills-manager`, `aseldev/plugins/skills-manager` |
| Artifacts | `packages/client/ui-artifacts`, `aseldev/plugins/artifacts`, plus one extra sidebar slot (`sidebar.launcher`) in `packages/client/ui-sidebar` |
| pi-ai 1.2.0 compatibility (newer models such as `gpt-6-sol`) | `packages/llm/llm-pi-ai/package.json` + `pnpm-lock.yaml` (pi-ai `^1.2.0`), and small type fixes in `src/catalog.ts`, `src/replay.ts`, `src/sign-in.ts`, `src/stream.ts`, `tests/catalog.spec.ts` (marked `AselDev (pi-ai 1.2.0 compatibility)`). If DeepSeek upgrades pi-ai themselves, take **their** version of these files. |
| Wiring | `tsconfig.client.json`, `packages/bundle/web-app/cordis.patch.yml` and `package.json` |

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| The window closes right away / "port already in use" | Something else is using port 3080 (often another copy of the app). `rebuild-aseldev.cmd` stops it; or close the other window. |
| Build failed | Open `%USERPROFILE%\.dsh-aseldev\last-build.log`, scroll to the first `error`. |
| It started but a feature is missing (Skills page, Artifacts button) | Press `Ctrl+F5` in the browser. Pages opened before a rebuild keep the old code. |
| Edge shows an empty sidebar but Chrome works | Edge kept old site data from the official version. Edge → Settings → Cookies and site permissions → *127.0.0.1* → Delete data, then reload. |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` or "Cannot find module …host.ts" | The profile points at an old folder. Run `powershell -ExecutionPolicy Bypass -File aseldev\setup-profile.ps1`. |
| "running scripts is disabled on this system" | The `.cmd` files already bypass this. If you run a `.ps1` directly, use `powershell -ExecutionPolicy Bypass -File <script>`. |
| `pnpm` not found | `npm install -g pnpm@11.7.0`, then open a new terminal. |
| No `/` skills in chat | Skills show inside a session: open or start one, then type `/`. Check Settings → Skills for the folder. |

<a id="other-systems"></a>
### Other systems (macOS / Linux)

The harness itself runs there. Instead of the `.cmd` helpers:

```bash
pnpm install && pnpm run build
export DSH_HOME="$HOME/.dsh-aseldev"
# add the aseldev block to $DSH_HOME/profiles/web/cordis.patch.yml by hand (see aseldev/setup-profile.ps1 for its content, using file:// URLs to this clone)
pnpm dsh web
```

## 7. Credits and license

Based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by DeepSeek, MIT License (see `LICENSE`). Their original README, architecture and developer docs: https://github.com/deepseek-ai/deepseek-harness#readme and the `docs/` folder.
