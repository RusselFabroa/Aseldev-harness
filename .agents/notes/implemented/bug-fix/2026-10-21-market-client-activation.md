# Agent Note: Market client activation and connection testing

Status: implemented

English | [中文](2026-10-21-market-client-activation.zh.md)

## Problem

A stale API Remotes browser bundle omits `remote.market`, leaving the Market UI pending and blocking the landing screen. Rebuilding reveals a separate registration defect: the `market/install` endpoint collides with the namespace service's private string-named `install` helper. An optional registry feature must also let users check availability from Settings before fetching or displaying results.

## Decision

Client Gateway registers projected methods through a Symbol-keyed helper. Business methods named `install` can mount, coexist with other methods, and withdraw without replacing that helper; existing field and method collision checks remain enforced.

Market UI requires only slots and locale to activate. Its action callbacks resolve the optional `remote.market` service through `ctx.get()` and reject unavailable calls. Opening the tab performs no request. **Test connection** executes the normal browse query through the Host provider, then displays the returned catalog and enables search. Failures stay in Settings and can be retried.

This timing decision supersedes the initial-query timing in the [Market tab note](../feature/2026-10-22-plugin-market-web-tab.md), which retains ownership of the tab composition and install presentation. Generated Remote selection is compiled into the API Remotes browser bundle, so changing its source requires rebuilding that package before refreshing the app.

## Alternatives considered

**Keep `remote.market` as a required UI injection.** A missing optional Market API prevents the entire app from opening Settings, where the user needs to test it.

**Rename the published install endpoint.** The collision belongs to client registration machinery. Renaming a business API would preserve an internal naming restriction without fixing its cause.

**Add a separate health endpoint.** A browse query already checks the generated method, transport, Host gateway, provider, and registry, and supplies the values the user wants displayed.

## Consequences

Unavailable Market services fail when requested rather than during UI activation. The connection test performs a real registry search; it does not install anything. Gateway tests cover `install` mounting and withdrawal, Market tests cover missing and late services plus explicit first queries, and the running Web composition confirms the landing screen loads and a successful test displays catalog entries.
