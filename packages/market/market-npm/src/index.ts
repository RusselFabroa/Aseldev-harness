/**
 * npm-registry Service Provider for the plugin-market seam: index search with
 * manifest confirmation, and installation into the resolved `dsh --profile`
 * profile. Registry access lives in `registry.ts`, profile installation in
 * `install.ts`; this module owns the service class, its Loader config schema,
 * config resolution, and the request-to-spec validation.
 * @module @deepseek-ai/dsh-market-npm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_RESULTS,
  DEFAULT_PACKAGE_MANAGER,
  DEFAULT_PROFILE,
  DEFAULT_REGISTRY_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SUBPROCESS_GRACE_MS,
  MarketService,
  resolveMarketConfig,
} from '@deepseek-ai/dsh-market'
import type {
  MarketConfig,
  MarketInstallRequest,
  MarketInstallResult,
  MarketSearchRequest,
  MarketSearchResult,
  ResolvedMarketConfig,
} from '@deepseek-ai/dsh-market'
import { findPluginManifest, searchRegistry } from './registry.ts'
import { installIntoProfile, resolveInstallSpec } from './install.ts'

export { findPluginManifest, searchRegistry } from './registry.ts'
export type { PluginManifest } from './registry.ts'
export { installIntoProfile, resolveInstallSpec } from './install.ts'

/** Provider config: the seam's input fields, validated here with the seam's defaults. */
export interface Config extends MarketConfig {}

/**
 * Resolve one search request to its spec: a non-blank query and the entry
 * bound, which is the caller's request clamped to the configured maximum.
 * @param request - the caller's query and optional count.
 * @param maxResults - the configured entry bound.
 * @returns the query to send and the number of entries to keep.
 */
export function resolveSearchSpec(
  request: MarketSearchRequest,
  maxResults: number,
): { readonly query: string; readonly limit: number } {
  const query = request.query.trim()
  if (query === '') throw new Error('dsh-market: search requires a non-blank query')
  if (request.limit === undefined) return { query, limit: maxResults }
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new Error('dsh-market: search limit must be a positive integer')
  }
  return { query, limit: Math.min(request.limit, maxResults) }
}

/**
 * npm-registry plugin market. Search asks the registry index and confirms every
 * candidate against its published manifest, because a package is a DSH plugin
 * only when it publishes under `@deepseek-ai/dsh-` or that manifest carries a
 * truthy `dsh` section. Install pins the confirmed version, runs the configured
 * package manager inside the profile, and registers the loader row the next
 * boot mounts.
 */
export class NpmMarketService extends MarketService {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    registryUrl: z.string().default(DEFAULT_REGISTRY_URL),
    profile: z.string().default(DEFAULT_PROFILE),
    dshHome: z.string(),
    maxResults: z.number().default(DEFAULT_MAX_RESULTS),
    requestTimeoutMs: z.number().default(DEFAULT_REQUEST_TIMEOUT_MS),
    subprocessGraceMs: z.number().default(DEFAULT_SUBPROCESS_GRACE_MS),
    maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
    packageManager: z.string().default(DEFAULT_PACKAGE_MANAGER),
  })

  private readonly config: ResolvedMarketConfig

  /**
   * @param ctx - context carrying the injected subprocess capability.
   * @param config - Loader-validated marketplace config.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveMarketConfig(config)
  }

  /**
   * Search the npm registry for published DSH plugins.
   * @param request - query text and an optional entry count.
   * @param signal - aborts the registry round trips.
   * @returns confirmed plugins, at most the configured bound.
   */
  override search(request: MarketSearchRequest, signal?: AbortSignal): Promise<MarketSearchResult> {
    const spec = resolveSearchSpec(request, this.config.maxResults)
    return searchRegistry(this.config, spec.query, spec.limit, signal)
  }

  /**
   * Install one published DSH plugin into the configured profile.
   * @param request - package name and an optional exact version pin.
   * @param signal - aborts the download and the package-manager process tree.
   * @returns what was installed and whether a restart is required to mount it.
   */
  override async install(
    request: MarketInstallRequest,
    signal?: AbortSignal,
  ): Promise<MarketInstallResult> {
    const spec = resolveInstallSpec(request)
    const manifest = await findPluginManifest(this.config, spec.name, spec.version, signal)
    if (manifest === undefined) {
      throw new Error(
        `dsh-market: ${spec.name}${spec.version === undefined ? '' : `@${spec.version}`} is not a published `
        + 'DSH plugin; a plugin publishes under @deepseek-ai/dsh- or declares a dsh field in its package.json',
      )
    }
    return installIntoProfile(
      this.config,
      this.ctx.subprocess,
      { name: manifest.name, version: manifest.version },
      signal,
    )
  }
}

export default NpmMarketService
