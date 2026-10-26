/**
 * Service Definition for the plugin-market capability seam (`ctx.market`), its
 * config contract, and the `market` Remote gateway the Web GUI settings page
 * dials. Search and install are capability operations: this package owns the
 * request/result payloads and where a plugin may be installed, never registry
 * access or package-manager invocation. The npm implementation lives in
 * `@deepseek-ai/dsh-market-npm` and the model-facing tools in
 * `@deepseek-ai/dsh-tool-market`.
 * @module @deepseek-ai/dsh-market
 */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { PROFILE_PATCH_FILENAME, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  MarketInstallRequest,
  MarketInstallResult,
  MarketSearchRequest,
  MarketSearchResult,
} from './types.ts'

export type {
  MarketInstallRequest,
  MarketInstallResult,
  MarketPluginEntry,
  MarketSearchRequest,
  MarketSearchResult,
} from './types.ts'

/** Public registry used when the deployment configures none. */
export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'

/** Profile a marketplace install targets when the deployment configures none. */
export const DEFAULT_PROFILE = 'web'

/** Entries returned by one search when the caller asks for no explicit count. */
export const DEFAULT_MAX_RESULTS = 10

/** Hard ceiling on entries returned by one search, whatever a caller asks for. */
export const MAX_RESULTS = 50

/** Deadline for one registry HTTP request, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/** Grace period for the package-manager process tree, in milliseconds. */
export const DEFAULT_SUBPROCESS_GRACE_MS = 10_000

/** Bytes retained from each package-manager stream for diagnostics. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000

/** Package manager that installs into the profile when the deployment configures none. */
export const DEFAULT_PACKAGE_MANAGER = 'pnpm'

/** `setTimeout`'s largest accepted delay; every configured millisecond bound stays below it. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Plugin config; every deployment-varying choice is a field here. The seam owns
 * this input contract and the defaults below, while each provider declares the
 * Loader schema its own package is validated with.
 */
export interface MarketConfig {
  /** Package registry base URL. Defaults to {@link DEFAULT_REGISTRY_URL}. */
  registryUrl?: string
  /** Profile name (the `dsh --profile` value) installs target. Defaults to {@link DEFAULT_PROFILE}. */
  profile?: string
  /** Harness home holding `profiles/`; defaults to `$DSH_HOME`. */
  dshHome?: string
  /** Entry bound for one search. Defaults to {@link DEFAULT_MAX_RESULTS}, never above {@link MAX_RESULTS}. */
  maxResults?: number
  /** Registry request deadline in milliseconds. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number
  /** Package-manager termination grace in milliseconds. Defaults to {@link DEFAULT_SUBPROCESS_GRACE_MS}. */
  subprocessGraceMs?: number
  /** Retained bytes per package-manager stream. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number
  /** Package-manager executable. Defaults to {@link DEFAULT_PACKAGE_MANAGER}. */
  packageManager?: string
}

/** Complete config: every field resolved and validated at plugin load. */
export interface ResolvedMarketConfig {
  /** Registry base URL without a trailing slash. */
  readonly registryUrl: string
  /** Profile name installs target. */
  readonly profile: string
  /** Absolute profile directory: `<dshHome>/profiles/<profile>`. */
  readonly profileDir: string
  /** Absolute profile patch layer the install registers its plugin row in. */
  readonly patchPath: string
  /** Entry bound for one search. */
  readonly maxResults: number
  /** Registry request deadline in milliseconds. */
  readonly requestTimeoutMs: number
  /** Package-manager termination grace in milliseconds. */
  readonly subprocessGraceMs: number
  /** Retained bytes per package-manager stream. */
  readonly maxOutputBytes: number
  /** Package-manager executable. */
  readonly packageManager: string
}

/** Reject a configured count, byte cap, or deadline that is not a positive integer. */
function assertPositiveInteger(name: string, value: number, min = 1): void {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`dsh-market: ${name} must be an integer of at least ${String(min)}`)
  }
}

