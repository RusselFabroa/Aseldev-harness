# market/ — plugin-market capability family

English | [中文](README.zh.md)

Discovers DSH plugins in a package registry and installs one into the configured `dsh --profile` profile. The seam splits into the three capability roles: a Service Definition that also projects the Host Remote the settings UI dials, one registry Service Provider, and the model-facing Consumer.

| Package | Role | ctx key |
|---|---|---|
| [`market/`](market/README.md) | Defines the search/install capability, its config, and the `market` Remote gateway | `ctx.market` (definition) |
| [`market-npm/`](market-npm/README.md) | Provides search and install against the npm registry | registers `ctx.market` |
| [`tool-market/`](tool-market/README.md) | Exposes search and install to the model | registers on `ctx.tools` |

Install writes only inside the resolved profile: the package manager runs with the profile directory as its working directory, and the profile's own `cordis.patch.yml` gains one insert row. The running process never mounts a newly installed plugin, so the result reports `restartRequired`.

A registry package is discoverable when its name starts with `@deepseek-ai/dsh-` or its published `package.json` declares a truthy `dsh` field: official plugins are found by scope, and a third-party plugin opts in with that field ([details](market-npm/README.md#discovery)).

The `ctx.market` service and the `market/search`/`market/install` Remote methods are mapped into [docs/subsystems/extensions.md](../../docs/subsystems/extensions.md) by `pnpm run gen-cordis-catalog`.
