# Agent Note: plugin market as a Web Plugins tab

Status: implemented

English | [中文](2026-10-22-plugin-market-web-tab.zh.md)

## Problem

The market capability seam shipped with a `market` Remote namespace and model-facing tools, but the browser had no way to reach it: a person who wanted a plugin still had to know its npm name and install it through the agent. The Web settings surface already had one Plugins section with feature-owned tabs, so the missing piece was a browser plugin plus a Client assembly that mounts the new namespace — nothing in `api-remotes` did, because that assembly lists its Remote contributions explicitly.

## Decision

`@deepseek-ai/dsh-client-ui-market` contributes one `settings.plugins.tab` contribution with id `market`, order 20, registered through `ctx.slots.inject()`. The section owner keeps the navigation row and tab chrome; the tab owns its hero row, search field, result cards, and copy. `ui-settings-plugin-inventory` is the template: a localized registration, an inject face that wraps two Remote calls, and a component whose loading, empty, no-match, and failure states never leave the mounted tab.

`@deepseek-ai/dsh-api-remotes` mounts `@deepseek-ai/dsh-market/remote` beside the four contributions it already mounted and re-exports its declaration merge type-only, so a consumer names `ctx.remote.market.search` and `ctx.remote.market.install` through the assembly facade. The payload types come from `@deepseek-ai/dsh-market/types` — a type-only import, so no browser bundle carries Host runtime code.

The first browse query (`dsh`) runs after the user selects **Test connection**, following the [connection-testing decision](../bug-fix/2026-10-21-market-client-activation.md). Typing then debounces into one request after 300 ms; a blank field returns to the browse query. The provider rejects a blank query, so an empty string cannot request a wider listing.

Each card is a compact disclosure: name, version, clamped description, and the install control stay visible; expanding reveals the full description, the version and publish time as labeled facts, and after an install the profile directory plus the restart notice. Only one card is open at a time, and the catalog list scrolls inside the tab, so a long registry answer never grows the settings page. Install state is per card (`pending` → `installed` | `failed`) and local to the component: nothing about an install is shared across tabs, and the Install button is disabled only while that card's request is in flight or after it succeeded. A successful install opens its own card, because the profile directory and the restart requirement are the answer the click asked for.

The install request carries the package name alone. The capability supports an exact version pin, but the tab has no version field, so pinning would mean inventing a control nobody asked for.

## Alternatives considered

**Add the tab to `ui-settings-plugins`.** The section owner would then own another feature's Remote dependency, its search lifecycle, and its install state. The tab extension point exists precisely so a Plugins view ships as its own package.

**Mount the `market` Remote from `ui-market` itself.** `ctx.remote.$mount` is the assembly's job: one place decides which Host namespaces this application exposes, and a feature package mounting its own would make the exposed set a function of which feature plugins the composition happened to load.

**Filter results locally against the browse text.** The registry already returns relevance-ordered candidates and the provider drops non-plugins; a local filter would be a second, weaker notion of matching over the same strings.

**One collapsible install panel per card with a version input.** Pinning needs a version the search result already knows, and offering an arbitrary version field invites typos the provider can only reject after a package-manager run.

**Auto-refresh the catalog after an install.** The installed plugin is invisible to the running Loader until a restart, so the result list would not change; a refresh would only re-issue a registry query for the same entries.

## Consequences

A person can search the market and install a plugin from the browser, and the result tells them where it landed and that a restart is due. The tab inherits two limits from the seam: an install is only useful after a restart, and the market wire announces no registry changes, so the catalog is a snapshot the next query replaces.

The Client assembly now names one more Host package. Adding a namespace stays an explicit value import and mount in `api-remotes`, and the ordering rule there — unwind in reverse mount order — covers the new contribution unchanged.

`packages/bundle/web-app` gains the `dsh.client` row and the dependency that row needs, and the base layer's `market` gateway row is what the browser half dials.

## Testing

`packages/client/ui-market/tests/components.client.spec.tsx` drives the component with stubbed inject faces: the browse query, debounced typing, empty versus no-match copy, retry, per-card install success and failure (including the restart notice being absent), disclosure state, and results that resolve after unmount. `browser-plugin.client.spec.tsx` pins the inject list, the registration options, the localized label, late declaration and declarer reload, and both Remote wrappers' failure mapping. `invariant.client.spec.ts` keeps the companion and node half inert.
