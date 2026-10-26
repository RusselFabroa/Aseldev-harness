# Isometric office

An opt-in AselDev plugin that renders the current conversation's **team assignments** as a live isometric office in the dsh web GUI. This directory owns the host half (route, store read, mapping) and, separately, the browser half (`client.tsx` and the scene modules); no Harness core or shipped preset changes are required.

## Installation

From the checkout, run `powershell -NoProfile -ExecutionPolicy Bypass -File aseldev/setup-profile.ps1`. It builds this package, links `@aseldev/dsh-office` into the profile plugin search directory, and adds its row after `aseldev-teams` in the AselDev profile patch. Refresh the existing Harness page afterwards; if the running process cannot discover the new client package, restart the normal AselDev launcher — do not start a second server. Host implementation changes require that restart; a browser refresh is not a host-code update.

To disable the scene without touching team data, add an `id: aseldev-office` / `disabled: true` override after the generated AselDev block in the profile patch.

## Data source

The office shows **this conversation's team assignments only** — the tasks the teams plugin persists, never plain `subagent` children. It reads the teams plugin's own store, `<teamsDir>/state.json` (default `$DSH_HOME/teams/state.json`), fresh on every request, and keeps no copy of its own.

The teams `TeamEngine` is deliberately **not** instantiated here: constructing it pauses every team and marks running assignments blocked. The store is read-only for this plugin, so an assignment started, retried, or settled in the Team panel appears in the office on the next poll, and the office can never disagree with the panel.

## Host API

Two routes, loopback only:

```
GET /aseldev-office/api/state?sessionId=<coordinating conversation id>
GET /aseldev-office/api/sessions
x-aseldev-office: 1
```

The sessions route also accepts the optional `x-aseldev-office-session` header naming the conversation that is asking; it only fills `currentSessionId`, and an over-long value answers `400`.

| Answer | When |
|---|---|
| `200` | The office document below, or the session list below. A conversation with no assignments is a normal empty answer (`agents: []`), including before the teams plugin has ever written its store. |
| `400` | `sessionId` is absent, empty, or over 200 characters, or the `x-aseldev-office-session` header is over 200 characters. |
| `403` | The caller is not this computer, the `Host` header is not a local name, the `Origin` header names another host, or `x-aseldev-office` is not `1`. |
| `405` | The method is not `GET`. |
| `500` | The teams store exists but cannot be read or parsed. The scene reports the failure instead of showing an empty office. |

The response is `application/json; charset=utf-8` with `cache-control: no-store`.

### Response fields

