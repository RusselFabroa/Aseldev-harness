# @deepseek-ai/dsh-market

English | [中文](README.zh.md)

Plugin-market capability seam. `MarketService` (named export, `ctx.market`) declares search and install; `MarketGateway` (default export) registers the Remote-only `marketGateway` service bound to the `market` wire namespace, publishing `market/search` and `market/install` for the Web GUI settings page. Every call forwards to the mounted provider, so the browser and the model-facing tools reach one implementation.

```ts
search(request: MarketSearchRequest, signal?: AbortSignal): Promise<MarketSearchResult>
install(request: MarketInstallRequest, signal?: AbortSignal): Promise<MarketInstallResult>
```

`MarketSearchRequest` is `{ query, limit? }`; `MarketSearchResult` is `{ entries }`, where each entry carries the published `name`, `version`, `description`, and `updatedAt`. `MarketInstallRequest` is `{ package, version? }`; `MarketInstallResult` reports the installed `package` and `version`, the absolute `profileDir` it landed in, and `restartRequired`. The payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

This package also owns the seam's config contract: the `MarketConfig` input type, the `DEFAULT_*` values, `ResolvedMarketConfig`, and `resolveMarketConfig()`. Each provider declares the Loader schema it is validated with in its own package, as the config catalog requires, and builds it from these defaults and field names. `registryUrl`, `profile`, `dshHome`, `maxResults`, `requestTimeoutMs`, `subprocessGraceMs`, `maxOutputBytes`, and `packageManager` are the deployment-varying fields; the resolution step validates the registry URL (absolute, `http`/`https`, no credentials), the entry bound (`1`–`50`), every positive millisecond and byte bound, and the profile name, then resolves the absolute `profileDir` and `patchPath`. The profile name and directory come from the launcher's own `resolveProfileDir()`, so an install always addresses a directory `dsh --profile` would load. Any violation throws at plugin load.

## Model Experience

None, as this package registers no prompt, tool, message, or provider request; the model-facing surface is [`dsh-tool-market`](../tool-market/README.md).

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Install targets one configured profile** — there is no "current profile" fact in the runtime, so a deployment that runs several profiles must configure the one the marketplace manages.
- **The Remote is mounted by the Web client assembly** — this package publishes the wire namespace; selecting it for the browser is the client assembly's decision.
- **A wire-initiated install asks nobody** — the gateway forwards `market/install` to the provider without an approval ask because the approval seam cannot answer it: `ctx.approval.request()` requires an `Agent` whose session has an open turn (it throws `outside an open turn` otherwise, since the `approval/asked`/`approval/decided` audit pair must be turn-enclosed), the wire request carries neither an agent nor a session, and the Web approval channel answers by correlating the ask with an `approval/asked` event in that session's log — with none, it fails closed as `unavailable`. Only `plugin_install` asks, from inside an agent turn. A confirmation the settings tab renders itself is presentation, not this gate: a direct wire call skips it. Gating the Wire call needs a turn-independent approval channel, which does not exist today; a prompt that always fails closed was deliberately not shipped.
- **`restartRequired` is always true for the shipped providers** — the Loader can mount a module it has already imported, but no live mount path exists for an npm package installed after boot.