/** Validate one registry base URL and normalize away its trailing slashes. */
function resolveRegistryUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`dsh-market: registryUrl ${JSON.stringify(value)} is not an absolute URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`dsh-market: registryUrl ${JSON.stringify(value)} must use http or https`)
  }
  // A registry credential would leak into every request URL and diagnostic.
  if (url.username !== '' || url.password !== '') {
    throw new Error('dsh-market: registryUrl must not carry credentials')
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, '')
}

/**
 * Validate the configured seam config and resolve the profile installs target.
 * Every failure is a load-time error: a market that cannot name a registry or a
 * profile would otherwise fail on the model's or the user's first operation.
 * @param config - the Loader-validated plugin config.
 * @returns the resolved config, including the absolute profile directory.
 */
export function resolveMarketConfig(config: MarketConfig): ResolvedMarketConfig {
  const registryUrl = resolveRegistryUrl(config.registryUrl ?? DEFAULT_REGISTRY_URL)
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
  assertPositiveInteger('maxResults', maxResults)
  if (maxResults > MAX_RESULTS) {
    throw new Error(`dsh-market: maxResults must not exceed ${String(MAX_RESULTS)}`)
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const subprocessGraceMs = config.subprocessGraceMs ?? DEFAULT_SUBPROCESS_GRACE_MS
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  assertPositiveInteger('requestTimeoutMs', requestTimeoutMs)
  assertPositiveInteger('subprocessGraceMs', subprocessGraceMs)
  assertPositiveInteger('maxOutputBytes', maxOutputBytes)
  if (requestTimeoutMs > MAX_TIMER_DELAY_MS || subprocessGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-market: configured millisecond bounds must not exceed ${String(MAX_TIMER_DELAY_MS)}`)
  }
  const packageManager = config.packageManager ?? DEFAULT_PACKAGE_MANAGER
  if (packageManager.trim() === '') throw new Error('dsh-market: packageManager must not be blank')
  const profile = config.profile ?? DEFAULT_PROFILE
  // The launcher's own profile-name rule decides what a valid profile is, so an
  // install can never address a directory the boot would refuse to load.
  const profileDir = resolveProfileDir(profile, config.dshHome === undefined
    ? resolveDshHome()
    : resolveDshHome(config.dshHome))
  return {
    registryUrl,
    profile,
    profileDir,
    patchPath: join(profileDir, PROFILE_PATCH_FILENAME),
    maxResults,
    requestTimeoutMs,
    subprocessGraceMs,
    maxOutputBytes,
    packageManager,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    market: MarketService
  }
}

/**
 * Abstract plugin-market service. Providers implement registry access and
 * installation; every provider honors the configured entry bound, writes only
 * inside {@link ResolvedMarketConfig.profileDir}, and reports whether the
 * running process can use a freshly installed plugin.
 */
export abstract class MarketService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'market')
  }

  /**
   * Search the configured registry for installable DSH plugins.
   * @param request - query text and an optional entry count.
   * @param signal - aborts the registry round trips.
   * @returns confirmed plugins, at most the configured bound.
   */
  abstract search(request: MarketSearchRequest, signal?: AbortSignal): Promise<MarketSearchResult>

  /**
   * Install one plugin package into the configured profile and register it for
   * the next boot.
   * @param request - package name and an optional exact version pin.
   * @param signal - aborts the download and the package-manager process tree.
   * @returns what was installed and whether a restart is required to mount it.
   */
  abstract install(request: MarketInstallRequest, signal?: AbortSignal): Promise<MarketInstallResult>
}

/**
 * Remote gateway for the Web GUI settings page: the `market` wire namespace
 * over `ctx.market`. It carries no state and no policy — every call forwards
 * to the mounted provider, so the browser and the model-facing tools share one
 * implementation.
 */
export class MarketGateway extends TypertRemoteService {
  static inject = ['market']

  constructor(ctx: Context) {
    super(ctx, 'marketGateway', { namespace: 'market' })
  }

  /**
   * Forward one index query to the mounted provider.
   * @param request - query text and an optional entry count.
   * @returns confirmed plugins, at most the configured bound.
   */
  @Remote('search')
  search(request: MarketSearchRequest): Promise<MarketSearchResult> {
    return this.ctx.market.search(request)
  }

  /**
   * Forward one install request to the mounted provider. This boundary cannot
   * ask for approval: `ctx.approval.request()` needs an agent whose session has
   * an open turn (the audit pair is turn-enclosed), and a wire call carries
   * neither, so only the model-facing tool reaches that gate.
   * @param request - package name and an optional exact version pin.
   * @returns what was installed and whether a restart is required to mount it.
   */
  @Remote('install')
  install(request: MarketInstallRequest): Promise<MarketInstallResult> {
    return this.ctx.market.install(request)
  }
}

export default MarketGateway