```json
{
  "sessionId": "…",
  "updatedAt": "2026-01-02T04:00:00.000Z",
  "boss": { "name": "You", "title": "Founder & team owner" },
  "project": { "name": "AselDev Harness", "objective": "…" },
  "agents": [
    {
      "id": "backend", "name": "Senior Backend Developer", "role": "backend", "title": "Backend developer",
      "accent": "#83c7b3", "status": "working", "progress": 33, "managerId": "boss",
      "specialist": "backend", "task": "Ship the host half",
      "jobs": [
        { "id": "task-a", "title": "Ship the host half", "status": "working", "progress": 50,
          "startedAt": "2026-01-02T03:06:05.000Z", "updatedAt": "2026-01-02T03:06:05.000Z" },
        { "id": "task-b", "title": "Write the mapping", "status": "done", "progress": 100,
          "startedAt": "2026-01-02T03:04:05.000Z", "updatedAt": "2026-01-02T03:05:05.000Z" },
        { "id": "task-c", "title": "Review the route", "status": "blocked", "progress": 50,
          "startedAt": "2026-01-02T03:05:05.000Z", "updatedAt": "2026-01-02T03:05:05.000Z" }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `sessionId` | The coordinated conversation the document was built for. |
| `updatedAt` | When this document was produced (request time). |
| `boss.name`, `boss.title` | The team owner shown at the manager desk: configured name, else the conversation's own title, else `You`, with the configured subtitle. |
| `project.name`, `project.objective` | The label above the office and its one-line objective, from configuration (defaults below). |
| `agents[]` | **One station per saved specialist** in the teams roster, in roster order — never one per assignment. A specialist with three jobs in this conversation is one station with three jobs. |
| `agents[].id` | The saved specialist's id (`backend`, `qa`, …), which is also the station's stable desk identity between polls. |
| `agents[].name` | The specialist's display name, or the role label when the roster entry has none. |
| `agents[].role` | `pm`, `backend`, `frontend`, `design`, `qa`, `devops`, `data`, `security`, `writer`, `research`, or `general`. Derived from keywords in the specialist id and name, never from a job. |
| `agents[].title` | The role's fixed label (`Project manager`, `Backend developer`, …). |
| `agents[].accent` | Stable hex colour per role (palette below). |
| `agents[].status` | The station's aggregate: `working` when any job is running, else `queued` when any job is queued, else `blocked` when any job failed, else `done` when every job is done, else `idle` (including a specialist with no jobs). See the status table below. |
| `agents[].progress` | `round(100 × done jobs ÷ all jobs)`, clamped to `0`–`100`; `0` when the specialist has no jobs. |
| `agents[].managerId` | Always `boss` — every station reports to the manager desk. |
| `agents[].specialist` | The raw specialist id from the store. |
| `agents[].task` | The newest job's title (first line only, at most 240 characters), or `No assignments in this session`. |
| `agents[].jobs[]` | That specialist's assignments in this conversation, newest first. |
| `agents[].jobs[].id` | The teams assignment id (`task-…`). |
| `agents[].jobs[].title` | The assignment title: first line only, at most 240 characters. |
| `agents[].jobs[].status` | The same status vocabulary, from the assignment status aliases below. |
| `agents[].jobs[].progress` | The assignment's own percentage when the store has one, else the percentage its status implies (same rule as the status table below). |
| `agents[].jobs[].startedAt`, `agents[].jobs[].updatedAt` | ISO-8601. `startedAt` is when the assignment was created; `updatedAt` is when it settled, or the creation time while unsettled. Both fall back to `updatedAt` of the document when the store holds no timestamp. |

At most `maxAgents` stations are returned, taking the first specialists in roster order.

An assignment naming a specialist the roster does not hold draws nothing: stations come from the saved roster, so the office never invents a desk.

### Session list fields

`GET /aseldev-office/api/sessions` answers every conversation that has a teams entry, running conversations first and then the most recently updated:

```json
{
  "currentSessionId": "session-queued",
  "sessions": [
    {
      "id": "session-running", "title": "Ship the office", "status": "active",
      "updatedAt": "2026-01-02T03:05:05.000Z",
      "teammates": 1, "working": 1, "running": true
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `currentSessionId` | The conversation asking, from the `x-aseldev-office-session` header, else `null`. It is only a hint for the selector: the client passes the `sessionId` it wants to the state route. |
| `sessions[].id` | The coordinating conversation's id. |
| `sessions[].title` | The conversation's own title from the sessions service, clamped to 200 characters; a conversation without one falls back to its id. |
| `sessions[].status` | The team's own scheduler state: `paused` when the store has the team paused, else `active`. The teams store carries no session status. |
| `sessions[].updatedAt` | ISO-8601: the newest assignment timestamp in that team, else the request time. It is the sort key after `running`. |
| `sessions[].teammates` | That conversation's assignment count. |
| `sessions[].working` | How many of them are `working`. |
| `sessions[].running` | Whether at least one assignment is `queued`, `starting`, `working`, or `canceling`. |

At most `maxSessions` rows are returned, in that order. A store with no teams answers `200` and `{"currentSessionId": …, "sessions": []}`.

### Status vocabulary

The host emits these six statuses, on a job and (aggregated) on its station. Matching is case-insensitive and treats spaces and underscores as hyphens, so `in_progress` and `settled_ok` match `in-progress` and `settled-ok`; every status the teams store can hold maps onto one of them, and an unrecognised value is `idle`.

| Office status | Assignment statuses it accepts |
|---|---|
| `working` | `starting`, `working`, `running`, `in-progress` (`in_progress`, `inprogress`), `active`, `busy` |
| `queued` | `queued`, `pending`, `waiting`, `scheduled` |
| `done` | `done`, `awaiting`, `settled-ok` (`settled_ok`), `settled`, `complete`, `completed`, `finished`, `success`, `succeeded`, `ok` |
| `blocked` | `failed`, `blocked`, `error`, `errored`, `stuck` |
| `offline` | `canceled`, `cancelled`, `canceling`, `cancelling`, `stopped`, `offline`, `terminated` |
| `idle` | `idle`, `none`, and any unknown value |

The scene's own vocabulary carries a seventh status, `review` ("needs your approval"). **The host never emits it today**: the teams store has no awaiting-approval assignment state, and an `awaiting` assignment is a finished one (`done`). The scene path for `review` exists and is unused until a store gains a needs-approval status.

### Role accents

| Role | Accent | Role | Accent |
|---|---|---|---|
| `pm` | `#73b9ec` | `devops` | `#91b995` |
| `backend` | `#83c7b3` | `data` | `#a7bde5` |
| `frontend` | `#94baff` | `security` | `#dba0a9` |
| `design` | `#c3a5df` | `writer` | `#c1c6ae` |
| `qa` | `#e6c18a` | `research` | `#9ccbd2` |
| | | `general` | `#9eb2cb` |

## Host configuration

Set these fields in the `aseldev-office` profile row. Keep user overrides outside the generated setup block.

| Field | Purpose |
|---|---|
| `teamsDir` | Folder holding the teams plugin's `state.json`; defaults to `$DSH_HOME/teams`. Point both plugins at the same folder if you override the teams plugin's `dir`. |
| `bossName`, `bossTitle` | Manager name and subtitle. The name falls back to the conversation's own title (clamped to 200 characters; a missing or unusable title falls back to `You`), and the subtitle defaults to `Founder & team owner`. |
| `projectName`, `projectObjective` | Project label and objective; default to `AselDev Harness` and a one-line objective. |
| `maxAgents` | Stations in one document, `1`–`500`; default `24`. The first specialists in roster order are kept. |
| `maxSessions` | Rows in one session list, `1`–`500`; default `50`. Running and most recently updated ones are kept. |

Invalid values fail the plugin entry at load rather than degrading the scene.

## Styles

`office.css` is the maintainable source of the overlay's stylesheet. The browser bundle cannot import CSS (a tsdown browser bundle without `@tsdown/css` rejects a `.css` import), so `client.tsx` carries the same text as `OFFICE_CSS` and injects it as one `<style>` element while the panel is open; `client.test.mjs` fails when the two copies drift apart.

Every overlay rule is scoped under the `.aseldev-office` root class, so the dsh web shell is untouched. `LAUNCHER_CSS` is the one deliberate exception: it styles the sidebar launcher button through the global `.aseldev-office-launch*` classes, because the launcher renders in the sidebar column **outside** the overlay subtree, where a `.aseldev-office`-scoped selector would never match. Those three rules are the only global ones, and every class they name is prefixed with the plugin's own `aseldev-office-launch` name.

## Known Limitations and Deferred Work

- Read-only: the office cannot assign, retry, cancel, or message a teammate. Those actions run through the Team panel or `team_manage`, which apply concurrency limits and path reservations.
- The state route draws one conversation. Only the session list spans conversations, and only as a selector: it reports counts, not another conversation's teammates.
- Stations are the saved roster, so a conversation's office shows every specialist even when most of them idle; the roster's own order decides where a desk sits until a specialist is removed.
- The page decides its own poll interval; the host holds no timer and no cached document.
- The boss name and both cards are per plugin configuration plus the conversation's own title; a per-conversation project name is not stored.
- The teams store is read per request. A very large team history costs one parse per poll, bounded by `maxAgents` and by `maxSessions` on the response side; every assignment of a station's roster entry is included in full.
- Assignment status is what the teams store last committed. A worker that is finishing now can appear `working` for one poll.
- The routes are restricted to loopback callers with a same-origin custom header. Remote or LAN viewing is not supported.

## Checks

`node aseldev/plugins/office/build.mjs` builds both halves into `lib/`, copies `state.mjs` beside the host bundle, and asserts the emitted host bundle is plain ESM with only builtin or relative imports. `node aseldev/plugins/office/build.mjs --check` fails when `lib/` is stale with respect to any source the bundles carry: `host.ts` and `state.mjs` for the host, and `client.tsx`, `scene.tsx`, and `office.css` for the client.

`node aseldev/plugins/office/host.test.mjs` covers the host: the mapping (one station per saved specialist, jobs grouped and ordered newest first, the aggregate status and progress, an idle specialist, roster order, the cap, unknown-specialist assignments, status normalization, role and accent derivation, card defaults, the title clamps, the session list's running-first order and cap) and the built routes (403 without the trust header or from another origin, 400 for a bad `sessionId`, 405 for a non-GET, 200 with `agents: []` when no store exists, 200 with an empty session list, 500 for a corrupt store on both routes). `node aseldev/plugins/office/client.test.mjs` covers the browser half: the bundle's launcher and locale, the scoped stylesheet, the scene's station layout, and the panel and modal renders. `npm --prefix aseldev/plugins/office run test` builds first, then runs both suites.
