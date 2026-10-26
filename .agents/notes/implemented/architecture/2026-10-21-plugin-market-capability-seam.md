# Agent Note: plugin market as a capability seam

Status: implemented

English | [中文](2026-10-21-plugin-market-capability-seam.zh.md)

## Problem

Nothing in the repository could discover or install a DSH plugin. A user who wants a plugin had to find its npm name, edit a profile's `package.json`, and hand-write a loader row — three steps with no shared implementation, no model-facing path, and nothing a settings page could call. The two audiences (the agent through tools, the Web GUI through a Remote) also had no common operation set, so building either one first would have invented its own copy of search and install.

## Decision

The plugin market is a capability seam with all three roles, in a new `packages/market/` group:

| Package | Role | `ctx` key |
|---|---|---|
| `market` | Service Definition (`MarketService`, named export), the seam's config contract, and the Remote gateway (default export) | `ctx.market` |
| `market-npm` | Service Provider against the npm registry | registers `ctx.market` |
| `tool-market` | Consumer: `market_search` and `plugin_install` | registers on `ctx.tools` |

`search(request, signal?)` returns at most the configured entry bound; `install(request, signal?)` installs one package into one configured profile. Both take an abort signal, which the tools forward from `exec.signal` and the Remote methods omit — the wire carries no cancellation.

### Why the Remote gateway lives in the Definition package

`MarketGateway` registers the Cordis service key `marketGateway` and binds it to the wire namespace `market`, so the published methods are `market/search` and `market/install` without colliding with the `ctx.market` service key. It has no state and no policy: every call forwards to the mounted provider, so the browser and the tools share one implementation, and any future registry provider serves both for free. Keeping it in the Definition package means the wire contract and the seam types are one artifact, as `dsh-host-plugin-inventory` keeps its gateway beside its projection.

### Discoverability: the official scope, or the `dsh` manifest field

A package is a DSH plugin when its name starts with `@deepseek-ai/dsh-` or its published `package.json` carries a truthy `dsh` field; [the scope rule](../feature/2026-10-21-plugin-market-discovery-by-scope.md) records why the name rule joined the field. Search asks the registry index for candidates and then fetches each candidate's manifest, because the index describes packages and only the manifest carries the version and description the entry reports. A candidate the registry does not serve at that version, or one that satisfies neither rule, is dropped silently — that is the filter, not an error. Transport and server failures still throw.

Verified scope of the `dsh` field across this repository: 45 of 225 packages declare it, and all of them are bundles (`dsh.bundle`) or browser plugins (`dsh.client`). Host plugin packages — tools, providers, Service Definitions — declare none and are found by scope instead, so no published manifest needed to change. Install applies the same acceptance test, so the marketplace can never be used to install an arbitrary package by name.

### Install writes only the profile, and activation is a restart

Install mirrors what the launcher already does, with no parallel mechanism:

1. `resolveMarketConfig()` resolves the target directory with the launcher's own `resolveProfileDir(profile, home)`, so the market can only address a directory `dsh --profile` would load, and derives the patch path from `PROFILE_PATCH_FILENAME`.
2. `packageManager` runs `add <name>@<exact-version>` through `ctx.subprocess` with the profile directory as `cwd`, the caller's signal attached to the process tree, its store pinned to `<dshHome>/profiles/.pnpm-store`, and bounded collected streams — no state lands outside the profile or the harness home.
3. The profile's own `cordis.patch.yml` gains one insert row (`id: market-<slug>`, `name: <package>`). That is the layer the launcher applies last, and a bare `name` row resolves through the profile's `node_modules` — exactly the resolution path `healProfilesModuleFallback` and the profile's pnpm-managed `node_modules` already provide. The row is written through `entryListSchema`, so `!!js` expressions round-trip.

The running process cannot mount the result: the Loader resolves a row at boot and no live mount path exists for an npm package installed afterwards (the dynamic Cordis runner mounts model-written vm code, not profile rows). Every result therefore reports `restartRequired: true`.

Install is idempotent for a package already named by a top-level row or an existing insert; it is not idempotent for a package mounted from inside a group row.

### The install tool asks the approval seam itself

`tools/pre-execute` would let a deployment policy answer per tool, but no composed policy knows that `plugin_install` runs the user's package manager; a policy that misses it silently installs. `plugin_install` therefore asks `ctx.get('approval')` before installing and fails closed — no channel, no agent, a rejection, a cancellation, or `unavailable` all end the call with no install. The grant is one-shot and covers only the package in the request. This is the same in-tool route the sandboxed bash and fs tools take for escalation.

### Why the approval ask cannot sit at the wire boundary

The Web settings tab reaches the same provider through `market/install`, and that call asks nobody. The approval seam cannot answer it, for three reasons that all hold at once:

