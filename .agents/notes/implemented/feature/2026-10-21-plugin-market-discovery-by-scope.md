# Agent Note: plugin discovery accepts the official scope

Status: implemented

English | [中文](2026-10-21-plugin-market-discovery-by-scope.zh.md)

## Problem

Market search kept only the packages whose published manifest declared a truthy `dsh` field. Measured across this repository, 45 of 225 packages declare it and every one of them is a bundle (`dsh.bundle`) or a browser plugin (`dsh.client`). Host plugins — tools, providers, service Definitions, including the market's own packages — declare none, so search could not return a single tool or provider package and the workflow the market exists for ended in an empty result for exactly the capability the harness is built from.

## Decision

A candidate is accepted when either rule holds: its name starts with `@deepseek-ai/dsh-`, the official package scope, or its published manifest carries a truthy `dsh` field. Both are evaluated after the manifest fetch the provider already performs, so the registry text-search query, the entry fields (`name`, `version`, `description`, `updatedAt`), the registry-relevance ordering, and the configurable registry base URL stay as they were.

The two rules are one acceptance test in `findPluginManifest`, not two code paths: official packages are discovered by scope, and a third-party package opts in by declaring `dsh` in its published `package.json`. Install runs the same test, so everything search returns is installable and the market still cannot install an arbitrary package by name.

No host plugin in this repository was changed to declare `dsh`. Publishing under the official scope is the compatibility answer for the packages already published, and name matching stays inside the first-party namespace, where it cannot mistake an unrelated package for a plugin.

### Why the scope rule is not the name heuristic the seam note rejected

[The seam note](../architecture/2026-10-21-plugin-market-capability-seam.md) rejected name-prefix matching as the *only* signal, because a heuristic that marks every scoped package a plugin cannot express a third-party plugin and lies about packages that merely share the prefix. That rejection stands: the `dsh` field remains the only way a third-party package becomes discoverable, and the prefix rule only names a namespace this project controls.

## Alternatives considered

**Declare `dsh` in every host plugin package.** This is the honest long-term convention, but it rewrites roughly 180 published manifests, and a package published without the field stays invisible until its next release — the compatibility answer for already-published plugins has to come from something the registry already carries.

**A registry-side plugin marker, such as a reserved npm keyword or a dedicated document.** npm keywords are author-controlled text that any package can claim, and a second document nobody publishes repeats the gap that made `dsh` necessary; both also need a provider change to read them.

**Drop the filter and return every search hit.** The index then decides what a plugin is: unrelated packages matching the query text would be offered to the model as installable and `plugin_install` would mount whatever the name resolved to.

## Consequences

Search returns host plugins, which is the capability the market was built for. The cost is a namespace coupling: everything under `@deepseek-ai/dsh-` is treated as a plugin, so a future non-plugin package in that scope becomes searchable and installable by name — it fails at mount, after the user approved the install. Third-party discovery is unchanged and still depends on the author declaring `dsh`, and a package outside the scope that declares no such field remains invisible.

## Testing

`packages/market/market-npm/tests/install.spec.ts` pins all four acceptance outcomes against a stubbed registry: an official-scope package with no `dsh` field is returned, a third-party package with the field is returned, a package with neither is dropped, and an official-scope package installs from its latest published version. `packages/market/tool-market/tests/tool-market.spec.ts` pins the empty-result text naming both rules.
