# @deepseek-ai/dsh-client-ui-market

English | [中文](README.zh.md)

The **Market** tab of Web Settings → Plugins searches published plugins and installs them into the current profile. The browser plugin registers one localized `settings.plugins.tab` contribution with id `market`; the Plugins section owns navigation and tab chrome. App startup and opening the tab make no market requests. Select **Test connection** to run the first browse query and display its results. Search and install resolve the optional `remote.market` service at invocation, so an unavailable API reports a local Settings error without blocking app startup. [`api-remotes`](../../api/remotes/README.md) owns the generated Market namespace.

The tab opens on a display-size heading, one search field, and one compact disclosure card per result. A card always shows the package name, its current version, its clamped description, and the install control; expanding it reveals the full description, the version, the registry publish time, and — after an install — the profile directory the package landed in with the restart notice. One card is open at a time, and the catalog scrolls inside the tab, so a long registry answer never grows the settings page. Typing is debounced into one request; a blank query returns to the browse query. Loading, empty, no-match, and generic failure states stay local, a failed read is retryable, and no state names a transport detail. Installs target the latest published version, because the tab offers no version field. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package renders a browser settings surface and registers nothing model-facing; a model reaches an installed plugin only through that plugin's own Host rows.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **An install takes effect after a restart** — the running process cannot mount a package the Loader never resolved at boot, so the install result reports `restartRequired` and the tab shows the profile directory plus the restart notice instead of claiming the plugin is live.
- **The catalog is a snapshot, not a subscription** — the market wire announces no registry changes, so the tab shows what the last query returned; typing another query or pressing retry is what re-reads it.
- **Browsing is a registry heuristic** — the index matches text, and only a package whose manifest carries a `dsh` field is a plugin, so a browse query can return fewer installable plugins than it lists candidates for, and a plugin whose published metadata says nothing about DSH is only found by a query that names it.
- **Install always takes the latest published version** — a pinned version exists in the request payload but the tab exposes no version field, so it always sends the package name alone.
