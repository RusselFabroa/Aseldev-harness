/**
 * Profile installation for the market provider: one package-manager run inside
 * the resolved profile, then the profile's own patch layer gains the loader row
 * that mounts the package on the next boot.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as yaml from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import type { MarketInstallResult, ResolvedMarketConfig } from '@deepseek-ai/dsh-market'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/**
 * npm's public package-name grammar; a name outside it addresses nothing the
 * registry can serve and is refused before any subprocess starts.
 */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u

/** An exact published version pin; ranges would let the index decide the installed code. */
const EXACT_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

/**
 * Install one plugin package into the configured profile and register its
 * loader row. The package manager runs with the profile directory as its
 * working directory and its store inside the harness home, so no state lands
 * outside the profile or `$DSH_HOME`.
 * @param config - resolved config naming the profile, manager, and bounds.
 * @param subprocess - the injected subprocess capability.
 * @param spec - validated `name` and the exact `version` to pin.
 * @param signal - caller cancellation; aborts the package-manager process tree.
 * @returns the installed package, its exact version, and the restart requirement.
 */
export async function installIntoProfile(
  config: ResolvedMarketConfig,
  subprocess: SubprocessRuntime,
  spec: { readonly name: string; readonly version: string },
  signal: AbortSignal | undefined,
): Promise<MarketInstallResult> {
  if (!existsSync(join(config.profileDir, 'package.json'))) {
    throw new Error(
      `dsh-market: profile ${JSON.stringify(config.profile)} does not exist at ${config.profileDir}; `
      + 'create it with the dsh launcher first',
    )
  }
  const executable = await subprocess.resolveExecutable(config.packageManager)
  const handle = subprocess.spawn({
    argv: [executable, 'add', `${spec.name}@${spec.version}`],
    cwd: config.profileDir,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: config.maxOutputBytes },
    },
    graceMs: config.subprocessGraceMs,
    // pnpm's default store is a user-level cache; keep every byte this install
    // writes inside the harness home the profile belongs to.
    env: { npm_config_store_dir: join(dirname(config.profileDir), '.pnpm-store') },
    signal,
  })
  const outcome = await handle.done
  if (outcome.exitCode !== 0) {
    const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
    const stdout = handle.collected.stdout?.readFrom(0).text.trim() ?? ''
    throw new Error(
      `dsh-market: ${config.packageManager} add ${spec.name}@${spec.version} failed `
      + `(exit ${String(outcome.exitCode)}, signal ${String(outcome.signal)}): ${stderr === '' ? stdout : stderr}`,
    )
  }
  registerPluginRow(config.patchPath, spec.name)
  return {
    package: spec.name,
    version: spec.version,
    profileDir: config.profileDir,
    restartRequired: true,
  }
}

/**
 * Validate the package name and version pin of one install request.
 * @param request - the caller's `package` and optional exact `version`.
 * @returns the validated name and pinned version, or `undefined` for the latest.
 */
export function resolveInstallSpec(
  request: { readonly package: string; readonly version?: string },
): { readonly name: string; readonly version: string | undefined } {
  const name = request.package.trim()
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    throw new Error(`dsh-market: ${JSON.stringify(request.package)} is not a valid package name`)
  }
  if (request.version === undefined) return { name, version: undefined }
  const version = request.version.trim()
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw new Error(
      `dsh-market: version ${JSON.stringify(request.version)} is not an exact published version; `
      + 'pin one version such as 1.2.3',
    )
  }
  return { name, version }
}

/** Loader entry id owned by one installed package; the market's row namespace. */
function rowId(packageName: string): string {
  return `market-${packageName.replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')}`
}

/**
 * Add one insert row for the installed package to the profile's patch layer.
 * Idempotent: a row already naming the package or its id is left alone.
 * @param patchPath - absolute profile `cordis.patch.yml` path.
 * @param packageName - the installed package name the row mounts.
 * @returns the row id registered for the package.
 */
function registerPluginRow(patchPath: string, packageName: string): string {
  const id = rowId(packageName)
  const patches: PatchOptions[] = existsSync(patchPath)
    ? loadOptionalPatches('dsh-market', patchPath) ?? []
    : []
  const registered = patches.some(patch => patch.name === packageName
    || patch.id === id
    || (patch.insert ?? []).some(entry => entry.name === packageName || entry.id === id))
  if (registered) return id
  // The user's own layer is rewritten through the loader's YAML dialect, so
  // `!!js` expressions and `!!js` config survive the round trip.
  writeFileSync(patchPath, yaml.dump([...patches, { insert: [{ id, name: packageName }] }], {
    schema: entryListSchema,
    noRefs: true,
    lineWidth: -1,
  }))
  return id
}
