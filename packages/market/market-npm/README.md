# @deepseek-ai/dsh-market-npm

English | [中文](README.zh.md)

npm-registry Service Provider for [`dsh-market`](../market/README.md). `NpmMarketService` registers `ctx.market` and implements both seam operations against the registry at `registryUrl` (default `https://registry.npmjs.org`).

**Search.** One request to `/<...>/-/v1/search?text=<query>&size=<n>` returns index candidates; each candidate's published manifest is then fetched to confirm it is a DSH plugin and to read the authoritative version and description. The filter is the one signal the index cannot answer: a package is a DSH plugin when it is published under `@deepseek-ai/dsh-`, or when its published `package.json` carries a truthy `dsh` field — the section DSH bundles (`dsh.bundle`) and browser plugins (`dsh.client`) publish. A candidate the registry does not have at that version, or one that satisfies neither rule, is dropped rather than reported as an error. The entry count is the caller's request clamped to `maxResults`.

**Install.** The request's package name and version pin are validated against npm's name grammar and an exact-version grammar, the exact version's manifest must pass the same discovery filter, and then `packageManager` runs `add <name>@<version>` with the profile directory as its working directory through `ctx.subprocess` (never `child_process`), with its store under `<dshHome>/profiles/.pnpm-store`. The profile's `cordis.patch.yml` then gains one insert row (`id: market-<slug>`, `name: <package>`), which the next boot's profile layer resolves through the profile's own `node_modules` — the module-resolution path the launcher already uses for a bare row. Re-installing the same package is idempotent: an existing row naming the package or its id is kept.

The package never mounts what it installs. The Loader resolves a row through Node resolution at boot, and no live mount path exists for a package installed after that, so every result reports `restartRequired: true`.

## Discovery

A package is discoverable when either rule holds: its name starts with `@deepseek-ai/dsh-`, the official plugin scope, or its published `package.json` carries a truthy `dsh` field. Official plugins therefore need no extra metadata; a third-party plugin becomes discoverable by declaring that field, since the registry index has no other marker to read. None of this repository's existing host plugins (tools, providers, service Definitions) declare `dsh`: the scope rule is the compatibility answer for them, and discovery stays name-based for its own packages.

## Config

| Field | Default | Meaning |
|---|---|---|
| `registryUrl` | `https://registry.npmjs.org` | Registry base URL; absolute `http`/`https`, no credentials |
| `profile` | `web` | Profile name installs target |
| `dshHome` | `$DSH_HOME` | Harness home holding `profiles/` |
| `maxResults` | `10` | Entries returned by one search; never above `50` |
| `requestTimeoutMs` | `20000` | Deadline for one registry request |
| `subprocessGraceMs` | `10000` | Package-manager termination grace |
| `maxOutputBytes` | `64000` | Retained bytes per package-manager stream |
| `packageManager` | `pnpm` | Package manager executable |

The provider declares its own `Config` schema (`static Config`, schemastery) from the seam's `MarketConfig` field names and `DEFAULT_*` values, so the Loader validates this package in this package. Misconfiguration fails at load: `resolveMarketConfig()` validates the URL, the entry bound, the millisecond and byte bounds, and the profile name (through the launcher's own `resolveProfileDir()`, so an install can never address a directory `dsh --profile` refuses).

## Model Experience

Indirectly, through [`dsh-tool-market`](../tool-market/README.md), whose `market_search` and `plugin_install` tools call this provider: a blank query, an invalid version pin, a package that is not a DSH plugin, and a failed package-manager run all reach the model as that tool call's error text.

#### KV Cache effect

None; this package registers no prompt, tool, or system-prompt section, so it never changes a model request's tokens.

## Known Limitations and Deferred Work

- **A third-party package without `dsh` metadata is invisible.** The name rule covers only the official `@deepseek-ai/dsh-` scope, so a package outside it that declares no `dsh` field never appears in search; declaring the field in its published manifest is a change only its author can make.
- **Installs require an initialized profile and a working package manager.** The provider never creates the profile; it fails with the launcher's guidance instead.
- **The profile patch layer is rewritten on install.** The row is added through the loader's YAML dialect, so `!!js` expressions round-trip, but hand-written comment lines in `cordis.patch.yml` do not survive the rewrite.
- **Only top-level and inserted rows are checked for an existing registration.** A package already mounted from inside a group row is installed again.
- **No uninstall, upgrade, or version listing.** The seam exposes search and install only.
- **Search cancellation reaches the registry requests but not through the Remote**, whose wire methods carry no signal.