1. `ApprovalService.request()` requires an `Agent`, and rejects before appending anything when that agent's session has no open turn — the `approval/asked` + `approval/decided` audit pair must be enclosed by the log's commit/replay boundary, since a bare event between turns is indistinguishable from a crash tail and is dropped on reload.
2. A Remote invocation carries only its `args` and an abort signal; the wire request names no agent and no session, so there is nothing to attach the ask to.
3. The Web approval channel (`api-proxy`) answers a `approval/request` by finding that request's still-undecided `approval/asked` event in `req.agent.session` and pushing an `approval/requested` mux frame for that session. With no agent and no such event it delegates, and the service's default turns that into `unavailable`.

A prompt that always fails closed was not shipped, and the gateway gained no bypass: the gate lives where a turn exists, and the tab's install is documented as ungated. Gating it needs a turn-independent approval channel — an ask with no agent and no session whose answer is still auditable and still subject to the `approval` policy.

### Config ownership

`dsh-market` owns `MarketConfig`, the `DEFAULT_*` values, and `resolveMarketConfig()`, because the resolved values (registry URL, profile name and directory, entry bound, request deadline, subprocess grace, output cap, package manager) are facts the seam's consumers reason about, not one provider's private settings. The schema itself lives in the provider, which is where the config catalog requires a plugin's config type to be declared: `market-npm` writes `static Config: z<Config>` over the seam's field names and defaults, so misconfiguration fails at plugin load — a non-absolute or credential-bearing registry URL, an entry bound outside `1..50`, a non-positive millisecond or byte bound, or a profile name the launcher would refuse all throw before the first call.

## Alternatives considered

**A registry-side plugin manifest instead of the `dsh` field.** A dedicated document (name, description, plugin type) would describe host plugins too. It does not exist, and inventing a second manifest convention would make a DSH plugin's discoverability depend on a file nobody publishes.

**Name-prefix matching (`@deepseek-ai/dsh-*`) as the only plugin signal.** It finds this repository's packages and nothing else, cannot express a third-party plugin, and would mark every scoped package of that shape a plugin. Rejected as the sole signal; the scope now accepts official plugins beside the `dsh` field, as [the discovery note](../feature/2026-10-21-plugin-market-discovery-by-scope.md) records.

**A separate package for the Remote gateway.** A fourth package would let a deployment publish the settings API without a Definition, which no current consumer wants; the gateway is the seam's transport projection, not an independent capability.

**Returning the row in the result and letting a caller write it.** The install would then be successful but unmounted until someone edited YAML — the exact step this feature exists to remove.

**Writing installs into the profile's `package.json` bundles list.** `dsh.profile.bundles` takes bundles, which must declare `dsh.bundle`; an ordinary plugin is not one.

**Live mounting the installed package.** Tempting because the Loader already mounts entries dynamically, but there is no path from a freshly installed npm package to a live row: the module is outside the boot graph, its services were never composed, and a half-mounted plugin is worse than a truthful restart requirement.

**Asking approval in the gateway, or borrowing a live agent's turn for it.** The gateway could reach `ctx.agents` and ask on behalf of whichever root agent happens to be live, which makes the same button prompt while a turn runs and fail while the session is idle, and files the audit pair inside an unrelated model step. A browser confirmation through the `userQuestions` seam has no agent and no turn requirement but carries no approval policy and no audit pair, so it would look like a gate without being one. Both would make the Wire path's safety depend on timing rather than on a contract.

## Consequences

The marketplace finds packages under the official scope or declaring `dsh`: bundles and browser plugins use the field, host plugins are found by scope, and a third-party package outside the scope needs the field before it is discoverable. Installing rewrites the user's `cordis.patch.yml` through a YAML dump: `!!js` round-trips, but hand-written comment lines do not survive. The approval gate covers the model-facing tool and not the Web tab's wire call, which is a weaker safety story for browser installs than the tool's. The seam has no uninstall, upgrade, or installed-version listing, so the model cannot see what is already present and a repeated install is reported as fresh. Search cancellation reaches the registry requests but not through the Remote, whose wire methods carry no signal.

What this bought: one implementation of search and install serving three surfaces, a loader row that the next boot genuinely mounts, and an install path that cannot silently write outside the resolved profile.

## Testing

`packages/market/market-npm/tests/install.spec.ts` covers the filter (a stubbed registry whose candidates declare the field, publish under the official scope, satisfy neither rule, or 404 their manifest), the entry bound, scoped-name encoding, exact-version and name-grammar refusals, the refusal of a non-plugin, the package-manager argv/cwd/store, the registered row, idempotence, the failure path with its stderr tail, and a missing profile. The Definition suite pins config resolution and the generated Remote namespace, and the tool suite pins registration, the fail-closed approval path, and the presenters. Each package carries its invariant companion suite.

## Deferred

A real-composition Loader boot test (installing into a temporary profile, booting the profile through the launcher, and asserting the plugin's tool appears) needs a profile fixture no existing suite has; the install flow is unit-covered instead. Uninstall, upgrade, and installed-state reporting are seams that do not exist yet.
